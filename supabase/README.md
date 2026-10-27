# supabase/ — database for the Cafe site

Owner: `database-engineer`. Spec: `engineering/decisions/architecture.md` (rev 3), `api-contract.md` 1.2.0,
`engineering/decisions/data-model.md` (tables, ER diagram, decisions). Money is integer paisa. Timestamps are `timestamptz`.

> **Test status (2026-10-23):** first real run on a local stack (Supabase CLI 2.121.0 via `pnpm exec supabase`,
> Postgres 15.19). `supabase start` / `supabase db reset` apply all 15 migrations and `seed.sql` with no errors.
> `supabase test db` passes **247/247** with no skips: pg_cron jobs present, SEC-018 storage trigger installed.
> Four test bugs were fixed and no migration needed changing (details: `engineering/decisions/data-model.md`,
> "First run fixes"). Nothing has been applied to a hosted project.
> **2026-10-23 (later): BUG-016 + BUG-015.** Two forward migrations, `20261023000001` (storage guard lets
> storage-api's dry-run through) and `20261023000002` (`product_variants.size_rank`), applied locally with
> `supabase migration up --local` (no reset; QA's local users and data kept). `supabase test db`: **265/265**, no skips.
> New storage-api regression test: `tests/integration/storage-upload.test.ts` (runs in `pnpm test` when a local stack
> is up, skipped otherwise).
> **2026-10-24: multi-language menu.** `20261024000001` adds `translations` jsonb to `menu_items`, `menu_categories`
> and `menu_variants` (shapes in "Menu translations" below), applied with `supabase migration up --local` (no reset).
> `supabase test db`: **353/353** (265 + 88 in the new `menu_translations.test.sql`), no skips. `seed.sql` now seeds
> translations for every placeholder category, item and variant from translator's
> `design/copy/menu-translations-2026-10-24.json` (DRAFT; takes effect on the next `supabase db reset`).
> **2026-10-25: daily food sales log + owner statistics.** `20261025000001` (`daily_sales`, `daily_sales_lines`,
> `upsert_daily_sales`, `get_daily_sales`) and `20261025000002` (eight `stats_*` RPCs), applied with
> `supabase migration up --local` (no reset). `supabase test db`: **480/480** (353 + 127 in `daily_sales_stats.test.sql`).
> A 60-day PLACEHOLDER food log (`note = 'DEMO DATA'`) is at the end of `seed.sql` and was also inserted into the
> running local DB. Shapes: "Statistics" below.
> **2026-10-25 (later): table ordering, spec 2.2.0** (`20261026000001`, `20261026000002`, new
> `table_ordering.test.sql`). **Not applied to the local DB** (no `migration up`, no reset; QA's data untouched).
> Verified on the running local stack inside a transaction that was rolled back: both migrations apply; the new
> file passes **362/362**; the four existing files still pass **480/480** on top of the new migrations; the seed
> block applies. Not run: `supabase db reset` from scratch and `supabase test db` itself (the same SQL was fed to psql
> in the db container). `types/database.generated.ts` is hand-updated in the generator's format; regenerate after
> `supabase migration up --local`. Shapes: "Table ordering" below.

## Layout

```
supabase/
  config.toml                         local stack config (hand-written, local only)
  migrations/                         applied in filename order; never edit an applied one, add a new file
    20261019000001_foundation.sql     deny-by-default grants, updated_at trigger, profiles, role helpers
    20261019000002_settings.sql       site_settings (public), order_rules (private), public_settings view
    20261019000003_menu.sql           categories, items (sold-out), variants, specials + RLS
    20261019000004_shop.sql           products, images, variants (stock) + RLS (no public stock column)
    20261019000005_abuse_controls.sql blocked_contacts (expires_at), rate_limits, rate_limit_hit, health_ping
    20261019000006_orders.sql         orders, order_items, status/paid constraints, write guard trigger
    20261019000007_order_functions.sql create_order, set_order_status, cancel_order, customer_cancel_order
    20261019000008_storage.sql        public-media bucket + policies
    20261019000009_realtime.sql       Realtime publication
    20261019000010_retention.sql      purge_personal_data() + pg_cron schedule
    20261021000001_function_privileges.sql   SEC-007: global "no EXECUTE for PUBLIC" default + sweep
    20261021000002_settings_rules_v2.sql     BUG-003 COD max 0 = none; SEC-003 IP caps, auto-cancel timeout,
                                             orders_paused; BUG-006 delivery-needs-area + hours checks
    20261021000003_order_functions_v2.sql    SEC-001 check order; SEC-003 caps/kill switch/auto-cancel fn;
                                             SEC-008 insert-or-nothing blocklist + block_contact(); auto_unconfirmed
    20261021000004_auto_cancel_schedule.sql  pg_cron job cafe-auto-cancel-unconfirmed (every 5 min)
    20261021000005_storage_object_guard.sql  SEC-018 per-width size + MIME trigger on storage.objects (guarded)
    20261023000001_storage_guard_dry_run.sql BUG-016: guard checks only Storage-measured rows (has "size"); dry-runs
                                             pass; raises 42501 (Storage: AccessDenied) instead of 23514 (500)
    20261023000002_product_variant_size_rank.sql  BUG-015: generated product_variants.size_rank + anon grant + index
    20261024000001_menu_translations.sql     translations jsonb on menu_items / menu_categories / menu_variants +
                                             CHECKs via private.menu_translations_valid() + anon column grants
    20261025000001_daily_sales.sql           daily_sales + daily_sales_lines (price snapshot trigger, RLS today/
                                             yesterday for staff), upsert_daily_sales, get_daily_sales, Kathmandu helpers
    20261025000002_stats.sql                 owner-only stats_* RPCs (jsonb), orders_completed_at_idx
    20261026000001_table_ordering.sql        table ordering schema: 5 table tables + admin_alerts / alert_deliveries,
                                             table_occupancy view, write guards, settings columns
    20261026000002_table_ordering_functions.sql  table ordering + owner-alert RPCs, cron expiry job, purge of alerts
  seed.sql                            PLACEHOLDER cafe data (local only), ends with a 60-day DEMO DATA food log
  tests/database/rls.test.sql         pgTAP: RLS, grants, storage policy
  tests/database/orders.test.sql      pgTAP: create_order, state machine, restock, blocklist, limits, purge
  tests/database/menu_translations.test.sql  pgTAP: translations CHECKs (valid / invalid shapes), staff/owner/anon access
  tests/database/daily_sales_stats.test.sql  pgTAP: sales log RLS + RPC, price snapshot, every stats RPC (numbers,
                                             compare math, Kathmandu boundaries, cancellations, stock alerts)
  tests/database/table_ordering.test.sql     pgTAP: table ordering, 13 groups (grants, guards, codes, tables, mode,
                                             join/rotate/lock, rounds, cancel window, close, board, expiry, stats, alerts)
  types/db.ts                         hand-written TypeScript types (see "Types")
  types/database.generated.ts         generated by `supabase gen types typescript --local` (2026-10-23)
../tests/integration/storage-upload.test.ts   Vitest: sign + upload through storage-api (local stack only)
```

## Run it locally

Prerequisites: Docker Desktop (running), Node 20+, and the Supabase CLI (`npm i -D supabase` in the app, or
`scoop install supabase` on Windows, or `brew install supabase/tap/supabase`). From `engineering/app/`:

```bash
supabase start            # pulls images the first time (a few GB), starts Postgres, Auth, Storage, Realtime, Studio
supabase db reset         # applies every migration, then seed.sql, on the LOCAL database only
supabase test db          # runs tests/database/*.test.sql with pgTAP
supabase status           # prints local URLs and the local anon + service_role keys
supabase stop             # stop; add --no-backup to also drop the local data
```

Studio (local) is at http://127.0.0.1:54323. The local API is http://127.0.0.1:54321. The keys printed by
`supabase status` belong to the local stack only and are not secrets worth protecting, but never paste them into a
hosted project's env.

Never run `supabase link`, `supabase db push` or `supabase db reset --linked` from here: those talk to a hosted
project, which needs Aabhash's approval (production / staging deploy gate).

### Create a local owner to click around with

No users are seeded (no known passwords in the repo). In Studio, Authentication > Add user (email + password), then
in the SQL editor (local DB only):

```sql
insert into public.profiles (id, role, display_name)
values ('<the new user id>', 'owner', 'Local Owner');
```

Use `'staff'` for a staff user. In the real app the backend creates the user and the profile together
(`inviteStaff`).

### Run one test file, or the SQL by hand

```bash
supabase test db supabase/tests/database/orders.test.sql
# or psql against the local DB:
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/database/orders.test.sql
```

Tests wrap everything in a transaction and roll back, so they leave the local data as it was.

### Checking a migration is safe before it ships

1. `supabase db reset` from scratch (proves migrations + seed apply cleanly in order).
2. `supabase test db`.
3. When Aabhash has approved touching staging: apply to staging first, then production. Never edit an applied migration.

## How the backend calls the database

Everything customer-facing goes through the Worker with the **service role** key (server only). The browser uses the
anon key and can only read public menu / shop / settings rows.

| Need                         | Call                                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Place an order               | `rpc('create_order', {...})`                                                                     | args: `p_items` (`[{variantId, qty}]`), `p_fulfilment`, `p_payment_method`, `p_customer_name`, `p_customer_phone` (normalised `+977 9[78]xxxxxxxx`), optional `p_customer_email`, `p_address`, `p_landmark`, `p_area`, `p_notes`, `p_ip_hash` (lowercase hex SHA-256 of salt+IP). Returns one row `{out_order_id, out_order_token, out_order_number, out_total_paisa, out_status}` |
| Staff status change / cancel | `rpc('set_order_status', {p_order_id, p_status, p_actor, p_reason, p_restock, p_block_contact})` | `p_actor` = the verified staff `profiles.id`. Role is read from `profiles`. `cancel_order(...)` is a thin wrapper                                                                                                                                                                                                                                                                  |
| Customer cancel              | `rpc('customer_cancel_order', {p_token})`                                                        | only while `placed`; always restocks; idempotent                                                                                                                                                                                                                                                                                                                                   |
| Rate limit                   | `rpc('rate_limit_hit', {p_key, p_window_seconds, p_max})` -> boolean                             | `rate_limit_hit_info` also returns `retry_after_seconds` for the `Retry-After` header                                                                                                                                                                                                                                                                                              |
| Keep-alive                   | `rpc('health_ping')`                                                                             | returns server time; callable with the anon key                                                                                                                                                                                                                                                                                                                                    |
| Retention                    | `rpc('purge_personal_data')`                                                                     | normally run by pg_cron; service role only                                                                                                                                                                                                                                                                                                                                         |
| Block a phone / IP hash      | `rpc('block_contact', {p_kind, p_value, p_reason, p_actor})`                                     | staff action `blockContact`. Returns one row `{out_id, out_created, out_expires_at}`. Insert-or-nothing: `out_created = false` means a live entry already existed and was **not** changed. An expired-but-unpurged entry is replaced. Errors: FORBIDDEN (actor has no profile), VALIDATION. Do **not** upsert `blocked_contacts` any more (SEC-008). |
| Renew a block (owner)        | `from('blocked_contacts').update({expires_at, reason}).eq('id', ...)`                            | owner only (`requireRole('owner')` first). `kind`, `value`, `created_at` are immutable and `created_by` can only be cleared: any other change fails with SQLSTATE `42501` for every role, service role included. |
| Pause / resume online orders | `from('site_settings').update({orders_paused: true or false}).eq('id', true)`                    | owner only (the staff guard trigger refuses staff). Public: anon reads it from `site_settings` / `public_settings` and gets it over Realtime. |
| Save a day's food sales log  | `rpc('upsert_daily_sales', {p_date, p_lines, p_till_total, p_note, p_actor})`                   | staff/owner. Returns `DailySalesLog`. See "Statistics" below |
| Read a day's food sales log  | `rpc('get_daily_sales', {p_date, p_actor})`                                                      | staff (today/yesterday) / owner. `DailySalesLog` or `null` |
| Owner statistics             | `rpc('stats_overview' \| 'stats_timeseries' \| ... , {..., p_actor})`                             | owner only, jsonb. See "Statistics" below |
| Auto-cancel stale orders     | `rpc('auto_cancel_unconfirmed_orders')`                                                          | normally run by pg_cron every 5 min; service role only. Returns `{enabled, timeoutMinutes, cancelled, failed, ranAt}`. Cancels `placed` orders older than `order_rules.auto_cancel_placed_after_minutes` (NULL = off) with reason `auto_unconfirmed` and restocks. |

### Error protocol (important for the backend)

`create_order` / `set_order_status` / `customer_cancel_order` fail with SQLSTATE `P0001`. PostgREST returns
`{ code: "P0001", message: "<ERROR_CODE>", details: "<json text>", hint: "<text>" }`. Map `message`:

| `message`                              | Contract error    | `details`                                                                                |
| -------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `ORDERS_PAUSED`                        | ORDERS_PAUSED (new; HTTP 503 suggested, tech-lead to confirm) | empty. `hint` = "Online ordering is paused right now. Please call us to order." Safe to show (says nothing about the customer). `create_order` only |
| `VALIDATION`                           | VALIDATION 400    | JSON `{ "<field path>": ["msg"] }` -> `fieldErrors` (includes the minimum-order message) |
| `OUT_OF_STOCK`                         | OUT_OF_STOCK 409  | JSON `{ "items.N": ["only 2 left" or "sold out"] }` -> `fieldErrors`                     |
| `ORDER_REFUSED`                        | ORDER_REFUSED 403 | empty on purpose (blocklist, open orders per phone, open orders per IP hash and COD max look identical) |
| `RATE_LIMITED`                         | RATE_LIMITED 429  | `{ "retryAfterSeconds": n }` -> `Retry-After` header (IP 10-min window, IP 24 h cap, phone 24 h cap) |
| `NOT_FOUND` / `CONFLICT` / `FORBIDDEN` | 404 / 409 / 403   | `hint` can carry safe text, e.g. "Please call us to change this order"                   |

Any other error from these calls is `INTERNAL`. `block_contact` uses the same protocol (FORBIDDEN, VALIDATION).

**Order of checks in `create_order` (SEC-001), so the backend does not undo it:** `ORDERS_PAUSED` -> input
`VALIDATION` -> IP-hash `RATE_LIMITED` (10-minute window, 24 h cap; these concern only the caller's own IP) -> items
re-priced / unavailable `VALIDATION` -> minimum order `VALIDATION` -> `OUT_OF_STOCK` -> `ORDER_REFUSED` (one code
path for every refusal rule) -> phone 24 h `RATE_LIMITED` -> insert. A bad basket gets the same answer for a blocked
phone and a clean one. The backend should not run a phone-keyed limit, or any extra DB read, before calling
`create_order` (SEC-001 points 2 to 4), or it reopens the oracle.

**Settings writes:** `site_settings` / `order_rules` now have these check constraints, so an owner save can fail with
SQLSTATE `23514` (check_violation; the constraint name is in the error message). Map to field errors:

| Constraint | Field | Suggested message |
|---|---|---|
| `site_settings_delivery_needs_area` | `deliveryAreas` | "Add at least one delivery area, or turn delivery off" |
| `site_settings_hours_ranges_valid` | `hours` | "Closing time must be after opening time (HH:mm, same day)" |
| `order_rules_cod_max_total_valid` | `codMaxTotal` | "Cannot be negative" (`0` and `null` both mean no limit) |

Never pass PostgREST's `details` for these through to the client (it contains the whole failing row).

### Menu translations (20261024000001)

English stays in the existing columns (`name`, `description`, `label`). Each table has one more column,
`translations jsonb NOT NULL DEFAULT '{}'`, keyed by the secondary language. Allowed language keys: `ne`, `zh`
(Simplified, `zh-Hans`), `ja`, `ko`, `pt` (Brazilian, `pt-BR`). Never `en`, never a BCP 47 tag, lower case only.

| Column | Shape | Limits (characters) |
|---|---|---|
| `menu_items.translations` | `{ "<lang>": { "name": string, "description"?: string, "pronunciation"?: string } }` | name 1..80 (required), description 1..240, pronunciation 1..80 and **`ne` only** (romanised Nepali) |
| `menu_categories.translations` | `{ "<lang>": { "name": string } }` | name 1..80 (required) |
| `menu_variants.translations` | `{ "<lang>": { "label": string } }` | label 1..40 (required; the English `label` allows 60) |

Example item: `{"ne": {"name": "मसला चिया", "description": "...", "pronunciation": "masala chiya"}, "zh": {"name": "马萨拉奶茶"}}`.

- **No other keys**, at either level. Values must be JSON strings (not `null`, numbers, arrays). An optional key that is
  empty must be **omitted**, not sent as `""` (the CHECK refuses empty strings). A language with no name is refused
  too: drop the whole language key instead. `{}` = English only. The DB does not trim; the backend should trim and
  drop blanks before saving.
- **Writes:** owner only (owner JWT, or service role after `requireRole('owner')`). Staff get 42501
  (`staff may only change: is_sold_out`) on items/variants and 0 rows on categories, same as for names today.
  Saving replaces the whole jsonb value; to change one language, read-modify-write (or `translations || jsonb_build_object(...)` in SQL).
- **Errors:** SQLSTATE `23514`, constraint `menu_items_translations_valid` / `menu_categories_translations_valid` /
  `menu_variants_translations_valid`. Map to field error `translations` (the Zod schema should catch it first with
  the same rules, so this is a backstop).
- **Reads:** anon can select `translations` on all three tables (table grant + explicit column grant); RLS still shows
  visible rows only. Add `translations` to the explicit `.select(...)` lists of the public menu queries. Realtime
  `menu_items` / `menu_variants` events carry the column.
- **Fallback rule for the UI** (same as aduwa's `only()`): a missing language, or text equal to the English, shows
  English only. The DB does not enforce "differs from English".

## Statistics (20261025000001, 20261025000002)

Owner dashboard data. Two sources: (a) the merch shop (`orders` / `order_items`), (b) a **daily food sales log** that
staff fill in at closing (the menu is view-only, so there are no food orders). TypeScript shapes: `types/db.ts`
(`DailySalesLog`, `Stats*`). Pinned by `tests/database/daily_sales_stats.test.sql`.

### Common rules

- **Call pattern: service role + verified actor**, like `set_order_status`. Every RPC here is EXECUTE for
  `service_role` only (SEC-007: anon and authenticated get `42501 permission denied`). The last argument `p_actor` is
  the verified `profiles.id` (from `requireRole`); the role is read from `profiles`. Stats need an **owner** actor,
  the sales log a staff or owner actor. Otherwise `FORBIDDEN`.
- **Errors** use the order-function protocol: SQLSTATE `P0001`, `message` = `FORBIDDEN` or `VALIDATION`, `details` =
  JSON `{ "<field>": ["msg"] }` for VALIDATION, `hint` = safe text for FORBIDDEN.
- **Kathmandu time.** Every date argument and every date in a result is a Kathmandu calendar date (`YYYY-MM-DD`,
  Asia/Kathmandu, UTC+05:45). Ranges are **inclusive** at both ends. An order belongs to the Kathmandu date of its
  timestamp: Kathmandu day D runs from 18:15 UTC on D-1 to 18:14:59.999 UTC on D. The frontend should compute "today",
  "this week" etc. in Asia/Kathmandu too, not in the browser's zone.
- **Ranges:** `p_from` and `p_to` required, `p_from <= p_to`, at most 1,096 days, else VALIDATION (`range`, or
  `compare.range` for the compare range).
- **Results** are ONE jsonb object per call. camelCase keys; money keys end in `Paisa` (integer paisa); every key is
  always present (null where noted). Weekday numbers: `0` = Sunday ... `6` = Saturday. Weeks start on **Sunday**.
- **Definitions.**
  - *Food revenue* = sum of `qty x unit price snapshot` of the logged lines. The optional till total is reported on
    its own (`foodTillTotalPaisa`) and never mixed into revenue.
  - *Merch revenue* = `orders.total_paisa` (as charged: VAT basis as snapshotted, delivery fee included) of
    **completed** orders, dated by `completed_at` (cash is collected at completion). *Merch orders* = count of those.
  - *Placed orders* (`merchOrdersPlaced`, heatmap, cancellations) = orders by `created_at`, any status.
  - `changePct` = `round((value - compare) / compare x 100, 1)`; `null` when there is no compare range or `compare`
    is 0 or null.

### Food sales log

**`upsert_daily_sales(p_date date, p_lines jsonb, p_till_total integer default null, p_note text default null, p_actor uuid default null) -> jsonb DailySalesLog`**

- `p_date`: Kathmandu business date. Not in the future (VALIDATION `date`). Staff: today or yesterday only (else
  FORBIDDEN, hint "Staff can log today and yesterday only. Ask the owner to change older days."). Owner: any past date.
- `p_lines`: `[{ "menuItemId": uuid, "variantId"?: uuid | null, "qty": 0..9999 }]`, 0..500 lines, at most one per
  (menuItemId, variantId). `qty` must be a JSON number with no fraction. **Any price the client sends is ignored**: the
  database snapshots name, variant label and unit price (item price + variant delta, floored at 0) from the menu.
  Hidden or sold-out items are accepted; a soft-deleted item only if it was deleted after that day began.
- `p_till_total`: paisa `0..1,000,000,000` or null. `p_note`: up to 500 characters, trimmed, `''` = null.
- **Semantics:** the header (till total, note) is **replaced** with what is sent, so send the current values to keep
  them. Lines are **merged**: a sent line inserts or updates that item's qty; lines not sent stay as they are; send
  `qty: 0` to zero one. An existing line keeps its price snapshot (the price at first entry); a new line takes the
  current menu price. One transaction, serialised per date.
- VALIDATION keys: `date`, `tillTotal`, `note`, `lines` (not an array / over 500), `lines.N` (N = 0-based index:
  bad shape, qty out of range, "unknown menu item", "unknown variant for this item", "the same item and variant
  appears more than once").

**`get_daily_sales(p_date date, p_actor uuid default null) -> jsonb DailySalesLog | null`**: the form's initial
state. `null` if nothing is logged for that date. Staff: today/yesterday only (FORBIDDEN otherwise).

`DailySalesLog`:
```jsonc
{ "id": "uuid", "businessDate": "2026-10-25", "tillTotalPaisa": 4500000 | null, "note": "text" | null,
  "createdBy": "uuid" | null, "updatedBy": "uuid" | null, "createdAt": "timestamptz", "updatedAt": "timestamptz",
  "linesTotalPaisa": 4387000, "itemsSold": 262,
  "lines": [ { "id": "uuid", "menuItemId": "uuid (original id)", "variantId": "uuid" | null,
               "menuItemExists": true, "name": "Masala Chai", "variantLabel": "Large" | null, "qty": 48,
               "unitPricePaisa": 9000, "lineTotalPaisa": 432000, "updatedBy": "uuid" | null, "updatedAt": "timestamptz" } ] }
```
Lines are ordered by name, then variant label (base item first).

Direct table access (owner/staff JWT) follows the same window through RLS: staff read/insert/update
`daily_sales` / `daily_sales_lines` for today and yesterday only and cannot delete; the owner can do everything for any
past date, never a future one. Only `qty` of a line can change after insert (42501 otherwise); `business_date` and
`created_*` are immutable; `created_by` / `updated_by` are forced to `auth.uid()` for JWT writers. Prefer the RPC.

### Stats RPCs (owner only)

| RPC | Arguments |
|---|---|
| `stats_overview` | `p_from date, p_to date, p_cmp_from date default null, p_cmp_to date default null, p_actor uuid` |
| `stats_timeseries` | `p_from date, p_to date, p_grain text default 'day'` (`day` \| `week` \| `month`), `p_actor uuid` |
| `stats_top_food` | `p_from date, p_to date, p_limit integer default 10` (1..100), `p_actor uuid` |
| `stats_best_food_per_day` | `p_from date, p_to date, p_actor uuid` |
| `stats_top_merch` | `p_from date, p_to date, p_limit integer default 10` (1..100), `p_actor uuid` |
| `stats_busy_heatmap` | `p_from date, p_to date, p_actor uuid` |
| `stats_cancellations` | `p_from date, p_to date, p_actor uuid` |
| `stats_stock_alerts` | `p_actor uuid` |

`p_actor` is declared `default null` (Postgres needs defaults after the optional args) but is required: null =
FORBIDDEN. The compare range is both ends or neither (VALIDATION `compare.range` otherwise).

**`stats_overview`** — every metric is `{ "value": n, "compare": n | null, "changePct": n | null }`:
```jsonc
{ "from": "2026-10-01", "to": "2026-10-25", "compareFrom": "2026-09-01" | null, "compareTo": "2026-09-25" | null,
  "timezone": "Asia/Kathmandu",
  "foodRevenuePaisa":   {...},  // logged lines
  "merchRevenuePaisa":  {...},  // completed orders, by completed_at
  "totalRevenuePaisa":  {...},  // food + merch
  "merchOrders":        {...},  // completed orders, by completed_at
  "avgMerchOrderPaisa": {...},  // round(merch revenue / merch orders); value null when 0 orders
  "foodItemsSold":      {...},
  "foodDaysLogged":     {...},
  "foodTillTotalPaisa": {...},  // sum of optional till totals (not revenue)
  "foodTillDays":       {...} } // days that have a till total
```

**`stats_timeseries`** — every bucket in the range, zeros included, ascending:
```jsonc
{ "from": "...", "to": "...", "grain": "week", "weekStartsOn": "sunday", "timezone": "Asia/Kathmandu",
  "buckets": [ { "bucket": "2026-10-04",   // natural start (day / Sunday / 1st of month)
                 "start": "2026-10-05", "end": "2026-10-10",   // clipped to the range
                 "partial": true,                              // clipped by the range
                 "foodRevenuePaisa": 0, "foodItemsSold": 0,
                 "merchRevenuePaisa": 0, "merchOrders": 0,     // completed, by completed_at
                 "merchOrdersPlaced": 0,                       // any status, by created_at
                 "totalRevenuePaisa": 0 } ] }
```

**`stats_top_food`** — variants summed into their item; items keyed by their original id, so a deleted item still
shows (current menu name, else its last logged name):
```jsonc
{ "from": "...", "to": "...", "limit": 10,
  "byQty":     [ { "rank": 1, "menuItemId": "uuid", "name": "Masala Chai", "isDeleted": false, "qty": 2822, "revenuePaisa": 26874000 } ],
  "byRevenue": [ /* same shape, ranked by revenue */ ] }
```
`byQty` ranks qty desc, then revenue, name; only qty > 0. `byRevenue` ranks revenue desc, then qty, name; only revenue > 0.

**`stats_best_food_per_day`** — one entry per date in the range:
```jsonc
{ "from": "...", "to": "...",
  "days": [ { "date": "2026-10-23", "logged": true, "menuItemId": "uuid" | null, "name": "Masala Chai" | null,
              "qty": 61 | null, "revenuePaisa": 579000 | null, "dayItemsSold": 301 | null, "dayFoodRevenuePaisa": 5130000 | null } ] }
```
Not logged: `logged: false`, all other fields null. Logged with nothing sold: item fields null, `qty` / `revenuePaisa` 0.
Ties: revenue, then name.

**`stats_top_merch`** — units in **completed** orders (by `completed_at`); `revenuePaisa` = unit price x qty (no
delivery fee); ranked by qty, then revenue:
```jsonc
{ "from": "...", "to": "...", "limit": 10,
  "byProduct": [ { "rank": 1, "productId": "uuid", "name": "Nailed Classic Tee", "qty": 12, "revenuePaisa": 1440000 } ],
  "byVariant": [ { "rank": 1, "variantId": "uuid", "productId": "uuid", "productName": "Nailed Classic Tee",
                   "size": "M", "colour": "Black", "label": "M / Black", "qty": 5, "revenuePaisa": 600000 } ] }
```

**`stats_busy_heatmap`** — merch orders **placed** (any status) by Kathmandu weekday x hour, all 168 cells ordered by
weekday then hour; food per weekday only (logs are daily), 7 rows:
```jsonc
{ "from": "...", "to": "...", "timezone": "Asia/Kathmandu", "weekdays": "0 = Sunday ... 6 = Saturday",
  "merch": [ { "weekday": 1, "hour": 10, "orders": 3, "completedOrders": 1 } ],
  "foodByWeekday": [ { "weekday": 5, "daysLogged": 9, "itemsSold": 3310, "revenuePaisa": 58504000,
                       "avgItemsSoldPerDay": 367.8 | null, "avgRevenuePaisaPerDay": 6500444 | null } ] }
```

**`stats_cancellations`** — orders **placed** in the range (by `created_at`):
```jsonc
{ "from": "...", "to": "...", "ordersPlaced": 359, "completed": 47, "cancelled": 305, "open": 7,
  "cancelRatePct": 85.0 | null, "completionRatePct": 13.1 | null,     // 1 decimal; null when ordersPlaced = 0
  "byReason": { "customer_request": 111, "auto_unconfirmed": 148, "no_show": 0, "refused": 0,
                "unreachable": 23, "out_of_stock": 0, "fake": 0, "other": 23 },   // all 8 keys always
  "refusedAttempts": { "recorded": false, "count": null, "note": "ORDER_REFUSED attempts are not stored ..." } }
```
**ORDER_REFUSED attempts are not recorded in the database:** `create_order` raises and its transaction rolls back;
the Worker only writes an `order_refused` line to the security log (`src/lib/log.ts`, Workers observability). The UI
should show "not tracked". `fake` is a staff-only reason; the owner may see it here.

**`stats_stock_alerts`** — variants that are `few_left` (stock 1..3) or `sold_out`, published or not:
```jsonc
{ "generatedAt": "timestamptz", "fewLeftThreshold": 3,
  "items": [ { "variantId": "uuid", "productId": "uuid", "productName": "Nailed Hoodie", "isPublished": true,
               "size": "XL", "colour": "Black", "sku": "HOOD-BLK-XL" | null, "stock": 3, "stockState": "few_left",
               "sold7d": 1, "sold30d": 1,            // rolling 7 x 24 h / 30 x 24 h, orders not cancelled
               "dailyRate30d": 0.03 | null,          // sold30d / 30, 2 decimals; null when 0
               "daysOfStockLeft": 90.0 | null } ] }  // 0 when sold out; stock / dailyRate30d (1 decimal); null when nothing sold
```
Order: sold out first, then fewest days left (unknown last), then stock, product, colour, size.

### Demo data (local only)

`seed.sql` ends with a 60-day PLACEHOLDER food log, every day tagged `note = 'DEMO DATA'` (the 60 Kathmandu dates
before today; Saturdays and the placeholder closures skipped; Friday busiest; Masala Chai top by qty, Steam Chicken Momo
by revenue). It was also run on the running local DB on 2026-10-25 (50 days, 1,350 lines). Remove it with
`delete from public.daily_sales where note = 'DEMO DATA';` (lines cascade). Merch statistics use the existing local orders.

### Reading data

- Public pages (anon): read `menu_categories`, `menu_items`, `menu_variants`, `menu_specials`, `site_settings` /
  `public_settings`, `products`, `product_images` freely (RLS shows only visible / published / unexpired rows).
- **`product_variants`: list columns explicitly.** Anon is denied the `stock` column, so `.select('*')` fails for anon by
  design. Use `.select('id, product_id, size, colour, sku, price_override_paisa, stock_state')`.
- **`product_variants` order (BUG-015):** always `.order('colour').order('size_rank').order('size').order('id')`
  (nested: `.order('size_rank', { referencedTable: 'product_variants' })` etc.). Without an ORDER BY, rows come back in
  physical order, which changes on every stock update. `size_rank` is generated from `size` (XXS 10, XS 20, S 30,
  M 40, L 50, XL 60, XXL/2XL 70, XXXL/3XL 80, 4XL 90, 5XL 100, numeric 200+n, unknown 1000, One size/Free size 1500) and
  anon may select it. The same list is the order to use for the `details.sizeChartCm` rows (jsonb does not keep key order).
- Order page by token (`GET /api/orders/[token]`): service role, `select ... from orders where public_token = $1` plus
  `order_items`. Return only the `OrderView` fields (never phone or address).
- Admin screens: either the staff member's own JWT (RLS lets staff/owner read; menu sold-out toggle and the settings
  announcement are the only direct writes staff have, guarded by triggers) or the service role after `requireRole`.
  Owner-only table writes (menu prices, products, stock, settings, order rules) also work with the owner's JWT.
  **Order writes and blocklist deletes only ever happen through the functions or service role.**

## Table ordering (20261026000001, 20261026000002)

Dine-in ordering from `/menu` (data-model decision 22, ADR 0002 rev 2, api-contract **2.2.0** section 9). Pinned by
`tests/database/table_ordering.test.sql` (13 groups). TypeScript shapes: `types/db.ts` (`TableSessionView`,
`AdminTableSession`, `TableBoardResult`, `StatsTableOrders`, ...).

**Access.** Seven new tables (`cafe_tables`, `table_sessions`, `table_orders`, `table_order_items`, `table_board_state`,
`admin_alerts`, `alert_deliveries`) and the view `table_occupancy`: RLS on with no policies, nothing for anon or
authenticated (table or column). Nothing is added to Realtime. **Every write goes through a function:** a guard
trigger refuses any INSERT / UPDATE / DELETE (service role included, SQLSTATE `42501`) unless the transaction-local
flag `app.table_write = 'on'` is set, which only the functions do. `site_settings.table_ordering` has the same
guard: only `set_table_ordering()` can change it, so **`updateSettings` must never send `table_ordering`** (it gets
`42501`). Reads: `GET /api/menu` reads `table_occupancy` (`number, label, occupied`) with the service role; everything
else is an RPC. `order_rules.staff_cancel_window_minutes` (0..60, default 10) and `order_rules.owner_alert_whatsapp`
(0..3 `+97797/98XXXXXXXX`) are ordinary owner settings (`updateSettings`); the CHECK names are
`order_rules_staff_cancel_window_range` and `order_rules_owner_alert_whatsapp_valid`.

### RPCs (all `service_role` only, SECURITY DEFINER, `search_path = ''`)

| RPC | Role | Returns |
|---|---|---|
| `list_cafe_tables(p_actor uuid)` | S | `{ rows: CafeTable[], mode }` |
| `save_cafe_tables(p_tables jsonb, p_actor uuid)` | O | `{ rows: CafeTable[] }` (the FULL set; left-out tables deleted, or deactivated if they have history) |
| `set_table_ordering(p_mode text, p_actor uuid)` | O; S only `on` <-> `paused` | `text` (the mode) |
| `open_table_session(p_table_id uuid, p_actor uuid)` | S | `AdminTableSession` |
| `rotate_table_code(p_session_id uuid, p_actor uuid)` | S | `AdminTableSession` (new code, `cookie_epoch + 1`, bill kept) |
| `set_table_orders_locked(p_session_id uuid, p_locked boolean, p_actor uuid)` | S | `AdminTableSession` |
| `join_table_session(p_table_number integer, p_code text)` | guest (after Turnstile) | `{ sessionId, epoch, view: TableSessionView }` |
| `table_session_guest_view(p_session_id uuid, p_epoch smallint, p_since integer default null)` | guest (cookie) | `TableGuestState` |
| `create_table_order(p_session_id uuid, p_epoch smallint, p_client_request_id uuid, p_items jsonb, p_note text default null)` | guest (cookie) | `{ round, replayed, session: TableSessionView }` |
| `transition_table_order(p_order_id uuid, p_to text, p_reason text, p_actor uuid)` | S; accepted rounds: S inside the window, else O | `AdminTableRound` |
| `close_table_session(p_session_id uuid, p_outcome text, p_paid_via text, p_expected_total integer, p_actor uuid)` | S; O to void (or close at 0) after any acceptance | `ClosedTableSummary` |
| `table_board(p_since text, p_actor uuid)` | S | `TableBoardResult` (`{changed:false, cursor, serverTime}` when `p_since` = cursor) |
| `auto_close_stale_table_sessions()` | pg_cron | `{ closed, failed, ranAt }` |
| `stats_table_orders(p_from date, p_to date, p_actor uuid)` | O | `StatsTableOrders` |
| `record_admin_alert(p_kind text, p_data jsonb)` | backend (failed-join threshold) | `uuid`; only `table_join_fail`, data `{ tableNumber: 1..99 \| null, failures }` |
| `mark_admin_alerts_read(p_ids uuid[], p_all boolean, p_actor uuid)` | O | `integer` (unread left) |
| `claim_alert_deliveries(p_channel text, p_limit integer)` | notifier | `setof jsonb` `{ alertId, kind, text, createdAt }` |
| `finish_alert_delivery(p_alert_id uuid, p_channel text, p_ok boolean, p_error text)` | notifier | `void` |

`p_epoch` is a **smallint**: supabase-js sends a JSON number, which is fine. From SQL, cast (`1::smallint`).
`purge_personal_data()` now also deletes `admin_alerts` older than 180 days (deliveries cascade) and returns `alertsDeleted`.

**Error protocol:** as `create_order` (P0001; `message` = code; `details` = JSON field errors; `hint` = the exact
safe text of api-contract 9.3 to 9.10a). New codes: `TABLE_SESSION_INVALID` (closed, unknown, 12 h old, or a wrong
epoch) and `TABLE_ORDERS_PAUSED` (mode `paused`, or the table is locked: the `hint` says which). The typed code never
appears in any message, detail or hint. Field-error keys: `tables.N.number|label|id|isActive`, `mode`, `code`,
`items`, `items.N`, `note`, `clientRequestId`, `reason`, `paidVia`, `outcome`, `expectedTotal`, `locked`, `kind`,
`data`, `ids`, `channel`, `limit`, `range`.

**Order of checks in `create_table_order`:** session (open, under 12 h, epoch, row lock) -> **replay** (same id and
same fingerprint = the original round, `replayed: true`, nothing bumped; same id, different body = CONFLICT; id used
in another session = VALIDATION) -> mode / table lock -> input (lines merged by item + SET of options) -> 6 rounds per
10 min (RATE_LIMITED, `retryAfterSeconds`) -> 3 waiting as `new` -> 30 not-cancelled / 60 total -> menu
(VALIDATION `items.N`) -> sold out (OUT_OF_STOCK) -> Rs. 20,000 cap -> insert. A duplicate-key race on the request id
is answered as the replay, never INTERNAL.

**Staff cancel window (2.2.0).** Staff cancel `new` rounds freely. An accepted round (`preparing` / `served`) only
while `now() <= accepted_at + staff_cancel_window_minutes` and the window is above 0; after that FORBIDDEN, hint
"Only the owner can cancel this order now. The kitchen accepted it more than N minutes ago.". Voiding, or a staff paid
close at Rs. 0, after any round was ever accepted is owner only. `AdminTableRound.staffCanCancelUntil` gives the board
the deadline.

**Owner alerts (2.2.0).** Written in the same transaction as the event: every void (`table_void`), every cancel of an
accepted round (`table_round_cancelled_after_accept`), every expiry with a bill above 0 (`table_expired_with_bill`);
plus `table_join_fail` from the backend via `record_admin_alert` when the failed-join counters
(`rate_limit_hit_info('table-join-fail:global', 3600, 50)` / `('table-join-fail:table:<n>', 3600, 20)`) first go over.
`text` is one fixed-wording English line (amounts via `fmt_npr`, e.g. "Table 1 voided by Sita (Rs. 200, 1 accepted
round)."); `data` has the structured copy. Never a code, note or phone. The Alerts view reads `admin_alerts` with
the service role (owner checked by `requireRole('owner')`); `readByName` joins `profiles`. No Telegram anywhere.
Delivery: `claim_alert_deliveries` hands out alerts of the last 24 h with no row, a `failed` row under 3 attempts, or
a `sending` row older than 5 minutes (FOR UPDATE SKIP LOCKED); `finish_alert_delivery` records `sent` / `failed`
(3 attempts max). Alerts older than 24 h are never claimed: map "no delivery row and older than 24 h" to `failed` in
the UI.

### Lock order (deadlock-free)
Every table writer first runs `select 1 from table_board_state for update` (serialises all table-ordering writes;
milliseconds each), then locks `cafe_tables` rows, then the `table_sessions` row, then `table_orders` rows. Readers take
no locks. A writer that changed something bumps `table_board_state.version` once and `rev` on each session it touched;
the board cursor is `version-YYYYMMDD` (Kathmandu date). The four alert RPCs touch only the alert tables and do not
take the board lock (a code-guessing flood must not stall the staff board).

### Cron and the manual fallback
`cafe-table-sessions-expire` runs `select public.auto_close_stale_table_sessions()` every 15 minutes (pg_cron; same
guarded block as the auto-cancel job). It closes sessions open for 12 h or more: `new` rounds become `cancelled`
(`session_closed`), `preparing` rounds become `served` and stay on the bill, outcome `expired`. **If pg_cron is
missing** the migration only prints a NOTICE: devops must then call `rpc('auto_close_stale_table_sessions')` with the
service key every 15 minutes from a scheduled job (the same job that calls `auto_cancel_unconfirmed_orders`). Guests
are not exposed meanwhile: join, guest view and rounds all refuse a session older than 12 h on their own. Check:
`select jobname, schedule from cron.job;`.

### pg_safeupdate regression check (run it after every migration that adds or edits a writer)
Supabase preloads `pg_safeupdate` for API sessions (role `authenticator`: `session_preload_libraries = supautils,
safeupdate`; hosted does the same). It refuses any UPDATE or DELETE **without a WHERE clause** (SQLSTATE `21000`),
also inside SECURITY DEFINER functions. psql and `supabase test db` connect as `postgres` and do not load it, so pgTAP
cannot see this. `20261026000003_table_ordering_safeupdate.sql` fixed the two cases (`private.table_board_bump()`,
`set_table_ordering()`; both single-row tables use `where id`). Rule: **every UPDATE / DELETE in a function gets a WHERE**
(`where id` on the single-row tables).

Check (local stack must be running; one transaction, rolled back, keeps nothing):
```bash
sh supabase/checks/run-safeupdate-check.sh     # from engineering/app; exit 0 and "PASSED (34 steps ...)" = good
```
It logs in as `authenticator` over TCP, switches to `service_role`, first proves safeupdate is active (a WHERE-less
UPDATE on a temp table must give 21000, else the run is INVALID), then calls every table-ordering writer and the older
API writers, and asserts the end state. It needs one owner and one staff row in `public.profiles` (the local QA users).
Not run in `supabase test db` on purpose (it needs a different login role).

### Seed
`seed.sql` adds 8 PLACEHOLDER tables (1..8, no labels) and sets `table_ordering = 'on'` in the seed only (the
migration default is `off`). No sessions are seeded (a known code would be a free pass on staging).

### Where the build differs from the spec text (flagged to tech-lead)
1. **Profile deletion vs the write guard.** `opened_by` / `closed_by` / `cancelled_by` / `read_by` are `ON DELETE SET
   NULL`, and Postgres runs that as an UPDATE through the guard. As specified, deleting any staff login that ever
   touched a table would fail with 42501. The guard therefore lets an UPDATE through without the flag when the only
   change is an actor column going to NULL (tested).
2. **Additions (stricter):** `cafe_tables_label_plain` (labels are shown to every guest: same plain-text rule as notes);
   the `app.table_write` guard also on `admin_alerts` and `alert_deliveries` (the spec only asks for immutability).
3. **The data-model helper paragraph** still says "staff may cancel only `new`" (2.1.0). The 2.2.0 window (function
   table, api-contract 9.6 / 9.10a) is what is built.
4. **The alert RPCs do not take the board lock** (the lock-order paragraph says "every writer"). They touch only the
   alert tables, so no deadlock is possible, and `record_admin_alert` must not let a code-guessing flood stall the board.
5. Note / label / alert-text regexes start at `\x01` (Postgres text cannot hold U+0000, so this is the same rule).
6. `save_cafe_tables`: a new row that takes the number of a left-out table with history (which keeps its number,
   deactivated) is VALIDATION `tables.N.number` (the spec does not say).
7. `purge_personal_data()` returns an extra key, `alertsDeleted`. A closed session's `bill.serviceChargePct` is the
   current setting (the percentage is not snapshotted; the amounts are).
8. A change of `staff_cancel_window_minutes` through `updateSettings` does not bump the board cursor, so an idle board
   shows the old `staffCanCancelUntil` until the next table change. The database still decides at cancel time.
9. `claim_alert_deliveries` marks a `sending` row that can no longer be retried (3 attempts, or the alert is over
   24 h old) as `failed` (`last_error = 'expired'`). An alert that is over 24 h old with no row is never claimed.
10. Not testable in one pgTAP session (no second connection): two parallel `claim_alert_deliveries` callers, and a
    real concurrent duplicate `clientRequestId` reaching the `unique_violation` handler.

## Free-tier notes

- **pg_cron:** Supabase Free includes it. Migration 10 enables it and schedules `cafe-daily-purge` (03:00 Nepal =
  21:15 UTC) running `purge_personal_data()`, which also sweeps expired blocklist rows and old `rate_limits` windows. If
  the extension is unavailable the migration still succeeds with a NOTICE; then schedule a GitHub Actions job that calls
  `rpc('purge_personal_data')` with the service key (`devops-engineer`). Check it ran: `select * from cron.job_run_details
order by start_time desc limit 5;`. The locally run stack also ships pg_cron.
- **Auto-cancel job:** migration `20261021000004` schedules `cafe-auto-cancel-unconfirmed` every 5 minutes, running
  `auto_cancel_unconfirmed_orders()`. Same fallback as the purge: if pg_cron is missing the migration only prints a
  NOTICE, and devops must call `rpc('auto_cancel_unconfirmed_orders')` with the service key every 5 to 15 minutes
  from a scheduled job. Check: `select jobname, schedule from cron.job;`.
- `rate_limit_hit` also deletes its own key's expired windows, so the table stays small even if cron is off.
- **Storage size guard (SEC-018):** migration `20261021000005` tries to add trigger `public_media_object_guard` on
  `storage.objects` (per-width byte caps 40/120/300 KB using the size Storage measured, plus WebP MIME). Hosted
  Supabase may refuse a trigger on the platform-owned storage schema; then the migration prints a NOTICE and the
  backend's post-upload check (size + `RIFF....WEBP` magic bytes) is the only control. Check:
  `select tgname from pg_trigger where tgrelid = 'storage.objects'::regclass;`. The trigger can never check magic
  bytes (the bytes are not stored in Postgres), so the backend check is needed either way.
  **BUG-016 (fixed by `20261023000001`):** storage-api 1.82 runs a permission dry-run (rolled-back INSERT) on every
  sign and upload request, with the *request's* declared `{mimetype, contentLength}` and no `size`; only the final row
  carries the measured `size`. The guard now checks only rows that have `size`, so the dry-run passes. A refusal is
  SQLSTATE 42501 with a `public-media: ...` message; storage-api answers HTTP 400 with body
  `{"statusCode":"403","code":"AccessDenied","message":"public-media: 480 px image is N bytes, the limit is 40960 bytes"}`
  (was a 500 "database error, code: 23514"). A PNG sent as `image/png` is refused earlier by the bucket allow-list.
  Regression test through storage-api: `pnpm test` with a local stack running (`tests/integration/storage-upload.test.ts`).
- Free projects have **no backups** and pause after 7 idle days: see architecture sections 7 and 8 (weekly encrypted
  `pg_dump`, keep-alive).
- Realtime publishes only `menu_items`, `menu_variants`, `menu_specials`, `site_settings`, `orders`. `orders` events
  reach only staff/owner sessions (RLS). Product stock is not published. No table-ordering table is published.
- **Table sessions expiry job:** `cafe-table-sessions-expire` every 15 minutes (see "Table ordering"). Same NOTICE
  fallback as the other jobs: schedule `rpc('auto_close_stale_table_sessions')` with the service key if pg_cron is missing.

## Types

Two files:

- `types/database.generated.ts`: **generated** from the local DB. Regenerate after every migration:
  ```bash
  pnpm exec supabase gen types typescript --local > supabase/types/database.generated.ts
  pnpm exec prettier --write supabase/types/database.generated.ts
  ```
- `types/db.ts`: **hand-written** (copy in `src/types/db.ts`, which the app imports; **2026-10-24: `supabase/types/db.ts` is ahead by the menu `translations` types (`MenuTranslationLang`, `MenuItemTranslations`, `MenuCategoryTranslations`, `MenuVariantTranslations` + the three row fields); backend to copy it over. The 2026-10-23 `size_rank` copy is done. 2026-10-25: also ahead by `IsoDate`, `DailySalesRow`, `DailySalesLineRow`, `DailySalesLineInput`, `UpsertDailySalesArgs`, `DailySalesLog(Line)`, the `Stats*` types and their `Database` entries; backend to copy**). Kept because it is
  narrower than what the generator can see. The app's Supabase clients are not typed with a `Database` generic today; the
  app imports only the row interfaces and unions.

Checked 2026-10-23: every table, column, view column, RPC and argument name matches. The differences:

| # | Where | Generated | Hand-written `db.ts` | Matters? |
|---|---|---|---|---|
| 1 | `rate_limits` table | present | **missing** from `Database.Tables` (no `RateLimitRow`) | Yes, if the clients ever get typed: the backend uses `.from("rate_limits")` directly |
| 2 | `Database` shape | `Row` / `Insert` / `Update` / `Relationships` per table, `Enums`, `CompositeTypes`, `graphql_public` schema | `Row` only | Yes: `db.ts`'s `Database` cannot be passed to `createClient<Database>()`. Use the generated one for that |
| 3 | CHECK-constrained text columns (`role`, `diet`, `tags`, `kind`, `status`, `fulfilment`, `payment_method`, `payment_status`, `cancel_reason`, `payment_methods_enabled`) | `string` / `string[]` | string-literal unions | No: generator cannot read CHECKs; `db.ts` is stricter and correct |
| 4 | `product_variants.stock_state` (generated column) | `string \| null` | `StockState`, non-null | No: `stock` is NOT NULL, so it is never null |
| 5 | `public_settings` view | every column nullable; `vat_pct: number` | non-null (from `site_settings`); `vat_pct: 13` | No: Postgres reports all view columns as nullable |
| 6 | jsonb `hours`, `features`, `details` | `Json` | structured objects | No: `db.ts` is stricter |
| 7 | single-row `id` (`site_settings`, `order_rules`) | `boolean` | `true` | No |
| 8 | Optional RPC args (`create_order` `p_customer_email`... `p_ip_hash`, `set_order_status` `p_reason`) | `string` (no `null`) | `string \| null` | Minor: passing `null` works at runtime; with generated types use `undefined` |
| 9 | `create_order.p_items` | `Json` | `{ variantId, qty }[]` | No |
| 10 | Returns of `auto_cancel_unconfirmed_orders`, `purge_personal_data` | `Json` | structured objects | No |
| 11 | `current_app_role` return | `string` | `Role \| null` | No: `db.ts` is right (no profile returns NULL) |
| 12 | `set_order_status` / `cancel_order` / `customer_cancel_order` | single `orders` row (`SetofOptions`, one-to-one) | `OrderRow` | Same |
| 13 | No-arg RPCs | `Args: Record<PropertyKey, never>` | `Record<string, never>` | No |
| 14 | `product_variants.size_rank` (generated column, 2026-10-23) | `number \| null`; `Insert`/`Update` `never` | `number`, non-null | No: `size` is NOT NULL and the CASE always returns a value |
| 15 | `translations` on `menu_items` / `menu_categories` / `menu_variants` (2026-10-24) | `NonNullable<Json>` | `MenuItemTranslations` / `MenuCategoryTranslations` / `MenuVariantTranslations` (keyed by `MenuTranslationLang`) | No: generator cannot read the CHECK; `db.ts` is stricter |
| 16 | Returns of `upsert_daily_sales`, `get_daily_sales`, `stats_*` (2026-10-25) | `Json` | `DailySalesLog` (\| `null`), `StatsOverview`, `StatsTimeseries`, `StatsTopFood`, `StatsBestFoodPerDay`, `StatsTopMerch`, `StatsBusyHeatmap`, `StatsCancellations`, `StatsStockAlerts` | No: jsonb returns; `db.ts` carries the contract |
| 17 | `p_actor` on the new RPCs | optional (`p_actor?: string`, it has a SQL default) | required `Uuid` | No: null is FORBIDDEN at runtime |
| 18 | `daily_sales_lines.line_total_paisa` (generated) | `number \| null` | `Paisa`, non-null | No: `qty` and `unit_price_paisa` are NOT NULL |
| 19 | Date columns / args (`business_date`, `p_from` ...) | `string` | `IsoDate` (alias of `string`) | No |
| 20 | Table ordering (2026-10-25): the generated file is **hand-updated** in the generator's format (migrations not applied locally) | `Json` results, `string` CHECK columns | contract shapes (`AdminTableSession`, `TableGuestState`, ...), literal unions | Regenerate after `migration up`; differences should be only formatting |
| 21 | `p_epoch` (smallint) | `number` | `number` | No |
| 22 | `claim_alert_deliveries` (setof jsonb) | `Json[]` | `ClaimedAlert[]` | No |

## Rules for future migrations

- New file, new timestamp. Never edit an applied migration.
- Every new table: `enable row level security`, `revoke all ... from anon, authenticated`, then explicit grants and
  policies. Default privileges are already revoked for anon/authenticated, so forgetting a grant fails closed.
- Every new function: `revoke all on function ... from public, anon, authenticated`, then grant to the intended role.
  Since `20261021000001` a function created by `postgres` is no longer executable by PUBLIC by default (any schema
  except `extensions`), so a forgotten grant fails closed too. `rls.test.sql` pins the anon-callable list
  (`health_ping`, `current_app_role`, `is_staff`, `is_owner`); adding an anon-callable function means updating it.
- A function used inside a CHECK constraint or a policy now needs an explicit EXECUTE grant for the roles that write
  the table (there is no implicit PUBLIC grant any more). The 2026-10-21 constraints use plain expressions and
  jsonpath for that reason. `20261024000001` uses `private.menu_translations_valid()` in its CHECKs and grants
  EXECUTE to `authenticated` and `service_role` (staff sold-out toggles re-check the row too, so `authenticated`
  needs it). A pgTAP case pins that grant.
- If you change an API shape, tell `tech-lead` first (contract rule).

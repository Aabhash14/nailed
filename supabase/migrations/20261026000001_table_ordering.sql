-- 20261026000001_table_ordering.sql
-- Table ordering (dine-in), data-model decision 22 (revised for api-contract 2.1.0 and 2.2.0), ADR 0002 rev 2,
-- api-contract 2.2.0 section 9. Part 1: schema. Part 2 (functions, grants, pg_cron job, purge change) is
-- 20261026000002_table_ordering_functions.sql.
--
--   site_settings.table_ordering             'off' | 'on' | 'paused' (public; default 'off'). Only set_table_ordering()
--                                            can change it (guard trigger, SEC-029)
--   order_rules.staff_cancel_window_minutes  staff may cancel an ACCEPTED round within this many minutes (0..60, default
--                                            10; owner via updateSettings; 2.2.0)
--   order_rules.owner_alert_whatsapp         0..3 Nepal mobiles for the (future, off) WhatsApp alert adapter (2.2.0)
--   cafe_tables                              the cafe's tables, numbers 1..99
--   table_sessions                           one party at a table: staff open it (6-character code), staff close it
--                                            (paid / void), or the system closes it after 12 h (expired)
--   table_orders                             a "round" (API name): one batch of items a guest sends
--   table_order_items                        round lines, price/name snapshot, immutable
--   table_board_state                        single-row change counter for the staff board's change-only feed
--   table_occupancy (view)                   number / label / occupied for GET /api/menu (service role only)
--   admin_alerts, alert_deliveries           owner alerts, stored in the same transaction as the event (2.2.0; no
--                                            Telegram; delivery adapters such as WhatsApp are optional and off)
--
-- Security model: RLS on with NO policies and nothing granted to anon or authenticated (table or column) on any of
-- the new tables or the view. The service role keeps the platform default privileges (as rate_limits), but write
-- guard triggers refuse every INSERT / UPDATE / DELETE unless the transaction-local flag app.table_write = 'on',
-- which only the table functions set. So even a stray service-role `update table_sessions ...` from app code fails
-- with 42501. Nothing here is added to the Realtime publication. No guest personal data is stored.
-- Money is integer paisa. Timestamps are timestamptz.

-- ---------------------------------------------------------------------------
-- Columns on existing tables
-- ---------------------------------------------------------------------------
alter table public.site_settings
  add column table_ordering text not null default 'off'
    constraint site_settings_table_ordering_valid check (table_ordering in ('off', 'on', 'paused'));
comment on column public.site_settings.table_ordering is
  'Table ordering mode (decision 22): off = hidden, on = guests can join and order, paused = guests can join but not '
  'send rounds (TABLE_ORDERS_PAUSED). Public. Changed only by set_table_ordering() (guard trigger).';

-- public_settings gains table_ordering, appended last (CREATE OR REPLACE VIEW can only add columns at the end).
-- security_invoker must be restated or the replace drops it. Existing grants on the view are kept.
create or replace view public.public_settings with (security_invoker = true) as
  select cafe_name, hours, announcement, phone, whatsapp, email, address, landmark, map_url,
         prices_include_vat, service_charge_pct, 13::integer as vat_pct,
         delivery_fee_paisa, delivery_areas,
         min_order_delivery_paisa, min_order_pickup_paisa,
         payment_methods_enabled, features, updated_at,
         orders_paused,
         table_ordering
  from public.site_settings;

-- Every element a Nepal mobile in +977 form. IMMUTABLE, used in a CHECK; since SEC-007 every role that writes
-- order_rules (owner JWT = authenticated, service role) needs EXECUTE on it.
create or replace function private.nepal_mobiles_valid(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and array_position(p, null) is null
     and not exists (select 1 from unnest(p) as x where x !~ '^\+977(97|98)[0-9]{8}$')
$$;
revoke all on function private.nepal_mobiles_valid(text[]) from public, anon, authenticated;
grant execute on function private.nepal_mobiles_valid(text[]) to authenticated, service_role;

alter table public.order_rules
  add column staff_cancel_window_minutes smallint not null default 10
    constraint order_rules_staff_cancel_window_range check (staff_cancel_window_minutes between 0 and 60),
  add column owner_alert_whatsapp text[] not null default '{}'
    constraint order_rules_owner_alert_whatsapp_valid
    check (cardinality(owner_alert_whatsapp) <= 3 and private.nepal_mobiles_valid(owner_alert_whatsapp));
comment on column public.order_rules.staff_cancel_window_minutes is
  'Table ordering (2.2.0): staff may cancel an accepted (preparing / served) round while now <= accepted_at + this '
  'many minutes; after that, and always when 0, only the owner. 0..60, default 10. Owner via updateSettings.';
comment on column public.order_rules.owner_alert_whatsapp is
  'Owner alert recipients for the optional WhatsApp adapter (2.2.0, off until approved): 0..3 numbers, +97797/98XXXXXXXX.';
-- NOTE: there is deliberately no order_rules.table_order_alerts (removed in 2.2.0: no per-round ping).

-- ---------------------------------------------------------------------------
-- cafe_tables
-- ---------------------------------------------------------------------------
create table public.cafe_tables (
  id          uuid primary key default gen_random_uuid(),
  number      smallint not null check (number between 1 and 99),
  label       text check (label is null or char_length(label) between 1 and 40),   -- stored trimmed; blank = null
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Deferrable so save_cafe_tables can swap two numbers inside one transaction.
  constraint cafe_tables_number_key unique (number) deferrable initially immediate,
  -- ADDITION (not in the spec, flagged to tech-lead): labels are shown to every guest, so the same "plain text" rule
  -- as round notes (no control characters, no bidi overrides). save_cafe_tables answers VALIDATION before this fires.
  constraint cafe_tables_label_plain check (label !~ '[\x01-\x1F\x7F-\x9F‪-‮⁦-⁩]')
);
comment on table public.cafe_tables is
  'The cafe''s tables (decision 22). Edited as a full set by save_cafe_tables(). A table that ever had a session is '
  'deactivated, never deleted.';

-- ---------------------------------------------------------------------------
-- table_sessions
-- ---------------------------------------------------------------------------
create table public.table_sessions (
  id                    uuid primary key default gen_random_uuid(),
  table_id              uuid not null references public.cafe_tables (id) on delete restrict,
  table_number          smallint not null,                       -- snapshot at open; history survives renumbering
  status                text not null default 'open' check (status in ('open', 'closed')),
  code                  text check (code is null or code ~ '^[2-9A-HJKMNP-Z]{6}$'),   -- plaintext while open, null after
  -- 2.1.0 (SEC-023): +1 on every rotate_table_code(). Guest cookies carry it; every guest function compares it, so a
  -- new code ends every cookie issued before. Rounds and the bill are kept.
  cookie_epoch          smallint not null default 1 check (cookie_epoch between 1 and 32767),
  -- 2.1.0 (SEC-023): staff "stop app orders for this table"; cleared on close.
  orders_locked         boolean not null default false,
  rev                   integer not null default 1 check (rev >= 1),
  opened_by             uuid references public.profiles (id) on delete set null,
  opened_at             timestamptz not null default now(),
  closed_by             uuid references public.profiles (id) on delete set null,
  closed_at             timestamptz,
  outcome               text check (outcome in ('paid', 'void', 'expired')),
  paid_via              text check (paid_via in ('cash', 'fonepay', 'other')),
  prices_include_vat    boolean,                                 -- snapshot at close
  subtotal_paisa        integer check (subtotal_paisa >= 0),       -- snapshot at close
  service_charge_paisa  integer check (service_charge_paisa >= 0), -- snapshot at close
  vat_paisa             integer check (vat_paisa >= 0),            -- snapshot at close
  total_paisa           integer check (total_paisa >= 0),          -- snapshot at close
  updated_at            timestamptz not null default now(),
  constraint table_sessions_code_iff_open check ((status = 'open') = (code is not null)),
  constraint table_sessions_closed_fields check (
    (status = 'closed') = (closed_at is not null and outcome is not null and subtotal_paisa is not null
                           and service_charge_paisa is not null and vat_paisa is not null and total_paisa is not null
                           and prices_include_vat is not null)),
  -- outcome is null on an open row: (null = false) is null, which passes. That is intended.
  constraint table_sessions_paid_via check ((outcome = 'paid') = (paid_via is not null)),
  constraint table_sessions_total_matches check (
    status = 'open'
    or total_paisa = subtotal_paisa + service_charge_paisa + case when prices_include_vat then 0 else vat_paisa end),
  constraint table_sessions_unlocked_when_closed check (status = 'open' or not orders_locked)
);
comment on table public.table_sessions is
  'One party at one table (decision 22). Service role only, through the table functions. code is the 6-character join '
  'code, plaintext while open and erased at close (ADR 0002 option 2). rev goes up on every change to the session or '
  'its rounds; cookie_epoch on every code change.';

create unique index table_sessions_one_open_per_table on public.table_sessions (table_id) where status = 'open';
create index table_sessions_open_opened_idx on public.table_sessions (opened_at) where status = 'open';   -- expiry job
create index table_sessions_closed_at_idx on public.table_sessions (closed_at desc) where status = 'closed';  -- closed today, stats
create index table_sessions_table_id_idx on public.table_sessions (table_id);   -- FK (RESTRICT check), hasHistory

-- ---------------------------------------------------------------------------
-- table_orders ("rounds" in the API)
-- ---------------------------------------------------------------------------
create table public.table_orders (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid not null references public.table_sessions (id) on delete restrict,
  -- 2.1.0 (SEC-023): the cap of 30 counts rounds that are NOT cancelled; 60 is the hard limit including cancelled ones.
  round                smallint not null check (round between 1 and 60),
  client_request_id    uuid not null,
  -- 2.1.0 (SEC-027): SHA-256 hex of the canonical merged lines + normalised note. A replay with another body is refused.
  request_fingerprint  text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status               text not null default 'new' check (status in ('new', 'preparing', 'served', 'cancelled')),
  -- 2.1.0 (SEC-029): one line of plain text: no control characters (newline included), no bidi overrides.
  note                 text check (note is null or (char_length(note) between 1 and 200
                                                    and note !~ '[\x01-\x1F\x7F-\x9F‪-‮⁦-⁩]')),
  subtotal_paisa       integer not null check (subtotal_paisa between 0 and 2000000),
  cancel_reason        text check (cancel_reason in ('guest_request', 'unavailable', 'mistake', 'other', 'session_closed')),
  cancelled_by         uuid references public.profiles (id) on delete set null,
  created_at           timestamptz not null default now(),
  -- 2.1.0 (SEC-022): set on the FIRST move out of 'new' (to preparing, or straight to served) and never cleared. It
  -- is the "ever accepted" fact the owner-only rules use.
  accepted_at          timestamptz,
  served_at            timestamptz,
  cancelled_at         timestamptz,
  updated_at           timestamptz not null default now(),
  constraint table_orders_session_round_key unique (session_id, round),
  constraint table_orders_session_request_key unique (session_id, client_request_id),
  constraint table_orders_cancel_reason_iff_cancelled check ((status = 'cancelled') = (cancel_reason is not null)),
  constraint table_orders_timestamps check ((status <> 'served' or served_at is not null)
                                            and (status <> 'cancelled' or cancelled_at is not null)),
  constraint table_orders_accepted check (status not in ('preparing', 'served') or accepted_at is not null),
  -- The system only ever cancels rounds that were never accepted.
  constraint table_orders_session_closed_only_unaccepted check (cancel_reason is distinct from 'session_closed'
                                                                or accepted_at is null)
);
comment on table public.table_orders is
  'A round: one batch of items a guest sent from the table (decision 22). Status changes only through '
  'private.transition_table_round(). Never deleted.';

-- Global: a clientRequestId reused in another session is detectable (create_table_order answers VALIDATION).
create unique index table_orders_client_request_id_key on public.table_orders (client_request_id);
create index table_orders_created_idx on public.table_orders (created_at);                       -- stats, 10-minute cap
create index table_orders_live_idx on public.table_orders (session_id) where status in ('new', 'preparing');

-- ---------------------------------------------------------------------------
-- table_order_items (immutable after insert)
-- ---------------------------------------------------------------------------
-- variant_refs must be sorted ascending with no nulls and no duplicates (the merge key of create_table_order).
-- IMMUTABLE SQL, used in a CHECK (SEC-007: explicit EXECUTE for the writing role).
create or replace function private.uuid_array_is_sorted_set(p uuid[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and array_position(p, null) is null
     and p = coalesce(array(select distinct u from unnest(p) as u order by u), '{}'::uuid[])
$$;
revoke all on function private.uuid_array_is_sorted_set(uuid[]) from public, anon, authenticated;
grant execute on function private.uuid_array_is_sorted_set(uuid[]) to service_role;

create table public.table_order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.table_orders (id) on delete cascade,
  line_no           smallint not null check (line_no between 1 and 20),
  menu_item_ref     uuid not null,                       -- menu_items.id, NO foreign key (items soft-delete, variants hard-delete)
  variant_refs      uuid[] not null default '{}' check (cardinality(variant_refs) <= 4),
  name_snapshot     text not null check (char_length(name_snapshot) between 1 and 80),
  options_snapshot  text check (options_snapshot is null or char_length(options_snapshot) between 1 and 300),
  unit_price_paisa  integer not null check (unit_price_paisa between 0 and 2000000),
  qty               smallint not null check (qty between 1 and 20),
  line_total_paisa  integer generated always as (unit_price_paisa * qty) stored,   -- max 40,000,000: fits int4
  constraint table_order_items_order_line_key unique (order_id, line_no),
  constraint table_order_items_variant_refs_sorted check (private.uuid_array_is_sorted_set(variant_refs))
);
comment on table public.table_order_items is
  'Lines of a round: snapshot of the English name, option labels and unit price at send time. Immutable.';
comment on column public.table_order_items.variant_refs is 'menu_variants ids chosen, sorted ascending, no FK.';

create index table_order_items_item_idx on public.table_order_items (menu_item_ref);   -- stats

-- ---------------------------------------------------------------------------
-- table_board_state: the board's change cursor (single row)
-- ---------------------------------------------------------------------------
create table public.table_board_state (
  id          boolean primary key default true check (id),
  version     bigint not null default 0,
  changed_at  timestamptz not null default now()
);
comment on table public.table_board_state is
  'Single row. version goes up on every table-ordering write (tables, sessions, rounds, mode). The staff board polls '
  'with the last cursor and gets {changed:false} while it is unchanged. Every writer locks this row first (lock order).';

insert into public.table_board_state default values;   -- before the write guard exists

-- ---------------------------------------------------------------------------
-- admin_alerts + alert_deliveries (2.2.0). Owner alerts are rows written by the database in the same transaction as
-- the event. The in-app Alerts view reads them (service role after requireRole('owner')). Delivery adapters (only
-- WhatsApp is specified, OFF until Aabhash approves) claim them with claim_alert_deliveries(). No Telegram.
-- Never a table code, a note, a phone number or guest data.
-- ---------------------------------------------------------------------------
create table public.admin_alerts (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('table_void', 'table_round_cancelled_after_accept', 'table_expired_with_bill',
                                            'table_join_fail')),
  -- One English line built by the database from fixed wording (also the WhatsApp template parameter).
  text        text not null check (char_length(text) between 1 and 200 and text !~ '[\x01-\x1F]'),
  data        jsonb not null default '{}'::jsonb
                check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 2000),
  session_id  uuid references public.table_sessions (id) on delete set null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  read_by     uuid references public.profiles (id) on delete set null
);
comment on table public.admin_alerts is
  'Owner alerts (2.2.0). Immutable except read_at / read_by (mark_admin_alerts_read). Service role only. Deleted by '
  'purge_personal_data() after 180 days.';
create index admin_alerts_created_idx on public.admin_alerts (created_at desc);
create index admin_alerts_unread_idx on public.admin_alerts (created_at desc) where read_at is null;
create index admin_alerts_session_idx on public.admin_alerts (session_id) where session_id is not null;

create table public.alert_deliveries (
  alert_id    uuid not null references public.admin_alerts (id) on delete cascade,
  channel     text not null check (channel in ('whatsapp')),
  status      text not null check (status in ('sending', 'sent', 'failed')),
  attempts    smallint not null default 1 check (attempts between 1 and 3),
  last_error  text check (last_error is null or char_length(last_error) <= 100),   -- HTTP status / provider code only
  claimed_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (alert_id, channel)
);
comment on table public.alert_deliveries is
  'One row per alert per delivery channel (2.2.0). Written only by claim_alert_deliveries() / finish_alert_delivery().';

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger cafe_tables_set_updated_at before update on public.cafe_tables
  for each row execute function public.set_updated_at();
create trigger table_sessions_set_updated_at before update on public.table_sessions
  for each row execute function public.set_updated_at();
create trigger table_orders_set_updated_at before update on public.table_orders
  for each row execute function public.set_updated_at();
create trigger alert_deliveries_set_updated_at before update on public.alert_deliveries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Write guard: every writer goes through a function (they set app.table_write = 'on', transaction-local).
-- Mirrors orders_guard / app.order_transition.
--
-- ONE exception (not in the spec, flagged to tech-lead), needed for staff deletion: opened_by / closed_by /
-- cancelled_by / read_by are ON DELETE SET NULL to profiles, and Postgres runs that FK action as an UPDATE that fires
-- this BEFORE UPDATE trigger. Without the exception, deleting a staff login that ever opened, closed or cancelled
-- anything (or read an alert) would fail with 42501. So an UPDATE without the flag is allowed when the only change is
-- one of those actor columns going to NULL (updated_at excluded: set_updated_at runs first). Same rule as
-- blocked_contacts.created_by and daily_sales.created_by ("may only be cleared").
-- ---------------------------------------------------------------------------
create or replace function private.table_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c_actor_cols constant text[] := array['opened_by', 'closed_by', 'cancelled_by', 'read_by'];
  v_new jsonb;
  v_old jsonb;
begin
  if current_setting('app.table_write', true) is not distinct from 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'UPDATE' and tg_table_name in ('table_sessions', 'table_orders', 'admin_alerts') then
    v_new := to_jsonb(new);
    v_old := to_jsonb(old);
    if (v_new - c_actor_cols - 'updated_at') = (v_old - c_actor_cols - 'updated_at')
       and not exists (select 1 from unnest(c_actor_cols) as c
                        where (v_new -> c) is distinct from (v_old -> c)
                          and (v_new -> c) is distinct from 'null'::jsonb) then
      return new;   -- FK ON DELETE SET NULL from profiles
    end if;
  end if;

  raise exception 'table ordering: write only through the table functions (%.%)', tg_table_name, lower(tg_op)
    using errcode = '42501';
end;
$$;

-- Lines never change after insert (as order_items), whatever the flag says.
create or replace function private.table_order_items_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'table_order_items: lines are immutable' using errcode = '42501';
end;
$$;

-- admin_alerts: kind, text, data, session_id (except the FK going to null) and created_at never change, flag or not.
create or replace function private.admin_alerts_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind
     or new.text is distinct from old.text
     or new.data is distinct from old.data
     or new.created_at is distinct from old.created_at
     or (new.session_id is distinct from old.session_id and new.session_id is not null) then
    raise exception 'admin_alerts: only read_at / read_by can change' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- 2.1.0 (SEC-029): only set_table_ordering() may change the mode (it checks the role rules and "off needs zero open
-- tables", and bumps the board version). Not the owner's own PostgREST session, not updateSettings, not the service
-- role. Other site_settings columns are untouched by this guard.
create or replace function private.site_settings_table_ordering_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.table_ordering is distinct from old.table_ordering
     and current_setting('app.table_write', true) is distinct from 'on' then
    raise exception 'site_settings.table_ordering: change it with set_table_ordering()' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.table_write_guard() from public, anon, authenticated;
revoke all on function private.table_order_items_immutable() from public, anon, authenticated;
revoke all on function private.admin_alerts_immutable() from public, anon, authenticated;
revoke all on function private.site_settings_table_ordering_guard() from public, anon, authenticated;
-- Trigger functions are not callable as RPC; the grants only make sure the firing roles are never refused (SEC-007).
grant execute on function private.table_write_guard() to authenticated, service_role;
grant execute on function private.table_order_items_immutable() to authenticated, service_role;
grant execute on function private.admin_alerts_immutable() to authenticated, service_role;
grant execute on function private.site_settings_table_ordering_guard() to authenticated, service_role;

create trigger cafe_tables_write_guard before insert or update or delete on public.cafe_tables
  for each row execute function private.table_write_guard();
create trigger table_sessions_write_guard before insert or update or delete on public.table_sessions
  for each row execute function private.table_write_guard();
create trigger table_orders_write_guard before insert or update or delete on public.table_orders
  for each row execute function private.table_write_guard();
create trigger table_order_items_write_guard before insert or update or delete on public.table_order_items
  for each row execute function private.table_write_guard();
create trigger table_board_state_write_guard before insert or update or delete on public.table_board_state
  for each row execute function private.table_write_guard();
create trigger admin_alerts_write_guard before insert or update or delete on public.admin_alerts
  for each row execute function private.table_write_guard();
create trigger alert_deliveries_write_guard before insert or update or delete on public.alert_deliveries
  for each row execute function private.table_write_guard();
create trigger table_order_items_immutable_trg before update on public.table_order_items
  for each row execute function private.table_order_items_immutable();
create trigger admin_alerts_immutable_trg before update on public.admin_alerts
  for each row execute function private.admin_alerts_immutable();
create trigger site_settings_table_ordering_guard before update on public.site_settings
  for each row execute function private.site_settings_table_ordering_guard();

-- ---------------------------------------------------------------------------
-- Occupancy for the public menu (read by GET /api/menu with the SERVICE ROLE; anon gets nothing new).
-- Exactly three columns, never the code. Active tables only.
-- ---------------------------------------------------------------------------
create view public.table_occupancy with (security_invoker = true) as
  select t.number,
         t.label,
         exists (select 1 from public.table_sessions s where s.table_id = t.id and s.status = 'open') as occupied
    from public.cafe_tables t
   where t.is_active;
comment on view public.table_occupancy is
  'Public occupancy for GET /api/menu (service role only). number, label, occupied. Never the code.';

-- ---------------------------------------------------------------------------
-- RLS + grants: deny anon and authenticated everything. The service role keeps the platform default privileges.
-- ---------------------------------------------------------------------------
alter table public.cafe_tables       enable row level security;
alter table public.table_sessions    enable row level security;
alter table public.table_orders      enable row level security;
alter table public.table_order_items enable row level security;
alter table public.table_board_state enable row level security;
alter table public.admin_alerts      enable row level security;
alter table public.alert_deliveries  enable row level security;
-- No policies on purpose: anon / authenticated could not read a row even if a grant appeared by mistake.

revoke all on public.cafe_tables, public.table_sessions, public.table_orders, public.table_order_items,
              public.table_board_state, public.admin_alerts, public.alert_deliveries, public.table_occupancy
  from anon, authenticated;
grant select on public.table_occupancy to service_role;

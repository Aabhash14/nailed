-- 20261025000001_daily_sales.sql
-- Daily food sales log for the owner's statistics dashboard. The menu is view-only (no food orders), so at closing
-- staff tap a count per menu item (and optionally the till's cash total for food) for one Kathmandu business day.
--
--   daily_sales        one row per business day (Kathmandu date), optional till total + note, audit columns
--   daily_sales_lines  one row per (day, menu item, variant): qty 0..9999, price snapshot, generated line total
--
-- Money is integer paisa. Business dates are Kathmandu (Asia/Kathmandu, UTC+05:45) calendar dates, never UTC dates.
--
-- Price snapshots are taken by the DATABASE, never from the client: a BEFORE INSERT trigger on daily_sales_lines
-- copies name, variant label and unit price (item price + variant delta, floored at 0) from the menu, whatever the
-- writer sent. After insert the snapshot is immutable (the qty is what changes), so correcting yesterday's count after
-- a price change keeps the price the line was first logged at.
--
-- History survives menu deletes: menu_item_id / variant_id are ON DELETE SET NULL, while menu_item_ref / variant_ref
-- keep the original ids (never nulled) and name_snapshot / variant_label_snapshot keep the text. Uniqueness and all
-- statistics group on the *_ref columns, so a deleted variant can never collide with another line of the same day.
--
-- Access (RLS + grants; anon has nothing):
--   * owner: read/insert/update/delete any day up to today (no future dates).
--   * staff: read/insert/update today and yesterday only (late closing); no deletes.
--   * Writes normally go through upsert_daily_sales() (service role, verified p_actor), which applies the same rules.
-- Audit: created_by / updated_by (profiles, ON DELETE SET NULL) + created_at / updated_at. For JWT writers the
-- trigger forces them to auth.uid(); the RPC passes the verified actor. business_date and created_* are immutable.
--
-- Also adds an index for the statistics RPCs (20261025000002): completed orders by completed_at.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.daily_sales (
  id                uuid primary key default gen_random_uuid(),
  business_date     date not null check (business_date >= date '2020-01-01'),
  till_total_paisa  integer check (till_total_paisa is null or till_total_paisa between 0 and 1000000000),  -- max Rs. 1 crore
  note              text check (note is null or char_length(note) <= 500),
  created_by        uuid references public.profiles (id) on delete set null,
  updated_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint daily_sales_business_date_key unique (business_date)          -- also the index for date-range filters
);
comment on table public.daily_sales is
  'One food sales log per Kathmandu business day (staff, at closing). Lines in daily_sales_lines. Money in paisa.';
comment on column public.daily_sales.business_date is 'Kathmandu calendar date of the trading day.';
comment on column public.daily_sales.till_total_paisa is 'Optional cash total for food from the till (paisa). Not used as revenue; revenue = sum of lines.';

create table public.daily_sales_lines (
  id                      uuid primary key default gen_random_uuid(),
  daily_sales_id          uuid not null references public.daily_sales (id) on delete cascade,
  menu_item_id            uuid references public.menu_items (id) on delete set null,      -- null once the item is hard-deleted
  variant_id              uuid references public.menu_variants (id) on delete set null,   -- null = base item, or variant deleted
  menu_item_ref           uuid not null,                     -- original menu item id, kept after delete (set by trigger)
  variant_ref             uuid,                              -- original variant id or null (set by trigger)
  name_snapshot           text not null check (char_length(name_snapshot) between 1 and 80),
  variant_label_snapshot  text check (variant_label_snapshot is null or char_length(variant_label_snapshot) between 1 and 60),
  qty                     integer not null check (qty between 0 and 9999),
  unit_price_paisa        integer not null check (unit_price_paisa between 0 and 2000000),   -- item max + variant delta max
  line_total_paisa        bigint generated always as (qty::bigint * unit_price_paisa) stored,
  updated_by              uuid references public.profiles (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint daily_sales_lines_one_per_item unique nulls not distinct (daily_sales_id, menu_item_ref, variant_ref),
  constraint daily_sales_lines_item_matches_ref check (menu_item_id is null or menu_item_id = menu_item_ref),
  constraint daily_sales_lines_variant_matches_ref check (variant_id is null or variant_id = variant_ref),
  constraint daily_sales_lines_label_iff_variant check ((variant_ref is null) = (variant_label_snapshot is null))
);
comment on table public.daily_sales_lines is
  'Item counts of one daily_sales day. Price/name are snapshotted from the menu by trigger (never from the client).';
comment on column public.daily_sales_lines.menu_item_ref is 'Original menu_items.id. Never nulled; stats group on it.';
comment on column public.daily_sales_lines.unit_price_paisa is 'Snapshot at first entry: menu_items.price_paisa + menu_variants.price_delta_paisa (>= 0). Set by trigger.';

create index daily_sales_lines_menu_item_idx on public.daily_sales_lines (menu_item_id) where menu_item_id is not null;
create index daily_sales_lines_variant_idx   on public.daily_sales_lines (variant_id)   where variant_id is not null;
create index daily_sales_lines_item_ref_idx  on public.daily_sales_lines (menu_item_ref);

-- Statistics: completed merch orders filtered by completion time (status + created_at is already indexed).
create index if not exists orders_completed_at_idx on public.orders (completed_at) where status = 'completed';

create trigger daily_sales_set_updated_at before update on public.daily_sales
  for each row execute function public.set_updated_at();
create trigger daily_sales_lines_set_updated_at before update on public.daily_sales_lines
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Triggers: audit columns + immutables (daily_sales), price snapshot + immutables (daily_sales_lines)
-- ---------------------------------------------------------------------------
create or replace function private.daily_sales_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());       -- null for the service role / postgres (the RPC passes the actor)
begin
  if tg_op = 'INSERT' then
    if v_uid is not null then
      new.created_by := v_uid;
      new.updated_by := v_uid;
    else
      new.updated_by := coalesce(new.updated_by, new.created_by);
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.business_date is distinct from old.business_date
     or new.created_at is distinct from old.created_at
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception 'daily_sales: business_date, created_by and created_at cannot be changed' using errcode = '42501';
  end if;
  if v_uid is not null then
    new.updated_by := v_uid;
  end if;
  return new;
end;
$$;

create or replace function private.daily_sales_lines_snapshot()
returns trigger
language plpgsql
security definer                          -- reads hidden / soft-deleted menu rows regardless of the writer's RLS
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_item  record;
  v_label text;                            -- variant label (null = no variant)
  v_delta integer := 0;                    -- variant price delta
begin
  if tg_op = 'INSERT' then
    if new.menu_item_id is null then
      raise exception 'daily_sales_lines: menu_item_id is required' using errcode = '23502';
    end if;
    select i.name, i.price_paisa into v_item from public.menu_items i where i.id = new.menu_item_id;
    if not found then
      raise exception 'daily_sales_lines: unknown menu item %', new.menu_item_id using errcode = '23503';
    end if;
    if new.variant_id is not null then
      select v.label, v.price_delta_paisa into v_label, v_delta
        from public.menu_variants v where v.id = new.variant_id and v.item_id = new.menu_item_id;
      if not found then
        raise exception 'daily_sales_lines: variant % does not belong to menu item %', new.variant_id, new.menu_item_id
          using errcode = '23503';
      end if;
    end if;

    -- Snapshot from the menu. Whatever the writer sent in these columns is overwritten.
    new.menu_item_ref          := new.menu_item_id;
    new.variant_ref            := new.variant_id;
    new.name_snapshot          := v_item.name;
    new.variant_label_snapshot := case when new.variant_id is not null then v_label end;
    new.unit_price_paisa       := greatest(v_item.price_paisa + case when new.variant_id is not null then v_delta else 0 end, 0);
    if v_uid is not null then
      new.updated_by := v_uid;
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE: only qty (and the audit columns) change. The FKs may only go to NULL (ON DELETE SET NULL).
  if new.daily_sales_id is distinct from old.daily_sales_id
     or new.menu_item_ref is distinct from old.menu_item_ref
     or new.variant_ref is distinct from old.variant_ref
     or new.name_snapshot is distinct from old.name_snapshot
     or new.variant_label_snapshot is distinct from old.variant_label_snapshot
     or new.unit_price_paisa is distinct from old.unit_price_paisa
     or new.created_at is distinct from old.created_at
     or (new.menu_item_id is distinct from old.menu_item_id and new.menu_item_id is not null)
     or (new.variant_id is distinct from old.variant_id and new.variant_id is not null) then
    raise exception 'daily_sales_lines: only qty can be changed; the item, variant and price snapshot are fixed'
      using errcode = '42501';
  end if;
  if v_uid is not null and new.qty is distinct from old.qty then
    new.updated_by := v_uid;
  end if;
  return new;
end;
$$;

revoke all on function private.daily_sales_audit() from public, anon, authenticated;
revoke all on function private.daily_sales_lines_snapshot() from public, anon, authenticated;
-- Trigger functions are not callable as RPC; the grants only make sure the firing roles are never refused.
grant execute on function private.daily_sales_audit() to authenticated, service_role;
grant execute on function private.daily_sales_lines_snapshot() to authenticated, service_role;

create trigger daily_sales_audit_trg before insert or update on public.daily_sales
  for each row execute function private.daily_sales_audit();
create trigger daily_sales_lines_snapshot_trg before insert or update on public.daily_sales_lines
  for each row execute function private.daily_sales_lines_snapshot();

-- ---------------------------------------------------------------------------
-- RLS and grants. "Today" is the Kathmandu date: (now() at time zone 'Asia/Kathmandu')::date.
-- Permissive policies are OR-ed; is_staff() is true for the owner too.
-- ---------------------------------------------------------------------------
alter table public.daily_sales       enable row level security;
alter table public.daily_sales_lines enable row level security;

revoke all on public.daily_sales, public.daily_sales_lines from anon, authenticated;
grant select, insert, update, delete on public.daily_sales, public.daily_sales_lines to authenticated;

-- daily_sales
create policy daily_sales_owner_read on public.daily_sales
  for select to authenticated using (public.is_owner());
create policy daily_sales_owner_insert on public.daily_sales
  for insert to authenticated
  with check (public.is_owner() and business_date <= (select (now() at time zone 'Asia/Kathmandu')::date));
create policy daily_sales_owner_update on public.daily_sales
  for update to authenticated
  using (public.is_owner())
  with check (public.is_owner() and business_date <= (select (now() at time zone 'Asia/Kathmandu')::date));
create policy daily_sales_owner_delete on public.daily_sales
  for delete to authenticated using (public.is_owner());

create policy daily_sales_staff_read on public.daily_sales
  for select to authenticated
  using (public.is_staff()
         and business_date between (select (now() at time zone 'Asia/Kathmandu')::date - 1)
                               and (select (now() at time zone 'Asia/Kathmandu')::date));
create policy daily_sales_staff_insert on public.daily_sales
  for insert to authenticated
  with check (public.is_staff()
              and business_date between (select (now() at time zone 'Asia/Kathmandu')::date - 1)
                                    and (select (now() at time zone 'Asia/Kathmandu')::date));
create policy daily_sales_staff_update on public.daily_sales
  for update to authenticated
  using (public.is_staff()
         and business_date between (select (now() at time zone 'Asia/Kathmandu')::date - 1)
                               and (select (now() at time zone 'Asia/Kathmandu')::date))
  with check (public.is_staff()
              and business_date between (select (now() at time zone 'Asia/Kathmandu')::date - 1)
                                    and (select (now() at time zone 'Asia/Kathmandu')::date));

-- daily_sales_lines (the window is the parent day's business_date; the subquery runs under the caller's RLS)
create policy daily_sales_lines_owner_read on public.daily_sales_lines
  for select to authenticated using (public.is_owner());
create policy daily_sales_lines_owner_insert on public.daily_sales_lines
  for insert to authenticated with check (public.is_owner());
create policy daily_sales_lines_owner_update on public.daily_sales_lines
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy daily_sales_lines_owner_delete on public.daily_sales_lines
  for delete to authenticated using (public.is_owner());

create policy daily_sales_lines_staff_read on public.daily_sales_lines
  for select to authenticated
  using (public.is_staff() and exists (
           select 1 from public.daily_sales d
            where d.id = daily_sales_id
              and d.business_date between (select (now() at time zone 'Asia/Kathmandu')::date - 1)
                                      and (select (now() at time zone 'Asia/Kathmandu')::date)));
create policy daily_sales_lines_staff_insert on public.daily_sales_lines
  for insert to authenticated
  with check (public.is_staff() and exists (
                select 1 from public.daily_sales d
                 where d.id = daily_sales_id
                   and d.business_date between (select (now() at time zone 'Asia/Kathmandu')::date - 1)
                                           and (select (now() at time zone 'Asia/Kathmandu')::date)));
create policy daily_sales_lines_staff_update on public.daily_sales_lines
  for update to authenticated
  using (public.is_staff() and exists (
           select 1 from public.daily_sales d
            where d.id = daily_sales_id
              and d.business_date between (select (now() at time zone 'Asia/Kathmandu')::date - 1)
                                      and (select (now() at time zone 'Asia/Kathmandu')::date)))
  with check (public.is_staff() and exists (
                select 1 from public.daily_sales d
                 where d.id = daily_sales_id
                   and d.business_date between (select (now() at time zone 'Asia/Kathmandu')::date - 1)
                                           and (select (now() at time zone 'Asia/Kathmandu')::date)));

-- ---------------------------------------------------------------------------
-- Helpers (private; not exposed by PostgREST)
-- ---------------------------------------------------------------------------
-- Kathmandu calendar date of an instant. Used by every statistics function so day boundaries are 00:00 +05:45.
create or replace function private.ktm_date(p_at timestamptz)
returns date
language sql
stable
set search_path = ''
as $$ select (p_at at time zone 'Asia/Kathmandu')::date $$;

-- First instant (timestamptz) of a Kathmandu calendar date: 00:00 Asia/Kathmandu = 18:15 UTC the day before.
create or replace function private.ktm_day_start(p_date date)
returns timestamptz
language sql
stable
set search_path = ''
as $$ select (p_date::timestamp at time zone 'Asia/Kathmandu') $$;

create or replace function private.ktm_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Asia/Kathmandu')::date $$;

-- One day's log as JSON (shape documented in supabase/README.md, "Statistics"). Null if the day has no log.
create or replace function private.daily_sales_json(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'id',              d.id,
           'businessDate',    d.business_date,
           'tillTotalPaisa',  d.till_total_paisa,
           'note',            d.note,
           'createdBy',       d.created_by,
           'updatedBy',       d.updated_by,
           'createdAt',       d.created_at,
           'updatedAt',       d.updated_at,
           'linesTotalPaisa', coalesce((select sum(l.line_total_paisa) from public.daily_sales_lines l where l.daily_sales_id = d.id), 0),
           'itemsSold',       coalesce((select sum(l.qty) from public.daily_sales_lines l where l.daily_sales_id = d.id), 0),
           'lines', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id',             l.id,
                       'menuItemId',     l.menu_item_ref,
                       'variantId',      l.variant_ref,
                       'menuItemExists', l.menu_item_id is not null,
                       'name',           l.name_snapshot,
                       'variantLabel',   l.variant_label_snapshot,
                       'qty',            l.qty,
                       'unitPricePaisa', l.unit_price_paisa,
                       'lineTotalPaisa', l.line_total_paisa,
                       'updatedBy',      l.updated_by,
                       'updatedAt',      l.updated_at)
                     order by l.name_snapshot, l.variant_label_snapshot nulls first, l.id)
                from public.daily_sales_lines l where l.daily_sales_id = d.id), '[]'::jsonb))
    from public.daily_sales d
   where d.id = p_id
$$;

-- Actor check shared by the daily-sales RPCs: returns the actor's role, FORBIDDEN without a profile.
create or replace function private.require_actor_role(p_actor uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  if p_actor is not null then
    select p.role into v_role from public.profiles p where p.id = p_actor;
  end if;
  if v_role is null then
    perform private.raise_order_error('FORBIDDEN');
  end if;
  return v_role;
end;
$$;

revoke all on function private.ktm_date(timestamptz), private.ktm_day_start(date), private.ktm_today(),
                       private.daily_sales_json(uuid), private.require_actor_role(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- upsert_daily_sales: save (part of) one day's log in ONE transaction. Service role only; p_actor = the verified
-- staff/owner profiles.id (role is read from profiles, never from the client).
--
--   p_date        Kathmandu business date. Not in the future. Staff: today or yesterday only (else FORBIDDEN).
--   p_lines       [{ "menuItemId": uuid, "variantId": uuid | null (optional), "qty": 0..9999 }], 0..500 lines,
--                 one per (menuItemId, variantId). Any other keys (e.g. a price) are ignored.
--   p_till_total  paisa 0..1,000,000,000 or null.  p_note  text <= 500 or null (trimmed; '' = null).
--
-- Semantics: the header (till total, note) is REPLACED by what is sent (send the current values to keep them).
-- Lines are MERGED: a sent line inserts or updates that item's qty; lines not sent stay as they are. To "remove" an
-- item send qty 0. Existing lines keep their price snapshot; new lines snapshot the current menu price.
-- Items must exist (hidden / sold-out are fine; a soft-deleted item only if it was deleted after that day started).
-- Errors (SQLSTATE P0001, protocol as create_order): FORBIDDEN, VALIDATION (details: {"date"|"tillTotal"|"note"|
-- "lines"|"lines.N": [msg]}). Returns the day's full log (private.daily_sales_json).
-- ---------------------------------------------------------------------------
create or replace function public.upsert_daily_sales(
  p_date        date,
  p_lines       jsonb,
  p_till_total  integer default null,
  p_note        text    default null,
  p_actor       uuid    default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_role    text;
  v_today   date := private.ktm_today();
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_errors  jsonb := '{}'::jsonb;
  v_id      uuid;
begin
  v_role := private.require_actor_role(p_actor);

  -- Date ------------------------------------------------------------------------------------------------------
  if p_date is null then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('date', jsonb_build_array('required')));
  end if;
  if p_date > v_today then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('date', jsonb_build_array('cannot be in the future')));
  end if;
  if p_date < date '2020-01-01' then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('date', jsonb_build_array('too far in the past')));
  end if;
  if v_role <> 'owner' and p_date < v_today - 1 then
    perform private.raise_order_error('FORBIDDEN', null,
      'Staff can log today and yesterday only. Ask the owner to change older days.');
  end if;

  -- Header fields -----------------------------------------------------------------------------------------------
  if p_till_total is not null and p_till_total not between 0 and 1000000000 then
    v_errors := v_errors || jsonb_build_object('tillTotal', jsonb_build_array('0 to 1,000,000,000 paisa'));
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    v_errors := v_errors || jsonb_build_object('note', jsonb_build_array('at most 500 characters'));
  end if;

  -- Lines: shape ------------------------------------------------------------------------------------------------
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 500 then
    v_errors := v_errors || jsonb_build_object('lines', jsonb_build_array('an array of at most 500 lines'));
  else
    select v_errors || coalesce(jsonb_object_agg('lines.' || (e.ord - 1),
             jsonb_build_array('each line needs a menuItemId, an optional variantId and a whole qty 0 to 9999')), '{}'::jsonb)
      into v_errors
      from jsonb_array_elements(p_lines) with ordinality as e(value, ord)
     where not coalesce(
             jsonb_typeof(e.value) = 'object'
             and jsonb_typeof(e.value -> 'menuItemId') = 'string'
             and (e.value ->> 'menuItemId') ~ c_uuid_re
             and (not (e.value ? 'variantId') or jsonb_typeof(e.value -> 'variantId') = 'null'
                  or (jsonb_typeof(e.value -> 'variantId') = 'string' and (e.value ->> 'variantId') ~ c_uuid_re))
             and jsonb_typeof(e.value -> 'qty') = 'number'
             and (e.value ->> 'qty') ~ '^[0-9]{1,4}$',
             false);
  end if;

  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- Lines: duplicates, existence, variant ownership -------------------------------------------------------------
  with l as (
    select (e.ord - 1)::int as idx,
           (e.value ->> 'menuItemId')::uuid as item_id,
           nullif(e.value ->> 'variantId', '')::uuid as variant_id
      from jsonb_array_elements(p_lines) with ordinality as e(value, ord)
  ),
  bad as (
    select l.idx,
           case
             when count(*) over (partition by l.item_id, l.variant_id) > 1
               then 'the same item and variant appears more than once'
             when i.id is null
               or (i.deleted_at is not null and i.deleted_at < private.ktm_day_start(p_date))
               then 'unknown menu item'
             when l.variant_id is not null and v.id is null
               then 'unknown variant for this item'
           end as msg
      from l
      left join public.menu_items i on i.id = l.item_id
      left join public.menu_variants v on v.id = l.variant_id and v.item_id = l.item_id
  )
  select v_errors || coalesce(jsonb_object_agg('lines.' || bad.idx, jsonb_build_array(bad.msg)), '{}'::jsonb)
    into v_errors
    from bad
   where bad.msg is not null;

  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- Write -------------------------------------------------------------------------------------------------------
  -- Two people saving the same day serialise here (the header upsert would too; this keeps line merges ordered).
  perform pg_advisory_xact_lock(hashtextextended('daily-sales:' || p_date::text, 0));

  insert into public.daily_sales as d (business_date, till_total_paisa, note, created_by, updated_by)
  values (p_date, p_till_total, v_note, p_actor, p_actor)
  on conflict (business_date) do update
     set till_total_paisa = excluded.till_total_paisa,
         note             = excluded.note,
         updated_by       = excluded.updated_by,
         updated_at       = now()
  returning d.id into v_id;

  -- Price / name snapshot columns are filled by daily_sales_lines_snapshot_trg; nothing price-like is read from p_lines.
  insert into public.daily_sales_lines as t (daily_sales_id, menu_item_id, variant_id, qty, updated_by)
  select v_id,
         (e.value ->> 'menuItemId')::uuid,
         nullif(e.value ->> 'variantId', '')::uuid,
         (e.value ->> 'qty')::integer,
         p_actor
    from jsonb_array_elements(p_lines) as e(value)
  on conflict on constraint daily_sales_lines_one_per_item do update
     set qty        = excluded.qty,
         updated_by = excluded.updated_by
   where t.qty is distinct from excluded.qty;

  return private.daily_sales_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- get_daily_sales: one day's log for the staff/owner form (null if nothing is logged yet). Service role only.
-- Same window as writes: staff may read today and yesterday (else FORBIDDEN); the owner any date.
-- ---------------------------------------------------------------------------
create or replace function public.get_daily_sales(p_date date, p_actor uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role  text;
  v_today date := private.ktm_today();
  v_id    uuid;
begin
  v_role := private.require_actor_role(p_actor);
  if p_date is null then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('date', jsonb_build_array('required')));
  end if;
  if v_role <> 'owner' and (p_date < v_today - 1 or p_date > v_today) then
    perform private.raise_order_error('FORBIDDEN', null,
      'Staff can see today and yesterday only.');
  end if;
  select d.id into v_id from public.daily_sales d where d.business_date = p_date;
  if v_id is null then
    return null;
  end if;
  return private.daily_sales_json(v_id);
end;
$$;

revoke all on function public.upsert_daily_sales(date, jsonb, integer, text, uuid) from public, anon, authenticated;
revoke all on function public.get_daily_sales(date, uuid) from public, anon, authenticated;
grant execute on function public.upsert_daily_sales(date, jsonb, integer, text, uuid) to service_role;
grant execute on function public.get_daily_sales(date, uuid) to service_role;

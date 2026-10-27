-- 20261021000003_order_functions_v2.sql
-- Order logic fixes from the 2026-10-21 security review and QA pass. Replaces function BODIES only; every public
-- signature is unchanged, so the backend calls stay the same. New: block_contact(), auto_cancel_unconfirmed_orders().
--
--   SEC-001  create_order runs input validation, re-pricing / item validity, minimum order and stock FIRST, and only
--            then the refusal rules (blocklist, open-order caps, COD max) and the per-phone daily backstop. A bad
--            item, a basket under the minimum or an out-of-stock line now gives the same VALIDATION / OUT_OF_STOCK
--            answer for a blocked phone and a clean one. Residual (documented): someone willing to place a real,
--            valid, in-stock order still learns the answer, and that order is visible to staff.
--   BUG-003  cod_max_total_paisa NULL or 0 = no limit.
--   SEC-003  ORDERS_PAUSED kill switch (checked first, disclosed on purpose), per-IP-hash open-order cap
--            (ORDER_REFUSED) and per-IP-hash 24 h cap (RATE_LIMITED); auto-cancel of stale `placed` orders with
--            reason 'auto_unconfirmed' (new cancel reason, system-only) and restock.
--   SEC-008  Blocking never overwrites an existing live entry (insert-or-nothing) in transition_order and in the new
--            block_contact() RPC; kind/value/created_by/created_at of a blocklist row are immutable for every role.
--   Review note (deadlock): restock now locks the variant rows in id order before updating them, the same order
--            create_order uses.
--
-- ERROR PROTOCOL unchanged (SQLSTATE P0001, MESSAGE = code, DETAIL = JSON text, HINT = safe text), plus one code:
--   ORDERS_PAUSED  owner switched online ordering off. DETAIL empty, HINT = safe text. Fine to show the customer.

-- ---------------------------------------------------------------------------
-- New cancel reason 'auto_unconfirmed' (set only by auto_cancel_unconfirmed_orders()).
-- The old single-column check is found in the catalog and replaced.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.orders'::regclass
       and c.contype = 'c'
       and c.conkey = array[(select a.attnum from pg_attribute a
                              where a.attrelid = 'public.orders'::regclass and a.attname = 'cancel_reason')]::int2[]
  loop
    execute format('alter table public.orders drop constraint %I', r.conname);
  end loop;
end
$$;

alter table public.orders
  add constraint orders_cancel_reason_valid
  check (cancel_reason in ('customer_request', 'unreachable', 'no_show', 'refused', 'fake', 'out_of_stock', 'other',
                           'auto_unconfirmed'));

-- Index for the per-IP open-order cap.
create index if not exists orders_open_ip_idx on public.orders (ip_hash)
  where ip_hash is not null and status in ('placed', 'confirmed', 'out_for_delivery', 'ready_for_pickup');

-- ---------------------------------------------------------------------------
-- create_order v2. Order of checks:
--   0. ORDERS_PAUSED (kill switch)
--   1. input validation                                   -> VALIDATION
--   2. advisory locks (phone, then IP hash)
--   3. IP-hash backstop: 10-minute window, 24 h cap       -> RATE_LIMITED  (about the caller's own IP only)
--   4. re-price from DB, item availability, qty           -> VALIDATION
--   5. minimum order                                      -> VALIDATION
--   6. stock                                              -> OUT_OF_STOCK
--   7. refusal gate, one code path: blocklist (phone/IP), open orders per phone, open orders per IP hash,
--      COD max (NULL/0 = none)                            -> ORDER_REFUSED (no detail)
--   8. per-phone 24 h backstop                            -> RATE_LIMITED
--   9. insert order + items, decrement stock
-- ---------------------------------------------------------------------------
create or replace function public.create_order(
  p_items          jsonb,
  p_fulfilment     text,
  p_payment_method text,
  p_customer_name  text,
  p_customer_phone text,
  p_customer_email text default null,
  p_address        text default null,
  p_landmark       text default null,
  p_area           text default null,
  p_notes          text default null,
  p_ip_hash        text default null
)
returns table (out_order_id uuid, out_order_token uuid, out_order_number text, out_total_paisa integer, out_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_uuid_re  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_set      public.site_settings%rowtype;
  v_rules    public.order_rules%rowtype;
  v_name     text := btrim(coalesce(p_customer_name, ''));
  v_phone    text := btrim(coalesce(p_customer_phone, ''));
  v_email    text := nullif(btrim(coalesce(p_customer_email, '')), '');
  v_address  text := nullif(btrim(coalesce(p_address, '')), '');
  v_landmark text := nullif(btrim(coalesce(p_landmark, '')), '');
  v_area     text := nullif(btrim(coalesce(p_area, '')), '');
  v_notes    text := nullif(btrim(coalesce(p_notes, '')), '');
  v_errors   jsonb := '{}'::jsonb;
  v_bad      integer;
  v_line     record;
  v_row      record;
  v_ids      uuid[] := '{}';
  v_qty      integer[] := '{}';
  v_idx      integer[] := '{}';
  v_price    integer[] := '{}';
  v_stock    integer[] := '{}';
  v_names    text[] := '{}';
  v_labels   text[] := '{}';
  v_i        integer;
  v_subtotal bigint := 0;
  v_service  bigint;
  v_taxable  bigint;
  v_vat      bigint;
  v_delivery integer;
  v_total    bigint;
  v_min      integer;
  v_cnt      integer;
  v_oldest   timestamptz;
  v_retry    integer;
  v_blocked      boolean;
  v_open_phone   integer;
  v_open_ip      integer := 0;
  v_cod_exceeded boolean;
  v_order_id uuid;
  v_token    uuid;
  v_number   text;
begin
  select * into v_set   from public.site_settings limit 1;
  select * into v_rules from public.order_rules   limit 1;

  -- 0. Kill switch (SEC-003). Disclosed on purpose: it says nothing about the caller. --------------------------
  if coalesce(v_set.orders_paused, false) then
    perform private.raise_order_error('ORDERS_PAUSED', null, 'Online ordering is paused right now. Please call us to order.');
  end if;

  -- 1. Input validation (collect all field errors, then raise once) --------------------------------------------
  if p_fulfilment is null or p_fulfilment not in ('pickup', 'delivery') then
    v_errors := v_errors || jsonb_build_object('fulfilment', jsonb_build_array('must be pickup or delivery'));
  end if;
  if p_payment_method is null or p_payment_method not in ('cod', 'pickup') then
    v_errors := v_errors || jsonb_build_object('paymentMethod', jsonb_build_array('must be cod or pickup'));
  elsif not (p_payment_method = any (v_set.payment_methods_enabled)) then
    v_errors := v_errors || jsonb_build_object('paymentMethod', jsonb_build_array('this payment method is not available'));
  elsif (p_fulfilment = 'delivery' and p_payment_method <> 'cod') or (p_fulfilment = 'pickup' and p_payment_method <> 'pickup') then
    v_errors := v_errors || jsonb_build_object('paymentMethod', jsonb_build_array('does not match the fulfilment type'));
  end if;
  if char_length(v_name) not between 2 and 80 then
    v_errors := v_errors || jsonb_build_object('customer.name', jsonb_build_array('2 to 80 characters'));
  end if;
  if v_phone !~ '^\+977(97|98)[0-9]{8}$' then
    v_errors := v_errors || jsonb_build_object('customer.phone', jsonb_build_array('enter a valid Nepal mobile number'));
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    v_errors := v_errors || jsonb_build_object('customer.email', jsonb_build_array('enter a valid email'));
  end if;
  if v_notes is not null and char_length(v_notes) > 300 then
    v_errors := v_errors || jsonb_build_object('notes', jsonb_build_array('at most 300 characters'));
  end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$' then
    v_errors := v_errors || jsonb_build_object('ipHash', jsonb_build_array('must be a lowercase hex SHA-256'));
  end if;
  if p_fulfilment = 'delivery' then
    if v_address is null or v_landmark is null or v_area is null then
      v_errors := v_errors || jsonb_build_object('delivery', jsonb_build_array('address, landmark and area are required'));
    elsif char_length(v_address) > 300 or char_length(v_landmark) > 200 or char_length(v_area) > 100 then
      v_errors := v_errors || jsonb_build_object('delivery', jsonb_build_array('address text is too long'));
    elsif not exists (select 1 from unnest(v_set.delivery_areas) a where lower(btrim(a)) = lower(v_area)) then
      v_errors := v_errors || jsonb_build_object('delivery.area', jsonb_build_array('we do not deliver to this area'));
    end if;
  else
    v_address := null; v_landmark := null; v_area := null;      -- pickup orders store no address
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then
    v_errors := v_errors || jsonb_build_object('items', jsonb_build_array('1 to 20 lines required'));
  else
    select count(*) into v_bad
      from jsonb_array_elements(p_items) as e(value)
     where not coalesce(
             jsonb_typeof(e.value) = 'object'
             and coalesce((e.value ->> 'variantId') ~ c_uuid_re, false)
             and case when (e.value ->> 'qty') ~ '^[0-9]{1,3}$'
                      then (e.value ->> 'qty')::integer between 1 and 10 else false end,
             false);
    if v_bad > 0 then
      v_errors := v_errors || jsonb_build_object('items', jsonb_build_array('each line needs a variantId and qty 1 to 10'));
    end if;
  end if;

  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- 2. Serialise per phone / per IP so the caps below cannot be raced by parallel requests -----------------------
  perform pg_advisory_xact_lock(hashtextextended('order-phone:' || v_phone, 0));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('order-ip:' || p_ip_hash, 0));
  end if;

  -- 3. IP-hash backstop limits. They concern only the caller's own address, so running them early reveals nothing
  --    about any phone number. ----------------------------------------------------------------------------------
  if p_ip_hash is not null then
    select count(*), min(o.created_at) into v_cnt, v_oldest
      from public.orders o
     where o.ip_hash = p_ip_hash
       and o.created_at > now() - make_interval(mins => v_rules.ip_window_minutes);
    if v_cnt >= v_rules.ip_orders_max then
      v_retry := greatest(ceil(extract(epoch from (v_oldest + make_interval(mins => v_rules.ip_window_minutes) - now())))::integer, 1);
      perform private.raise_order_error('RATE_LIMITED', jsonb_build_object('retryAfterSeconds', v_retry));
    end if;

    select count(*), min(o.created_at) into v_cnt, v_oldest
      from public.orders o
     where o.ip_hash = p_ip_hash
       and o.created_at > now() - interval '24 hours';
    if v_cnt >= v_rules.ip_orders_max_per_day then
      v_retry := greatest(ceil(extract(epoch from (v_oldest + interval '24 hours' - now())))::integer, 1);
      perform private.raise_order_error('RATE_LIMITED', jsonb_build_object('retryAfterSeconds', v_retry));
    end if;
  end if;

  -- 4. Re-price from the database; lock variant rows in id order (avoids deadlocks) -----------------------------
  for v_line in
    select (e.value ->> 'variantId')::uuid              as variant_id,
           sum((e.value ->> 'qty')::integer)::integer    as qty,
           min(e.ord)::integer - 1                       as idx
      from jsonb_array_elements(p_items) with ordinality as e(value, ord)
     group by 1
     order by 1
  loop
    select pv.id, pv.stock, coalesce(pv.price_override_paisa, p.price_paisa) as price,
           p.name, pv.size, pv.colour, p.is_published
      into v_row
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
     where pv.id = v_line.variant_id
       for update of pv;

    if not found or not v_row.is_published then
      v_errors := v_errors || jsonb_build_object('items.' || v_line.idx, jsonb_build_array('this item is no longer available'));
      continue;
    end if;
    if v_line.qty > 10 then
      v_errors := v_errors || jsonb_build_object('items.' || v_line.idx, jsonb_build_array('at most 10 of one item'));
      continue;
    end if;

    v_ids    := v_ids    || v_row.id;
    v_qty    := v_qty    || v_line.qty;
    v_idx    := v_idx    || v_line.idx;
    v_price  := v_price  || v_row.price;
    v_stock  := v_stock  || v_row.stock;
    v_names  := v_names  || v_row.name;
    v_labels := v_labels || (v_row.size || ' / ' || v_row.colour);
    v_subtotal := v_subtotal + v_row.price::bigint * v_line.qty;
  end loop;

  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- Totals. Service charge applies to the item subtotal. VAT (13%) applies to subtotal + service charge;
  -- the delivery fee is treated as VAT-inclusive and not taxed again. ASSUMPTION, confirm with finance.
  v_service  := round(v_subtotal * v_set.service_charge_pct / 100.0)::bigint;
  v_taxable  := v_subtotal + v_service;
  v_delivery := case when p_fulfilment = 'delivery' then v_set.delivery_fee_paisa else 0 end;
  if v_set.prices_include_vat then
    v_vat   := round(v_taxable * 13 / 113.0)::bigint;                 -- VAT portion inside the prices
    v_total := v_taxable + v_delivery;
  else
    v_vat   := round(v_taxable * 13 / 100.0)::bigint;                 -- VAT added on top
    v_total := v_taxable + v_vat + v_delivery;
  end if;
  if v_total > 2000000000 then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('items', jsonb_build_array('order is too large')));
  end if;

  -- 5. Minimum order (item subtotal, before delivery fee) --------------------------------------------------------
  v_min := case when p_fulfilment = 'delivery' then v_set.min_order_delivery_paisa else v_set.min_order_pickup_paisa end;
  if v_min > 0 and v_subtotal < v_min then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('items', jsonb_build_array(
      'Minimum order for ' || p_fulfilment || ' is ' || private.fmt_npr(v_min))));
  end if;

  -- 6. Stock check (rows are already locked, so no one can take the last unit between check and decrement) -------
  for v_i in 1 .. array_length(v_ids, 1) loop
    if v_stock[v_i] < v_qty[v_i] then
      v_errors := v_errors || jsonb_build_object('items.' || v_idx[v_i], jsonb_build_array(
        case when v_stock[v_i] <= 0 then 'sold out' else 'only ' || v_stock[v_i] || ' left' end));
    end if;
  end loop;
  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('OUT_OF_STOCK', v_errors);
  end if;

  -- 7. Refusal gate (SEC-001). Reached only by a fully valid, in-stock order. All rules are evaluated every time
  --    and raised from ONE place with no detail, so neither the answer nor the work done says which rule fired. ---
  select exists (
           select 1 from public.blocked_contacts b
            where b.expires_at > now()
              and ((b.kind = 'phone' and b.value = v_phone)
                or (b.kind = 'ip_hash' and p_ip_hash is not null and b.value = p_ip_hash)))
    into v_blocked;

  select count(*) into v_open_phone
    from public.orders o
   where o.customer_phone = v_phone and o.status in ('placed', 'confirmed', 'out_for_delivery', 'ready_for_pickup');

  if p_ip_hash is not null then
    select count(*) into v_open_ip
      from public.orders o
     where o.ip_hash = p_ip_hash and o.status in ('placed', 'confirmed', 'out_for_delivery', 'ready_for_pickup');
  end if;

  -- BUG-003: NULL or 0 = no COD limit.
  v_cod_exceeded := coalesce(v_rules.cod_max_total_paisa, 0) > 0 and v_total > v_rules.cod_max_total_paisa;

  if v_blocked
     or v_open_phone >= v_rules.max_open_orders_per_phone
     or (p_ip_hash is not null and v_open_ip >= v_rules.ip_open_orders_max)
     or v_cod_exceeded then
    perform private.raise_order_error('ORDER_REFUSED');
  end if;

  -- 8. Per-phone 24 h backstop (moved after validation so it cannot be used to test a number with a bad basket) --
  select count(*), min(o.created_at) into v_cnt, v_oldest
    from public.orders o
   where o.customer_phone = v_phone and o.created_at > now() - interval '24 hours';
  if v_cnt >= v_rules.phone_orders_max_per_day then
    v_retry := greatest(ceil(extract(epoch from (v_oldest + interval '24 hours' - now())))::integer, 1);
    perform private.raise_order_error('RATE_LIMITED', jsonb_build_object('retryAfterSeconds', v_retry));
  end if;

  -- 9. Insert + decrement ----------------------------------------------------------------------------------------
  insert into public.orders (
      fulfilment, payment_method, prices_include_vat,
      subtotal_paisa, service_charge_paisa, delivery_fee_paisa, vat_paisa, total_paisa,
      customer_name, customer_phone, customer_email, address, landmark, area, notes, ip_hash)
  values (
      p_fulfilment, p_payment_method, v_set.prices_include_vat,
      v_subtotal, v_service, v_delivery, v_vat, v_total,
      v_name, v_phone, v_email, v_address, v_landmark, v_area, v_notes, p_ip_hash)
  returning id, public_token, number into v_order_id, v_token, v_number;

  for v_i in 1 .. array_length(v_ids, 1) loop
    insert into public.order_items (order_id, product_variant_id, name, variant_label, unit_price_paisa, qty)
    values (v_order_id, v_ids[v_i], v_names[v_i], v_labels[v_i], v_price[v_i], v_qty[v_i]);

    update public.product_variants set stock = stock - v_qty[v_i] where id = v_ids[v_i];
  end loop;

  return query select v_order_id, v_token, v_number, v_total::integer, 'placed'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- transition_order v2 (internal state machine).
-- Changes: accepts reason 'auto_unconfirmed'; restock locks variants in id order first; block-on-cancel is
-- insert-or-nothing (SEC-008): an existing live entry is left exactly as it is; an expired-but-not-yet-purged
-- entry is replaced, because it no longer blocks anything.
-- ---------------------------------------------------------------------------
create or replace function private.transition_order(
  p_order_id uuid, p_to text, p_reason text, p_restock boolean, p_block boolean,
  p_actor uuid, p_actor_role text, p_by_customer boolean
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  o         public.orders%rowtype;
  v_ok      boolean;
  v_restock boolean;
  v_now     timestamptz := now();
  v_months  integer;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    perform private.raise_order_error('NOT_FOUND');
  end if;

  if p_by_customer then
    if o.status = 'cancelled' and o.cancel_reason = 'customer_request' then
      return o;                                                       -- same success again
    end if;
    if o.status <> 'placed' then
      perform private.raise_order_error('CONFLICT', null, 'Please call us to change this order');
    end if;
  end if;

  if p_to = 'cancelled' and o.status = 'cancelled' then
    return o;                                                         -- idempotent cancel, no second restock
  end if;

  v_ok := (o.status = 'placed' and p_to in ('confirmed', 'cancelled'))
       or (o.status = 'confirmed' and (
              (p_to = 'out_for_delivery' and o.fulfilment = 'delivery')
           or (p_to = 'ready_for_pickup' and o.fulfilment = 'pickup')
           or p_to = 'cancelled'))
       or (o.status in ('out_for_delivery', 'ready_for_pickup') and p_to in ('completed', 'cancelled'));
  if not v_ok then
    perform private.raise_order_error('CONFLICT', null, 'illegal status transition');
  end if;

  if p_to = 'cancelled' then
    if p_reason is null or p_reason not in ('customer_request', 'unreachable', 'no_show', 'refused', 'fake',
                                            'out_of_stock', 'other', 'auto_unconfirmed') then
      perform private.raise_order_error('VALIDATION', jsonb_build_object('reason', jsonb_build_array('a valid cancel reason is required')));
    end if;
    -- Cancelling after the order is on its way / ready is owner only (contract cancelOrder role rule).
    if o.status in ('out_for_delivery', 'ready_for_pickup') and p_actor_role is distinct from 'owner' then
      perform private.raise_order_error('FORBIDDEN');
    end if;
  end if;

  v_restock := p_to = 'cancelled' and (coalesce(p_restock, false) or p_by_customer) and o.stock_restocked_at is null;
  if v_restock then
    -- Lock the variants in id order (same order as create_order) so concurrent cancels/orders do not deadlock.
    perform 1
       from public.product_variants pv
      where pv.id in (select i.product_variant_id from public.order_items i where i.order_id = o.id)
      order by pv.id
        for update;
    update public.product_variants pv
       set stock = pv.stock + s.qty
      from (select i.product_variant_id, sum(i.qty)::integer as qty
              from public.order_items i where i.order_id = o.id group by i.product_variant_id) s
     where pv.id = s.product_variant_id;
  end if;

  perform set_config('app.order_transition', 'on', true);
  update public.orders set
      status             = p_to,
      payment_status     = case when p_to = 'completed' then 'paid' else payment_status end,
      confirmed_at       = case when p_to = 'confirmed' then v_now else confirmed_at end,
      completed_at       = case when p_to = 'completed' then v_now else completed_at end,
      cancelled_at       = case when p_to = 'cancelled' then v_now else cancelled_at end,
      cancel_reason      = case when p_to = 'cancelled' then p_reason else cancel_reason end,
      stock_restocked_at = case when v_restock then v_now else stock_restocked_at end
   where id = o.id
  returning * into o;
  perform set_config('app.order_transition', 'off', true);

  -- Optional: block the phone in the same transaction (cancelOrder.blockContact). Insert-or-nothing (SEC-008).
  if p_to = 'cancelled' and coalesce(p_block, false) and o.customer_phone is not null then
    select blocklist_months into v_months from public.order_rules limit 1;
    delete from public.blocked_contacts b
     where b.kind = 'phone' and b.value = o.customer_phone and b.expires_at <= v_now;
    insert into public.blocked_contacts (kind, value, reason, created_by, expires_at)
    values ('phone', o.customer_phone, 'order ' || o.number || ': ' || p_reason, p_actor,
            v_now + make_interval(months => coalesce(v_months, 12)))
    on conflict (kind, value) do nothing;
  end if;

  return o;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_order_status v2: same as before, but 'auto_unconfirmed' is reserved for the system job.
-- ---------------------------------------------------------------------------
create or replace function public.set_order_status(
  p_order_id      uuid,
  p_status        text,
  p_actor         uuid,
  p_reason        text default null,
  p_restock       boolean default false,
  p_block_contact boolean default false
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select p.role into v_role from public.profiles p where p.id = p_actor;
  if v_role is null then
    perform private.raise_order_error('FORBIDDEN');
  end if;
  if p_status is null or p_status not in ('confirmed', 'out_for_delivery', 'ready_for_pickup', 'completed', 'cancelled') then
    perform private.raise_order_error('CONFLICT', null, 'illegal status transition');
  end if;
  if p_reason = 'auto_unconfirmed' then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('reason', jsonb_build_array('this reason is set by the system only')));
  end if;
  return private.transition_order(p_order_id, p_status, p_reason, p_restock, p_block_contact, p_actor, v_role, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- SEC-008: blocklist rows keep their identity and audit fields for every role (including the service role, which
-- bypasses RLS). kind, value, created_at never change; created_by may only be cleared (the FK is ON DELETE SET
-- NULL when a staff profile is removed). Owner renewals change expires_at / reason only.
-- ---------------------------------------------------------------------------
create or replace function private.blocked_contacts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind
     or new.value is distinct from old.value
     or new.created_at is distinct from old.created_at
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception 'blocked_contacts: kind, value, created_by and created_at cannot be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
-- Trigger functions are not callable as RPC; the grant only makes sure the firing roles are never refused.
grant execute on function private.blocked_contacts_guard() to authenticated, service_role;

drop trigger if exists blocked_contacts_guard_trg on public.blocked_contacts;
create trigger blocked_contacts_guard_trg before update on public.blocked_contacts
  for each row execute function private.blocked_contacts_guard();

-- ---------------------------------------------------------------------------
-- block_contact: the staff "block" action (contract blockContact, role S). Insert-or-nothing:
--   * live entry exists       -> returned unchanged, out_created = false (staff cannot shorten or rewrite it)
--   * expired, not yet purged -> replaced by a fresh entry, out_created = true
--   * none                    -> created, out_created = true
-- p_actor = the verified staff/owner profiles.id (FORBIDDEN otherwise). Expiry = now + order_rules.blocklist_months.
-- Renewal (owner only, contract unblock/renew rules) stays a plain UPDATE of expires_at / reason after
-- requireRole('owner'); the guard trigger above keeps the audit fields intact.
-- ---------------------------------------------------------------------------
create or replace function public.block_contact(
  p_kind   text,
  p_value  text,
  p_reason text,
  p_actor  uuid
)
returns table (out_id uuid, out_created boolean, out_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text;
  v_months integer;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_value  text := btrim(coalesce(p_value, ''));
  v_id     uuid;
  v_exp    timestamptz;
begin
  select p.role into v_role from public.profiles p where p.id = p_actor;
  if v_role is null then
    perform private.raise_order_error('FORBIDDEN');
  end if;

  if p_kind is null or p_kind not in ('phone', 'ip_hash') then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('kind', jsonb_build_array('must be phone or ip_hash')));
  end if;
  if (p_kind = 'phone' and v_value !~ '^\+977(97|98)[0-9]{8}$')
     or (p_kind = 'ip_hash' and v_value !~ '^[0-9a-f]{64}$') then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('value', jsonb_build_array(
      case when p_kind = 'phone' then 'enter a valid Nepal mobile number' else 'must be a lowercase hex SHA-256' end)));
  end if;
  if v_reason is not null and char_length(v_reason) > 200 then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('reason', jsonb_build_array('at most 200 characters')));
  end if;

  select r.blocklist_months into v_months from public.order_rules r limit 1;

  delete from public.blocked_contacts b
   where b.kind = p_kind and b.value = v_value and b.expires_at <= now();

  insert into public.blocked_contacts (kind, value, reason, created_by, expires_at)
  values (p_kind, v_value, v_reason, p_actor, now() + make_interval(months => coalesce(v_months, 12)))
  on conflict (kind, value) do nothing
  returning id, expires_at into v_id, v_exp;

  if v_id is not null then
    return query select v_id, true, v_exp;
  else
    return query select b.id, false, b.expires_at
                   from public.blocked_contacts b
                  where b.kind = p_kind and b.value = v_value;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- SEC-003: auto-cancel orders left `placed` longer than order_rules.auto_cancel_placed_after_minutes
-- (NULL = off). Reason 'auto_unconfirmed', always restocked, through private.transition_order (guard trigger and
-- idempotency apply). Rows are taken FOR UPDATE SKIP LOCKED, so an order a staff member is confirming right now is
-- skipped, and the status is re-checked under the lock (a just-confirmed order is never cancelled).
-- At most 500 orders per run; one failing order is skipped and counted, the rest still go through.
-- Scheduled every 5 minutes by 20261021000004_auto_cancel_schedule.sql (pg_cron). Service role only.
-- ---------------------------------------------------------------------------
create or replace function public.auto_cancel_unconfirmed_orders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_minutes integer;
  v_id      uuid;
  v_done    integer := 0;
  v_failed  integer := 0;
begin
  select r.auto_cancel_placed_after_minutes into v_minutes from public.order_rules r limit 1;
  if v_minutes is null then
    return jsonb_build_object('enabled', false, 'cancelled', 0, 'failed', 0, 'ranAt', now());
  end if;

  for v_id in
    select o.id
      from public.orders o
     where o.status = 'placed'
       and o.created_at < now() - make_interval(mins => v_minutes)
     order by o.created_at
     limit 500
       for update skip locked
  loop
    begin
      perform private.transition_order(v_id, 'cancelled', 'auto_unconfirmed', true, false, null, 'system', false);
      v_done := v_done + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'auto_cancel_unconfirmed_orders: order % skipped (%)', v_id, sqlstate;
    end;
  end loop;

  return jsonb_build_object('enabled', true, 'timeoutMinutes', v_minutes, 'cancelled', v_done,
                            'failed', v_failed, 'ranAt', now());
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: service role only (re-stated for the replaced functions; CREATE OR REPLACE keeps the old ACL).
-- ---------------------------------------------------------------------------
revoke all on function public.create_order(jsonb, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.set_order_status(uuid, text, uuid, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.block_contact(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.auto_cancel_unconfirmed_orders() from public, anon, authenticated;
grant execute on function public.create_order(jsonb, text, text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.set_order_status(uuid, text, uuid, text, boolean, boolean) to service_role;
grant execute on function public.block_contact(text, text, text, uuid) to service_role;
grant execute on function public.auto_cancel_unconfirmed_orders() to service_role;

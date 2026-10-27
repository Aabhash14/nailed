-- 20261019000007_order_functions.sql
-- Transactional order logic. All public functions here are SERVICE ROLE ONLY (anon/authenticated cannot
-- execute them). The Worker calls them over PostgREST RPC with the service key.
--
-- ERROR PROTOCOL: failures raise SQLSTATE 'P0001' with
--   MESSAGE = contract error code  (VALIDATION | ORDER_REFUSED | OUT_OF_STOCK | RATE_LIMITED | NOT_FOUND | CONFLICT | FORBIDDEN)
--   DETAIL  = JSON text, e.g. {"items.0": ["only 2 left"]} for field errors, {"retryAfterSeconds": 120} for RATE_LIMITED
--   HINT    = optional safe human text (e.g. "Please call us to change this order")
-- PostgREST returns these as {"code":"P0001","message":"OUT_OF_STOCK","details":"{...}","hint":...}.
-- ORDER_REFUSED never says which rule fired (blocklist, open-order cap, COD max): the real reason is not returned.

create or replace function private.raise_order_error(p_code text, p_detail jsonb default null, p_hint text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%', p_code
    using errcode = 'P0001', detail = coalesce(p_detail::text, ''), hint = coalesce(p_hint, '');
end;
$$;

create or replace function private.fmt_npr(p_paisa bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Rs. ' || case when p_paisa % 100 = 0 then (p_paisa / 100)::text
                        else to_char(p_paisa / 100.0, 'FM999999990.00') end
$$;

-- ---------------------------------------------------------------------------
-- create_order: ONE transaction. Order of checks follows api-contract 3.1.
--   validate input -> DB backstop rate limits (IP hash, phone) -> blocklist -> open-order cap
--   -> re-price from DB (client prices do not exist) -> COD max total -> minimum order
--   -> stock check -> insert order + items and decrement stock.
-- Any failure raises and the whole transaction (including stock decrement) rolls back.
-- p_phone must already be normalised to +977 9[78]XXXXXXXX; p_ip_hash is the salted SHA-256 (lowercase hex).
-- p_items = [{"variantId": "<uuid>", "qty": 1..10}, ...]; duplicate variants are merged.
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
  c_uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
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
  v_order_id uuid;
  v_token    uuid;
  v_number   text;
begin
  select * into v_set   from public.site_settings limit 1;
  select * into v_rules from public.order_rules   limit 1;

  -- 1. Input validation (collect all field errors, then raise once) --------------------------------
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

  -- 2. Serialise per phone / per IP so the caps below cannot be raced by parallel requests -----------
  perform pg_advisory_xact_lock(hashtextextended('order-phone:' || v_phone, 0));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('order-ip:' || p_ip_hash, 0));
  end if;

  -- 3. DB backstop rate limits (the app also limits earlier with rate_limit_hit) ---------------------
  if p_ip_hash is not null then
    select count(*), min(o.created_at) into v_cnt, v_oldest
      from public.orders o
     where o.ip_hash = p_ip_hash
       and o.created_at > now() - make_interval(mins => v_rules.ip_window_minutes);
    if v_cnt >= v_rules.ip_orders_max then
      v_retry := greatest(ceil(extract(epoch from (v_oldest + make_interval(mins => v_rules.ip_window_minutes) - now())))::integer, 1);
      perform private.raise_order_error('RATE_LIMITED', jsonb_build_object('retryAfterSeconds', v_retry));
    end if;
  end if;
  select count(*), min(o.created_at) into v_cnt, v_oldest
    from public.orders o
   where o.customer_phone = v_phone and o.created_at > now() - interval '24 hours';
  if v_cnt >= v_rules.phone_orders_max_per_day then
    v_retry := greatest(ceil(extract(epoch from (v_oldest + interval '24 hours' - now())))::integer, 1);
    perform private.raise_order_error('RATE_LIMITED', jsonb_build_object('retryAfterSeconds', v_retry));
  end if;

  -- 4. Blocklist (phone and IP hash; expired entries are ignored) ------------------------------------
  if exists (
       select 1 from public.blocked_contacts b
        where b.expires_at > now()
          and ((b.kind = 'phone' and b.value = v_phone)
            or (b.kind = 'ip_hash' and p_ip_hash is not null and b.value = p_ip_hash))) then
    perform private.raise_order_error('ORDER_REFUSED');
  end if;

  -- 5. Open orders per phone ---------------------------------------------------------------------
  select count(*) into v_cnt
    from public.orders o
   where o.customer_phone = v_phone
     and o.status in ('placed', 'confirmed', 'out_for_delivery', 'ready_for_pickup');
  if v_cnt >= v_rules.max_open_orders_per_phone then
    perform private.raise_order_error('ORDER_REFUSED');
  end if;

  -- 6. Re-price from the database; lock variant rows in id order (avoids deadlocks) -------------------
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

  -- 7. COD maximum total (applies to any cash order; ORDER_REFUSED, deliberately vague) -------------
  if v_rules.cod_max_total_paisa is not null and v_total > v_rules.cod_max_total_paisa then
    perform private.raise_order_error('ORDER_REFUSED');
  end if;

  -- 8. Minimum order (item subtotal, before delivery fee) ------------------------------------------
  v_min := case when p_fulfilment = 'delivery' then v_set.min_order_delivery_paisa else v_set.min_order_pickup_paisa end;
  if v_min > 0 and v_subtotal < v_min then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('items', jsonb_build_array(
      'Minimum order for ' || p_fulfilment || ' is ' || private.fmt_npr(v_min))));
  end if;

  -- 9. Stock check (rows are already locked, so no one can take the last unit between check and decrement)
  for v_i in 1 .. array_length(v_ids, 1) loop
    if v_stock[v_i] < v_qty[v_i] then
      v_errors := v_errors || jsonb_build_object('items.' || v_idx[v_i], jsonb_build_array(
        case when v_stock[v_i] <= 0 then 'sold out' else 'only ' || v_stock[v_i] || ' left' end));
    end if;
  end loop;
  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('OUT_OF_STOCK', v_errors);
  end if;

  -- 10. Insert + decrement ------------------------------------------------------------------------
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
-- Internal state-machine step. The ONLY code path that may change status/payment/timestamps
-- (it raises the transaction-local flag that private.orders_guard() checks).
-- Transition table = api-contract 3.2. Idempotent cancel: cancelling a cancelled order is a no-op,
-- and stock is restocked at most once (orders.stock_restocked_at).
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
    return o;                                                         -- idempotent staff cancel, no second restock
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
    if p_reason is null or p_reason not in ('customer_request', 'unreachable', 'no_show', 'refused', 'fake', 'out_of_stock', 'other') then
      perform private.raise_order_error('VALIDATION', jsonb_build_object('reason', jsonb_build_array('a valid cancel reason is required')));
    end if;
    -- Cancelling after the order is on its way / ready is owner only (contract cancelOrder role rule).
    if o.status in ('out_for_delivery', 'ready_for_pickup') and p_actor_role is distinct from 'owner' then
      perform private.raise_order_error('FORBIDDEN');
    end if;
  end if;

  v_restock := p_to = 'cancelled' and (coalesce(p_restock, false) or p_by_customer) and o.stock_restocked_at is null;
  if v_restock then
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

  -- Optional: block the phone in the same transaction (cancelOrder.blockContact).
  if p_to = 'cancelled' and coalesce(p_block, false) and o.customer_phone is not null then
    select blocklist_months into v_months from public.order_rules limit 1;
    insert into public.blocked_contacts (kind, value, reason, created_by, expires_at)
    values ('phone', o.customer_phone, 'order ' || o.number || ': ' || p_reason, p_actor,
            v_now + make_interval(months => coalesce(v_months, 12)))
    on conflict (kind, value) do update
      set expires_at = excluded.expires_at, reason = excluded.reason;
  end if;

  return o;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_order_status: the staff entry point (also used for cancel). p_actor is the logged-in staff
-- profile id as verified by the backend; the role is read from profiles, never from the caller.
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
  return private.transition_order(p_order_id, p_status, p_reason, p_restock, p_block_contact, p_actor, v_role, false);
end;
$$;

create or replace function public.cancel_order(
  p_order_id      uuid,
  p_actor         uuid,
  p_reason        text,
  p_restock       boolean,
  p_block_contact boolean default false
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.set_order_status(p_order_id, 'cancelled', p_actor, p_reason, p_restock, p_block_contact);
end;
$$;

-- Customer cancel by token, allowed only while `placed`; always restocks; idempotent.
create or replace function public.customer_cancel_order(p_token uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select o.id into v_id from public.orders o where o.public_token = p_token;
  if v_id is null then
    perform private.raise_order_error('NOT_FOUND');
  end if;
  return private.transition_order(v_id, 'cancelled', 'customer_request', true, false, null, null, true);
end;
$$;

-- Privileges: service role only.
revoke all on function public.create_order(jsonb, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.set_order_status(uuid, text, uuid, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.cancel_order(uuid, uuid, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.customer_cancel_order(uuid) from public, anon, authenticated;
grant execute on function public.create_order(jsonb, text, text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.set_order_status(uuid, text, uuid, text, boolean, boolean) to service_role;
grant execute on function public.cancel_order(uuid, uuid, text, boolean, boolean) to service_role;
grant execute on function public.customer_cancel_order(uuid) to service_role;

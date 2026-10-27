-- orders.test.sql  (pgTAP; run with `supabase test db`)
-- Covers create_order (re-pricing, stock, minimum order, COD max, blocklist, open-order cap, IP/phone
-- backstop limits, atomic rollback), the set_order_status state machine, idempotent cancel-and-restock,
-- customer cancel, block-on-cancel, rate_limit_hit and the retention purge.
-- 2026-10-21 fix pass (migrations 20261021000001..5): SEC-001 check order (same answer for blocked and clean
-- phones when the basket is bad), BUG-003 (COD max 0/NULL = no limit), SEC-003 (ORDERS_PAUSED, per-IP open and
-- daily caps, auto-cancel of stale placed orders + its pg_cron job), SEC-008 (insert-or-nothing blocklist,
-- immutable audit fields, block_contact RPC).
-- Self-contained, rolled back at the end. Calls run as service_role, like the real backend.
-- STATUS: executed 2026-10-23 on a local stack (CLI 2.121.0, Postgres 15.19): passing. First-run fixes: data-model.md.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- Helpers (temp, vanish with the session) -------------------------------------------------------------------------
create function pg_temp.h(t text) returns text language sql as
$$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

-- Runs a statement; returns 'ok' or '<message>|<detail>' so we can assert on the error protocol.
create function pg_temp.try(q text) returns text language plpgsql as $$
declare d text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return sqlerrm || '|' || coalesce(d, '');
end $$;

-- Places a 1-line pickup order, returns its public token.
create function pg_temp.place(p_phone text, p_variant uuid, p_qty int default 1, p_ip text default null)
returns uuid language plpgsql as $$
declare r record;
begin
  select * into r from public.create_order(
    jsonb_build_array(jsonb_build_object('variantId', p_variant, 'qty', p_qty)),
    'pickup', 'pickup', 'Test Person', p_phone, null, null, null, null, null, p_ip);
  return r.out_order_token;
end $$;

create function pg_temp.oid(tok uuid) returns uuid language sql as
$$ select id from public.orders where public_token = tok $$;

-- true/false = is the pg_cron job there; null = pg_cron is not installed in this database.
create function pg_temp.cron_job_exists(p_name text) returns boolean language plpgsql as $$
declare v boolean;
begin
  if to_regclass('cron.job') is null then return null; end if;
  execute 'select exists (select 1 from cron.job where jobname = $1)' into v using p_name;
  return v;
end $$;

-- SEC-007 (20261021000001) removed the global PUBLIC EXECUTE default for functions created by `postgres`, and that
-- includes pg_temp. The calls below run as service_role, so the helpers need an explicit grant (first-run fix).
grant execute on function pg_temp.h(text), pg_temp.try(text), pg_temp.place(text, uuid, int, text),
                          pg_temp.oid(uuid), pg_temp.cron_job_exists(text) to service_role;

-- Fixtures --------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('f2000000-0000-4000-8000-000000000001', 'owner@test.invalid'),
  ('f2000000-0000-4000-8000-000000000002', 'staff@test.invalid');
insert into public.profiles (id, role, display_name) values
  ('f2000000-0000-4000-8000-000000000001', 'owner', 'T Owner'),
  ('f2000000-0000-4000-8000-000000000002', 'staff', 'T Staff');

insert into public.products (id, slug, name, price_paisa, is_published) values
  ('f0000000-0000-4000-8000-000000000001', 't-tee',      'T Tee',      10000, true),
  ('f0000000-0000-4000-8000-000000000002', 't-unpub',    'T Unpub',    10000, false);
insert into public.product_variants (id, product_id, size, colour, stock) values
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'M',  'Black', 5),     -- V1
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001', 'L',  'Black', 1),     -- V2
  ('f1000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000001', 'XL', 'Black', 1000),  -- V3 bulk
  ('f1000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000002', 'M',  'Black', 5);     -- V4 unpublished

update public.site_settings set
  delivery_areas = array['Thamel'], delivery_fee_paisa = 5000,
  min_order_delivery_paisa = 20000, min_order_pickup_paisa = 0,
  prices_include_vat = true, service_charge_pct = 0,
  payment_methods_enabled = array['cod', 'pickup'], orders_paused = false;
update public.order_rules set
  cod_max_total_paisa = null, max_open_orders_per_phone = 2,
  ip_orders_max = 5, ip_window_minutes = 10, phone_orders_max_per_day = 5, retention_days = 90,
  ip_open_orders_max = 50, ip_orders_max_per_day = 100,          -- high here; sections 15-16 test them
  auto_cancel_placed_after_minutes = 120;

-- SEC-003: the auto-cancel job is scheduled (skipped where pg_cron is not installed)
select case when pg_temp.cron_job_exists('cafe-auto-cancel-unconfirmed') is null
            then skip('pg_cron is not installed here; schedule auto_cancel_unconfirmed_orders() another way', 1)
            else ok(pg_temp.cron_job_exists('cafe-auto-cancel-unconfirmed'), 'pg_cron job cafe-auto-cancel-unconfirmed is scheduled')
       end;

set local role service_role;

-- ===== 1. Happy path + re-pricing + stock decrement ===============================================================
create temp table o1 as select * from public.create_order(
  '[{"variantId": "f1000000-0000-4000-8000-000000000001", "qty": 2, "price": 1}]'::jsonb,
  'pickup', 'pickup', 'Test One', '+9779811111101', null, null, null, null, 'no onions', pg_temp.h('ip-1'));

select is((select out_total_paisa from o1), 20000, 'total is computed from DB prices (client "price" ignored)');
select is((select out_status from o1), 'placed', 'new order is placed');
select alike((select out_order_number from o1), 'NC-%', 'order number has the NC- prefix');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000001'), 3, 'stock decremented by qty');
select is((select unit_price_paisa from public.order_items where order_id = (select out_order_id from o1)), 10000, 'unit price snapshot comes from the DB');
select is((select payment_status from public.orders where id = (select out_order_id from o1)), 'unpaid', 'payment_status starts unpaid');
select is((select vat_paisa from public.orders where id = (select out_order_id from o1)), 2301, 'VAT portion of an inclusive total is round(total*13/113)');
select is((select ip_hash from public.orders where id = (select out_order_id from o1)), pg_temp.h('ip-1'), 'only the salted hash of the IP is stored');

-- ===== 2. Validation: minimum order, area, method, availability =====================================================
select alike(pg_temp.try($$select * from public.create_order(
    '[{"variantId": "f1000000-0000-4000-8000-000000000003", "qty": 1}]'::jsonb,
    'delivery', 'cod', 'Test Two', '+9779811111102', null, 'Addr 1', 'Near x', 'Thamel')$$),
  'VALIDATION|%Minimum order for delivery is Rs. 200%', 'minimum order for delivery is enforced with a readable message');

create temp table o3 as select * from public.create_order(
  '[{"variantId": "f1000000-0000-4000-8000-000000000003", "qty": 3}]'::jsonb,
  'delivery', 'cod', 'Test Three', '+9779811111103', null, 'Addr 1', 'Near x', 'Thamel');
select is((select out_total_paisa from o3), 35000, 'delivery total = items (30000) + delivery fee (5000), VAT inclusive');

select throws_ok($$select * from public.create_order(
    '[{"variantId": "f1000000-0000-4000-8000-000000000003", "qty": 3}]'::jsonb,
    'delivery', 'cod', 'Test', '+9779811111104', null, 'Addr', 'Near', 'Mars')$$,
  'P0001', 'VALIDATION', 'unknown delivery area is rejected');
select throws_ok($$select * from public.create_order(
    '[{"variantId": "f1000000-0000-4000-8000-000000000003", "qty": 3}]'::jsonb,
    'delivery', 'pickup', 'Test', '+9779811111104', null, 'Addr', 'Near', 'Thamel')$$,
  'P0001', 'VALIDATION', 'payment method must match fulfilment');
select throws_ok($$select pg_temp.place('+9779811111104', 'f1000000-0000-4000-8000-000000000004')$$,
  'P0001', 'VALIDATION', 'unpublished product cannot be ordered');
select throws_ok($$select pg_temp.place('+9779811111104', gen_random_uuid())$$,
  'P0001', 'VALIDATION', 'unknown variant is rejected');
select throws_ok($$select pg_temp.place('+9779811111104', 'f1000000-0000-4000-8000-000000000003', 11)$$,
  'P0001', 'VALIDATION', 'qty above 10 is rejected');
select throws_ok($$select * from public.create_order('[]'::jsonb, 'pickup', 'pickup', 'Test', '+9779811111104')$$,
  'P0001', 'VALIDATION', 'empty cart is rejected');
select throws_ok($$select pg_temp.place('12345', 'f1000000-0000-4000-8000-000000000003')$$,
  'P0001', 'VALIDATION', 'non-normalised phone is rejected');

-- ===== 3. Stock: insufficient, exact, sold out, atomic rollback =====================================================
create temp table s0 as select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003';

select throws_ok($$select * from public.create_order(
    '[{"variantId": "f1000000-0000-4000-8000-000000000003", "qty": 1}, {"variantId": "f1000000-0000-4000-8000-000000000002", "qty": 2}]'::jsonb,
    'pickup', 'pickup', 'Test', '+9779811111105')$$,
  'P0001', 'OUT_OF_STOCK', 'asking for more than the stock fails with OUT_OF_STOCK');
select alike(pg_temp.try($$select * from public.create_order(
    '[{"variantId": "f1000000-0000-4000-8000-000000000003", "qty": 1}, {"variantId": "f1000000-0000-4000-8000-000000000002", "qty": 2}]'::jsonb,
    'pickup', 'pickup', 'Test', '+9779811111105')$$),
  'OUT_OF_STOCK|%items.1%only 1 left%', 'OUT_OF_STOCK names the line and what is left');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003'), (select stock from s0),
          'a failed order leaves other lines untouched (all or nothing)');
select lives_ok($$select pg_temp.place('+9779811111105', 'f1000000-0000-4000-8000-000000000002', 1)$$, 'taking the last unit works');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000002'), 0, 'stock reaches exactly 0');
select alike(pg_temp.try($$select pg_temp.place('+9779811111106', 'f1000000-0000-4000-8000-000000000002', 1)$$),
  'OUT_OF_STOCK|%sold out%', 'a sold-out variant reports sold out');
select throws_ok($$update public.product_variants set stock = -1 where id = 'f1000000-0000-4000-8000-000000000001'$$,
  '23514', null::text, 'stock can never go below 0 (check constraint)');

-- ===== 4. COD maximum total ===========================================================================================
update public.order_rules set cod_max_total_paisa = 25000;
select throws_ok($$select pg_temp.place('+9779811111107', 'f1000000-0000-4000-8000-000000000003', 3)$$,
  'P0001', 'ORDER_REFUSED', 'total above the COD maximum is refused');
select is(pg_temp.try($$select pg_temp.place('+9779811111107', 'f1000000-0000-4000-8000-000000000003', 3)$$), 'ORDER_REFUSED|',
  'ORDER_REFUSED reveals no reason');
select lives_ok($$select pg_temp.place('+9779811111107', 'f1000000-0000-4000-8000-000000000003', 2)$$, 'total within the COD maximum is accepted');
update public.order_rules set cod_max_total_paisa = null;

-- ===== 5. Blocklist ====================================================================================================
insert into public.blocked_contacts (kind, value) values
  ('phone', '+9779812121212'),
  ('ip_hash', pg_temp.h('bad-ip'));
insert into public.blocked_contacts (kind, value, expires_at) values ('phone', '+9779813131313', now() - interval '1 day');

select throws_ok($$select pg_temp.place('+9779812121212', 'f1000000-0000-4000-8000-000000000003')$$,
  'P0001', 'ORDER_REFUSED', 'a blocked phone is refused');
select throws_ok($$select pg_temp.place('+9779812121299', 'f1000000-0000-4000-8000-000000000003', 1, pg_temp.h('bad-ip'))$$,
  'P0001', 'ORDER_REFUSED', 'a blocked IP hash is refused');
select lives_ok($$select pg_temp.place('+9779813131313', 'f1000000-0000-4000-8000-000000000003')$$, 'an expired block no longer applies');

-- ===== 6. Open orders per phone (cap 2) ================================================================================
create temp table c1 as select pg_temp.place('+9779814141414', 'f1000000-0000-4000-8000-000000000003') as tok;
select lives_ok($$select pg_temp.place('+9779814141414', 'f1000000-0000-4000-8000-000000000003')$$, 'second open order for a phone is accepted');
select throws_ok($$select pg_temp.place('+9779814141414', 'f1000000-0000-4000-8000-000000000003')$$,
  'P0001', 'ORDER_REFUSED', 'third open order for the same phone is refused');
select lives_ok($$select public.customer_cancel_order((select tok from c1))$$, 'customer cancels one order');
select lives_ok($$select pg_temp.place('+9779814141414', 'f1000000-0000-4000-8000-000000000003')$$, 'cancelling frees a slot under the cap');

-- ===== 7. DB backstop rate limits ======================================================================================
select lives_ok($$select count(pg_temp.place('+97798151515' || lpad(i::text, 2, '0'), 'f1000000-0000-4000-8000-000000000003', 1, pg_temp.h('ip-flood')))
                  from generate_series(1, 5) i$$, 'five orders from one IP hash inside the window are accepted');
select alike(pg_temp.try($$select pg_temp.place('+9779815151506', 'f1000000-0000-4000-8000-000000000003', 1, pg_temp.h('ip-flood'))$$),
  'RATE_LIMITED|%retryAfterSeconds%', 'the sixth order from the same IP hash is rate limited, with a retry hint');

update public.order_rules set phone_orders_max_per_day = 1;
create temp table c2 as select pg_temp.place('+9779816161616', 'f1000000-0000-4000-8000-000000000003') as tok;
select public.customer_cancel_order((select tok from c2));
select throws_ok($$select pg_temp.place('+9779816161616', 'f1000000-0000-4000-8000-000000000003')$$,
  'P0001', 'RATE_LIMITED', 'per-phone daily cap counts cancelled orders too');
update public.order_rules set phone_orders_max_per_day = 5;

-- ===== 8. State machine ================================================================================================
create temp table ta as select pg_temp.oid(pg_temp.place('+9779817171717', 'f1000000-0000-4000-8000-000000000003')) as id;   -- pickup
create temp table tb as select out_order_id as id from public.create_order(                                                  -- delivery
  '[{"variantId": "f1000000-0000-4000-8000-000000000003", "qty": 3}]'::jsonb,
  'delivery', 'cod', 'Test B', '+9779818181818', null, 'Addr', 'Near', 'Thamel');

select throws_ok($$select public.set_order_status((select id from ta), 'completed', 'f2000000-0000-4000-8000-000000000002')$$,
  'P0001', 'CONFLICT', 'placed -> completed is refused');
select throws_ok($$select public.set_order_status((select id from ta), 'placed', 'f2000000-0000-4000-8000-000000000002')$$,
  'P0001', 'CONFLICT', 'nothing can move back to placed');
select throws_ok($$select public.set_order_status((select id from ta), 'confirmed', gen_random_uuid())$$,
  'P0001', 'FORBIDDEN', 'an unknown actor is refused');
select throws_ok($$update public.orders set status = 'completed' where id = (select id from ta)$$,
  '42501', null::text, 'a direct UPDATE cannot jump status, even for the service role');
select throws_ok($$update public.orders set payment_status = 'paid' where id = (select id from ta)$$,
  '42501', null::text, 'a direct UPDATE cannot mark an order paid');
select throws_ok($$update public.orders set total_paisa = 1 where id = (select id from ta)$$,
  '42501', null::text, 'a direct UPDATE cannot change money');
select throws_ok($$update public.order_items set qty = 9$$, '42501', null::text, 'order items are immutable');
select lives_ok($$update public.orders set notes = 'staff note' where id = (select id from ta)$$, 'non-state columns stay editable');

select lives_ok($$select public.set_order_status((select id from ta), 'confirmed', 'f2000000-0000-4000-8000-000000000002')$$, 'staff confirms');
select ok((select confirmed_at is not null from public.orders where id = (select id from ta)), 'confirmed_at is stamped');
select throws_ok($$select public.set_order_status((select id from ta), 'out_for_delivery', 'f2000000-0000-4000-8000-000000000002')$$,
  'P0001', 'CONFLICT', 'a pickup order cannot go out for delivery');
select lives_ok($$select public.set_order_status((select id from ta), 'ready_for_pickup', 'f2000000-0000-4000-8000-000000000002')$$, 'pickup order becomes ready');
select lives_ok($$select public.set_order_status((select id from ta), 'completed', 'f2000000-0000-4000-8000-000000000002')$$, 'ready order completes');
select is((select payment_status from public.orders where id = (select id from ta)), 'paid', 'completing sets payment_status = paid');
select ok((select completed_at is not null from public.orders where id = (select id from ta)), 'completed_at is stamped');
select throws_ok($$select public.set_order_status((select id from ta), 'cancelled', 'f2000000-0000-4000-8000-000000000001', 'other', true)$$,
  'P0001', 'CONFLICT', 'a completed order is terminal');

-- delivery order
select throws_ok($$select public.set_order_status((select id from tb), 'out_for_delivery', 'f2000000-0000-4000-8000-000000000002')$$,
  'P0001', 'CONFLICT', 'placed -> out_for_delivery is refused');
select lives_ok($$select public.set_order_status((select id from tb), 'confirmed', 'f2000000-0000-4000-8000-000000000002')$$, 'delivery order confirmed');
select throws_ok($$select public.set_order_status((select id from tb), 'ready_for_pickup', 'f2000000-0000-4000-8000-000000000002')$$,
  'P0001', 'CONFLICT', 'a delivery order cannot be ready_for_pickup');
select lives_ok($$select public.set_order_status((select id from tb), 'out_for_delivery', 'f2000000-0000-4000-8000-000000000002')$$, 'delivery order goes out');
select throws_ok($$select public.set_order_status((select id from tb), 'cancelled', 'f2000000-0000-4000-8000-000000000002', 'refused', true)$$,
  'P0001', 'FORBIDDEN', 'staff cannot cancel an order that is out for delivery (owner only)');
select throws_ok($$select public.set_order_status((select id from tb), 'cancelled', 'f2000000-0000-4000-8000-000000000001', 'because', true)$$,
  'P0001', 'VALIDATION', 'cancel needs a valid reason');

-- ===== 9. Idempotent cancel-and-restock =================================================================================
create temp table sv1 as select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003';
select lives_ok($$select public.set_order_status((select id from tb), 'cancelled', 'f2000000-0000-4000-8000-000000000001', 'refused', true)$$,
  'owner cancels with restock');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003'), (select stock + 3 from sv1),
  'stock restored by the order quantity');
select ok((select stock_restocked_at is not null from public.orders where id = (select id from tb)), 'restock is recorded on the order');
create temp table sv2 as select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003';
select lives_ok($$select public.set_order_status((select id from tb), 'cancelled', 'f2000000-0000-4000-8000-000000000001', 'refused', true)$$,
  'cancelling again is a harmless no-op');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003'), (select stock from sv2),
  'a repeated cancel does not restock twice');

-- cancel without restock
create temp table tc as select pg_temp.oid(pg_temp.place('+9779819191910', 'f1000000-0000-4000-8000-000000000003', 2)) as id;
create temp table sv3 as select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003';
select lives_ok($$select public.cancel_order((select id from tc), 'f2000000-0000-4000-8000-000000000002', 'no_show', false)$$, 'cancel_order wrapper works for staff on a placed order');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003'), (select stock from sv3), 'restock = false leaves stock alone');
select is((select status from public.orders where id = (select id from tc)), 'cancelled', 'order is cancelled');

-- ===== 10. Customer cancel ==============================================================================================
create temp table td as select pg_temp.place('+9779819191911', 'f1000000-0000-4000-8000-000000000003', 4) as tok;
create temp table sv4 as select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003';
select lives_ok($$select public.customer_cancel_order((select tok from td))$$, 'customer cancels while placed');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003'), (select stock + 4 from sv4), 'customer cancel always restocks');
select is((select cancel_reason from public.orders where public_token = (select tok from td)), 'customer_request', 'reason is customer_request');
create temp table sv5 as select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003';
select lives_ok($$select public.customer_cancel_order((select tok from td))$$, 'cancelling again returns the same success');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000003'), (select stock from sv5), 'and does not restock again');

create temp table te as select pg_temp.place('+9779819191912', 'f1000000-0000-4000-8000-000000000003') as tok;
select public.set_order_status(pg_temp.oid((select tok from te)), 'confirmed', 'f2000000-0000-4000-8000-000000000002');
select throws_ok($$select public.customer_cancel_order((select tok from te))$$, 'P0001', 'CONFLICT', 'customer cannot cancel after confirmation');
select throws_ok($$select public.customer_cancel_order(gen_random_uuid())$$, 'P0001', 'NOT_FOUND', 'unknown token is NOT_FOUND');

-- ===== 11. Block the contact while cancelling ==========================================================================
create temp table tf as select pg_temp.oid(pg_temp.place('+9779820101010', 'f1000000-0000-4000-8000-000000000003')) as id;
select lives_ok($$select public.set_order_status((select id from tf), 'cancelled', 'f2000000-0000-4000-8000-000000000002', 'fake', true, true)$$,
  'staff cancels and blocks the contact in one call');
select is((select count(*)::int from public.blocked_contacts where kind = 'phone' and value = '+9779820101010'
             and created_by = 'f2000000-0000-4000-8000-000000000002'), 1, 'the phone is on the blocklist, attributed to staff');
select ok((select expires_at > now() + interval '11 months' from public.blocked_contacts where value = '+9779820101010'), 'block expires about 12 months out');
select throws_ok($$select pg_temp.place('+9779820101010', 'f1000000-0000-4000-8000-000000000003')$$,
  'P0001', 'ORDER_REFUSED', 'the blocked phone can no longer order');

-- ===== 12. rate_limit_hit ===============================================================================================
select is((select array_agg(public.rate_limit_hit('t:k1', 604800, 3)) from generate_series(1, 5)),
          array[true, true, true, false, false], 'rate_limit_hit allows 3 then denies');
select ok(public.rate_limit_hit('t:k2', 604800, 3), 'a different key has its own counter');
select ok((select retry_after_seconds > 0 from public.rate_limit_hit_info('t:k1', 604800, 3)), 'denied hits report a Retry-After');

-- ===== 13. SEC-001: refusal rules run only after the order is otherwise valid ===========================================
-- A blocked phone (or one at its open-order cap) must get exactly the same answer as a clean phone whenever the basket
-- itself is bad, so a bad item cannot be used to probe the blocklist or the caps.
insert into public.blocked_contacts (kind, value) values ('phone', '+9779826262626');

select is(pg_temp.try($$select pg_temp.place('+9779826262626', 'f1000000-0000-4000-8000-0000000000ff')$$),
          pg_temp.try($$select pg_temp.place('+9779826262627', 'f1000000-0000-4000-8000-0000000000ff')$$),
          'SEC-001: unknown item -> same error for a blocked phone and a clean phone');
select alike(pg_temp.try($$select pg_temp.place('+9779826262626', 'f1000000-0000-4000-8000-0000000000ff')$$),
          'VALIDATION|%no longer available%', 'SEC-001: ... and that error is VALIDATION, not ORDER_REFUSED');
select is(pg_temp.try($$select pg_temp.place('+9779826262626', 'f1000000-0000-4000-8000-000000000004')$$),
          pg_temp.try($$select pg_temp.place('+9779826262627', 'f1000000-0000-4000-8000-000000000004')$$),
          'SEC-001: unpublished item -> same error for blocked and clean phones');
select is(pg_temp.try($$select * from public.create_order('[{"variantId": "f1000000-0000-4000-8000-000000000003", "qty": 1}]'::jsonb,
            'delivery', 'cod', 'Test', '+9779826262626', null, 'Addr', 'Near', 'Thamel')$$),
          pg_temp.try($$select * from public.create_order('[{"variantId": "f1000000-0000-4000-8000-000000000003", "qty": 1}]'::jsonb,
            'delivery', 'cod', 'Test', '+9779826262627', null, 'Addr', 'Near', 'Thamel')$$),
          'SEC-001: basket under the delivery minimum -> same error for blocked and clean phones');
select is(pg_temp.try($$select pg_temp.place('+9779826262626', 'f1000000-0000-4000-8000-000000000002')$$),
          pg_temp.try($$select pg_temp.place('+9779826262627', 'f1000000-0000-4000-8000-000000000002')$$),
          'SEC-001: sold-out item -> same OUT_OF_STOCK for blocked and clean phones');
select alike(pg_temp.try($$select pg_temp.place('+9779814141414', 'f1000000-0000-4000-8000-0000000000ff')$$),
          'VALIDATION|%', 'SEC-001: a phone at its open-order cap also gets VALIDATION for a bad item');
select is(pg_temp.try($$select pg_temp.place('+9779826262626', 'f1000000-0000-4000-8000-000000000003')$$), 'ORDER_REFUSED|',
          'SEC-001: a fully valid order from the blocked phone is refused, with no detail');

-- ===== 14. BUG-003: COD maximum 0 or NULL = no limit ====================================================================
update public.order_rules set cod_max_total_paisa = 0;
select lives_ok($$select pg_temp.place('+9779827272727', 'f1000000-0000-4000-8000-000000000003', 10)$$, 'BUG-003: COD max 0 means no limit');
update public.order_rules set cod_max_total_paisa = null;
select lives_ok($$select pg_temp.place('+9779827272728', 'f1000000-0000-4000-8000-000000000003', 10)$$, 'BUG-003: COD max NULL means no limit');
select throws_ok($$update public.order_rules set cod_max_total_paisa = -1$$, '23514', null::text, 'a negative COD max is rejected');

-- ===== 15. SEC-003: kill switch and per-IP open-order cap ===============================================================
update public.site_settings set orders_paused = true;
select is(pg_temp.try($$select pg_temp.place('+9779828282828', 'f1000000-0000-4000-8000-000000000003')$$), 'ORDERS_PAUSED|',
          'SEC-003: while paused every order gets ORDERS_PAUSED (no detail)');
select is(pg_temp.try($$select pg_temp.place('+9779826262626', 'f1000000-0000-4000-8000-0000000000ff')$$), 'ORDERS_PAUSED|',
          'SEC-003: ORDERS_PAUSED is checked first (same for a blocked phone with a bad item)');
update public.site_settings set orders_paused = false;
select lives_ok($$select pg_temp.place('+9779828282828', 'f1000000-0000-4000-8000-000000000003')$$, 'unpausing restores ordering');

update public.order_rules set ip_open_orders_max = 2;
create temp table ipo as select pg_temp.place('+9779829292901', 'f1000000-0000-4000-8000-000000000003', 1, pg_temp.h('ip-open')) as tok;
select lives_ok($$select pg_temp.place('+9779829292902', 'f1000000-0000-4000-8000-000000000003', 1, pg_temp.h('ip-open'))$$,
                'second open order from one IP hash is accepted');
select is(pg_temp.try($$select pg_temp.place('+9779829292903', 'f1000000-0000-4000-8000-000000000003', 1, pg_temp.h('ip-open'))$$), 'ORDER_REFUSED|',
          'SEC-003: a third open order from the same IP hash (new phone) is refused');
select alike(pg_temp.try($$select pg_temp.place('+9779829292903', 'f1000000-0000-4000-8000-0000000000ff', 1, pg_temp.h('ip-open'))$$), 'VALIDATION|%',
          'SEC-003: the IP cap is also checked only after validation');
select lives_ok($$select public.customer_cancel_order((select tok from ipo))$$, 'customer cancels one of them');
select lives_ok($$select pg_temp.place('+9779829292903', 'f1000000-0000-4000-8000-000000000003', 1, pg_temp.h('ip-open'))$$, 'cancelling frees an IP slot');
update public.order_rules set ip_open_orders_max = 50;

-- ===== 16. SEC-003: per-IP 24 h cap =====================================================================================
update public.order_rules set ip_orders_max_per_day = 3;
select lives_ok($$select count(pg_temp.place('+97798303030' || lpad(i::text, 2, '0'), 'f1000000-0000-4000-8000-000000000003', 1, pg_temp.h('ip-day')))
                  from generate_series(1, 3) i$$, 'three orders from one IP hash in a day are accepted');
select alike(pg_temp.try($$select pg_temp.place('+9779830303004', 'f1000000-0000-4000-8000-000000000003', 1, pg_temp.h('ip-day'))$$),
  'RATE_LIMITED|%retryAfterSeconds%', 'SEC-003: the fourth order from that IP hash within 24 h is rate limited');
update public.order_rules set ip_orders_max_per_day = 100;

-- ===== 17. SEC-003: auto-cancel of stale placed orders ==================================================================
create temp table ac_old  as select pg_temp.oid(pg_temp.place('+9779831313101', 'f1000000-0000-4000-8000-000000000001', 1)) as id;
create temp table ac_conf as select pg_temp.oid(pg_temp.place('+9779831313102', 'f1000000-0000-4000-8000-000000000003', 1)) as id;
select public.set_order_status((select id from ac_conf), 'confirmed', 'f2000000-0000-4000-8000-000000000002');
create temp table ac_new  as select pg_temp.oid(pg_temp.place('+9779831313103', 'f1000000-0000-4000-8000-000000000003', 1)) as id;
select set_config('app.order_transition', 'on', true);
update public.orders set created_at = now() - interval '3 hours'
 where id in (select id from ac_old union all select id from ac_conf);
select set_config('app.order_transition', 'off', true);
create temp table acs0 as select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000001';

create temp table ac1 as select public.auto_cancel_unconfirmed_orders() as r;
select is(((select r from ac1) ->> 'cancelled')::int, 1, 'SEC-003: exactly one stale placed order is auto-cancelled');
select is((select status || '/' || cancel_reason from public.orders where id = (select id from ac_old)),
          'cancelled/auto_unconfirmed', 'it is cancelled with reason auto_unconfirmed');
select ok((select stock_restocked_at is not null from public.orders where id = (select id from ac_old)), 'the restock is recorded');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000001'), (select stock + 1 from acs0), 'its stock is restored');
select is((select status from public.orders where id = (select id from ac_conf)), 'confirmed', 'an old but confirmed order is not touched');
select is((select status from public.orders where id = (select id from ac_new)), 'placed', 'a fresh placed order is not touched');
create temp table ac2 as select public.auto_cancel_unconfirmed_orders() as r;
select is(((select r from ac2) ->> 'cancelled')::int, 0, 'a second run finds nothing to do');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000001'), (select stock + 1 from acs0), 'and never restocks twice');

update public.order_rules set auto_cancel_placed_after_minutes = null;
select set_config('app.order_transition', 'on', true);
update public.orders set created_at = now() - interval '3 hours' where id = (select id from ac_new);
select set_config('app.order_transition', 'off', true);
select is(public.auto_cancel_unconfirmed_orders() ->> 'enabled', 'false', 'a NULL timeout switches auto-cancel off');
select is((select status from public.orders where id = (select id from ac_new)), 'placed', 'so the stale order stays placed');
update public.order_rules set auto_cancel_placed_after_minutes = 120;
select throws_ok($$select public.set_order_status((select id from ac_new), 'cancelled', 'f2000000-0000-4000-8000-000000000002', 'auto_unconfirmed', true)$$,
  'P0001', 'VALIDATION', 'staff cannot use the system-only reason auto_unconfirmed');

-- ===== 18. SEC-008: blocking never overwrites an existing entry =========================================================
create temp table tg as select pg_temp.oid(pg_temp.place('+9779832323201', 'f1000000-0000-4000-8000-000000000003')) as id;
insert into public.blocked_contacts (kind, value, reason, created_by, expires_at)
values ('phone', '+9779832323201', 'owner: repeat no-show', 'f2000000-0000-4000-8000-000000000001', now() + interval '36 months');

select lives_ok($$select public.set_order_status((select id from tg), 'cancelled', 'f2000000-0000-4000-8000-000000000002', 'fake', true, true)$$,
  'staff cancel-and-block on an already blocked phone succeeds');
select is((select reason || '|' || created_by::text from public.blocked_contacts where value = '+9779832323201'),
          'owner: repeat no-show|f2000000-0000-4000-8000-000000000001',
          'SEC-008: the existing entry keeps its reason and creator');
select ok((select expires_at > now() + interval '35 months' from public.blocked_contacts where value = '+9779832323201'),
          'SEC-008: ... and its longer expiry');

create temp table bc1 as select * from public.block_contact('phone', '+9779832323201', 'staff retry', 'f2000000-0000-4000-8000-000000000002');
select is((select out_created from bc1), false, 'block_contact on a live entry creates nothing');
select is((select reason from public.blocked_contacts where value = '+9779832323201'), 'owner: repeat no-show',
          'block_contact on a live entry changes nothing');

insert into public.blocked_contacts (kind, value, reason, expires_at)
values ('phone', '+9779832323202', 'old', now() - interval '1 day');
create temp table bc2 as select * from public.block_contact('phone', '+9779832323202', 'new block', 'f2000000-0000-4000-8000-000000000002');
select ok((select out_created and out_expires_at > now() + interval '11 months' from bc2),
          'an expired (not yet purged) entry is replaced by a fresh block');
select is((select created_by from public.blocked_contacts where value = '+9779832323202'),
          'f2000000-0000-4000-8000-000000000002'::uuid, 'the fresh block is attributed to the staff member');
select ok((select out_created from public.block_contact('ip_hash', pg_temp.h('ip-block'), null, 'f2000000-0000-4000-8000-000000000002')),
          'block_contact creates a new IP-hash entry');
select throws_ok($$select * from public.block_contact('ip_hash', '1.2.3.4', null, 'f2000000-0000-4000-8000-000000000002')$$,
  'P0001', 'VALIDATION', 'block_contact rejects a raw IP');
select throws_ok($$select * from public.block_contact('phone', '+9779832323203', null, gen_random_uuid())$$,
  'P0001', 'FORBIDDEN', 'block_contact refuses an unknown actor');
select throws_ok($$update public.blocked_contacts set created_by = 'f2000000-0000-4000-8000-000000000002' where value = '+9779832323201'$$,
  '42501', null::text, 'SEC-008: created_by cannot be rewritten, even by the service role');
select throws_ok($$update public.blocked_contacts set value = '+9779832323299' where value = '+9779832323201'$$,
  '42501', null::text, 'SEC-008: the blocked value cannot be changed');
select lives_ok($$update public.blocked_contacts set expires_at = now() + interval '48 months', reason = 'owner renewed'
                   where value = '+9779832323201'$$, 'renewing (expires_at, reason) still works');

-- ===== 19. Retention purge ==============================================================================================
insert into public.blocked_contacts (kind, value) values ('phone', '+9779817171717');                       -- A's phone, still valid
insert into public.blocked_contacts (kind, value, expires_at) values ('phone', '+9779821212121', now() - interval '1 day');
select set_config('app.order_transition', 'on', true);
update public.orders set completed_at = now() - interval '100 days' where id = (select id from ta);          -- old completed order
update public.orders set created_at   = now() - interval '200 days' where id = (select out_order_id from o1); -- old but still open
select set_config('app.order_transition', 'off', true);

create temp table pr as select public.purge_personal_data() as r;
select ok(((select r from pr) ->> 'ordersPurged')::int >= 1, 'purge reports at least one order blanked');
select ok((select customer_phone is null and customer_name is null and personal_data_purged_at is not null and ip_hash is null
             from public.orders where id = (select id from ta)), 'old completed order lost its personal data');
select ok((select total_paisa > 0 and status = 'completed' from public.orders where id = (select id from ta)), 'but kept status and money for the books');
select ok((select count(*) > 0 from public.order_items where order_id = (select id from ta)), 'and kept its items');
select ok((select customer_phone is not null from public.orders where id = (select out_order_id from o1)), 'open orders are never purged, however old');
select is((select count(*)::int from public.blocked_contacts where value = '+9779821212121'), 0, 'expired blocklist entries are deleted');
select is((select count(*)::int from public.blocked_contacts where value = '+9779817171717'), 1, 'blanking an order does not delete a live blocklist entry');

reset role;
select * from finish();
rollback;

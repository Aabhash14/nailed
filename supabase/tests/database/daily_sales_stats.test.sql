-- daily_sales_stats.test.sql  (pgTAP; run with `supabase test db`)
-- Migrations 20261025000001_daily_sales.sql + 20261025000002_stats.sql.
-- Proves: structure + grants (SEC-007: service role only for every new RPC); Kathmandu day boundaries; RLS (anon
-- denied; staff may write today/yesterday only and cannot read older days, cannot delete, cannot change the price
-- snapshot or the date; owner may write any past date, never a future one); upsert_daily_sales (actor/role rules,
-- validation, server-side price snapshot, merge semantics, snapshot kept after a menu price change, history kept
-- after an item is hard-deleted); every stats RPC (owner only, exact numbers, compare math, Kathmandu buckets,
-- cancellations, stock alerts).
-- Self-contained: fixtures use 'DS ' names, 2021 dates for the stats ranges, and today/yesterday for the window rules.
-- Any log already on those dates (demo data, QA) is deleted INSIDE the test transaction only: everything is rolled
-- back at the end, so local data is unchanged. Does not depend on seed.sql.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ===== Fixtures (as postgres) ===================================================================================
delete from public.daily_sales
 where business_date between (now() at time zone 'Asia/Kathmandu')::date - 40 and (now() at time zone 'Asia/Kathmandu')::date + 1
    or business_date between date '2020-01-01' and date '2021-12-31';

insert into auth.users (id, email) values
  ('fa000000-0000-4000-8000-000000000001', 'ds-owner@test.invalid'),
  ('fa000000-0000-4000-8000-000000000002', 'ds-staff@test.invalid');
insert into public.profiles (id, role, display_name) values
  ('fa000000-0000-4000-8000-000000000001', 'owner', 'DS Owner'),
  ('fa000000-0000-4000-8000-000000000002', 'staff', 'DS Staff');

insert into public.menu_categories (id, slug, name) values
  ('fb000000-0000-4000-8000-000000000001', 'ds-cat', 'DS Cat');
insert into public.menu_items (id, category_id, name, price_paisa) values
  ('fc000000-0000-4000-8000-000000000001', 'fb000000-0000-4000-8000-000000000001', 'DS Chai',  10000),
  ('fc000000-0000-4000-8000-000000000002', 'fb000000-0000-4000-8000-000000000001', 'DS Momo',  20000),
  ('fc000000-0000-4000-8000-000000000003', 'fb000000-0000-4000-8000-000000000001', 'DS Gone',   5000),
  ('fc000000-0000-4000-8000-000000000004', 'fb000000-0000-4000-8000-000000000001', 'DS Lassi',  5000);
insert into public.menu_variants (id, item_id, kind, label, price_delta_paisa) values
  ('fd000000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'size',  'DS Large', 3000),
  ('fd000000-0000-4000-8000-000000000002', 'fc000000-0000-4000-8000-000000000002', 'addon', 'DS Extra', 1000),
  ('fd000000-0000-4000-8000-000000000003', 'fc000000-0000-4000-8000-000000000003', 'size',  'DS Big',    500);

insert into public.products (id, slug, name, price_paisa, is_published) values
  ('fe000000-0000-4000-8000-000000000001', 'ds-tee', 'DS Tee', 100000, true);
insert into public.product_variants (id, product_id, size, colour, stock) values
  ('ff000000-0000-4000-8000-000000000001', 'fe000000-0000-4000-8000-000000000001', 'M',  'Black',  0),   -- sold_out
  ('ff000000-0000-4000-8000-000000000002', 'fe000000-0000-4000-8000-000000000001', 'L',  'Black',  2),   -- few_left
  ('ff000000-0000-4000-8000-000000000003', 'fe000000-0000-4000-8000-000000000001', 'XL', 'Black', 10);   -- in_stock

-- Orders are inserted directly (fixed timestamps; the guard trigger only restricts UPDATEs).
create function pg_temp.mk_order(p_created timestamptz, p_status text, p_done timestamptz, p_reason text,
                                 p_variant uuid, p_qty integer, p_unit integer)
returns uuid language plpgsql as $$
declare
  v uuid;
begin
  insert into public.orders (status, fulfilment, payment_method, payment_status, prices_include_vat,
                             subtotal_paisa, total_paisa, customer_name, customer_phone, cancel_reason,
                             created_at, completed_at, cancelled_at)
  values (p_status, 'pickup', 'pickup', case when p_status = 'completed' then 'paid' else 'unpaid' end, true,
          p_qty * p_unit, p_qty * p_unit, 'DS Customer', '+9779811111111', p_reason,
          p_created, case when p_status = 'completed' then p_done end,
          case when p_status = 'cancelled' then coalesce(p_done, p_created) end)
  returning id into v;
  insert into public.order_items (order_id, product_variant_id, name, variant_label, unit_price_paisa, qty)
  values (v, p_variant, 'DS Tee', 'snapshot', p_unit, p_qty);
  return v;
end;
$$;

-- Error message + detail of a statement, for asserting VALIDATION field keys.
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare
  m text; d text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail;
  return m || ' ' || coalesce(d, '');
end;
$$;
grant execute on function pg_temp.err(text) to service_role;

-- ===== Structure and privileges ================================================================================
select has_table('public', 'daily_sales', 'daily_sales exists');
select has_table('public', 'daily_sales_lines', 'daily_sales_lines exists');
select ok((select relrowsecurity from pg_class where oid = 'public.daily_sales'::regclass)
          and (select relrowsecurity from pg_class where oid = 'public.daily_sales_lines'::regclass),
          'RLS is enabled on both tables');
select col_type_is('public', 'daily_sales', 'business_date', 'date', 'business_date is a date (Kathmandu)');
select col_type_is('public', 'daily_sales', 'created_at', 'timestamp with time zone', 'timestamps are timestamptz');
select col_type_is('public', 'daily_sales_lines', 'line_total_paisa', 'bigint', 'line_total_paisa is bigint');
select is((select attgenerated::text from pg_attribute
            where attrelid = 'public.daily_sales_lines'::regclass and attname = 'line_total_paisa'), 's',
          'line_total_paisa is a stored generated column');
select ok(exists (select 1 from pg_constraint where conname = 'daily_sales_business_date_key' and contype = 'u'),
          'one log per business_date');
select ok(exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
                   where c.relname = 'daily_sales_lines_one_per_item' and i.indisunique and i.indnullsnotdistinct),
          'one line per (day, item, variant), NULLS NOT DISTINCT');
select ok(exists (select 1 from pg_indexes where indexname = 'orders_completed_at_idx'), 'orders_completed_at_idx exists');
select ok(not has_table_privilege('anon', 'public.daily_sales', 'select')
          and not has_table_privilege('anon', 'public.daily_sales_lines', 'select')
          and not has_table_privilege('anon', 'public.daily_sales', 'insert'),
          'anon has no table privileges on the sales log');

select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('upsert_daily_sales', 'get_daily_sales', 'stats_overview', 'stats_timeseries',
                                'stats_top_food', 'stats_best_food_per_day', 'stats_top_merch', 'stats_busy_heatmap',
                                'stats_cancellations', 'stats_stock_alerts')
              and p.prosecdef and p.proconfig @> array['search_path=""']
              and has_function_privilege('service_role', p.oid, 'execute')
              and not has_function_privilege('anon', p.oid, 'execute')
              and not has_function_privilege('authenticated', p.oid, 'execute')),
          10, 'all 10 new RPCs: SECURITY DEFINER, search_path empty, service_role only (SEC-007)');

-- ===== Kathmandu day boundaries ================================================================================
select is(private.ktm_date('2026-10-24 18:14:59+00'), date '2026-10-24', 'ktm_date: 23:59:59 +05:45 is still the same day');
select is(private.ktm_date('2026-10-24 18:15:00+00'), date '2026-10-25', 'ktm_date: 00:00 +05:45 is the next day');
select is(private.ktm_day_start(date '2026-10-25'), '2026-10-24 18:15:00+00'::timestamptz,
          'ktm_day_start: a Kathmandu day starts at 18:15 UTC the day before');
select is(private.ktm_today(), (now() at time zone 'Asia/Kathmandu')::date, 'ktm_today is the Kathmandu date');

-- ===== RLS: anon ================================================================================================
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$select * from public.daily_sales$$, '42501', null, 'anon cannot read daily_sales');
select throws_ok($$select * from public.daily_sales_lines$$, '42501', null, 'anon cannot read daily_sales_lines');
select throws_ok($$insert into public.daily_sales (business_date) values ((now() at time zone 'Asia/Kathmandu')::date)$$,
                 '42501', null, 'anon cannot insert a log');
select throws_ok($$select public.stats_overview('2021-03-01', '2021-03-07')$$, '42501', null, 'anon cannot call stats_overview');
reset role;

-- ===== RLS: staff JWT, direct table writes =====================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"fa000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select lives_ok($$insert into public.daily_sales (business_date, note, created_by)
                  values ((now() at time zone 'Asia/Kathmandu')::date, 'DS staff today', 'fa000000-0000-4000-8000-000000000001')$$,
                'staff can create today''s log');
select lives_ok($$insert into public.daily_sales (business_date, note)
                  values ((now() at time zone 'Asia/Kathmandu')::date - 1, 'DS staff yesterday')$$,
                'staff can create yesterday''s log (late closing)');
select throws_ok($$insert into public.daily_sales (business_date) values ((now() at time zone 'Asia/Kathmandu')::date - 2)$$,
                 '42501', null, 'staff cannot create a log 2 days back');
select throws_ok($$insert into public.daily_sales (business_date) values ((now() at time zone 'Asia/Kathmandu')::date + 1)$$,
                 '42501', null, 'staff cannot create a log for tomorrow');
select lives_ok($$insert into public.daily_sales_lines (daily_sales_id, menu_item_id, variant_id, qty, unit_price_paisa, name_snapshot)
                  select d.id, 'fc000000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001', 4, 1, 'hacked'
                    from public.daily_sales d where d.business_date = (now() at time zone 'Asia/Kathmandu')::date$$,
                'staff can add a line to today''s log');
select lives_ok($$update public.daily_sales_lines set qty = 6
                   where menu_item_ref = 'fc000000-0000-4000-8000-000000000001'$$,
                'staff can change a qty today');
select throws_ok($$update public.daily_sales_lines set unit_price_paisa = 1
                    where menu_item_ref = 'fc000000-0000-4000-8000-000000000001'$$,
                 '42501', null, 'staff cannot change the price snapshot');
select throws_ok($$update public.daily_sales set business_date = business_date - 1
                    where business_date = (now() at time zone 'Asia/Kathmandu')::date$$,
                 '42501', null, 'business_date cannot be changed (moving today to yesterday is refused)');
with x as (delete from public.daily_sales_lines returning 1)
select is(count(*)::int, 0, 'staff cannot delete lines (0 rows)') from x;
with x as (delete from public.daily_sales returning 1)
select is(count(*)::int, 0, 'staff cannot delete logs (0 rows)') from x;
reset role;

select is((select created_by from public.daily_sales where note = 'DS staff today'),
          'fa000000-0000-4000-8000-000000000002'::uuid, 'created_by is forced to the staff member (not what was sent)');
select is((select updated_by from public.daily_sales where note = 'DS staff today'),
          'fa000000-0000-4000-8000-000000000002'::uuid, 'updated_by is the staff member');
select is((select unit_price_paisa from public.daily_sales_lines where menu_item_ref = 'fc000000-0000-4000-8000-000000000001'),
          13000, 'direct insert: price snapshotted from the menu (10000 + 3000 variant), the sent 1 ignored');
select is((select name_snapshot || ' / ' || variant_label_snapshot from public.daily_sales_lines
            where menu_item_ref = 'fc000000-0000-4000-8000-000000000001'),
          'DS Chai / DS Large', 'direct insert: name and variant label snapshotted from the menu');
select is((select line_total_paisa from public.daily_sales_lines where menu_item_ref = 'fc000000-0000-4000-8000-000000000001'),
          78000::bigint, 'line_total_paisa = qty 6 x 13000');
select is((select count(*)::int from public.daily_sales_lines l join public.daily_sales d on d.id = l.daily_sales_id
            where d.note = 'DS staff today'), 1, 'the staff delete removed nothing');
select ok((select count(*) from public.daily_sales) >= 2, 'the staff delete removed no logs');

-- ===== RLS: owner JWT ===========================================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"fa000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$insert into public.daily_sales (id, business_date, note)
                  values ('fa000000-0000-4000-8000-0000000000d1', (now() at time zone 'Asia/Kathmandu')::date - 5, 'DS owner old')$$,
                'owner can create a log for an older date');
select lives_ok($$insert into public.daily_sales_lines (daily_sales_id, menu_item_id, qty)
                  select d.id, 'fc000000-0000-4000-8000-000000000002', 3 from public.daily_sales d where d.note = 'DS owner old'$$,
                'owner can add a line to an older date');
select throws_ok($$insert into public.daily_sales (business_date) values ((now() at time zone 'Asia/Kathmandu')::date + 1)$$,
                 '42501', null, 'owner cannot create a log for a future date');
select is((select count(*)::int from public.daily_sales where note like 'DS %'), 3, 'owner reads every log');
select throws_ok($$select public.stats_overview('2021-03-01', '2021-03-07', null, null, 'fa000000-0000-4000-8000-000000000001')$$,
                 '42501', null, 'owner JWT cannot call stats RPCs directly (service role only, SEC-007)');
reset role;

-- staff cannot see or change the older day
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"fa000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from public.daily_sales where note = 'DS owner old'), 0, 'staff cannot read a log older than yesterday');
select is((select count(*)::int from public.daily_sales_lines where menu_item_ref = 'fc000000-0000-4000-8000-000000000002'), 0,
          'staff cannot read lines of an older log');
with x as (update public.daily_sales_lines set qty = 99
            where menu_item_ref = 'fc000000-0000-4000-8000-000000000002' returning 1)
select is(count(*)::int, 0, 'staff update of an older line changes 0 rows') from x;
select throws_ok($$insert into public.daily_sales_lines (daily_sales_id, menu_item_id, qty)
                   values ('fa000000-0000-4000-8000-0000000000d1', 'fc000000-0000-4000-8000-000000000001', 1)$$,
                 '42501', null, 'staff cannot add a line to an older log (RLS)');
select is((select count(*)::int from public.daily_sales where note like 'DS %'), 2, 'staff reads only today and yesterday');
reset role;
select is((select qty from public.daily_sales_lines where menu_item_ref = 'fc000000-0000-4000-8000-000000000002'), 3,
          'the older line is unchanged');

-- ===== upsert_daily_sales (service role) =======================================================================
delete from public.daily_sales where note like 'DS %';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is((public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date,
             '[{"menuItemId": "fc000000-0000-4000-8000-000000000001", "qty": 5},
               {"menuItemId": "fc000000-0000-4000-8000-000000000001", "variantId": "fd000000-0000-4000-8000-000000000001", "qty": 2},
               {"menuItemId": "fc000000-0000-4000-8000-000000000002", "variantId": null, "qty": 3, "unitPricePaisa": 1}]'::jsonb,
             50000, '  first  ', 'fa000000-0000-4000-8000-000000000002') ->> 'linesTotalPaisa')::bigint,
          136000::bigint, 'staff logs today: total 5x10000 + 2x13000 + 3x20000 (client price ignored)');
select is((public.get_daily_sales((now() at time zone 'Asia/Kathmandu')::date, 'fa000000-0000-4000-8000-000000000002')
             -> 'lines') @> '[{"menuItemId": "fc000000-0000-4000-8000-000000000002", "unitPricePaisa": 20000, "qty": 3}]'::jsonb,
          true, 'price snapshot is the menu price (20000), not the sent 1');
select is(public.get_daily_sales((now() at time zone 'Asia/Kathmandu')::date, 'fa000000-0000-4000-8000-000000000002')
            - 'lines' - 'id' - 'createdAt' - 'updatedAt' - 'businessDate',
          jsonb_build_object('tillTotalPaisa', 50000, 'note', 'first', 'createdBy', 'fa000000-0000-4000-8000-000000000002',
                             'updatedBy', 'fa000000-0000-4000-8000-000000000002', 'linesTotalPaisa', 136000, 'itemsSold', 10),
          'header: till total, trimmed note, audit columns, totals');
select lives_ok($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date - 1,
                    '[{"menuItemId": "fc000000-0000-4000-8000-000000000002", "qty": 1}]', null, null,
                    'fa000000-0000-4000-8000-000000000002')$$, 'staff can log yesterday');
select throws_ok($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date - 2,
                     '[{"menuItemId": "fc000000-0000-4000-8000-000000000002", "qty": 1}]', null, null,
                     'fa000000-0000-4000-8000-000000000002')$$, 'P0001', 'FORBIDDEN', 'staff cannot log 2 days back');
select lives_ok($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date - 30,
                    '[{"menuItemId": "fc000000-0000-4000-8000-000000000003", "variantId": "fd000000-0000-4000-8000-000000000003", "qty": 4}]',
                    null, 'DS owner back-fill', 'fa000000-0000-4000-8000-000000000001')$$, 'owner can log 30 days back');
select throws_ok($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date + 1, '[]', null, null,
                     'fa000000-0000-4000-8000-000000000001')$$, 'P0001', 'VALIDATION', 'nobody can log a future date');
select throws_ok($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date, '[]', null, null, null)$$,
                 'P0001', 'FORBIDDEN', 'no actor = FORBIDDEN');
select throws_ok($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date, '[]', null, null,
                     '00000000-0000-4000-8000-0000000000ff')$$, 'P0001', 'FORBIDDEN', 'unknown actor = FORBIDDEN');
select is(pg_temp.err($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date,
            '[{"menuItemId": "fc000000-0000-4000-8000-000000000001", "qty": 10000}]', null, null,
            'fa000000-0000-4000-8000-000000000001')$$) like 'VALIDATION %"lines.0"%', true, 'qty 10000 -> VALIDATION lines.0');
select is(pg_temp.err($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date,
            '[{"menuItemId": "fc000000-0000-4000-8000-000000000001", "qty": 1}, {"menuItemId": "fc000000-0000-4000-8000-000000000001", "qty": -1}]',
            null, null, 'fa000000-0000-4000-8000-000000000001')$$) like 'VALIDATION %"lines.1"%', true, 'qty -1 -> VALIDATION lines.1');
select is(pg_temp.err($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date,
            '[{"menuItemId": "fc000000-0000-4000-8000-000000000001", "qty": 1.5}]', null, null,
            'fa000000-0000-4000-8000-000000000001')$$) like 'VALIDATION %', true, 'qty 1.5 -> VALIDATION');
select is(pg_temp.err($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date,
            '[{"menuItemId": "fc000000-0000-4000-8000-000000000001", "qty": "5"}]', null, null,
            'fa000000-0000-4000-8000-000000000001')$$) like 'VALIDATION %', true, 'qty as a string -> VALIDATION');
select is(pg_temp.err($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date,
            '[{"menuItemId": "00000000-0000-4000-8000-000000000999", "qty": 1}]', null, null,
            'fa000000-0000-4000-8000-000000000001')$$) like 'VALIDATION %unknown menu item%', true, 'unknown item -> VALIDATION');
select is(pg_temp.err($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date,
            '[{"menuItemId": "fc000000-0000-4000-8000-000000000001", "variantId": "fd000000-0000-4000-8000-000000000002", "qty": 1}]',
            null, null, 'fa000000-0000-4000-8000-000000000001')$$) like 'VALIDATION %unknown variant for this item%', true,
          'variant of another item -> VALIDATION');
select is(pg_temp.err($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date,
            '[{"menuItemId": "fc000000-0000-4000-8000-000000000002", "qty": 1}, {"menuItemId": "fc000000-0000-4000-8000-000000000002", "qty": 2}]',
            null, null, 'fa000000-0000-4000-8000-000000000001')$$) like 'VALIDATION %more than once%', true,
          'duplicate item/variant -> VALIDATION');
select is(pg_temp.err($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date, '[]', -1, null,
            'fa000000-0000-4000-8000-000000000001')$$) like 'VALIDATION %tillTotal%', true, 'negative till total -> VALIDATION');
select throws_ok($$select public.get_daily_sales((now() at time zone 'Asia/Kathmandu')::date - 30,
                     'fa000000-0000-4000-8000-000000000002')$$, 'P0001', 'FORBIDDEN', 'staff cannot read a log 30 days back');
select is(public.get_daily_sales(date '2020-06-01', 'fa000000-0000-4000-8000-000000000001'), null::jsonb,
          'get_daily_sales returns null for a day with no log');
reset role;

-- Price change after logging: existing line keeps its snapshot, new lines take the new price. Merge semantics.
update public.menu_items set price_paisa = 15000 where id = 'fc000000-0000-4000-8000-000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date,
             '[{"menuItemId": "fc000000-0000-4000-8000-000000000001", "qty": 7},
               {"menuItemId": "fc000000-0000-4000-8000-000000000002", "variantId": "fd000000-0000-4000-8000-000000000002", "qty": 1}]'::jsonb,
             null, null, 'fa000000-0000-4000-8000-000000000001') ->> 'linesTotalPaisa')::bigint,
          (7 * 10000 + 2 * 13000 + 3 * 20000 + 1 * 21000)::bigint,
          'merge: qty 5 -> 7 at the OLD snapshot 10000, untouched lines kept, new line at 20000 + 1000');
reset role;
select is((select unit_price_paisa from public.daily_sales_lines l join public.daily_sales d on d.id = l.daily_sales_id
            where d.business_date = (now() at time zone 'Asia/Kathmandu')::date
              and l.menu_item_ref = 'fc000000-0000-4000-8000-000000000001' and l.variant_ref is null), 10000,
          'snapshot kept after the menu price changed');
select is((select till_total_paisa from public.daily_sales where business_date = (now() at time zone 'Asia/Kathmandu')::date),
          null, 'header is replaced: till total sent as null is cleared');
select is((select updated_by from public.daily_sales where business_date = (now() at time zone 'Asia/Kathmandu')::date),
          'fa000000-0000-4000-8000-000000000001'::uuid, 'updated_by = the last actor (owner)');
select is((select created_by from public.daily_sales where business_date = (now() at time zone 'Asia/Kathmandu')::date),
          'fa000000-0000-4000-8000-000000000002'::uuid, 'created_by stays the first actor (staff)');

-- Hard delete of a menu item keeps the history.
delete from public.menu_items where id = 'fc000000-0000-4000-8000-000000000003';
select is((select row(menu_item_id, variant_id, menu_item_ref, variant_ref, name_snapshot, variant_label_snapshot, unit_price_paisa)::text
             from public.daily_sales_lines where menu_item_ref = 'fc000000-0000-4000-8000-000000000003'),
          row(null::uuid, null::uuid, 'fc000000-0000-4000-8000-000000000003'::uuid, 'fd000000-0000-4000-8000-000000000003'::uuid,
              'DS Gone', 'DS Big', 5500)::text,
          'after a hard delete: FKs null, refs + name/label/price snapshot kept');

-- ===== Statistics fixtures (2021, as postgres) ==================================================================
-- Range A = 2021-03-01 (Mon) .. 2021-03-07 (Sun); compare B = 2021-02-22 .. 2021-02-28.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.upsert_daily_sales('2021-03-01',
  '[{"menuItemId": "fc000000-0000-4000-8000-000000000002", "qty": 10}, {"menuItemId": "fc000000-0000-4000-8000-000000000004", "qty": 20}]',
  310000, null, 'fa000000-0000-4000-8000-000000000001');                         -- 200000 + 100000, 30 items
select public.upsert_daily_sales('2021-03-05',
  '[{"menuItemId": "fc000000-0000-4000-8000-000000000002", "qty": 5}, {"menuItemId": "fc000000-0000-4000-8000-000000000004", "qty": 2},
    {"menuItemId": "fc000000-0000-4000-8000-000000000001", "qty": 0}]',
  null, null, 'fa000000-0000-4000-8000-000000000001');                           -- 100000 + 10000, 7 items
select public.upsert_daily_sales('2021-02-24',
  '[{"menuItemId": "fc000000-0000-4000-8000-000000000004", "qty": 40}]',
  null, null, 'fa000000-0000-4000-8000-000000000001');                           -- 200000, 40 items
reset role;

select pg_temp.mk_order('2021-03-01 10:00:00+05:45', 'completed', '2021-03-07 18:14:59+00', null,
                        'ff000000-0000-4000-8000-000000000003', 1, 100000);   -- done 03-07 23:59:59 KTM: in A
select pg_temp.mk_order('2021-03-02 09:00:00+05:45', 'completed', '2021-03-02 06:00:00+00', null,
                        'ff000000-0000-4000-8000-000000000002', 3, 100000);   -- in A
select pg_temp.mk_order('2021-03-06 12:00:00+05:45', 'completed', '2021-03-07 18:15:00+00', null,
                        'ff000000-0000-4000-8000-000000000001', 1, 999900);   -- done 03-08 00:00 KTM: NOT in A
select pg_temp.mk_order('2021-02-27 12:00:00+05:45', 'completed', '2021-02-28 18:14:59+00', null,
                        'ff000000-0000-4000-8000-000000000003', 2, 100000);   -- done 02-28 23:59:59 KTM: in B only
select pg_temp.mk_order('2021-02-28 18:15:00+00', 'cancelled', null, 'no_show',
                        'ff000000-0000-4000-8000-000000000003', 1, 100000);   -- placed Mon 03-01 00:00 KTM
select pg_temp.mk_order('2021-03-03 12:00:00+05:45', 'cancelled', null, 'fake',
                        'ff000000-0000-4000-8000-000000000003', 1, 100000);
select pg_temp.mk_order('2021-03-04 12:00:00+05:45', 'cancelled', null, 'auto_unconfirmed',
                        'ff000000-0000-4000-8000-000000000003', 1, 100000);
select pg_temp.mk_order('2021-03-04 13:00:00+05:45', 'placed', null, null,
                        'ff000000-0000-4000-8000-000000000003', 1, 100000);   -- still open

-- Stock-alert fixtures, relative to now (rolling 7 / 30 days, non-cancelled orders count).
select pg_temp.mk_order(now() - interval '2 days',  'placed',    null, null, 'ff000000-0000-4000-8000-000000000002', 1, 100000);
select pg_temp.mk_order(now() - interval '20 days', 'completed', now() - interval '19 days', null,
                        'ff000000-0000-4000-8000-000000000002', 2, 100000);
select pg_temp.mk_order(now() - interval '10 days', 'cancelled', null, 'customer_request',
                        'ff000000-0000-4000-8000-000000000002', 5, 100000);   -- cancelled: not sold
select pg_temp.mk_order(now() - interval '40 days', 'completed', now() - interval '39 days', null,
                        'ff000000-0000-4000-8000-000000000002', 9, 100000);   -- outside 30 days

-- ===== Statistics: access =======================================================================================
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$select public.stats_overview('2021-03-01', '2021-03-07', null, null, 'fa000000-0000-4000-8000-000000000002')$$,
                 'P0001', 'FORBIDDEN', 'staff actor: stats_overview FORBIDDEN');
select throws_ok($$select public.stats_timeseries('2021-03-01', '2021-03-07', 'day', 'fa000000-0000-4000-8000-000000000002')$$,
                 'P0001', 'FORBIDDEN', 'staff actor: stats_timeseries FORBIDDEN');
select throws_ok($$select public.stats_top_food('2021-03-01', '2021-03-07', 10, 'fa000000-0000-4000-8000-000000000002')$$,
                 'P0001', 'FORBIDDEN', 'staff actor: stats_top_food FORBIDDEN');
select throws_ok($$select public.stats_best_food_per_day('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000002')$$,
                 'P0001', 'FORBIDDEN', 'staff actor: stats_best_food_per_day FORBIDDEN');
select throws_ok($$select public.stats_top_merch('2021-03-01', '2021-03-07', 10, 'fa000000-0000-4000-8000-000000000002')$$,
                 'P0001', 'FORBIDDEN', 'staff actor: stats_top_merch FORBIDDEN');
select throws_ok($$select public.stats_busy_heatmap('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000002')$$,
                 'P0001', 'FORBIDDEN', 'staff actor: stats_busy_heatmap FORBIDDEN');
select throws_ok($$select public.stats_cancellations('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000002')$$,
                 'P0001', 'FORBIDDEN', 'staff actor: stats_cancellations FORBIDDEN');
select throws_ok($$select public.stats_stock_alerts('fa000000-0000-4000-8000-000000000002')$$,
                 'P0001', 'FORBIDDEN', 'staff actor: stats_stock_alerts FORBIDDEN');
select throws_ok($$select public.stats_overview('2021-03-01', '2021-03-07')$$, 'P0001', 'FORBIDDEN', 'no actor: FORBIDDEN');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"fa000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.stats_cancellations('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001')$$,
                 '42501', null, 'staff JWT cannot call stats RPCs at all, even passing the owner id');
select throws_ok($$select public.upsert_daily_sales((now() at time zone 'Asia/Kathmandu')::date, '[]', null, null,
                     'fa000000-0000-4000-8000-000000000001')$$, '42501', null, 'staff JWT cannot call upsert_daily_sales directly');
reset role;

-- ===== Statistics: numbers (owner actor via service role) ======================================================
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- stats_overview + compare math
select is(public.stats_overview('2021-03-01', '2021-03-07', '2021-02-22', '2021-02-28', 'fa000000-0000-4000-8000-000000000001')
            -> 'foodRevenuePaisa', '{"value": 410000, "compare": 200000, "changePct": 105.0}'::jsonb,
          'overview foodRevenuePaisa: 410000 vs 200000 = +105.0%');
select is(public.stats_overview('2021-03-01', '2021-03-07', '2021-02-22', '2021-02-28', 'fa000000-0000-4000-8000-000000000001')
            -> 'merchRevenuePaisa', '{"value": 400000, "compare": 200000, "changePct": 100.0}'::jsonb,
          'overview merchRevenuePaisa: completed orders by Kathmandu completion date (23:59:59 in, 00:00 out)');
select is(public.stats_overview('2021-03-01', '2021-03-07', '2021-02-22', '2021-02-28', 'fa000000-0000-4000-8000-000000000001')
            -> 'totalRevenuePaisa', '{"value": 810000, "compare": 400000, "changePct": 102.5}'::jsonb,
          'overview totalRevenuePaisa: 810000 vs 400000 = +102.5%');
select is(public.stats_overview('2021-03-01', '2021-03-07', '2021-02-22', '2021-02-28', 'fa000000-0000-4000-8000-000000000001')
            -> 'merchOrders', '{"value": 2, "compare": 1, "changePct": 100.0}'::jsonb, 'overview merchOrders');
select is(public.stats_overview('2021-03-01', '2021-03-07', '2021-02-22', '2021-02-28', 'fa000000-0000-4000-8000-000000000001')
            -> 'avgMerchOrderPaisa', '{"value": 200000, "compare": 200000, "changePct": 0.0}'::jsonb, 'overview avgMerchOrderPaisa');
select is(public.stats_overview('2021-03-01', '2021-03-07', '2021-02-22', '2021-02-28', 'fa000000-0000-4000-8000-000000000001')
            -> 'foodItemsSold', '{"value": 37, "compare": 40, "changePct": -7.5}'::jsonb, 'overview foodItemsSold: -7.5%');
select is(public.stats_overview('2021-03-01', '2021-03-07', '2021-02-22', '2021-02-28', 'fa000000-0000-4000-8000-000000000001')
            -> 'foodTillTotalPaisa', '{"value": 310000, "compare": 0, "changePct": null}'::jsonb,
          'overview foodTillTotalPaisa (separate from revenue); compare 0 -> changePct null');
select is(public.stats_overview('2021-03-01', '2021-03-07', null, null, 'fa000000-0000-4000-8000-000000000001')
            -> 'foodRevenuePaisa', '{"value": 410000, "compare": null, "changePct": null}'::jsonb,
          'overview without a compare range: compare and changePct are null');
select is(public.stats_overview('2021-03-01', '2021-03-07', '2020-01-01', '2020-01-07', 'fa000000-0000-4000-8000-000000000001')
            -> 'merchRevenuePaisa', '{"value": 400000, "compare": 0, "changePct": null}'::jsonb,
          'overview vs an empty compare range: compare 0, changePct null (no division by zero)');
select is(public.stats_overview('2021-03-01', '2021-03-07', '2020-01-01', '2020-01-07', 'fa000000-0000-4000-8000-000000000001')
            -> 'avgMerchOrderPaisa', '{"value": 200000, "compare": null, "changePct": null}'::jsonb,
          'overview avg with no compare orders: compare null');
select is((select array_agg(k order by k) from jsonb_object_keys(
             public.stats_overview('2021-03-01', '2021-03-07', null, null, 'fa000000-0000-4000-8000-000000000001')) k),
          array['avgMerchOrderPaisa', 'compareFrom', 'compareTo', 'foodDaysLogged', 'foodItemsSold', 'foodRevenuePaisa',
                'foodTillDays', 'foodTillTotalPaisa', 'from', 'merchOrders', 'merchRevenuePaisa', 'timezone', 'to',
                'totalRevenuePaisa'],
          'overview keys are stable');
select throws_ok($$select public.stats_overview('2021-03-07', '2021-03-01', null, null, 'fa000000-0000-4000-8000-000000000001')$$,
                 'P0001', 'VALIDATION', 'from after to -> VALIDATION');
select throws_ok($$select public.stats_overview('2021-03-01', '2021-03-07', '2021-02-22', null, 'fa000000-0000-4000-8000-000000000001')$$,
                 'P0001', 'VALIDATION', 'half a compare range -> VALIDATION');
select throws_ok($$select public.stats_overview('2018-01-01', '2021-03-07', null, null, 'fa000000-0000-4000-8000-000000000001')$$,
                 'P0001', 'VALIDATION', 'range over 1096 days -> VALIDATION');

-- stats_timeseries: Kathmandu day buckets
select is(jsonb_array_length(public.stats_timeseries('2021-03-01', '2021-03-07', 'day', 'fa000000-0000-4000-8000-000000000001') -> 'buckets'),
          7, 'timeseries day: one bucket per day, empty days included');
select is((select b from jsonb_array_elements(public.stats_timeseries('2021-03-01', '2021-03-07', 'day',
             'fa000000-0000-4000-8000-000000000001') -> 'buckets') b where b ->> 'bucket' = '2021-03-07'),
          '{"bucket": "2021-03-07", "start": "2021-03-07", "end": "2021-03-07", "partial": false, "foodRevenuePaisa": 0,
            "foodItemsSold": 0, "merchRevenuePaisa": 100000, "merchOrders": 1, "merchOrdersPlaced": 0, "totalRevenuePaisa": 100000}'::jsonb,
          'timeseries: an order completed 23:59:59 Kathmandu counts on that day (the 00:00 one does not)');
select is((select b from jsonb_array_elements(public.stats_timeseries('2021-03-01', '2021-03-07', 'day',
             'fa000000-0000-4000-8000-000000000001') -> 'buckets') b where b ->> 'bucket' = '2021-03-01'),
          '{"bucket": "2021-03-01", "start": "2021-03-01", "end": "2021-03-01", "partial": false, "foodRevenuePaisa": 300000,
            "foodItemsSold": 30, "merchRevenuePaisa": 0, "merchOrders": 0, "merchOrdersPlaced": 2, "totalRevenuePaisa": 300000}'::jsonb,
          'timeseries: an order placed 18:15 UTC on 02-28 is placed on 03-01 Kathmandu');
select is((select jsonb_agg(jsonb_build_object('bucket', b -> 'bucket', 'start', b -> 'start', 'end', b -> 'end',
                                               'partial', b -> 'partial', 'merch', b -> 'merchRevenuePaisa'))
             from jsonb_array_elements(public.stats_timeseries('2021-03-01', '2021-03-07', 'week',
                    'fa000000-0000-4000-8000-000000000001') -> 'buckets') b),
          '[{"bucket": "2021-02-28", "start": "2021-03-01", "end": "2021-03-06", "partial": true, "merch": 300000},
            {"bucket": "2021-03-07", "start": "2021-03-07", "end": "2021-03-07", "partial": true, "merch": 100000}]'::jsonb,
          'timeseries week: weeks start on Sunday, clipped buckets are partial');
select is((select jsonb_agg(b -> 'bucket') from jsonb_array_elements(public.stats_timeseries('2021-02-22', '2021-03-07', 'month',
             'fa000000-0000-4000-8000-000000000001') -> 'buckets') b),
          '["2021-02-01", "2021-03-01"]'::jsonb, 'timeseries month buckets');
select throws_ok($$select public.stats_timeseries('2021-03-01', '2021-03-07', 'year', 'fa000000-0000-4000-8000-000000000001')$$,
                 'P0001', 'VALIDATION', 'grain must be day, week or month');

-- stats_top_food
select is((select jsonb_agg(jsonb_build_object('rank', x -> 'rank', 'name', x -> 'name', 'qty', x -> 'qty', 'revenuePaisa', x -> 'revenuePaisa'))
             from jsonb_array_elements(public.stats_top_food('2021-03-01', '2021-03-07', 10,
                    'fa000000-0000-4000-8000-000000000001') -> 'byQty') x),
          '[{"rank": 1, "name": "DS Lassi", "qty": 22, "revenuePaisa": 110000}, {"rank": 2, "name": "DS Momo", "qty": 15, "revenuePaisa": 300000}]'::jsonb,
          'top food by qty (qty-0 lines left out)');
select is((select jsonb_agg(x -> 'name') from jsonb_array_elements(public.stats_top_food('2021-03-01', '2021-03-07', 1,
             'fa000000-0000-4000-8000-000000000001') -> 'byRevenue') x),
          '["DS Momo"]'::jsonb, 'top food by revenue, limit 1');
select is((select x - 'rank' - 'qty' - 'revenuePaisa' from jsonb_array_elements(public.stats_top_food(
             (now() at time zone 'Asia/Kathmandu')::date - 30, (now() at time zone 'Asia/Kathmandu')::date - 30, 10,
             'fa000000-0000-4000-8000-000000000001') -> 'byQty') x),
          '{"menuItemId": "fc000000-0000-4000-8000-000000000003", "name": "DS Gone", "isDeleted": true}'::jsonb,
          'top food shows a hard-deleted item by its snapshot name, isDeleted true');
select throws_ok($$select public.stats_top_food('2021-03-01', '2021-03-07', 0, 'fa000000-0000-4000-8000-000000000001')$$,
                 'P0001', 'VALIDATION', 'limit 0 -> VALIDATION');

-- stats_best_food_per_day
select is(public.stats_best_food_per_day('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001') -> 'days' -> 0,
          '{"date": "2021-03-01", "logged": true, "menuItemId": "fc000000-0000-4000-8000-000000000004", "name": "DS Lassi",
            "qty": 20, "revenuePaisa": 100000, "dayItemsSold": 30, "dayFoodRevenuePaisa": 300000}'::jsonb,
          'best food on 03-01: DS Lassi x 20');
select is(public.stats_best_food_per_day('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001') -> 'days' -> 1,
          '{"date": "2021-03-02", "logged": false, "menuItemId": null, "name": null, "qty": null, "revenuePaisa": null,
            "dayItemsSold": null, "dayFoodRevenuePaisa": null}'::jsonb,
          'a day without a log: logged false, nulls');
select is((public.stats_best_food_per_day('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001') -> 'days' -> 4) ->> 'name',
          'DS Momo', 'best food on 03-05: DS Momo (5) beats DS Lassi (2) and the qty-0 DS Chai');
select is(jsonb_array_length(public.stats_best_food_per_day('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001') -> 'days'),
          7, 'best food: one entry per date');

-- stats_top_merch
select is(public.stats_top_merch('2021-03-01', '2021-03-07', 10, 'fa000000-0000-4000-8000-000000000001') -> 'byProduct',
          '[{"rank": 1, "productId": "fe000000-0000-4000-8000-000000000001", "name": "DS Tee", "qty": 4, "revenuePaisa": 400000}]'::jsonb,
          'top merch by product (completed orders in range only)');
select is((select jsonb_agg(jsonb_build_object('rank', x -> 'rank', 'label', x -> 'label', 'qty', x -> 'qty'))
             from jsonb_array_elements(public.stats_top_merch('2021-03-01', '2021-03-07', 10,
                    'fa000000-0000-4000-8000-000000000001') -> 'byVariant') x),
          '[{"rank": 1, "label": "L / Black", "qty": 3}, {"rank": 2, "label": "XL / Black", "qty": 1}]'::jsonb,
          'top merch by variant (size / colour)');

-- stats_busy_heatmap
select is(jsonb_array_length(public.stats_busy_heatmap('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001') -> 'merch'),
          168, 'heatmap: 7 x 24 cells');
select is((select c from jsonb_array_elements(public.stats_busy_heatmap('2021-03-01', '2021-03-07',
             'fa000000-0000-4000-8000-000000000001') -> 'merch') c where c @> '{"weekday": 1, "hour": 0}'),
          '{"weekday": 1, "hour": 0, "orders": 1, "completedOrders": 0}'::jsonb,
          'heatmap: 18:15 UTC Sunday = Monday 00:00 Kathmandu');
select is((select c from jsonb_array_elements(public.stats_busy_heatmap('2021-03-01', '2021-03-07',
             'fa000000-0000-4000-8000-000000000001') -> 'merch') c where c @> '{"weekday": 1, "hour": 10}'),
          '{"weekday": 1, "hour": 10, "orders": 1, "completedOrders": 1}'::jsonb, 'heatmap: Monday 10:00 Kathmandu');
select is((select sum((c ->> 'orders')::int) from jsonb_array_elements(public.stats_busy_heatmap('2021-03-01', '2021-03-07',
             'fa000000-0000-4000-8000-000000000001') -> 'merch') c)::int, 7, 'heatmap: 7 orders placed in range');
select is(public.stats_busy_heatmap('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001') -> 'foodByWeekday' -> 5,
          '{"weekday": 5, "daysLogged": 1, "itemsSold": 7, "revenuePaisa": 110000, "avgItemsSoldPerDay": 7.0, "avgRevenuePaisaPerDay": 110000}'::jsonb,
          'heatmap food per weekday (Friday)');
select is(jsonb_array_length(public.stats_busy_heatmap('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001') -> 'foodByWeekday'),
          7, 'heatmap food: 7 weekdays');

-- stats_cancellations
select is(public.stats_cancellations('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001') - 'refusedAttempts',
          '{"from": "2021-03-01", "to": "2021-03-07", "ordersPlaced": 7, "completed": 3, "cancelled": 3, "open": 1,
            "cancelRatePct": 42.9, "completionRatePct": 42.9,
            "byReason": {"customer_request": 0, "auto_unconfirmed": 1, "no_show": 1, "refused": 0, "unreachable": 0,
                         "out_of_stock": 0, "fake": 1, "other": 0}}'::jsonb,
          'cancellations: counts by Kathmandu placement date, rate, all 8 reasons');
select is(public.stats_cancellations('2021-03-01', '2021-03-07', 'fa000000-0000-4000-8000-000000000001') -> 'refusedAttempts' -> 'recorded',
          'false'::jsonb, 'cancellations: ORDER_REFUSED attempts are reported as not recorded');
select is(public.stats_cancellations('2020-01-01', '2020-01-07', 'fa000000-0000-4000-8000-000000000001') -> 'cancelRatePct',
          'null'::jsonb, 'cancellations: no orders -> cancelRatePct null');

-- stats_stock_alerts
select is((select x - 'productId' - 'productName' - 'isPublished' - 'sku' - 'colour'
             from jsonb_array_elements(public.stats_stock_alerts('fa000000-0000-4000-8000-000000000001') -> 'items') x
            where x ->> 'variantId' = 'ff000000-0000-4000-8000-000000000002'),
          '{"variantId": "ff000000-0000-4000-8000-000000000002", "size": "L", "stock": 2, "stockState": "few_left",
            "sold7d": 1, "sold30d": 3, "dailyRate30d": 0.10, "daysOfStockLeft": 20.0}'::jsonb,
          'stock alert few_left: sold 7d/30d from non-cancelled orders, 2 / (3/30) = 20 days left');
select is((select x ->> 'daysOfStockLeft' from jsonb_array_elements(public.stats_stock_alerts('fa000000-0000-4000-8000-000000000001') -> 'items') x
            where x ->> 'variantId' = 'ff000000-0000-4000-8000-000000000001'), '0', 'stock alert sold_out: 0 days left');
select is((select count(*)::int from jsonb_array_elements(public.stats_stock_alerts('fa000000-0000-4000-8000-000000000001') -> 'items') x
            where x ->> 'variantId' = 'ff000000-0000-4000-8000-000000000003'), 0, 'in-stock variants are not listed');
select ok((select min(o) filter (where x ->> 'stockState' = 'sold_out') < min(o) filter (where x ->> 'stockState' = 'few_left')
             from jsonb_array_elements(public.stats_stock_alerts('fa000000-0000-4000-8000-000000000001') -> 'items')
                  with ordinality as t(x, o)),
          'stock alerts list sold_out before few_left');
reset role;

select * from finish();
rollback;

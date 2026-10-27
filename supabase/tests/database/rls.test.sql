-- rls.test.sql  (pgTAP; run with `supabase test db`)
-- Proves deny-by-default RLS and grants for anon, staff and owner. Self-contained: everything it creates is
-- rolled back. Does not depend on seed.sql (it filters on its own 'T ' fixture names).
-- STATUS: executed 2026-10-23 on a local stack (CLI 2.121.0, Postgres 15.19): passing. First-run fixes: data-model.md.
-- 2026-10-21 additions: SEC-007 (function privileges, default ACL probe), SEC-003 (orders_paused is public, owner
-- only), BUG-006 (delivery needs an area; hours close > open), BUG-003 (owner may save COD max 0), SEC-018
-- (storage size guard, skipped if the platform refused the trigger). Assumes the runner connects as `postgres`
-- (what `supabase test db` does), because the default-privilege probe creates a function as that role.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- Fixtures (as the migration owner) -----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('f2000000-0000-4000-8000-000000000001', 'owner@test.invalid'),
  ('f2000000-0000-4000-8000-000000000002', 'staff@test.invalid');
insert into public.profiles (id, role, display_name) values
  ('f2000000-0000-4000-8000-000000000001', 'owner', 'T Owner'),
  ('f2000000-0000-4000-8000-000000000002', 'staff', 'T Staff');

insert into public.menu_categories (id, slug, name, is_visible) values
  ('f3000000-0000-4000-8000-000000000001', 't-visible-cat', 'T Visible cat', true),
  ('f3000000-0000-4000-8000-000000000002', 't-hidden-cat',  'T Hidden cat',  false);
insert into public.menu_items (id, category_id, name, price_paisa, is_visible, deleted_at) values
  ('f4000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'T Visible',      10000, true,  null),
  ('f4000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000001', 'T Hidden',       10000, false, null),
  ('f4000000-0000-4000-8000-000000000003', 'f3000000-0000-4000-8000-000000000001', 'T Deleted',      10000, true,  now()),
  ('f4000000-0000-4000-8000-000000000004', 'f3000000-0000-4000-8000-000000000002', 'T In hidden cat', 10000, true,  null);
insert into public.menu_variants (item_id, kind, label) values
  ('f4000000-0000-4000-8000-000000000001', 'size', 'T Large'),
  ('f4000000-0000-4000-8000-000000000002', 'size', 'T Hidden item variant');

insert into public.products (id, slug, name, price_paisa, is_published) values
  ('f0000000-0000-4000-8000-000000000001', 't-published',   'T Published',   10000, true),
  ('f0000000-0000-4000-8000-000000000002', 't-unpublished', 'T Unpublished', 10000, false);
insert into public.product_variants (id, product_id, size, colour, stock) values
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'M', 'Black', 5),
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002', 'M', 'Black', 5);

update public.site_settings set delivery_areas = array['Thamel'], min_order_delivery_paisa = 0,
  prices_include_vat = true, service_charge_pct = 0, delivery_fee_paisa = 0,
  payment_methods_enabled = array['cod', 'pickup'], orders_paused = false;
update public.order_rules set cod_max_total_paisa = null, max_open_orders_per_phone = 5;

-- one real order so staff have something to read
select public.create_order(
  '[{"variantId": "f1000000-0000-4000-8000-000000000001", "qty": 1}]'::jsonb,
  'pickup', 'pickup', 'T Customer', '+9779855555555');

-- SEC-018 storage trigger present? Hosted may refuse triggers on storage.objects; then those cases are skipped.
-- SEC-007 removed PUBLIC EXECUTE for functions created by postgres (pg_temp too), so grant it to the test roles.
create function pg_temp.sec018_installed() returns boolean language sql stable as $$
  select exists (select 1 from pg_trigger t
                  where t.tgname = 'public_media_object_guard' and t.tgrelid = 'storage.objects'::regclass) $$;
grant execute on function pg_temp.sec018_installed() to authenticated;

-- ===== Structure =============================================================================================
select is((select count(*)::int
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
          0, 'RLS is enabled on every public table');

select ok((select public from storage.buckets where id = 'public-media'), 'public-media bucket exists and is public');
select is((select allowed_mime_types from storage.buckets where id = 'public-media'), array['image/webp'], 'bucket accepts WebP only');

select ok(not has_function_privilege('anon', 'public.create_order(jsonb,text,text,text,text,text,text,text,text,text,text)', 'execute'),
          'anon cannot execute create_order');
select ok(not has_function_privilege('authenticated', 'public.create_order(jsonb,text,text,text,text,text,text,text,text,text,text)', 'execute'),
          'authenticated cannot execute create_order');
select ok(has_function_privilege('service_role', 'public.create_order(jsonb,text,text,text,text,text,text,text,text,text,text)', 'execute'),
          'service_role can execute create_order');
select ok(not has_function_privilege('authenticated', 'public.set_order_status(uuid,text,uuid,text,boolean,boolean)', 'execute'),
          'authenticated cannot execute set_order_status');
select ok(not has_function_privilege('anon', 'public.rate_limit_hit(text,integer,integer)', 'execute'),
          'anon cannot execute rate_limit_hit');
select ok(not has_function_privilege('authenticated', 'public.purge_personal_data()', 'execute'),
          'authenticated cannot execute purge_personal_data');
select ok(not has_function_privilege('anon', 'public.block_contact(text,text,text,uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.block_contact(text,text,text,uuid)', 'execute')
          and has_function_privilege('service_role', 'public.block_contact(text,text,text,uuid)', 'execute'),
          'block_contact is service-role only');
select ok(not has_function_privilege('anon', 'public.auto_cancel_unconfirmed_orders()', 'execute')
          and not has_function_privilege('authenticated', 'public.auto_cancel_unconfirmed_orders()', 'execute')
          and has_function_privilege('service_role', 'public.auto_cancel_unconfirmed_orders()', 'execute'),
          'auto_cancel_unconfirmed_orders is service-role only');

-- SEC-007: the only public functions anon/authenticated can execute are the four intended ones. Trigger functions
-- are excluded (PostgREST cannot call them; Postgres refuses to call them outside a trigger), as are functions
-- that belong to an extension.
select is((select coalesce(array_agg(p.proname::text order by p.proname::text), '{}')
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
              and not exists (select 1 from pg_depend d
                               where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
              and has_function_privilege('anon', p.oid, 'execute')),
          array['current_app_role', 'health_ping', 'is_owner', 'is_staff'],
          'SEC-007: anon can execute only health_ping, current_app_role, is_staff, is_owner');
select is((select coalesce(array_agg(p.proname::text order by p.proname::text), '{}')
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
              and not exists (select 1 from pg_depend d
                               where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
              and has_function_privilege('authenticated', p.oid, 'execute')),
          array['current_app_role', 'health_ping', 'is_owner', 'is_staff'],
          'SEC-007: authenticated can execute only the same four');
-- SEC-007: the default really is "deny" now. A brand-new function with no grants must not be callable.
create function public.t_sec007_probe() returns integer language sql as $$ select 1 $$;
select ok(not has_function_privilege('anon', 'public.t_sec007_probe()', 'execute'),
          'SEC-007: a new public function is not executable by anon by default');
select ok(not has_function_privilege('authenticated', 'public.t_sec007_probe()', 'execute'),
          'SEC-007: ... nor by authenticated');
drop function public.t_sec007_probe();

-- The backend (staff digest, Telegram gate, ratelimit reset) reads/writes rate_limits directly with the service key.
-- That privilege comes from Supabase's default ACL for `postgres` in schema public, not from our migrations: pin it.
select ok(has_table_privilege('service_role', 'public.rate_limits', 'select')
          and has_table_privilege('service_role', 'public.rate_limits', 'insert')
          and has_table_privilege('service_role', 'public.rate_limits', 'delete'),
          'service_role can select/insert/delete rate_limits directly (backend relies on it)');

select ok((select 'security_invoker=true' = any (c.reloptions) from pg_class c where c.oid = 'public.public_settings'::regclass),
          'public_settings is still security_invoker after it was replaced');

-- ===== BUG-015: product variant display order (20261023000002) ================================================
-- Own product, not named 'T ...', so the anon/staff counts above and below are unaffected.
insert into public.products (id, slug, name, price_paisa, is_published) values
  ('f0000000-0000-4000-8000-000000000003', 'size-order-fixture', 'Size order fixture', 10000, true);
insert into public.product_variants (product_id, size, colour, stock) values
  ('f0000000-0000-4000-8000-000000000003', 'XL',       'Black', 5),
  ('f0000000-0000-4000-8000-000000000003', 'One size', 'Cream', 5),
  ('f0000000-0000-4000-8000-000000000003', 'S',        'Black', 5),
  ('f0000000-0000-4000-8000-000000000003', '2XL',      'Black', 5),
  ('f0000000-0000-4000-8000-000000000003', 'M',        'Cream', 5),
  ('f0000000-0000-4000-8000-000000000003', 'Tall',     'Cream', 5),
  ('f0000000-0000-4000-8000-000000000003', ' l ',      'Black', 5),
  ('f0000000-0000-4000-8000-000000000003', '32',       'Cream', 5),
  ('f0000000-0000-4000-8000-000000000003', 'xs',       'Cream', 5);

select results_eq(
  $$select size, size_rank::int from public.product_variants
     where product_id = 'f0000000-0000-4000-8000-000000000003' order by colour, size_rank, size, id$$,
  $$values ('S', 30), (' l ', 50), ('XL', 60), ('2XL', 70),
           ('xs', 20), ('M', 40), ('32', 232), ('Tall', 1000), ('One size', 1500)$$,
  'BUG-015: size_rank orders S < M < L < XL < XXL per colour (case/space-insensitive; numeric, unknown, one-size last)');
update public.product_variants set stock = 1
 where product_id = 'f0000000-0000-4000-8000-000000000003' and size = 'S';
update public.product_variants set size = 'XXL'
 where product_id = 'f0000000-0000-4000-8000-000000000003' and size = '2XL';
select results_eq(
  $$select size from public.product_variants
     where product_id = 'f0000000-0000-4000-8000-000000000003' order by colour, size_rank, size, id$$,
  $$values ('S'), (' l '), ('XL'), ('XXL'), ('xs'), ('M'), ('32'), ('Tall'), ('One size')$$,
  'BUG-015: the order is unchanged after a stock update, and size_rank follows a size edit (2XL -> XXL)');
select ok(has_column_privilege('anon', 'public.product_variants', 'size_rank', 'select'),
          'BUG-015: anon may select (and so ORDER BY) size_rank');
select ok(not has_column_privilege('anon', 'public.product_variants', 'stock', 'select'),
          'BUG-015: anon still cannot select stock');

-- ===== ANON ===================================================================================================
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select is((select count(*)::int from public.menu_items where name like 'T %'), 1,
          'anon sees only the visible, not-deleted item in a visible category');
select is((select count(*)::int from public.menu_categories where name like 'T %'), 1, 'anon sees only the visible category');
select is((select count(*)::int from public.menu_variants where label like 'T %'), 1, 'anon sees variants of visible items only');
select is((select count(*)::int from public.products where name like 'T %'), 1, 'anon sees published products only');
select is((select count(*)::int from public.product_variants where product_id in
            ('f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002')), 1,
          'anon sees variants of published products only');
select lives_ok($$select id, size, colour, stock_state from public.product_variants$$, 'anon can read stock_state');
select throws_ok($$select stock from public.product_variants$$, '42501', null::text, 'anon cannot read exact stock');
select results_eq(
  $$select size from public.product_variants
     where product_id = 'f0000000-0000-4000-8000-000000000003' order by colour, size_rank, size, id$$,
  $$values ('S'), (' l '), ('XL'), ('XXL'), ('xs'), ('M'), ('32'), ('Tall'), ('One size')$$,
  'BUG-015: anon can read variants in display order (ORDER BY colour, size_rank, size, id)');
select lives_ok($$select * from public.public_settings$$, 'anon can read public_settings');
select lives_ok($$select * from public.site_settings$$, 'anon can read site_settings');
select is((select orders_paused from public.public_settings), false, 'SEC-003: anon can read orders_paused from public_settings');
select throws_ok($$update public.site_settings set orders_paused = true$$, '42501', null::text, 'anon cannot pause orders');
select throws_ok($$select * from public.block_contact('phone', '+9779866666600', null, gen_random_uuid())$$,
                 '42501', null::text, 'anon cannot call block_contact');
select throws_ok($$select public.auto_cancel_unconfirmed_orders()$$, '42501', null::text, 'anon cannot call auto_cancel_unconfirmed_orders');
select lives_ok($$select public.health_ping()$$, 'anon can call health_ping');

select throws_ok($$select * from public.orders$$,           '42501', null::text, 'anon cannot read orders');
select throws_ok($$select * from public.order_items$$,      '42501', null::text, 'anon cannot read order_items');
select throws_ok($$select * from public.blocked_contacts$$, '42501', null::text, 'anon cannot read blocked_contacts');
select throws_ok($$select * from public.rate_limits$$,      '42501', null::text, 'anon cannot read rate_limits');
select throws_ok($$select * from public.profiles$$,         '42501', null::text, 'anon cannot read profiles');
select throws_ok($$select * from public.order_rules$$,      '42501', null::text, 'anon cannot read order_rules');
select throws_ok($$insert into public.menu_items (category_id, name, price_paisa)
                    values ('f3000000-0000-4000-8000-000000000001', 'hack', 1)$$,
                 '42501', null::text, 'anon cannot insert menu items');
select throws_ok($$update public.menu_items set price_paisa = 1$$, '42501', null::text, 'anon cannot update menu items');
select throws_ok($$update public.site_settings set announcement = 'hacked'$$, '42501', null::text, 'anon cannot update settings');
select throws_ok($$select public.rate_limit_hit('k', 60, 5)$$, '42501', null::text, 'anon cannot call rate_limit_hit');
select throws_ok($$select * from public.create_order('[]'::jsonb, 'pickup', 'pickup', 'x', 'y')$$,
                 '42501', null::text, 'anon cannot call create_order');
reset role;

-- ===== STAFF ==================================================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select ok((select count(*) from public.orders) >= 1, 'staff can read orders');
select ok((select count(*) from public.order_items) >= 1, 'staff can read order_items');
select is((select count(*)::int from public.menu_items where name like 'T %'), 4, 'staff can read all menu items, including hidden and deleted');
select is((select count(*)::int from public.profiles), 1, 'staff can read only their own profile');
select lives_ok($$select * from public.order_rules$$, 'staff can read order_rules');

select throws_ok($$update public.orders set status = 'completed'$$, '42501', null::text, 'staff cannot update orders directly');
select throws_ok($$insert into public.orders (fulfilment, payment_method, prices_include_vat, subtotal_paisa, total_paisa)
                    values ('pickup', 'pickup', true, 1, 1)$$,
                 '42501', null::text, 'staff cannot insert orders directly');
select throws_ok($$delete from public.orders$$, '42501', null::text, 'staff cannot delete orders');
select throws_ok($$select * from public.rate_limits$$, '42501', null::text, 'staff cannot read rate_limits');
select throws_ok($$insert into public.profiles (id, role, display_name)
                    values (gen_random_uuid(), 'owner', 'x')$$, '42501', null::text, 'staff cannot create profiles');
select throws_ok($$update public.profiles set role = 'owner'$$, '42501', null::text, 'staff cannot escalate their role');
select throws_ok($$select * from public.create_order('[]'::jsonb, 'pickup', 'pickup', 'x', 'y')$$,
                 '42501', null::text, 'staff cannot call create_order');
select throws_ok($$select * from public.set_order_status(gen_random_uuid(), 'confirmed', gen_random_uuid())$$,
                 '42501', null::text, 'staff cannot call set_order_status directly (only via the backend)');

select lives_ok($$update public.menu_items set is_sold_out = true where id = 'f4000000-0000-4000-8000-000000000001'$$,
                'staff can toggle sold-out');
select is((select is_sold_out from public.menu_items where id = 'f4000000-0000-4000-8000-000000000001'), true,
          'sold-out flag actually changed');
select throws_ok($$update public.menu_items set price_paisa = 1 where id = 'f4000000-0000-4000-8000-000000000001'$$,
                 '42501', null::text, 'staff cannot change a price');
select lives_ok($$update public.menu_variants set is_sold_out = true where label = 'T Large'$$, 'staff can toggle variant sold-out');
select throws_ok($$update public.menu_variants set price_delta_paisa = 5 where label = 'T Large'$$,
                 '42501', null::text, 'staff cannot change a variant price');
select throws_ok($$insert into public.menu_items (category_id, name, price_paisa)
                    values ('f3000000-0000-4000-8000-000000000001', 'staff new', 1)$$,
                 '42501', null::text, 'staff cannot create menu items');
-- Row-count checks use results_eq with a SQL string: Postgres only allows a data-modifying CTE at the top level,
-- so `select is((with d as (delete ...) ...), n)` is a syntax error (first-run fix, 2026-10-23).
select results_eq($$with d as (delete from public.menu_items where id = 'f4000000-0000-4000-8000-000000000001' returning 1)
                    select count(*)::int from d$$, $$values (0)$$, 'staff cannot delete menu items');
-- products / product_variants have no staff UPDATE policy, so RLS filters every row: the update is a silent no-op
-- (0 rows), not a 42501 error. Assert the row count and that the value did not move (first-run fix, 2026-10-23).
select results_eq($$with u as (update public.products set price_paisa = 1 returning 1) select count(*)::int from u$$,
                  $$values (0)$$, 'staff cannot change product prices (0 rows updated)');
select results_eq($$with u as (update public.product_variants set stock = 999 returning 1) select count(*)::int from u$$,
                  $$values (0)$$, 'staff cannot change stock (0 rows updated)');
select is((select stock from public.product_variants where id = 'f1000000-0000-4000-8000-000000000001'), 4,
          'stock is unchanged after the staff attempt (5 seeded, 1 taken by the fixture order)');
select lives_ok($$update public.site_settings set announcement = 'Closed early today'$$, 'staff can set the announcement');
select throws_ok($$update public.site_settings set cafe_name = 'Renamed'$$, '42501', null::text, 'staff cannot change other settings');
select throws_ok($$update public.site_settings set orders_paused = true$$, '42501', null::text, 'SEC-003: staff cannot pause orders (owner only)');
select throws_ok($$select * from public.block_contact('phone', '+9779866666600', null, 'f2000000-0000-4000-8000-000000000002')$$,
                 '42501', null::text, 'staff cannot call block_contact directly (only via the backend)');
select results_eq($$with u as (update public.order_rules set max_open_orders_per_phone = 1 returning 1) select count(*)::int from u$$,
          $$values (0)$$, 'staff cannot change order rules');

select lives_ok($$insert into public.blocked_contacts (kind, value, reason, created_by)
                  values ('phone', '+9779866666666', 'test', 'f2000000-0000-4000-8000-000000000002')$$,
                'staff can add a blocked contact');
select throws_ok($$insert into public.blocked_contacts (kind, value, created_by)
                    values ('phone', '+9779877777777', 'f2000000-0000-4000-8000-000000000001')$$,
                 '42501', null::text, 'staff cannot attribute a block to someone else');
select throws_ok($$insert into public.blocked_contacts (kind, value, created_by)
                    values ('ip_hash', '1.2.3.4', 'f2000000-0000-4000-8000-000000000002')$$,
                 '23514', null::text, 'a raw IP can never be stored as a block value');
select is((select count(*)::int from public.blocked_contacts where value = '+9779866666666'), 1, 'staff can read the blocklist');
select results_eq($$with d as (delete from public.blocked_contacts where value = '+9779866666666' returning 1) select count(*)::int from d$$,
          $$values (0)$$, 'staff cannot remove a blocked contact');

-- storage: staff may not upload
select throws_ok($$insert into storage.objects (bucket_id, name)
                    values ('public-media', 'menu/f5000000-0000-4000-8000-000000000001/480.webp')$$,
                 '42501', null::text, 'staff cannot upload to public-media');
reset role;

-- ===== OWNER ==================================================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f2000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is((select count(*)::int from public.profiles where id in
            ('f2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000002')), 2,
          'owner can read all profiles');
select lives_ok($$update public.menu_items set price_paisa = 12345 where id = 'f4000000-0000-4000-8000-000000000001'$$,
                'owner can change a price');
select is((select price_paisa from public.menu_items where id = 'f4000000-0000-4000-8000-000000000001'), 12345, 'price changed');
select lives_ok($$update public.site_settings set cafe_name = 'T Renamed'$$, 'owner can change settings');

-- SEC-003 kill switch is owner-only and public
select lives_ok($$update public.site_settings set orders_paused = true$$, 'SEC-003: owner can pause online orders');
select is((select orders_paused from public.public_settings), true, 'SEC-003: the pause shows in public_settings');
select lives_ok($$update public.site_settings set orders_paused = false$$, 'owner can resume online orders');

-- BUG-003: 0 is a valid COD maximum (= no limit)
select lives_ok($$update public.order_rules set cod_max_total_paisa = 0$$, 'BUG-003: owner can save COD max 0 (no limit)');
select lives_ok($$update public.order_rules set cod_max_total_paisa = null$$, 'owner can clear COD max');

-- BUG-006: delivery needs at least one area
select throws_ok($$update public.site_settings set delivery_areas = '{}'$$, '23514', null::text,
                 'BUG-006: delivery (cod) cannot stay on with no delivery area');
select throws_ok($$update public.site_settings set delivery_areas = array['  ']$$, '23514', null::text,
                 'BUG-006: a blank area does not count');
select lives_ok($$update public.site_settings set payment_methods_enabled = array['pickup'], delivery_areas = '{}'$$,
                'BUG-006: turning delivery off and clearing the areas in one save is fine');
select throws_ok($$update public.site_settings set payment_methods_enabled = array['cod', 'pickup']$$, '23514', null::text,
                 'BUG-006: delivery cannot be turned back on without an area');
select lives_ok($$update public.site_settings set payment_methods_enabled = array['cod', 'pickup'], delivery_areas = array['Thamel']$$,
                'BUG-006: delivery on again with an area');

-- BUG-006: opening hours ranges need close > open, "HH:mm"
select throws_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,1}', '[{"open": "18:00", "close": "09:00"}]')$$,
                 '23514', null::text, 'BUG-006: reversed hours (18:00-09:00) are rejected');
select throws_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,1}', '[{"open": "09:00", "close": "09:00"}]')$$,
                 '23514', null::text, 'BUG-006: an empty range (open = close) is rejected');
select throws_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,1}', '[{"open": "7:00", "close": "21:00"}]')$$,
                 '23514', null::text, 'BUG-006: a time that is not HH:mm is rejected');
select throws_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,1}', '[{"open": "25:00", "close": "26:00"}]')$$,
                 '23514', null::text, 'BUG-006: an impossible hour is rejected');
select throws_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,1}', '[{"open": "07:00"}]')$$,
                 '23514', null::text, 'BUG-006: a range without close is rejected');
select throws_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,1}', '[{"open": 700, "close": "21:00"}]')$$,
                 '23514', null::text, 'BUG-006: a non-string time is rejected');
select throws_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,1}', '["07:00-21:00"]')$$,
                 '23514', null::text, 'BUG-006: a range that is not an object is rejected');
select lives_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,1}',
                    '[{"open": "07:00", "close": "11:00"}, {"open": "12:00", "close": "24:00"}]')$$,
                'BUG-006: split hours, closing at 24:00, are accepted');
select lives_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,2}', 'null')$$,
                'BUG-006: a closed day (null) is accepted');
select lives_ok($$update public.site_settings set hours = jsonb_set(hours, '{weekly,3}', '[]')$$,
                'BUG-006: an empty list of ranges is accepted');
select results_eq($$with u as (update public.order_rules set max_open_orders_per_phone = 3 returning 1) select count(*)::int from u$$,
          $$values (1)$$, 'owner can change order rules');
select lives_ok($$update public.product_variants set stock = 50 where id = 'f1000000-0000-4000-8000-000000000001'$$, 'owner can set stock');
select throws_ok($$update public.orders set status = 'completed'$$, '42501', null::text, 'owner cannot update orders directly either');
select throws_ok($$update public.profiles set role = 'staff'$$, '42501', null::text, 'owner cannot rewrite profiles from the client');
select results_eq($$with d as (delete from public.menu_variants where label = 'T Hidden item variant' returning 1) select count(*)::int from d$$,
          $$values (1)$$, 'owner can delete a variant');

select lives_ok($$insert into storage.objects (bucket_id, name)
                  values ('public-media', 'menu/f5000000-0000-4000-8000-000000000001/480.webp')$$,
                'owner can upload a well-formed path');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('public-media', 'menu/anything.webp')$$,
                 '42501', null::text, 'owner cannot upload a badly shaped path');
select throws_ok($$insert into storage.objects (bucket_id, name)
                    values ('public-media', 'menu/f5000000-0000-4000-8000-000000000002/480.png')$$,
                 '42501', null::text, 'owner cannot upload a non-webp path');

-- SEC-018 / BUG-016: per-width size cap and WebP-only, checked by the storage trigger (skipped if the platform refused
-- it). Fixture shapes copy what storage-api 1.82 really writes (see 20261023000001_storage_guard_dry_run.sql):
--   dry-runs carry only the request's declared {mimetype, contentLength[, contentEncoding]} and are rolled back;
--   the real row carries the backend-measured {eTag, size, mimetype, cacheControl, lastModified, contentLength, ...}.
-- The trigger raises 42501 with a "public-media:" message (storage-api turns that into AccessDenied, not a 500).

-- Dry-run shapes must pass (BUG-016: the sign request's own application/json used to be rejected)
select case when pg_temp.sec018_installed()
  then lives_ok($$insert into storage.objects (bucket_id, name, metadata)
                  values ('public-media', 'menu/f5000000-0000-4000-8000-000000000003/480.webp',
                          '{"mimetype": "application/json", "contentLength": 2}')$$,
                'BUG-016: the sign-URL permission dry-run (sign request mimetype/contentLength, no size) passes')
  else skip('SEC-018 storage trigger not installed on this stack; the backend post-upload check is the control', 1)
end;
select case when pg_temp.sec018_installed()
  then lives_ok($$insert into storage.objects (bucket_id, name, metadata)
                  values ('public-media', 'menu/f5000000-0000-4000-8000-000000000006/960.webp', '{}')$$,
                'BUG-016: a sign dry-run with no Content-Type / Content-Length (metadata {}) passes')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
select case when pg_temp.sec018_installed()
  then lives_ok($$insert into storage.objects (bucket_id, name, metadata)
                  values ('public-media', 'menu/f5000000-0000-4000-8000-000000000007/1600.webp',
                          '{"mimetype": "image/png", "contentLength": 999999}')$$,
                'BUG-016: the upload pre-check dry-run (client-declared, unmeasured) passes; the real row is checked')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;

-- Real (measured) rows
select case when pg_temp.sec018_installed()
  then throws_ok($$insert into storage.objects (bucket_id, name, metadata)
                   values ('public-media', 'menu/f5000000-0000-4000-8000-000000000008/480.webp',
                           '{"eTag": "\"a1\"", "size": 50000, "mimetype": "image/webp", "cacheControl": "max-age=3600",
                             "contentLength": 50000, "httpStatusCode": 200}')$$,
                 '42501', 'public-media: 480 px image is 50000 bytes, the limit is 40960 bytes',
                 'SEC-018: a 480 px object over 40 KB is rejected by the storage layer')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
select case when pg_temp.sec018_installed()
  then lives_ok($$insert into storage.objects (bucket_id, name, metadata)
                  values ('public-media', 'menu/f5000000-0000-4000-8000-000000000004/480.webp',
                          '{"eTag": "\"a2\"", "size": 30000, "mimetype": "image/webp", "cacheControl": "max-age=3600",
                            "contentLength": 30000, "httpStatusCode": 200}')$$,
                'SEC-018: a 480 px object under 40 KB is accepted')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
select case when pg_temp.sec018_installed()
  then lives_ok($$insert into storage.objects (bucket_id, name, metadata)
                  values ('public-media', 'menu/f5000000-0000-4000-8000-000000000009/480.webp',
                          '{"size": 40960, "mimetype": "image/webp"}')$$,
                'SEC-018: a 480 px object of exactly 40 KB is accepted (cap is inclusive)')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
select case when pg_temp.sec018_installed()
  then throws_ok($$insert into storage.objects (bucket_id, name, metadata)
                   values ('public-media', 'menu/f5000000-0000-4000-8000-00000000000a/960.webp',
                           '{"size": 122881, "mimetype": "image/webp"}')$$,
                 '42501', 'public-media: 960 px image is 122881 bytes, the limit is 122880 bytes',
                 'SEC-018: a 960 px object one byte over 120 KB is rejected')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
select case when pg_temp.sec018_installed()
  then lives_ok($$insert into storage.objects (bucket_id, name, metadata)
                  values ('public-media', 'menu/f5000000-0000-4000-8000-00000000000b/1600.webp',
                          '{"size": 307200, "mimetype": "image/webp"}')$$,
                'SEC-018: a 1600 px object of exactly 300 KB is accepted')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
select case when pg_temp.sec018_installed()
  then throws_ok($$insert into storage.objects (bucket_id, name, metadata)
                   values ('public-media', 'menu/f5000000-0000-4000-8000-000000000005/960.webp',
                           '{"size": 1000, "mimetype": "image/png"}')$$,
                 '42501', 'public-media: only image/webp is accepted (got image/png)',
                 'SEC-018: a non-WebP MIME type is rejected by the storage layer')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
select case when pg_temp.sec018_installed()
  then throws_ok($$insert into storage.objects (bucket_id, name, metadata)
                   values ('public-media', 'menu/f5000000-0000-4000-8000-00000000000c/960.webp', '{"size": 1000}')$$,
                 '42501', 'public-media: only image/webp is accepted (got none)',
                 'SEC-018: a real object with no mimetype is rejected (fail closed)')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
select case when pg_temp.sec018_installed()
  then throws_ok($$insert into storage.objects (bucket_id, name, metadata)
                   values ('public-media', 'menu/f5000000-0000-4000-8000-00000000000d/480.webp',
                           '{"size": "lots", "mimetype": "image/webp"}')$$,
                 '42501', 'public-media: 480 px image has no measured size',
                 'SEC-018: a non-numeric size is rejected (fail closed)')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
select case when pg_temp.sec018_installed()
  then lives_ok($$insert into storage.objects (bucket_id, name, metadata)
                  values ('public-media', 'menu/f5000000-0000-4000-8000-00000000000e/960.webp',
                          '{"size": 1000, "mimetype": "Image/WebP; charset=binary"}')$$,
                'SEC-018: mimetype is compared case-insensitively, parameters ignored')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
reset role;

-- The trigger runs for privileged writers too (storage-api writes the kept row as its superuser role)
select case when pg_temp.sec018_installed()
  then throws_ok($$insert into storage.objects (bucket_id, name, metadata)
                   values ('public-media', 'menu/f5000000-0000-4000-8000-00000000000f/1600.webp',
                           '{"size": 307201, "mimetype": "image/webp"}')$$,
                 '42501', 'public-media: 1600 px image is 307201 bytes, the limit is 307200 bytes',
                 'SEC-018: an over-cap object is rejected for a privileged role too')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
-- A move (rename) into a variant path is checked like a new object
insert into storage.objects (bucket_id, name, metadata)
  values ('public-media', 'menu/f5000000-0000-4000-8000-000000000010/original.bin',
          '{"size": 999999, "mimetype": "image/jpeg"}');
select case when pg_temp.sec018_installed()
  then throws_ok($$update storage.objects set name = 'menu/f5000000-0000-4000-8000-000000000010/480.webp'
                    where bucket_id = 'public-media' and name = 'menu/f5000000-0000-4000-8000-000000000010/original.bin'$$,
                 '42501', 'public-media: 480 px image is 999999 bytes, the limit is 40960 bytes',
                 'SEC-018: renaming an oversized object into a variant path is rejected')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
-- An update that changes neither content metadata nor path (e.g. last_accessed_at) is not re-checked
select case when pg_temp.sec018_installed()
  then lives_ok($$update storage.objects set last_accessed_at = now()
                   where bucket_id = 'public-media' and name = 'menu/f5000000-0000-4000-8000-000000000004/480.webp'$$,
                'SEC-018: touching last_accessed_at on a stored variant passes')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;
-- Replacing a stored variant with an oversized one (upsert path) is rejected on UPDATE
select case when pg_temp.sec018_installed()
  then throws_ok($$update storage.objects set metadata = '{"size": 40961, "mimetype": "image/webp"}'
                    where bucket_id = 'public-media' and name = 'menu/f5000000-0000-4000-8000-000000000004/480.webp'$$,
                 '42501', 'public-media: 480 px image is 40961 bytes, the limit is 40960 bytes',
                 'SEC-018: overwriting a variant with an over-cap object is rejected')
  else skip('SEC-018 storage trigger not installed on this stack', 1)
end;

-- Owner may delete a blocklist entry (insert one as the migration owner first)
insert into public.blocked_contacts (kind, value, created_by) values ('phone', '+9779888888888', null);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f2000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select results_eq($$with d as (delete from public.blocked_contacts where value = '+9779888888888' returning 1) select count(*)::int from d$$,
          $$values (1)$$, 'owner can remove a blocked contact');
reset role;

-- ===== No session at all (authenticated role but no profile) ================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000ff","role":"authenticated"}', true);
select is((select count(*)::int from public.orders), 0, 'an authenticated user without a profile sees no orders');
select is((select count(*)::int from public.menu_items where name like 'T %'), 1, 'an authenticated user without a profile only gets public menu rows');
reset role;

select * from finish();
rollback;

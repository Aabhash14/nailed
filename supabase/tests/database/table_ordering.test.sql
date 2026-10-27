-- table_ordering.test.sql  (pgTAP; run with `supabase test db`)
-- Migrations 20261026000001_table_ordering.sql + 20261026000002_table_ordering_functions.sql: data-model decision 22
-- as revised for api-contract 2.1.0 (security review SEC-022 to SEC-029) and 2.2.0 (staff cancel window, owner alerts).
-- The 13 groups of the spec, in order:
--   1 structure and grants   2 guards   3 code generation   4 save_cafe_tables   5 mode   6 open, join, rotate, lock
--   7 rounds   8 transitions (+ cancel window)   9 close (+ cancel window)   10 board and guest view   11 expiry
--   12 stats   13 owner alerts
-- Self-contained: table-ordering rows and alerts already in the database (seed, QA) are deleted INSIDE the test
-- transaction, and everything is rolled back at the end, so local data is unchanged. Does not depend on seed.sql.
-- RPCs are called as service_role, like the backend. Fixture rows that the functions cannot create (backdated
-- sessions, 2021 stats history) are written as postgres with the same transaction-local flag the functions use.
-- NOTE: one transaction means now() is constant for the whole file; time rules are tested by backdating rows.
-- NOT COVERED here (needs two sessions): two parallel claim_alert_deliveries callers, and a real concurrent duplicate
-- clientRequestId hitting the unique_violation branch of create_table_order. Both are covered by the code (FOR UPDATE
-- SKIP LOCKED; exception handler) and are listed in the README.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ===== Helpers ==================================================================================================
-- SEC-007 removed PUBLIC EXECUTE for functions created by postgres (pg_temp too), so helpers are granted to
-- service_role explicitly.
create table pg_temp.ctx (k text primary key, v text);
grant all on pg_temp.ctx to service_role;

create function pg_temp.c(p_k text) returns uuid language sql stable as $$ select v::uuid from pg_temp.ctx where k = p_k $$;
create function pg_temp.ct(p_k text) returns text language sql stable as $$ select v from pg_temp.ctx where k = p_k $$;
create function pg_temp.put(p_k text, p_v text) returns text language sql as
  $$ insert into pg_temp.ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v returning v $$;
create function pg_temp.ow() returns uuid language sql immutable as $$ select 'e1000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.sf() returns uuid language sql immutable as $$ select 'e1000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.rq(n integer) returns uuid language sql immutable as
  $$ select ('e7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.ln(p_item uuid, p_qty integer, p_variants uuid[] default null) returns jsonb language sql immutable as
  $$ select jsonb_build_object('menuItemId', p_item, 'qty', p_qty)
            || case when p_variants is null then '{}'::jsonb else jsonb_build_object('variantIds', to_jsonb(p_variants)) end $$;
create function pg_temp.momo(n integer default 1) returns jsonb language sql immutable as
  $$ select jsonb_build_array(pg_temp.ln('e3000000-0000-4000-8000-000000000002', n)) $$;
create function pg_temp.ver() returns bigint language sql stable as $$ select version from public.table_board_state $$;
create function pg_temp.flag(p_on boolean) returns text language sql as
  $$ select set_config('app.table_write', case when p_on then 'on' else 'off' end, true) $$;
create function pg_temp.alerts(p_kind text) returns integer language sql stable as
  $$ select count(*)::integer from public.admin_alerts where kind = p_kind $$;
create function pg_temp.has_key(j jsonb, k text) returns boolean language sql immutable as
  $$ select jsonb_path_exists(j, ('strict $.** ? (exists (@."' || k || '"))')::jsonpath) $$;

-- Runs a statement; returns 'ok' or 'MESSAGE|DETAIL|HINT' so the error protocol can be asserted.
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare
  m text; d text; h text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail, h = pg_exception_hint;
  return m || '|' || coalesce(d, '') || '|' || coalesce(h, '');
end;
$$;
-- Same, but returns the SQLSTATE.
create function pg_temp.state(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- Guest calls (the epoch is a smallint in the RPCs).
create function pg_temp.ord(p_s uuid, p_req integer, p_items jsonb, p_note text default null, p_epoch integer default 1)
returns jsonb language sql as
  $$ select public.create_table_order(p_s, p_epoch::smallint, pg_temp.rq(p_req), p_items, p_note) $$;
create function pg_temp.ord_err(p_s uuid, p_req integer, p_items jsonb, p_note text default null, p_epoch integer default 1)
returns text language sql as
  $$ select pg_temp.err(format('select pg_temp.ord(%L::uuid, %s, %L::jsonb, %L, %s)', p_s, p_req, p_items, p_note, p_epoch)) $$;
create function pg_temp.gv(p_s uuid, p_since integer default null, p_epoch integer default 1) returns jsonb language sql as
  $$ select public.table_session_guest_view(p_s, p_epoch::smallint, p_since) $$;
-- Staff / owner calls on round <n> of a session.
create function pg_temp.mv(p_s uuid, p_round integer, p_to text, p_actor uuid default 'e1000000-0000-4000-8000-000000000002',
                           p_reason text default null)
returns jsonb language sql as
  $$ select public.transition_table_order(o.id, p_to, p_reason, p_actor)
       from public.table_orders o where o.session_id = p_s and o.round = p_round $$;
create function pg_temp.mv_err(p_s uuid, p_round integer, p_to text, p_actor uuid, p_reason text default null)
returns text language sql as
  $$ select pg_temp.err(format('select pg_temp.mv(%L::uuid, %s, %L, %L::uuid, %L)', p_s, p_round, p_to, p_actor, p_reason)) $$;
create function pg_temp.open(p_table uuid, p_actor uuid default 'e1000000-0000-4000-8000-000000000002') returns jsonb
language sql as $$ select public.open_table_session(p_table, p_actor) $$;

grant execute on function pg_temp.c(text), pg_temp.ct(text), pg_temp.put(text, text), pg_temp.ow(), pg_temp.sf(),
  pg_temp.rq(integer), pg_temp.ln(uuid, integer, uuid[]), pg_temp.momo(integer), pg_temp.ver(), pg_temp.flag(boolean),
  pg_temp.alerts(text), pg_temp.has_key(jsonb, text), pg_temp.err(text), pg_temp.state(text),
  pg_temp.ord(uuid, integer, jsonb, text, integer), pg_temp.ord_err(uuid, integer, jsonb, text, integer),
  pg_temp.gv(uuid, integer, integer), pg_temp.mv(uuid, integer, text, uuid, text),
  pg_temp.mv_err(uuid, integer, text, uuid, text), pg_temp.open(uuid, uuid)
  to service_role;

-- ===== Fixtures (as postgres) ===================================================================================
select pg_temp.flag(true);
delete from public.admin_alerts;
delete from public.table_order_items;
delete from public.table_orders;
delete from public.table_sessions;
delete from public.cafe_tables;
update public.site_settings set table_ordering = 'on', prices_include_vat = true, service_charge_pct = 0;
select pg_temp.flag(false);
update public.order_rules set staff_cancel_window_minutes = 10, owner_alert_whatsapp = '{}';

insert into auth.users (id, email) values
  ('e1000000-0000-4000-8000-000000000001', 'to-owner@test.invalid'),
  ('e1000000-0000-4000-8000-000000000002', 'to-staff@test.invalid'),
  ('e1000000-0000-4000-8000-000000000003', 'to-staff2@test.invalid');
insert into public.profiles (id, role, display_name) values
  ('e1000000-0000-4000-8000-000000000001', 'owner', 'TO Owner'),
  ('e1000000-0000-4000-8000-000000000002', 'staff', 'TO Staff'),
  ('e1000000-0000-4000-8000-000000000003', 'staff', 'TO Staff Two');

insert into public.menu_categories (id, slug, name, is_visible) values
  ('e2000000-0000-4000-8000-000000000001', 'to-cat',        'TO Cat',        true),
  ('e2000000-0000-4000-8000-000000000002', 'to-hidden-cat', 'TO Hidden cat', false);
insert into public.menu_items (id, category_id, name, price_paisa, is_visible, is_sold_out, deleted_at) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'TO Chai',        10000, true,  false, null),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'TO Momo',        20000, true,  false, null),
  ('e3000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'TO Hidden',      10000, false, false, null),
  ('e3000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000002', 'TO In hidden',   10000, true,  false, null),
  ('e3000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000001', 'TO Deleted',     10000, true,  false, now()),
  ('e3000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-000000000001', 'TO Sold out',    10000, true,  true,  null),
  ('e3000000-0000-4000-8000-000000000007', 'e2000000-0000-4000-8000-000000000001', 'TO Feast',     1000000, true,  false, null);
insert into public.menu_variants (id, item_id, kind, label, price_delta_paisa, is_sold_out, sort_order) values
  ('e4000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'size',  'Large',     3000, false, 1),
  ('e4000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000001', 'milk',  'Oat milk',  6000, false, 2),
  ('e4000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000001', 'size',  'Small',   -20000, false, 3),
  ('e4000000-0000-4000-8000-000000000004', 'e3000000-0000-4000-8000-000000000001', 'milk',  'Soy milk',  5000, true,  4),
  ('e4000000-0000-4000-8000-000000000005', 'e3000000-0000-4000-8000-000000000002', 'addon', 'Achar',     3000, false, 1);

-- Tables 1, 2, 3 and 9. Table 9 has history (one old void session with a served round), so it can only be deactivated.
select pg_temp.flag(true);
insert into public.cafe_tables (id, number, label, is_active) values
  ('e5000000-0000-4000-8000-000000000001', 1, 'Window', true),
  ('e5000000-0000-4000-8000-000000000002', 2, null,     true),
  ('e5000000-0000-4000-8000-000000000003', 3, null,     true),
  ('e5000000-0000-4000-8000-000000000009', 9, null,     true);
insert into public.table_sessions (id, table_id, table_number, status, code, opened_at, closed_at, outcome,
                                   prices_include_vat, subtotal_paisa, service_charge_paisa, vat_paisa, total_paisa)
values ('e6000000-0000-4000-8000-000000000009', 'e5000000-0000-4000-8000-000000000009', 9, 'closed', null,
        '2020-12-31 10:00+05:45', '2020-12-31 11:00+05:45', 'void', true, 10000, 0, 1150, 10000);
insert into public.table_orders (id, session_id, round, client_request_id, request_fingerprint, status, subtotal_paisa,
                                 created_at, accepted_at, served_at)
values ('e8000000-0000-4000-8000-000000000009', 'e6000000-0000-4000-8000-000000000009', 1, pg_temp.rq(9999), repeat('0', 64),
        'served', 10000, '2020-12-31 10:10+05:45', '2020-12-31 10:15+05:45', '2020-12-31 10:20+05:45');
select pg_temp.flag(false);

-- =================================================================================================================
-- 1. Structure and grants
-- =================================================================================================================
select has_table('public', t, t || ' exists')
  from unnest(array['cafe_tables', 'table_sessions', 'table_orders', 'table_order_items', 'table_board_state',
                    'admin_alerts', 'alert_deliveries']) t;
select has_view('public', 'table_occupancy', 'table_occupancy view exists');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relrowsecurity
              and c.relname in ('cafe_tables', 'table_sessions', 'table_orders', 'table_order_items', 'table_board_state',
                                'admin_alerts', 'alert_deliveries')),
          7, 'RLS is enabled on all 7 new tables');
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
            where c.relname in ('cafe_tables', 'table_sessions', 'table_orders', 'table_order_items', 'table_board_state',
                                'admin_alerts', 'alert_deliveries')),
          0, 'no RLS policies on them (deny by default)');
select is((select count(*)::int
             from unnest(array['anon', 'authenticated']) r,
                  unnest(array['public.cafe_tables', 'public.table_sessions', 'public.table_orders', 'public.table_order_items',
                               'public.table_board_state', 'public.admin_alerts', 'public.alert_deliveries',
                               'public.table_occupancy']) t,
                  unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
            where has_table_privilege(r, t, p)),
          0, 'anon and authenticated have no table privilege on the new tables or the view');
select is((select count(*)::int from information_schema.column_privileges
            where grantee in ('anon', 'authenticated', 'PUBLIC') and table_schema = 'public'
              and table_name in ('cafe_tables', 'table_sessions', 'table_orders', 'table_order_items', 'table_board_state',
                                 'admin_alerts', 'alert_deliveries', 'table_occupancy')),
          0, 'SEC-029: and no column privilege either');
select ok(has_table_privilege('service_role', 'public.table_occupancy', 'select'), 'service_role can read table_occupancy');
select is((select array_agg(attname::text order by attnum) from pg_attribute
            where attrelid = 'public.table_occupancy'::regclass and attnum > 0 and not attisdropped),
          array['number', 'label', 'occupied'], 'table_occupancy has exactly number, label, occupied (never the code)');
select is((select attname::text from pg_attribute
            where attrelid = 'public.public_settings'::regclass and attnum > 0 and not attisdropped
            order by attnum desc limit 1), 'table_ordering', 'public_settings has table_ordering as its last column');
select col_default_is('public', 'site_settings', 'table_ordering', 'off', 'site_settings.table_ordering defaults to off');
select col_type_is('public', 'order_rules', 'staff_cancel_window_minutes', 'smallint', '2.2.0: staff_cancel_window_minutes is smallint');
select col_default_is('public', 'order_rules', 'staff_cancel_window_minutes', '10', '... default 10 minutes');
select col_default_is('public', 'order_rules', 'owner_alert_whatsapp', '{}', '2.2.0: owner_alert_whatsapp defaults to empty');
select hasnt_column('public', 'order_rules', 'table_order_alerts', '2.2.0: there is no order_rules.table_order_alerts');
select col_type_is('public', 'table_sessions', 'cookie_epoch', 'smallint', '2.1.0: cookie_epoch smallint');
select col_default_is('public', 'table_sessions', 'cookie_epoch', '1', '... starts at 1');
select col_default_is('public', 'table_sessions', 'orders_locked', 'false', '2.1.0: orders_locked defaults to false');
select col_not_null('public', 'table_orders', 'request_fingerprint', '2.1.0: every round has a request fingerprint');
select ok(exists (select 1 from pg_indexes where indexname = 'table_sessions_one_open_per_table'), 'one-open-per-table index exists');
select ok(exists (select 1 from pg_constraint where conname = 'cafe_tables_number_key' and condeferrable),
          'cafe_tables_number_key is deferrable');
select ok(exists (select 1 from pg_constraint where conname = 'table_orders_session_closed_only_unaccepted')
          and exists (select 1 from pg_constraint where conname = 'table_orders_accepted')
          and exists (select 1 from pg_constraint where conname = 'table_sessions_unlocked_when_closed'),
          '2.1.0 constraints exist');

-- The pinned anon / authenticated callable lists (rls.test.sql) are unchanged.
select is((select coalesce(array_agg(p.proname::text order by p.proname::text), '{}')
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
              and not exists (select 1 from pg_depend d
                               where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
              and has_function_privilege('anon', p.oid, 'execute')),
          array['current_app_role', 'health_ping', 'is_owner', 'is_staff'], 'anon-callable list unchanged');
select is((select coalesce(array_agg(p.proname::text order by p.proname::text), '{}')
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
              and not exists (select 1 from pg_depend d
                               where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
              and has_function_privilege('authenticated', p.oid, 'execute')),
          array['current_app_role', 'health_ping', 'is_owner', 'is_staff'], 'authenticated-callable list unchanged');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('list_cafe_tables', 'save_cafe_tables', 'set_table_ordering', 'open_table_session',
                                'rotate_table_code', 'set_table_orders_locked', 'join_table_session',
                                'table_session_guest_view', 'create_table_order', 'transition_table_order',
                                'close_table_session', 'table_board', 'auto_close_stale_table_sessions',
                                'stats_table_orders', 'record_admin_alert', 'mark_admin_alerts_read',
                                'claim_alert_deliveries', 'finish_alert_delivery', 'purge_personal_data')
              and p.prosecdef and p.proconfig @> array['search_path=""']
              and has_function_privilege('service_role', p.oid, 'execute')
              and not has_function_privilege('anon', p.oid, 'execute')
              and not has_function_privilege('authenticated', p.oid, 'execute')
              and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')),
          19, 'all 19 table-ordering / alert RPCs: SECURITY DEFINER, search_path empty, service_role only, nothing for PUBLIC');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.prorettype <> 'trigger'::regtype
              and p.proname in ('new_table_code', 'table_bill', 'table_session_subtotal', 'table_ever_accepted',
                                'table_session_bill', 'table_round_guest_json', 'table_round_admin_json',
                                'table_session_guest_json', 'table_session_admin_json', 'table_closed_summary_json',
                                'cafe_tables_json', 'table_lock_board', 'table_board_bump', 'table_request_fingerprint',
                                'raise_admin_alert', 'transition_table_round', 'table_order_replay')
              and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                   or has_function_privilege('service_role', p.oid, 'execute'))),
          0, 'private helpers are not executable by anon, authenticated or service_role');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private'
              and p.proname in ('new_table_code', 'table_bill', 'table_session_subtotal', 'table_ever_accepted',
                                'table_session_bill', 'table_round_guest_json', 'table_round_admin_json',
                                'table_session_guest_json', 'table_session_admin_json', 'table_closed_summary_json',
                                'cafe_tables_json', 'table_lock_board', 'table_board_bump', 'table_request_fingerprint',
                                'raise_admin_alert', 'transition_table_round', 'table_order_replay')),
          17, 'all 17 private helpers exist (separate guest and admin builders)');
select is((select count(*)::int from pg_publication_tables
            where pubname = 'supabase_realtime'
              and tablename in ('cafe_tables', 'table_sessions', 'table_orders', 'table_order_items', 'table_board_state',
                                'admin_alerts', 'alert_deliveries')),
          0, 'nothing new in the supabase_realtime publication');
select ok(not exists (select 1 from pg_extension where extname = 'pg_cron')
          or exists (select 1 from cron.job where jobname = 'cafe-table-sessions-expire' and schedule = '*/15 * * * *'
                       and command = 'select public.auto_close_stale_table_sessions()'),
          'pg_cron job cafe-table-sessions-expire runs every 15 minutes (when pg_cron is installed)');

set local role anon;
select throws_ok($$select * from public.table_occupancy$$, '42501', null, 'anon cannot read table_occupancy');
select throws_ok($$select * from public.admin_alerts$$, '42501', null, 'anon cannot read admin_alerts');
select throws_ok($$select public.join_table_session(1, 'AAAAAA')$$, '42501', null, 'anon cannot call join_table_session');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select * from public.table_sessions$$, '42501', null, 'owner JWT cannot read table_sessions directly');
select throws_ok($$select * from public.alert_deliveries$$, '42501', null, 'owner JWT cannot read alert_deliveries directly');
select throws_ok($$select public.table_board(null, 'e1000000-0000-4000-8000-000000000001')$$, '42501', null,
                 'owner JWT cannot call table_board (service role only)');
reset role;

-- owner_alert_whatsapp CHECK (0..3 Nepal mobiles)
select is(pg_temp.state($$update public.order_rules set owner_alert_whatsapp = array['+9779841000001', '+9779751000002', '+9779801000003']$$),
          'ok', 'owner_alert_whatsapp: three Nepal mobiles accepted');
select is(pg_temp.state($$update public.order_rules set owner_alert_whatsapp = array['+9779841000001', '+9779841000002', '+9779841000003', '+9779841000004']$$),
          '23514', 'owner_alert_whatsapp: a fourth number is refused');
select is(pg_temp.state($$update public.order_rules set owner_alert_whatsapp = array['9841000001']$$), '23514',
          'owner_alert_whatsapp: a number without +977 is refused');
select is(pg_temp.state($$update public.order_rules set staff_cancel_window_minutes = 61$$), '23514',
          'staff_cancel_window_minutes over 60 is refused');
update public.order_rules set owner_alert_whatsapp = '{}';

-- =================================================================================================================
-- 2. Guards
-- =================================================================================================================
set local role service_role;
select is(pg_temp.state($$insert into public.cafe_tables (number) values (50)$$), '42501', 'service role insert without the flag: 42501');
select is(pg_temp.state($$update public.cafe_tables set label = 'x' where number = 1$$), '42501', 'service role update without the flag: 42501');
select is(pg_temp.state($$delete from public.cafe_tables where number = 3$$), '42501', 'service role delete without the flag: 42501');
select is(pg_temp.state($$update public.table_board_state set version = version + 1$$), '42501', 'board state is guarded too');
select is(pg_temp.state($$insert into public.table_sessions (table_id, table_number, code)
                          values ('e5000000-0000-4000-8000-000000000001', 1, 'ABCDEF')$$), '42501', 'session insert without the flag: 42501');
select is(pg_temp.state($$update public.table_orders set status = 'cancelled' where id = 'e8000000-0000-4000-8000-000000000009'$$),
          '42501', 'round update without the flag: 42501');
select is(pg_temp.state($$insert into public.admin_alerts (kind, text) values ('table_join_fail', 'x')$$), '42501',
          'admin_alerts insert without the flag: 42501');
select is(pg_temp.state($$update public.site_settings set table_ordering = 'paused'$$), '42501',
          'SEC-029: the service role cannot change site_settings.table_ordering directly');
select is(pg_temp.state($$update public.site_settings set announcement = announcement$$), 'ok',
          'other site_settings columns are not affected by the mode guard');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$update public.site_settings set table_ordering = 'paused'$$, '42501', null,
                 'SEC-029: the owner JWT cannot change site_settings.table_ordering either');
select results_eq($$with u as (update public.site_settings set announcement = 'TO owner edit' returning 1) select count(*)::int from u$$,
                  $$values (1)$$, 'the owner JWT can still edit other settings');
reset role;

-- CHECKs (flag on, as postgres): code, note, label.
select pg_temp.flag(true);
select is(pg_temp.state(format($$insert into public.table_sessions (table_id, table_number, code)
                                 values ('e5000000-0000-4000-8000-000000000003', 3, %L)$$, c)), '23514',
          'code CHECK rejects ' || c)
  from unnest(array['ABCDEO', 'ABCDE0', 'ABCDE1', 'ABCDEI', 'ABCDEL', 'abcdef', 'ABCDE', 'ABCDEFG']) c;
select is(pg_temp.state($$insert into public.table_sessions (table_id, table_number, code)
                          values ('e5000000-0000-4000-8000-000000000003', 3, null)$$), '23514',
          'an open session must have a code');
select is(pg_temp.state(format($$insert into public.table_orders (session_id, round, client_request_id, request_fingerprint,
                                   subtotal_paisa, note)
                                 values ('e6000000-0000-4000-8000-000000000009', 2, gen_random_uuid(), repeat('0', 64), 0, %L)$$,
                                n.txt)), '23514', 'note CHECK rejects ' || n.label)
  from (values (E'less\nsugar', '\n'), (E'ring\u0007', 'U+0007'), (E'abc‮def', 'U+202E'), (E'abc⁦def', 'U+2066'),
               (E'tab\there', '\t')) as n(txt, label);
select is(pg_temp.state($$insert into public.table_orders (session_id, round, client_request_id, request_fingerprint,
                            subtotal_paisa, note)
                          values ('e6000000-0000-4000-8000-000000000009', 2, gen_random_uuid(), repeat('0', 64), 0, 'less sugar, éé')$$),
          'ok', 'a plain note (Unicode letters fine) is accepted');
select is(pg_temp.state($$update public.cafe_tables set label = E'Win‮dow' where number = 1$$), '23514',
          'label CHECK rejects a bidi override (addition, flagged)');
-- admin_alerts: only read_at / read_by can ever change, flag or not.
insert into public.admin_alerts (id, kind, text) values ('e9000000-0000-4000-8000-000000000001', 'table_join_fail', 'TO fixture');
select is(pg_temp.state($$update public.admin_alerts set text = 'changed' where id = 'e9000000-0000-4000-8000-000000000001'$$),
          '42501', 'admin_alerts text is immutable');
select is(pg_temp.state($$update public.admin_alerts set kind = 'table_void' where id = 'e9000000-0000-4000-8000-000000000001'$$),
          '42501', 'admin_alerts kind is immutable');
select is(pg_temp.state($$update public.admin_alerts set read_at = now() where id = 'e9000000-0000-4000-8000-000000000001'$$),
          'ok', 'read_at can change (with the flag)');
delete from public.admin_alerts where id = 'e9000000-0000-4000-8000-000000000001';
delete from public.table_orders where session_id = 'e6000000-0000-4000-8000-000000000009' and round = 2;
select pg_temp.flag(false);

-- FK ON DELETE SET NULL from profiles still works through the guard (deleting a staff login).
select pg_temp.flag(true);
insert into public.table_sessions (id, table_id, table_number, status, code, opened_by, opened_at, closed_by, closed_at, outcome,
                                   prices_include_vat, subtotal_paisa, service_charge_paisa, vat_paisa, total_paisa)
values ('e6000000-0000-4000-8000-000000000008', 'e5000000-0000-4000-8000-000000000009', 9, 'closed', null,
        'e1000000-0000-4000-8000-000000000003', '2020-12-30 10:00+05:45', 'e1000000-0000-4000-8000-000000000003',
        '2020-12-30 11:00+05:45', 'void', true, 0, 0, 0, 0);
select pg_temp.flag(false);
select lives_ok($$delete from auth.users where id = 'e1000000-0000-4000-8000-000000000003'$$,
                'a staff login that opened and closed a table can still be deleted (guard allows FK set null; addition, flagged)');
select is((select row(opened_by, closed_by)::text from public.table_sessions where id = 'e6000000-0000-4000-8000-000000000008'),
          row(null::uuid, null::uuid)::text, 'opened_by / closed_by became null');

-- =================================================================================================================
-- 3. Code generation
-- =================================================================================================================
create temp table codes as select private.new_table_code() as c from generate_series(1, 1000);
select is((select count(*)::int from codes where c ~ '^[2-9A-HJKMNP-Z]{6}$'), 1000, '1,000 codes all match the code pattern');
select is((select count(distinct ch)::int from codes, regexp_split_to_table(c, '') ch), 31,
          'every one of the 31 alphabet symbols appears');
select is((select string_agg(distinct ch, '' order by ch) from codes, regexp_split_to_table(c, '') ch),
          '23456789ABCDEFGHJKMNPQRSTUVWXYZ', 'and nothing else (no 0, 1, I, L, O)');

-- =================================================================================================================
-- 4. save_cafe_tables
-- =================================================================================================================
set local role service_role;
select pg_temp.put('v0', pg_temp.ver()::text);
select is(jsonb_array_length(public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 1, "label": "Window", "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 2, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000003", "number": 3, "label": null, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000009", "number": 9, "isActive": true},
              {"number": 4, "label": "  Garden  ", "isActive": true},
              {"number": 5, "label": "   ", "isActive": true}]', pg_temp.ow()) -> 'rows'),
          6, 'create: 2 new tables added to the 4 existing');
select is((select label from public.cafe_tables where number = 4), 'Garden', 'label stored trimmed');
select is((select label from public.cafe_tables where number = 5), null, 'blank label stored as null');
select ok(pg_temp.ver() > pg_temp.ct('v0')::bigint, 'save bumps the board version');
select is((select row(r ->> 'isOpen', r ->> 'hasHistory')::text
             from jsonb_array_elements(public.list_cafe_tables(pg_temp.sf()) -> 'rows') r
            where (r ->> 'number')::int = 9), row('false', 'true')::text, 'list_cafe_tables (staff): table 9 hasHistory');
select is(public.list_cafe_tables(pg_temp.sf()) ->> 'mode', 'on', 'list_cafe_tables returns the mode');

select lives_ok($$select public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 2, "label": "Window", "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 1, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000003", "number": 3, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000009", "number": 9, "isActive": true}]', pg_temp.ow())$$,
                'swap numbers 1 <-> 2 in one call (and leave out 4 and 5)');
select is((select number from public.cafe_tables where id = 'e5000000-0000-4000-8000-000000000001'), 2::smallint, 'numbers swapped (a)');
select is((select number from public.cafe_tables where id = 'e5000000-0000-4000-8000-000000000002'), 1::smallint, 'numbers swapped (b)');
select is((select count(*)::int from public.cafe_tables where number in (4, 5)), 0, 'left-out tables without history are deleted');
select lives_ok($$select public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 1, "label": "Window", "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 2, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000003", "number": 3, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000009", "number": 9, "isActive": true}]', pg_temp.ow())$$, 'swap back');
select pg_temp.put('v1', pg_temp.ver()::text);
select lives_ok($$select public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 1, "label": "Window", "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 2, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000003", "number": 3, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000009", "number": 9, "isActive": true}]', pg_temp.ow())$$,
                'saving the same set again');
select is(pg_temp.ver(), pg_temp.ct('v1')::bigint, 'a save that changes nothing does not bump the version');

select ok(pg_temp.err($$select public.save_cafe_tables('[{"number": 7, "isActive": true}, {"number": 7, "isActive": true}]',
            pg_temp.ow())$$) like 'VALIDATION|%"tables.1.number": ["That table number is used twice."]%',
          'duplicate number: VALIDATION tables.N.number');
select ok(pg_temp.err($$select public.save_cafe_tables('[{"number": 100, "isActive": true}, {"number": 1, "label": "x", "isActive": "yes"}]',
            pg_temp.ow())$$) like 'VALIDATION|%tables.0.number%tables.1.isActive%',
          'number 100 and a non-boolean isActive: VALIDATION with both keys');
select ok(pg_temp.err($$select public.save_cafe_tables('[{"number": 1, "label": "12345678901234567890123456789012345678901", "isActive": true}]',
            pg_temp.ow())$$) like 'VALIDATION|%tables.0.label%', 'label over 40: VALIDATION');
select ok(pg_temp.err(format($$select public.save_cafe_tables(%L, %L)$$,
            jsonb_build_array(jsonb_build_object('number', 1, 'label', E'Win‮dow', 'isActive', true)), pg_temp.ow()))
          like 'VALIDATION|%tables.0.label%plain text%', 'label with a bidi override: VALIDATION (not a 23514)');
select ok(pg_temp.err($$select public.save_cafe_tables('[{"id": "00000000-0000-4000-8000-0000000000aa", "number": 1, "isActive": true}]',
            pg_temp.ow())$$) like 'NOT_FOUND|%', 'unknown id: NOT_FOUND');
select ok(pg_temp.err($$select public.save_cafe_tables('[]', pg_temp.sf())$$) like 'FORBIDDEN|%', 'staff refused: FORBIDDEN');
select ok(pg_temp.err($$select public.save_cafe_tables('[]', null)$$) like 'FORBIDDEN|%', 'no actor: FORBIDDEN');

select lives_ok($$select public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 1, "label": "Window", "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 2, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000003", "number": 3, "isActive": true}]', pg_temp.ow())$$,
                'leave out table 9 (has history)');
select is((select is_active from public.cafe_tables where id = 'e5000000-0000-4000-8000-000000000009'), false,
          'a left-out table with history is deactivated, not deleted');
select ok(pg_temp.err($$select public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 1, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 2, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000003", "number": 3, "isActive": true},
              {"number": 9, "isActive": true}]', pg_temp.ow())$$) like 'VALIDATION|%tables.3.number%old table%',
          'a new row cannot take the number of a left-out table that keeps its history');

select pg_temp.put('s_t3', pg_temp.open('e5000000-0000-4000-8000-000000000003') ->> 'id');
select ok(pg_temp.err($$select public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 1, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 2, "isActive": true}]', pg_temp.ow())$$)
          = 'CONFLICT||Close table 3 first.', 'leaving out an open table: CONFLICT');
select ok(pg_temp.err($$select public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 1, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 2, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000003", "number": 30, "isActive": true}]', pg_temp.ow())$$)
          = 'CONFLICT||Close table 3 first.', 'renumbering an open table: CONFLICT');
select ok(pg_temp.err($$select public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 1, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 2, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000003", "number": 3, "isActive": false}]', pg_temp.ow())$$)
          = 'CONFLICT||Close table 3 first.', 'deactivating an open table: CONFLICT');
select lives_ok($$select public.save_cafe_tables(
            '[{"id": "e5000000-0000-4000-8000-000000000001", "number": 1, "label": "Window", "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000002", "number": 2, "isActive": true},
              {"id": "e5000000-0000-4000-8000-000000000003", "number": 3, "label": "Corner", "isActive": true}]', pg_temp.ow())$$,
                'relabelling an open table is fine');
reset role;

-- =================================================================================================================
-- 5. Mode
-- =================================================================================================================
set local role service_role;
select pg_temp.put('v2', pg_temp.ver()::text);
select is(public.set_table_ordering('paused', pg_temp.sf()), 'paused', 'staff: on -> paused');
select ok(pg_temp.ver() > pg_temp.ct('v2')::bigint, 'a mode change bumps the board version');
select is(public.set_table_ordering('on', pg_temp.sf()), 'on', 'staff: paused -> on');
select ok(pg_temp.err($$select public.set_table_ordering('off', pg_temp.sf())$$) like 'FORBIDDEN|%', 'staff: off refused (FORBIDDEN)');
select ok(pg_temp.err($$select public.set_table_ordering('off', pg_temp.ow())$$) = 'CONFLICT||Close all open tables first.',
          'owner: off with an open table: CONFLICT');
select ok(pg_temp.err($$select public.set_table_ordering('sleep', pg_temp.ow())$$) like 'VALIDATION|%mode%', 'unknown mode: VALIDATION');
select is(public.close_table_session(pg_temp.c('s_t3'), 'void', null, 0, pg_temp.sf()) ->> 'outcome', 'void',
          'staff voids the empty table 3 (no round was ever accepted)');
select is(public.set_table_ordering('off', pg_temp.ow()), 'off', 'owner: off with no open table');
select is((select table_ordering from public.public_settings), 'off', 'public_settings shows the mode');
select ok(pg_temp.err($$select pg_temp.open('e5000000-0000-4000-8000-000000000001')$$)
          = 'CONFLICT||Table ordering is off. Turn it on in Tables setup.', 'open while off: CONFLICT');
select ok(pg_temp.err($$select public.join_table_session(1, 'AAAAAA')$$) like 'NOT_FOUND|%', 'join while off: NOT_FOUND');
select ok(pg_temp.ord_err(pg_temp.c('s_t3'), 1, pg_temp.momo()) like 'TABLE_SESSION_INVALID|%',
          'a round while off: refused (no session can be open while off; the session check runs first)');
select is(pg_temp.gv(pg_temp.c('s_t3')), '{"state": "none"}'::jsonb, 'guest view while off: none');
select ok(pg_temp.err($$select public.set_table_ordering('on', pg_temp.sf())$$) like 'FORBIDDEN|%', 'staff cannot switch away from off');
select is(public.set_table_ordering('on', pg_temp.ow()), 'on', 'owner: off -> on');
select pg_temp.put('v3', pg_temp.ver()::text);
select is(public.set_table_ordering('on', pg_temp.ow()), 'on', 'setting the same mode again');
select is(pg_temp.ver(), pg_temp.ct('v3')::bigint, 'no change, no version bump');
reset role;

-- =================================================================================================================
-- 6. Open, join, rotate, lock
-- =================================================================================================================
set local role service_role;
select pg_temp.put('v4', pg_temp.ver()::text);
select pg_temp.put('open1', pg_temp.open('e5000000-0000-4000-8000-000000000001')::text);
select pg_temp.put('s1', pg_temp.ct('open1')::jsonb ->> 'id');
select pg_temp.put('code1', pg_temp.ct('open1')::jsonb ->> 'code');
select ok(pg_temp.ver() > pg_temp.ct('v4')::bigint, 'open bumps the board version');
select ok(pg_temp.ct('code1') ~ '^[2-9A-HJKMNP-Z]{6}$', 'the new code has 6 symbols from the alphabet');
select is(pg_temp.ct('open1')::jsonb ->> 'joinPath', '/menu?t=1#c=' || pg_temp.ct('code1'), 'joinPath carries the code in the fragment (#c=)');
select is(pg_temp.ct('open1')::jsonb - 'id' - 'code' - 'joinPath' - 'openedAt' - 'lastActivityAt',
          '{"openedByName": "TO Staff", "ordersLocked": false, "codeChanges": 0, "everAccepted": false, "rounds": [],
            "bill": {"subtotal": 0, "serviceCharge": 0, "vat": 0, "total": 0, "pricesIncludeVat": true, "serviceChargePct": 0.00},
            "waiting": {"new": 0, "preparing": 0}}'::jsonb,
          'open returns AdminTableSession');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.ct('open1')::jsonb) k),
          array['bill', 'code', 'codeChanges', 'everAccepted', 'id', 'joinPath', 'lastActivityAt', 'openedAt', 'openedByName',
                'ordersLocked', 'rounds', 'waiting'], 'AdminTableSession keys (api-contract 9.7)');
select is(pg_temp.err($$select pg_temp.open('e5000000-0000-4000-8000-000000000001', pg_temp.ow())$$),
          'CONFLICT||Table 1 is still open from '
          || to_char((select opened_at from public.table_sessions where id = pg_temp.c('s1')) at time zone 'Asia/Kathmandu', 'HH24:MI')
          || '. Close it first, or press New code.', 'one open per table: "still open from HH:mm" (Kathmandu)');
select ok(pg_temp.err($$select pg_temp.open('e5000000-0000-4000-8000-000000000009')$$) = 'CONFLICT||This table is not in use.',
          'inactive table: CONFLICT');
select ok(pg_temp.err($$select pg_temp.open('00000000-0000-4000-8000-0000000000aa')$$) like 'NOT_FOUND|%', 'unknown table: NOT_FOUND');
select ok(pg_temp.err($$select pg_temp.open('e5000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa')$$)
          like 'FORBIDDEN|%', 'unknown actor: FORBIDDEN');
select is((select array_agg(occupied order by number) from public.table_occupancy), array[true, false, false],
          'occupancy: table 1 occupied, 2 and 3 free, inactive 9 hidden');

select pg_temp.put('v5', pg_temp.ver()::text);
select is((public.join_table_session(1, pg_temp.ct('code1')) ->> 'sessionId')::uuid, pg_temp.c('s1'), 'join with the right code');
select is(public.join_table_session(1, pg_temp.ct('code1')) -> 'epoch', '1'::jsonb, 'join returns the epoch');
select is((public.join_table_session(1, pg_temp.ct('code1')) -> 'view') - 'openedAt',
          '{"rev": 1, "tableNumber": 1, "tableLabel": "Window", "ordering": "on", "rounds": [],
            "bill": {"subtotal": 0, "serviceCharge": 0, "vat": 0, "total": 0, "pricesIncludeVat": true, "serviceChargePct": 0.00},
            "limits": {"maxLines": 20, "maxQty": 20, "maxWaitingRounds": 3, "maxLiveRounds": 30, "maxNoteLength": 200}}'::jsonb,
          'join returns TableSessionView (guest builder)');
select is(pg_temp.ver(), pg_temp.ct('v5')::bigint, 'join writes nothing (no version bump)');
select is((public.join_table_session(1, lower(substr(pg_temp.ct('code1'), 1, 3)) || ' - ' || lower(substr(pg_temp.ct('code1'), 4)))
            ->> 'sessionId')::uuid, pg_temp.c('s1'), 'case, spaces and dashes are normalised');

-- One identical VALIDATION for: wrong code, free table, inactive table, unknown number, old code, 12 h old session.
select pg_temp.put('wrong', case when pg_temp.ct('code1') = 'ZZZZZZ' then 'YYYYYY' else 'ZZZZZZ' end);
select pg_temp.put('e_wrong',   pg_temp.err(format('select public.join_table_session(1, %L)', pg_temp.ct('wrong'))));
select pg_temp.put('e_free',    pg_temp.err(format('select public.join_table_session(2, %L)', pg_temp.ct('code1'))));
select pg_temp.put('e_inact',   pg_temp.err(format('select public.join_table_session(9, %L)', pg_temp.ct('code1'))));
select pg_temp.put('e_unknown', pg_temp.err(format('select public.join_table_session(77, %L)', pg_temp.ct('code1'))));
select is(pg_temp.ct('e_wrong'),
          'VALIDATION|{"code": ["That code doesn''t match this table. Check it, or ask our staff."]}|', 'wrong code: VALIDATION code');
select ok(position(pg_temp.ct('wrong') in pg_temp.ct('e_wrong')) = 0, 'D5: the error text does not contain the typed code');
select is(array[pg_temp.ct('e_free'), pg_temp.ct('e_inact'), pg_temp.ct('e_unknown')],
          array[pg_temp.ct('e_wrong'), pg_temp.ct('e_wrong'), pg_temp.ct('e_wrong')],
          'free table, inactive table and unknown number get the identical answer');
-- table 2: open, then backdate to 12 h 1 min ago (also used by the expiry group)
select pg_temp.put('open2', pg_temp.open('e5000000-0000-4000-8000-000000000002', pg_temp.ow())::text);
select pg_temp.put('s2', pg_temp.ct('open2')::jsonb ->> 'id');
reset role;
select pg_temp.flag(true);
update public.table_sessions set opened_at = now() - interval '12 hours 1 minute' where id = pg_temp.c('s2');
select pg_temp.flag(false);
set local role service_role;
select is(pg_temp.err(format('select public.join_table_session(2, %L)', pg_temp.ct('open2')::jsonb ->> 'code')),
          pg_temp.ct('e_wrong'), 'a session opened 12 h ago refuses the join with the same answer');

-- rotate_table_code and set_table_orders_locked (session s4 on table 3)
select pg_temp.put('open4', pg_temp.open('e5000000-0000-4000-8000-000000000003')::text);
select pg_temp.put('s4', pg_temp.ct('open4')::jsonb ->> 'id');
select pg_temp.put('code4', pg_temp.ct('open4')::jsonb ->> 'code');
select is((pg_temp.ord(pg_temp.c('s4'), 401, pg_temp.momo()) ->> 'round')::int, 1, 'a round on table 3');
select pg_temp.put('v_rot', pg_temp.ver()::text);
select pg_temp.put('rot4', public.rotate_table_code(pg_temp.c('s4'), pg_temp.sf())::text);
select ok(pg_temp.ct('rot4')::jsonb ->> 'code' <> pg_temp.ct('code4'), 'rotate: a different code');
select is((pg_temp.ct('rot4')::jsonb ->> 'codeChanges')::int, 1, 'rotate: codeChanges 1');
select is(pg_temp.ct('rot4')::jsonb ->> 'joinPath', '/menu?t=3#c=' || (pg_temp.ct('rot4')::jsonb ->> 'code'), 'rotate: new joinPath');
select is(jsonb_array_length(pg_temp.ct('rot4')::jsonb -> 'rounds'), 1, 'rotate: rounds kept');
select is(pg_temp.ct('rot4')::jsonb -> 'bill' -> 'subtotal', '20000'::jsonb, 'rotate: bill kept');
select ok(pg_temp.ver() > pg_temp.ct('v_rot')::bigint, 'rotate bumps the board version');
select is(pg_temp.gv(pg_temp.c('s4')), '{"state": "none"}'::jsonb, 'rotate: the old epoch reads as none');
select ok(pg_temp.ord_err(pg_temp.c('s4'), 402, pg_temp.momo()) like 'TABLE_SESSION_INVALID|%', 'rotate: the old epoch cannot send rounds');
select is(pg_temp.err(format('select public.join_table_session(3, %L)', pg_temp.ct('code4'))), pg_temp.ct('e_wrong'),
          'rotate: the old code gets the identical VALIDATION');
select is(public.join_table_session(3, pg_temp.ct('rot4')::jsonb ->> 'code') -> 'epoch', '2'::jsonb, 'rotate: the new code joins with epoch 2');
select is(pg_temp.gv(pg_temp.c('s4'), null, 2) ->> 'state', 'open', 'the new epoch reads the session');
select is(public.set_table_orders_locked(pg_temp.c('s4'), true, pg_temp.sf()) -> 'ordersLocked', 'true'::jsonb, 'lock: ordersLocked true');
select pg_temp.put('v_lock', pg_temp.ver()::text);
select is(public.set_table_orders_locked(pg_temp.c('s4'), true, pg_temp.sf()) -> 'ordersLocked', 'true'::jsonb, 'lock again: idempotent');
select is(pg_temp.ver(), pg_temp.ct('v_lock')::bigint, '... no version bump');
select is(pg_temp.ord_err(pg_temp.c('s4'), 403, pg_temp.momo(), null, 2),
          'TABLE_ORDERS_PAUSED||Ordering from the app is stopped for this table. Please order with our staff.',
          'locked: TABLE_ORDERS_PAUSED with the table message');
select is(pg_temp.gv(pg_temp.c('s4'), null, 2) -> 'session' ->> 'ordering', 'stopped', 'locked: the guest sees ordering "stopped"');
select is(public.set_table_orders_locked(pg_temp.c('s4'), false, pg_temp.sf()) -> 'ordersLocked', 'false'::jsonb, 'unlock');
select is(public.set_table_orders_locked(pg_temp.c('s4'), true, pg_temp.sf()) -> 'ordersLocked', 'true'::jsonb, 'lock before closing');
select is(public.close_table_session(pg_temp.c('s4'), 'void', null, 20000, pg_temp.sf()) ->> 'outcome', 'void',
          'staff void with only `new` rounds: OK');
reset role;
select is((select row(orders_locked, code)::text from public.table_sessions where id = pg_temp.c('s4')),
          row(false, null::text)::text, 'close clears orders_locked and the code');
select is((select row(status, cancel_reason)::text from public.table_orders where session_id = pg_temp.c('s4')),
          row('cancelled', 'session_closed')::text, 'the new round became session_closed');
set local role service_role;
select is(pg_temp.err($$select public.rotate_table_code(pg_temp.c('s4'), pg_temp.sf())$$), 'CONFLICT||This table is closed.',
          'rotate a closed table: CONFLICT');
select is(pg_temp.err($$select public.set_table_orders_locked(pg_temp.c('s4'), false, pg_temp.sf())$$),
          'CONFLICT||This table is closed.', 'lock a closed table: CONFLICT');
reset role;

-- =================================================================================================================
-- 7. Rounds (session s1, table 1; VAT inside, no service charge)
-- =================================================================================================================
set local role service_role;
select pg_temp.put('r1items', jsonb_build_array(
         pg_temp.ln('e3000000-0000-4000-8000-000000000001', 2),
         pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1, array['e4000000-0000-4000-8000-000000000001'::uuid]),
         pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1, array['e4000000-0000-4000-8000-000000000002'::uuid,
                                                                      'e4000000-0000-4000-8000-000000000001'::uuid]),
         pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1, array['e4000000-0000-4000-8000-000000000003'::uuid]),
         pg_temp.ln('e3000000-0000-4000-8000-000000000002', 1))::text);
select pg_temp.put('v6', pg_temp.ver()::text);
select pg_temp.put('r1', pg_temp.ord(pg_temp.c('s1'), 1, pg_temp.ct('r1items')::jsonb, '  less sugar  ')::text);
select is((pg_temp.ct('r1')::jsonb ->> 'round')::int, 1, 'first round is round 1');
select is(pg_temp.ct('r1')::jsonb -> 'replayed', 'false'::jsonb, 'replayed false');
select is((select jsonb_agg(jsonb_build_object('options', l -> 'options', 'unitPrice', l -> 'unitPrice', 'qty', l -> 'qty'))
             from jsonb_array_elements(pg_temp.ct('r1')::jsonb -> 'session' -> 'rounds' -> 0 -> 'items') l),
          '[{"options": null, "unitPrice": 10000, "qty": 2},
            {"options": "Large", "unitPrice": 13000, "qty": 1},
            {"options": "Large, Oat milk", "unitPrice": 19000, "qty": 1},
            {"options": "Small", "unitPrice": 0, "qty": 1},
            {"options": null, "unitPrice": 20000, "qty": 1}]'::jsonb,
          'pricing with 0, 1 and 2 options; negative delta floored at 0; options in variant sort order');
select is(pg_temp.ct('r1')::jsonb -> 'session' -> 'rounds' -> 0 -> 'items' -> 2 -> 'variantIds',
          '["e4000000-0000-4000-8000-000000000001", "e4000000-0000-4000-8000-000000000002"]'::jsonb, 'variantIds sorted');
select is((pg_temp.ct('r1')::jsonb -> 'session' -> 'rounds' -> 0) - 'items' - 'createdAt',
          '{"round": 1, "status": "new", "note": "less sugar", "subtotal": 72000}'::jsonb, 'guest round: trimmed note, subtotal');
select is(pg_temp.ct('r1')::jsonb -> 'session' -> 'bill',
          '{"subtotal": 72000, "serviceCharge": 0, "vat": 8283, "total": 72000, "pricesIncludeVat": true, "serviceChargePct": 0.00}'::jsonb,
          'live bill, VAT inside: round(72000 x 13 / 113) = 8283');
select is((pg_temp.ct('r1')::jsonb -> 'session' ->> 'rev')::int, 2, 'rev went up');
select ok(pg_temp.ver() > pg_temp.ct('v6')::bigint, 'a round bumps the board version');
select ok((select request_fingerprint ~ '^[0-9a-f]{64}$' from public.table_orders where client_request_id = pg_temp.rq(1)),
          'the round stores a SHA-256 fingerprint');

-- replay (SEC-027)
select pg_temp.put('v7', pg_temp.ver()::text);
select is(pg_temp.ord(pg_temp.c('s1'), 1,
            (select jsonb_agg(e order by o desc) from jsonb_array_elements(pg_temp.ct('r1items')::jsonb) with ordinality as x(e, o)),
            'less sugar') - 'session',
          '{"round": 1, "replayed": true}'::jsonb, 'replay with the same body (lines reordered, note re-trimmed): the same round');
select is((select count(*)::int from public.table_orders where session_id = pg_temp.c('s1')), 1, 'replay inserts nothing');
select is(pg_temp.ver(), pg_temp.ct('v7')::bigint, 'replay does not bump the version');
select is((select rev from public.table_sessions where id = pg_temp.c('s1')), 2, 'replay does not bump rev');
select is(pg_temp.ord_err(pg_temp.c('s1'), 1, pg_temp.momo(2), 'less sugar'),
          'CONFLICT||This order was already sent with different items. Refresh and send again.',
          'replay with different items: CONFLICT');
select is(pg_temp.ord_err(pg_temp.c('s1'), 1, pg_temp.ct('r1items')::jsonb, 'more sugar'),
          'CONFLICT||This order was already sent with different items. Refresh and send again.',
          'replay with a different note: CONFLICT');
select is(pg_temp.ord_err(pg_temp.c('s1'), 1, '[]'::jsonb), 'CONFLICT||This order was already sent with different items. Refresh and send again.',
          'replay with an empty body: CONFLICT (not a crash)');

-- merge (round 2)
select pg_temp.put('r2', pg_temp.ord(pg_temp.c('s1'), 2, jsonb_build_array(
         pg_temp.ln('e3000000-0000-4000-8000-000000000001', 3),
         pg_temp.ln('e3000000-0000-4000-8000-000000000001', 2, array[]::uuid[]),
         pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1, array['e4000000-0000-4000-8000-000000000002'::uuid,
                                                                      'e4000000-0000-4000-8000-000000000001'::uuid]),
         pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1, array['e4000000-0000-4000-8000-000000000001'::uuid,
                                                                      'e4000000-0000-4000-8000-000000000002'::uuid])))::text);
select is((select jsonb_agg(jsonb_build_object('qty', l -> 'qty', 'lineTotal', l -> 'lineTotal'))
             from jsonb_array_elements(pg_temp.ct('r2')::jsonb -> 'session' -> 'rounds' -> 1 -> 'items') l),
          '[{"qty": 5, "lineTotal": 50000}, {"qty": 2, "lineTotal": 38000}]'::jsonb, 'merge: 4 request lines -> 2 lines');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, jsonb_build_array(pg_temp.ln('e3000000-0000-4000-8000-000000000002', 15),
                                                                 pg_temp.ln('e3000000-0000-4000-8000-000000000002', 6)))
          like 'VALIDATION|{"items.0": ["At most 20 of one item."]}|%', 'merged qty over 20: VALIDATION items.0');

-- validation
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, jsonb_build_array(pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1,
            array['e4000000-0000-4000-8000-000000000001'::uuid, 'e4000000-0000-4000-8000-000000000003'::uuid])))
          like 'VALIDATION|{"items.0": ["Pick at most one option of each kind."]}|%', 'two options of one kind: VALIDATION');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, jsonb_build_array(pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1,
            array['e4000000-0000-4000-8000-000000000005'::uuid])))
          like 'VALIDATION|{"items.0": ["This item is no longer on the menu."]}|%', 'option of another item: VALIDATION');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, jsonb_build_array(pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1),
            pg_temp.ln('e3000000-0000-4000-8000-000000000003', 1), pg_temp.ln('e3000000-0000-4000-8000-000000000004', 1),
            pg_temp.ln('e3000000-0000-4000-8000-000000000005', 1), pg_temp.ln('00000000-0000-4000-8000-0000000000aa', 1)))
          like 'VALIDATION|{"items.1": ["This item is no longer on the menu."], "items.2": [%], "items.3": [%], "items.4": [%]}|%',
          'hidden item, hidden category, deleted item, unknown item: VALIDATION items.1..4 (request index)');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, jsonb_build_array(pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1),
            pg_temp.ln('e3000000-0000-4000-8000-000000000006', 1),
            pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1, array['e4000000-0000-4000-8000-000000000004'::uuid])))
          = 'OUT_OF_STOCK|{"items.1": ["sold out"], "items.2": ["sold out"]}|', 'sold-out item and sold-out option: OUT_OF_STOCK');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, jsonb_build_array(pg_temp.ln('e3000000-0000-4000-8000-000000000007', 2),
            pg_temp.ln('e3000000-0000-4000-8000-000000000001', 1)))
          like 'VALIDATION|{"items": ["This order is too large to send from the app. Please order with our staff."]}|%',
          'round over Rs. 20,000: VALIDATION items');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, jsonb_build_array(pg_temp.ln('e3000000-0000-4000-8000-000000000001', 0)))
          like 'VALIDATION|{"items.0": [%', 'qty 0: VALIDATION items.0');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, '[]'::jsonb) like 'VALIDATION|{"items": [%', 'no lines: VALIDATION items');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, pg_temp.momo(), repeat('x', 201)) like 'VALIDATION|{"note": [%', 'note over 200: VALIDATION note');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, pg_temp.momo(), E'less\nsugar') like 'VALIDATION|{"note": [%',
          'note with a newline: VALIDATION note (never a 23514)');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, pg_temp.momo(), E'abc‮def') like 'VALIDATION|{"note": [%',
          'note with a bidi override: VALIDATION note');
select ok(pg_temp.err(format($$select public.create_table_order(%L, 1::smallint, null, %L)$$, pg_temp.c('s1'), pg_temp.momo()))
          like 'VALIDATION|{"clientRequestId": [%', 'no clientRequestId: VALIDATION');
select is((select count(*)::int from public.table_orders where session_id = pg_temp.c('s1')), 2, 'refused rounds inserted nothing');

-- caps: 3 waiting as new; 6 per 10 min
select lives_ok($$select pg_temp.ord(pg_temp.c('s1'), 3, pg_temp.momo())$$, 'round 3 (3 waiting)');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, pg_temp.momo())
          = 'CONFLICT||Your earlier orders are still waiting for the kitchen. Please wait a moment or ask our staff.',
          'a 4th round while 3 are new: CONFLICT');
select lives_ok($$select pg_temp.mv(pg_temp.c('s1'), r, 'preparing') from generate_series(1, 3) r$$, 'staff accept rounds 1..3');
select lives_ok($$select pg_temp.ord(pg_temp.c('s1'), n, pg_temp.momo()) from generate_series(4, 6) n$$, 'rounds 4..6');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, pg_temp.momo()) = 'RATE_LIMITED|{"retryAfterSeconds": 600}|',
          '7th round in 10 min: RATE_LIMITED with retryAfterSeconds from the oldest');

-- 30 not cancelled, 60 in total (session s3 on table 3, 29 old served rounds inserted as fixtures)
select pg_temp.put('s3', pg_temp.open('e5000000-0000-4000-8000-000000000003') ->> 'id');
reset role;
select pg_temp.flag(true);
insert into public.table_orders (session_id, round, client_request_id, request_fingerprint, status, subtotal_paisa,
                                 created_at, accepted_at, served_at)
select pg_temp.c('s3'), g, gen_random_uuid(), repeat('0', 64), 'served', 0,
       now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour'
  from generate_series(1, 29) g;
select pg_temp.flag(false);
set local role service_role;
select lives_ok($$select pg_temp.ord(pg_temp.c('s3'), 30, pg_temp.momo())$$, 'round 30 is allowed');
select ok(pg_temp.ord_err(pg_temp.c('s3'), 91, pg_temp.momo()) = 'CONFLICT||Please order the rest with our staff.',
          '30 rounds not cancelled: CONFLICT');
reset role;
select pg_temp.flag(true);
update public.table_orders set status = 'cancelled', cancel_reason = 'other', cancelled_at = now() - interval '1 hour'
 where session_id = pg_temp.c('s3') and round <= 10;
select pg_temp.flag(false);
set local role service_role;
select lives_ok($$select pg_temp.ord(pg_temp.c('s3'), 31, pg_temp.momo())$$, 'cancelled rounds do not count towards 30');
reset role;
select pg_temp.flag(true);
insert into public.table_orders (session_id, round, client_request_id, request_fingerprint, status, cancel_reason, subtotal_paisa,
                                 created_at, cancelled_at)
select pg_temp.c('s3'), g, gen_random_uuid(), repeat('0', 64), 'cancelled', 'other', 0, now() - interval '1 hour', now() - interval '1 hour'
  from generate_series(32, 60) g;
select pg_temp.flag(false);
set local role service_role;
select ok(pg_temp.ord_err(pg_temp.c('s3'), 92, pg_temp.momo()) = 'CONFLICT||Please order the rest with our staff.',
          '60 rounds in total (hard limit): CONFLICT');
select ok(pg_temp.ord_err(pg_temp.c('s3'), 1, pg_temp.momo()) like 'VALIDATION|{"clientRequestId": [%',
          'a clientRequestId used in another session: VALIDATION');

-- paused / closed / 12 h / unknown
select public.set_table_ordering('paused', pg_temp.sf());
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, pg_temp.momo())
          = 'TABLE_ORDERS_PAUSED||The kitchen is not taking orders from the app right now. Please order with our staff.',
          'paused: TABLE_ORDERS_PAUSED');
select is(pg_temp.ord(pg_temp.c('s1'), 1, pg_temp.ct('r1items')::jsonb, 'less sugar') - 'session',
          '{"round": 1, "replayed": true}'::jsonb, 'replay while paused: the original round (SEC-027 order)');
select is(pg_temp.gv(pg_temp.c('s1')) -> 'session' ->> 'ordering', 'paused', 'guest view shows paused');
select lives_ok($$select pg_temp.mv(pg_temp.c('s1'), 6, 'served')$$, 'paused: rounds already sent can still be moved');
select public.set_table_ordering('on', pg_temp.sf());
select ok(pg_temp.ord_err(pg_temp.c('s_t3'), 90, pg_temp.momo())
          = 'TABLE_SESSION_INVALID||Your table is not open for ordering. Enter the code from our staff to order.',
          'closed session: TABLE_SESSION_INVALID');
select ok(pg_temp.ord_err(pg_temp.c('s2'), 90, pg_temp.momo()) like 'TABLE_SESSION_INVALID|%', 'session opened 12 h ago: TABLE_SESSION_INVALID');
select ok(pg_temp.ord_err('00000000-0000-4000-8000-0000000000aa', 90, pg_temp.momo()) like 'TABLE_SESSION_INVALID|%',
          'unknown session: TABLE_SESSION_INVALID');
select ok(pg_temp.ord_err(pg_temp.c('s1'), 90, pg_temp.momo(), null, 2) like 'TABLE_SESSION_INVALID|%',
          'a wrong epoch: TABLE_SESSION_INVALID');
reset role;

-- snapshot kept after a menu price change; lines are immutable
update public.menu_items set price_paisa = 15000, name = 'TO Chai renamed' where id = 'e3000000-0000-4000-8000-000000000001';
select is((select row(name_snapshot, unit_price_paisa)::text from public.table_order_items i
             join public.table_orders o on o.id = i.order_id
            where o.session_id = pg_temp.c('s1') and o.round = 1 and i.line_no = 1),
          row('TO Chai', 10000)::text, 'snapshot kept after a menu price and name change');
select pg_temp.flag(true);
select is(pg_temp.state($$update public.table_order_items set qty = 3$$), '42501', 'lines are immutable, even with the flag');
select pg_temp.flag(false);

-- =================================================================================================================
-- 8. Transitions (s1: r1..r3 preparing, r4 r5 new, r6 served; all accepted "now")
-- =================================================================================================================
set local role service_role;
select is(pg_temp.mv(pg_temp.c('s1'), 4, 'preparing') ->> 'status', 'preparing', 'staff: new -> preparing');
select ok((select accepted_at = now() and served_at is null from public.table_orders where session_id = pg_temp.c('s1') and round = 4),
          'sets acceptedAt');
select is((pg_temp.mv(pg_temp.c('s1'), 5, 'served') - 'items' - 'createdAt' - 'id'),
          jsonb_build_object('round', 5, 'status', 'served', 'note', null, 'subtotal', 20000, 'acceptedAt', now(),
                             'servedAt', now(), 'cancelledAt', null, 'cancelReason', null, 'cancelledByName', null,
                             'staffCanCancelUntil', now() + interval '10 minutes'),
          'staff: new -> served at once sets acceptedAt and servedAt; AdminTableRound with staffCanCancelUntil');
select is(pg_temp.mv(pg_temp.c('s1'), 1, 'served') ->> 'status', 'served', 'staff: preparing -> served');
select ok(pg_temp.mv_err(pg_temp.c('s1'), 3, 'cancelled', pg_temp.sf()) like 'VALIDATION|{"reason": [%', 'cancel without a reason: VALIDATION');
select ok(pg_temp.mv_err(pg_temp.c('s1'), 3, 'cancelled', pg_temp.ow(), 'session_closed') like 'VALIDATION|{"reason": [%',
          'session_closed from staff/owner: VALIDATION reason');

-- 2.2.0 cancel window: inside the window staff may cancel accepted rounds (preparing and served), with an alert each
select pg_temp.put('a0', pg_temp.alerts('table_round_cancelled_after_accept')::text);
select is(pg_temp.mv(pg_temp.c('s1'), 2, 'cancelled', pg_temp.sf(), 'unavailable') - 'items' - 'createdAt' - 'acceptedAt'
            - 'cancelledAt' - 'id' - 'note' - 'staffCanCancelUntil',
          '{"round": 2, "status": "cancelled", "subtotal": 88000, "servedAt": null, "cancelReason": "unavailable",
            "cancelledByName": "TO Staff"}'::jsonb, 'staff: cancel a preparing round inside the window');
select is(pg_temp.alerts('table_round_cancelled_after_accept'), pg_temp.ct('a0')::int + 1, '... writes one alert');
select is((select row(text, data, session_id)::text from public.admin_alerts
            where kind = 'table_round_cancelled_after_accept' and (data ->> 'round')::int = 2),
          row('Table 1: round 2 (Rs. 880) cancelled by TO Staff, 0 min after the kitchen accepted it (reason: unavailable).',
              '{"tableNumber": 1, "round": 2, "amount": 88000, "actorName": "TO Staff", "reason": "unavailable", "minutesAfterAccept": 0}'::jsonb,
              pg_temp.c('s1'))::text, 'the alert text and data');
select is(pg_temp.mv(pg_temp.c('s1'), 6, 'cancelled', pg_temp.sf(), 'mistake') ->> 'status', 'cancelled',
          'staff: cancel a served round inside the window');
select is(pg_temp.alerts('table_round_cancelled_after_accept'), pg_temp.ct('a0')::int + 2, '... writes one alert');
-- window + 1 s: FORBIDDEN for staff
reset role;
select pg_temp.flag(true);
update public.table_orders set accepted_at = now() - interval '10 minutes 1 second' where session_id = pg_temp.c('s1') and round = 1;
select pg_temp.flag(false);
set local role service_role;
select is(pg_temp.mv_err(pg_temp.c('s1'), 1, 'cancelled', pg_temp.sf(), 'mistake'),
          'FORBIDDEN||Only the owner can cancel this order now. The kitchen accepted it more than 10 minutes ago.',
          'staff at window + 1 s: FORBIDDEN with the minutes in the hint');
select is(pg_temp.alerts('table_round_cancelled_after_accept'), pg_temp.ct('a0')::int + 2, '... and no alert');
-- window 0: always FORBIDDEN for staff
reset role;
update public.order_rules set staff_cancel_window_minutes = 0;
set local role service_role;
select is(pg_temp.mv_err(pg_temp.c('s1'), 3, 'cancelled', pg_temp.sf(), 'mistake'),
          'FORBIDDEN||Only the owner can cancel this order now. The kitchen accepted it more than 0 minutes ago.',
          'window 0: staff can never cancel an accepted round');
select is((select r -> 'staffCanCancelUntil' from jsonb_array_elements(
             public.table_board(null, pg_temp.sf()) -> 'tables' -> 0 -> 'session' -> 'rounds') r
            where (r ->> 'round')::int = 3), 'null'::jsonb, 'window 0: staffCanCancelUntil is null');
reset role;
update public.order_rules set staff_cancel_window_minutes = 10;
set local role service_role;
-- owner: any time, with cancelled_by and an alert
select is(pg_temp.mv(pg_temp.c('s1'), 1, 'cancelled', pg_temp.ow(), 'mistake') ->> 'cancelledByName', 'TO Owner',
          'owner: cancel an accepted round after the window, cancelled_by = owner');
select is(pg_temp.alerts('table_round_cancelled_after_accept'), pg_temp.ct('a0')::int + 3, '... writes one alert');
select is((select data ->> 'minutesAfterAccept' from public.admin_alerts
            where kind = 'table_round_cancelled_after_accept' and (data ->> 'round')::int = 1), '10',
          'minutesAfterAccept counts whole minutes');
-- refused moves
select ok(pg_temp.mv_err(pg_temp.c('s1'), 2, 'preparing', pg_temp.ow()) = 'CONFLICT||That status change is not allowed.', 'cancelled -> preparing: CONFLICT');
select ok(pg_temp.mv_err(pg_temp.c('s1'), 2, 'cancelled', pg_temp.ow(), 'other') = 'CONFLICT||That status change is not allowed.', 'cancelled -> cancelled: CONFLICT');
select ok(pg_temp.mv_err(pg_temp.c('s1'), 5, 'preparing', pg_temp.sf()) = 'CONFLICT||That status change is not allowed.', 'served -> preparing: CONFLICT');
select ok(pg_temp.mv_err(pg_temp.c('s1'), 5, 'served', pg_temp.sf()) = 'CONFLICT||That status change is not allowed.', 'served -> served: CONFLICT');
select ok(pg_temp.mv_err(pg_temp.c('s1'), 3, 'preparing', pg_temp.sf()) = 'CONFLICT||That status change is not allowed.', 'preparing -> preparing: CONFLICT');
select ok(pg_temp.mv_err(pg_temp.c('s1'), 3, 'new', pg_temp.sf()) = 'CONFLICT||That status change is not allowed.', 'to new: CONFLICT');
select ok(pg_temp.err($$select public.transition_table_order('00000000-0000-4000-8000-0000000000aa', 'served', null, pg_temp.sf())$$)
          like 'NOT_FOUND|%', 'unknown round: NOT_FOUND');
select ok(pg_temp.mv_err(pg_temp.c('s1'), 3, 'served', '00000000-0000-4000-8000-0000000000aa') like 'FORBIDDEN|%', 'unknown actor: FORBIDDEN');
select ok(pg_temp.err($$select public.transition_table_order('e8000000-0000-4000-8000-000000000009', 'cancelled', 'other', pg_temp.ow())$$)
          = 'CONFLICT||This table is closed.', 'a change on a closed table: CONFLICT');
select is((select array_agg(status order by round) from public.table_orders where session_id = pg_temp.c('s1')),
          array['cancelled', 'cancelled', 'preparing', 'preparing', 'served', 'cancelled'], 'state after the transitions');
select ok((select bool_and(accepted_at is not null) from public.table_orders where session_id = pg_temp.c('s1')),
          'every round of s1 was accepted (accepted_at never cleared by a cancel)');
reset role;

-- =================================================================================================================
-- 9. Close
-- =================================================================================================================
select pg_temp.flag(true);
update public.table_orders set created_at = created_at - interval '11 minutes' where session_id = pg_temp.c('s1');  -- leave the 10-min cap
select pg_temp.flag(false);
update public.site_settings set service_charge_pct = 10;
set local role service_role;
select lives_ok($$select pg_temp.ord(pg_temp.c('s1'), 7, pg_temp.momo())$$, 'round 7 (new)');
-- live: r3 + r4 + r5 + r7 = 80000; service 8000; VAT inside round(88000 x 13 / 113) = 10124
select ok(pg_temp.err($$select public.close_table_session(pg_temp.c('s1'), 'paid', 'cash', 88000, pg_temp.sf())$$)
          = 'CONFLICT||Accept or cancel the new order first.', 'paid with a new round: CONFLICT');
select pg_temp.put('a1', (select count(*) from public.admin_alerts)::text);
select is(pg_temp.mv(pg_temp.c('s1'), 7, 'cancelled', pg_temp.sf(), 'mistake') ->> 'status', 'cancelled', 'staff cancels the new round 7');
select is((select count(*)::int from public.admin_alerts), pg_temp.ct('a1')::int, 'a cancel of a `new` round raises no alert');
-- live: r3 + r4 + r5 = 60000 + 6000 service = 66000, VAT inside round(66000 x 13 / 113) = 7593
select ok(pg_temp.err($$select public.close_table_session(pg_temp.c('s1'), 'paid', 'cash', 65999, pg_temp.sf())$$)
          = 'CONFLICT||The total changed. Check the new total and close again.', 'wrong expectedTotal: CONFLICT');
select ok(pg_temp.err($$select public.close_table_session(pg_temp.c('s1'), 'paid', null, 66000, pg_temp.sf())$$)
          like 'VALIDATION|{"paidVia": [%', 'paid without paidVia: VALIDATION');
select ok(pg_temp.err($$select public.close_table_session(pg_temp.c('s1'), 'void', 'cash', 66000, pg_temp.ow())$$)
          like 'VALIDATION|{"paidVia": [%', 'void with paidVia: VALIDATION');
select ok(pg_temp.err($$select public.close_table_session(pg_temp.c('s1'), 'expired', null, 66000, pg_temp.ow())$$)
          like 'VALIDATION|{"outcome": [%', 'expired is system only: VALIDATION');
select is(pg_temp.err($$select public.close_table_session(pg_temp.c('s1'), 'void', null, 66000, pg_temp.sf())$$),
          'FORBIDDEN||Only the owner can void a table after an order was accepted.', 'staff void after a round was accepted: FORBIDDEN');
select pg_temp.put('v8', pg_temp.ver()::text);
select pg_temp.put('close1', public.close_table_session(pg_temp.c('s1'), 'paid', 'cash', 66000, pg_temp.sf())::text);
select is(pg_temp.ct('close1')::jsonb - 'openedAt' - 'closedAt' - 'sessionId',
          '{"tableNumber": 1, "outcome": "paid", "paidVia": "cash", "total": 66000, "rounds": 3, "closedByName": "TO Staff"}'::jsonb,
          'paid close returns ClosedTableSummary');
select ok(pg_temp.ver() > pg_temp.ct('v8')::bigint, 'close bumps the board version');
reset role;
select is((select array_agg(status order by round) from public.table_orders where session_id = pg_temp.c('s1')),
          array['cancelled', 'cancelled', 'served', 'served', 'served', 'cancelled', 'cancelled'], 'paid close: preparing -> served');
select is((select row(status, code, orders_locked, prices_include_vat, subtotal_paisa, service_charge_paisa, vat_paisa, total_paisa)::text
             from public.table_sessions where id = pg_temp.c('s1')),
          row('closed', null::text, false, true, 60000, 6000, 7593, 66000)::text,
          'bill snapshot, VAT inside with a service charge; code and lock cleared');
select is((select occupied from public.table_occupancy where number = 1), false, 'the table is free at once');
set local role service_role;
select ok(pg_temp.err($$select public.close_table_session(pg_temp.c('s1'), 'paid', 'cash', 66000, pg_temp.sf())$$)
          = 'CONFLICT||This table is already closed.', 'close again: CONFLICT');
select ok(pg_temp.err(format($$select public.join_table_session(1, %L)$$, pg_temp.ct('code1'))) like 'VALIDATION|%',
          'the old code no longer joins');
select is(pg_temp.gv(pg_temp.c('s1')), '{"state": "closed", "tableNumber": 1}'::jsonb, 'guest view: closed');

-- VAT on top, with a service charge: 40000 + 4000 = 44000, VAT round(44000 x 13 / 100) = 5720, total 49720
reset role;
update public.site_settings set prices_include_vat = false;
set local role service_role;
select pg_temp.put('s5', pg_temp.open('e5000000-0000-4000-8000-000000000001') ->> 'id');
select lives_ok($$select pg_temp.ord(pg_temp.c('s5'), 50, pg_temp.momo(2))$$, 'round on a new session');
select is(pg_temp.gv(pg_temp.c('s5')) -> 'session' -> 'bill',
          '{"subtotal": 40000, "serviceCharge": 4000, "vat": 5720, "total": 49720, "pricesIncludeVat": false, "serviceChargePct": 10.00}'::jsonb,
          'live bill, VAT on top');
select lives_ok($$select pg_temp.mv(pg_temp.c('s5'), 1, 'preparing')$$, 'accept it');
select is((public.close_table_session(pg_temp.c('s5'), 'paid', 'fonepay', 49720, pg_temp.sf()) ->> 'total')::int, 49720,
          'paid close with VAT on top');
reset role;
select is((select row(prices_include_vat, subtotal_paisa, service_charge_paisa, vat_paisa, total_paisa)::text
             from public.table_sessions where id = pg_temp.c('s5')),
          row(false, 40000, 4000, 5720, 49720)::text, 'bill snapshot, VAT on top');
update public.site_settings set prices_include_vat = true, service_charge_pct = 0;
set local role service_role;

-- s6: two accepted rounds, both cancelled (owner after acceptance, staff inside the window) -> still owner-only void
select pg_temp.put('s6', pg_temp.open('e5000000-0000-4000-8000-000000000001') ->> 'id');
select lives_ok($$select pg_temp.ord(pg_temp.c('s6'), n, pg_temp.momo()) from generate_series(61, 62) n$$, 'two rounds');
select lives_ok($$select pg_temp.mv(pg_temp.c('s6'), r, 'preparing') from generate_series(1, 2) r$$, 'both accepted');
select lives_ok($$select pg_temp.mv(pg_temp.c('s6'), 1, 'cancelled', pg_temp.ow(), 'guest_request')$$, 'owner cancels round 1');
select lives_ok($$select pg_temp.mv(pg_temp.c('s6'), 2, 'cancelled', pg_temp.sf(), 'mistake')$$, 'staff cancels round 2 inside the window');
select is(pg_temp.err($$select public.close_table_session(pg_temp.c('s6'), 'void', null, 0, pg_temp.sf())$$),
          'FORBIDDEN||Only the owner can void a table after an order was accepted.',
          'staff void after accepted rounds, even when every round has since been cancelled: FORBIDDEN');
select is(pg_temp.err($$select public.close_table_session(pg_temp.c('s6'), 'paid', 'cash', 0, pg_temp.sf())$$),
          'FORBIDDEN||Only the owner can void a table after an order was accepted.',
          'staff paid close at total 0 with accepted history: FORBIDDEN');
select pg_temp.put('tv0', pg_temp.alerts('table_void')::text);
select is(public.close_table_session(pg_temp.c('s6'), 'void', null, 0, pg_temp.ow()) ->> 'outcome', 'void', 'the owner can void it');
select is(pg_temp.alerts('table_void'), pg_temp.ct('tv0')::int + 1, '... one table_void alert');
-- s7: only new rounds -> staff void OK, rounds session_closed
select pg_temp.put('s7', pg_temp.open('e5000000-0000-4000-8000-000000000001') ->> 'id');
select lives_ok($$select pg_temp.ord(pg_temp.c('s7'), 71, pg_temp.momo())$$, 'a new round');
select is(public.close_table_session(pg_temp.c('s7'), 'void', null, 20000, pg_temp.sf()) ->> 'total', '0',
          'staff void with only new rounds: OK, total 0');
select is(pg_temp.alerts('table_void'), pg_temp.ct('tv0')::int + 2, '... one table_void alert (every void, staff included)');
-- s8: owner void keeps accepted rounds in the snapshot
select pg_temp.put('s8', pg_temp.open('e5000000-0000-4000-8000-000000000001') ->> 'id');
select lives_ok($$select pg_temp.ord(pg_temp.c('s8'), n, pg_temp.momo()) from generate_series(81, 82) n$$, 'two rounds');
select lives_ok($$select pg_temp.mv(pg_temp.c('s8'), 1, 'preparing')$$, 'accept round 1');
select is(public.close_table_session(pg_temp.c('s8'), 'void', null, 40000, pg_temp.ow()) - 'openedAt' - 'closedAt' - 'sessionId',
          '{"tableNumber": 1, "outcome": "void", "paidVia": null, "total": 20000, "rounds": 1, "closedByName": "TO Owner"}'::jsonb,
          'owner void: the accepted round stays in the snapshot');
reset role;
select is((select array_agg(row(status, cancel_reason)::text order by round) from public.table_orders where session_id = pg_temp.c('s8')),
          array[row('preparing', null::text)::text, row('cancelled', 'session_closed')::text],
          'owner void: only `new` rounds become session_closed; the accepted one stays as it is');
select is((select row(text, data)::text from public.admin_alerts where kind = 'table_void' and session_id = pg_temp.c('s8')),
          row('Table 1 voided by TO Owner (Rs. 200, 1 accepted round).',
              '{"tableNumber": 1, "amount": 20000, "actorName": "TO Owner", "acceptedRounds": 1}'::jsonb)::text,
          'the table_void alert text and data');
select is((select count(*)::int from public.table_sessions s where s.outcome = 'void' and s.closed_at = now()
              and (select count(*) from public.admin_alerts a where a.kind = 'table_void' and a.session_id = s.id) <> 1),
          0, 'every void wrote exactly one table_void alert');

-- =================================================================================================================
-- 10. Board and guest view
-- =================================================================================================================
-- "closed today" boundary fixtures on table 9: 00:00:00 Kathmandu today (in), 23:59:59 yesterday (out).
select pg_temp.flag(true);
insert into public.table_sessions (id, table_id, table_number, status, code, opened_at, closed_at, outcome, paid_via,
                                   prices_include_vat, subtotal_paisa, service_charge_paisa, vat_paisa, total_paisa)
values ('e6000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000009', 9, 'closed', null,
        private.ktm_day_start(private.ktm_date(now())) - interval '1 hour', private.ktm_day_start(private.ktm_date(now())),
        'paid', 'other', true, 1234, 0, 142, 1234),
       ('e6000000-0000-4000-8000-0000000000a2', 'e5000000-0000-4000-8000-000000000009', 9, 'closed', null,
        private.ktm_day_start(private.ktm_date(now())) - interval '1 hour',
        private.ktm_day_start(private.ktm_date(now())) - interval '1 second', 'paid', 'cash', true, 999, 0, 115, 999);
select pg_temp.flag(false);
select is(private.ktm_day_start(date '2026-10-25'), '2026-10-24 18:15:00+00'::timestamptz, 'a Kathmandu day starts at 18:15 UTC');

set local role service_role;
select pg_temp.put('b1', public.table_board(null, pg_temp.sf())::text);
select is(pg_temp.ct('b1')::jsonb -> 'changed', 'true'::jsonb, 'no cursor: full board');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.ct('b1')::jsonb) k),
          array['changed', 'closedToday', 'closedTodayTotals', 'cursor', 'mode', 'serverTime', 'tables'], 'TableBoard keys');
select is(pg_temp.ct('b1')::jsonb ->> 'cursor', pg_temp.ver() || '-' || to_char((now() at time zone 'Asia/Kathmandu')::date, 'YYYYMMDD'),
          'cursor = version-YYYYMMDD (Kathmandu)');
select is((select jsonb_agg(jsonb_build_object('number', t -> 'number', 'open', t -> 'session' <> 'null'::jsonb))
             from jsonb_array_elements(pg_temp.ct('b1')::jsonb -> 'tables') t),
          '[{"number": 1, "open": false}, {"number": 2, "open": true}, {"number": 3, "open": true}]'::jsonb,
          'board: active tables by number with their open session');
select is(public.table_board(pg_temp.ct('b1')::jsonb ->> 'cursor', pg_temp.sf()) - 'serverTime',
          jsonb_build_object('changed', false, 'cursor', pg_temp.ct('b1')::jsonb ->> 'cursor'), 'same cursor: {changed:false}');
select is((select array_agg(c ->> 'sessionId') from jsonb_array_elements(pg_temp.ct('b1')::jsonb -> 'closedToday') c
            where c ->> 'sessionId' like 'e6000000-%'),
          array['e6000000-0000-4000-8000-0000000000a1'], 'closedToday: 00:00 Kathmandu is in, 23:59:59 yesterday is out');
select is(pg_temp.ct('b1')::jsonb -> 'closedTodayTotals',
          '{"tables": 8, "paid": 116954, "byPaidVia": {"cash": 66000, "fonepay": 49720, "other": 1234}, "voided": 5, "expired": 0}'::jsonb,
          'closedTodayTotals (t3, s4, s6, s7, s8 void; s1 cash; s5 fonepay; boundary other)');
select is(jsonb_array_length(pg_temp.ct('b1')::jsonb -> 'closedToday'), 8, 'closedToday lists 8');
select ok(pg_temp.err($$select public.table_board(null, '00000000-0000-4000-8000-0000000000aa')$$) like 'FORBIDDEN|%',
          'board needs a staff actor');

-- the cursor changes after each writer (rotate and lock included); a replay does not change it
select pg_temp.put('cur', public.table_board(null, pg_temp.sf()) ->> 'cursor');
select pg_temp.put('open9', pg_temp.open('e5000000-0000-4000-8000-000000000001')::text);
select pg_temp.put('s9', pg_temp.ct('open9')::jsonb ->> 'id');
select is(public.table_board(pg_temp.ct('cur'), pg_temp.sf()) -> 'changed', 'true'::jsonb, 'cursor changes after open');
select pg_temp.put('cur', public.table_board(null, pg_temp.sf()) ->> 'cursor');
select pg_temp.put('join9', public.join_table_session(1, pg_temp.ct('open9')::jsonb ->> 'code')::text);
select pg_temp.put('g1', pg_temp.ord(pg_temp.c('s9'), 900, pg_temp.momo(), 'no onion')::text);
select is(public.table_board(pg_temp.ct('cur'), pg_temp.sf()) -> 'changed', 'true'::jsonb, '... after a round');
select pg_temp.put('cur', public.table_board(null, pg_temp.sf()) ->> 'cursor');
select pg_temp.ord(pg_temp.c('s9'), 900, pg_temp.momo(), 'no onion');
select is(public.table_board(pg_temp.ct('cur'), pg_temp.sf()) -> 'changed', 'false'::jsonb, '... but not after a replay');
select pg_temp.mv(pg_temp.c('s9'), 1, 'preparing');
select is(public.table_board(pg_temp.ct('cur'), pg_temp.sf()) -> 'changed', 'true'::jsonb, '... after a transition');
-- guest view: rev and unchanged (rev 1 open, 2 round, 3 accept)
select is((pg_temp.ct('g1')::jsonb -> 'session' ->> 'rev')::int, 2, 'rev 2 after the first round');
select is(pg_temp.gv(pg_temp.c('s9'), 3), '{"state": "unchanged", "rev": 3}'::jsonb, 'since = current rev (3 after the accept): unchanged');
select is(pg_temp.gv(pg_temp.c('s9'), 2) ->> 'state', 'open', 'an older rev: the full view');
select is(pg_temp.gv(pg_temp.c('s9')) -> 'session' -> 'rounds' -> 0 ->> 'status', 'preparing', 'the guest sees the round status');
select is(pg_temp.gv('00000000-0000-4000-8000-0000000000aa'), '{"state": "none"}'::jsonb, 'unknown session: none');
select is(pg_temp.gv(pg_temp.c('s2')), '{"state": "closed", "tableNumber": 2}'::jsonb, 'an open session older than 12 h reads as closed');
-- SEC-029 leak test: no admin key at any depth, and no code or staff name anywhere in the guest results
select is((select array_agg(k order by k) from unnest(array['code', 'joinPath', 'id', 'openedByName', 'cancelledByName',
                                                             'cancelReason', 'waiting', 'ordersLocked', 'everAccepted',
                                                             'staffCanCancelUntil', 'acceptedAt']) k
            where pg_temp.has_key(pg_temp.ct('join9')::jsonb -> 'view', k) or pg_temp.has_key(pg_temp.ct('g1')::jsonb, k)
               or pg_temp.has_key(pg_temp.gv(pg_temp.c('s9')), k)),
          null::text[], 'leak test: join view, round result and guest view carry no admin key at any depth');
select ok(position(pg_temp.ct('open9')::jsonb ->> 'code' in pg_temp.ct('join9') || pg_temp.ct('g1') || pg_temp.gv(pg_temp.c('s9'))::text) = 0
          and position('TO Staff' in pg_temp.ct('join9') || pg_temp.ct('g1') || pg_temp.gv(pg_temp.c('s9'))::text) = 0,
          'leak test: the code and staff names appear nowhere in guest results');
select ok(pg_temp.has_key(pg_temp.ct('open9')::jsonb, 'code') and pg_temp.has_key(pg_temp.ct('open9')::jsonb, 'waiting'),
          'the admin builder does carry them (the leak test can see keys)');
select pg_temp.put('cur', public.table_board(null, pg_temp.sf()) ->> 'cursor');
select public.rotate_table_code(pg_temp.c('s9'), pg_temp.sf());
select is(public.table_board(pg_temp.ct('cur'), pg_temp.sf()) -> 'changed', 'true'::jsonb, '... after a code rotation');
select pg_temp.put('cur', public.table_board(null, pg_temp.sf()) ->> 'cursor');
select public.set_table_orders_locked(pg_temp.c('s9'), true, pg_temp.sf());
select is(public.table_board(pg_temp.ct('cur'), pg_temp.sf()) -> 'changed', 'true'::jsonb, '... after a lock');
select pg_temp.put('cur', public.table_board(null, pg_temp.sf()) ->> 'cursor');
select public.set_table_ordering('paused', pg_temp.sf());
select public.set_table_ordering('on', pg_temp.sf());
select is(public.table_board(pg_temp.ct('cur'), pg_temp.sf()) -> 'changed', 'true'::jsonb, '... after a mode change');
select is(public.table_board('3-19990101', pg_temp.sf()) -> 'changed', 'true'::jsonb, 'a cursor from another day gives the full board');
select is((select t -> 'session' -> 'waiting' from jsonb_array_elements(public.table_board(null, pg_temp.sf()) -> 'tables') t
            where (t ->> 'number')::int = 1), '{"new": 0, "preparing": 1}'::jsonb, 'board card shows waiting counts');
select is(public.close_table_session(pg_temp.c('s9'), 'paid', 'cash', 20000, pg_temp.sf()) ->> 'outcome', 'paid', 'close s9 (paid)');
reset role;

-- =================================================================================================================
-- 11. Expiry (s2 on table 2 opened 12 h 1 m ago with live rounds; s3 moved to 11 h 59 m; s10 12 h old and empty)
-- =================================================================================================================
set local role service_role;
select pg_temp.put('s10', pg_temp.open('e5000000-0000-4000-8000-000000000001') ->> 'id');
reset role;
select pg_temp.flag(true);
update public.table_sessions set opened_at = now() - interval '11 hours 59 minutes' where id = pg_temp.c('s3');
update public.table_sessions set opened_at = now() - interval '12 hours 5 minutes' where id = pg_temp.c('s10');
insert into public.table_orders (session_id, round, client_request_id, request_fingerprint, status, subtotal_paisa,
                                 created_at, accepted_at, served_at) values
  (pg_temp.c('s2'), 1, pg_temp.rq(201), repeat('0', 64), 'new',       20000, now() - interval '12 hours', null, null),
  (pg_temp.c('s2'), 2, pg_temp.rq(202), repeat('0', 64), 'preparing', 20000, now() - interval '12 hours', now() - interval '11 hours', null),
  (pg_temp.c('s2'), 3, pg_temp.rq(203), repeat('0', 64), 'served',    30000, now() - interval '12 hours', now() - interval '11 hours', now() - interval '11 hours');
select pg_temp.flag(false);

set local role service_role;
select pg_temp.put('v9', pg_temp.ver()::text);
select pg_temp.put('ex0', pg_temp.alerts('table_expired_with_bill')::text);
select is(public.auto_close_stale_table_sessions() - 'ranAt', '{"closed": 2, "failed": 0}'::jsonb, 'expiry closes the two stale sessions');
select ok(pg_temp.ver() > pg_temp.ct('v9')::bigint, 'expiry bumps the board version');
reset role;
select is((select row(status, outcome, closed_by, code, orders_locked, subtotal_paisa, total_paisa)::text
             from public.table_sessions where id = pg_temp.c('s2')),
          row('closed', 'expired', null::uuid, null::text, false, 50000, 50000)::text,
          'the 12 h 1 m session is expired: no closer, code erased, bill snapshot with the accepted food');
select is((select array_agg(row(status, cancel_reason)::text order by round) from public.table_orders where session_id = pg_temp.c('s2')),
          array[row('cancelled', 'session_closed')::text, row('served', null::text)::text, row('served', null::text)::text],
          '`new` -> cancelled (session_closed); `preparing` -> served and kept on the bill');
select is((select status from public.table_sessions where id = pg_temp.c('s3')), 'open', 'the 11 h 59 m session is kept');
select is((select total_paisa from public.table_sessions where id = pg_temp.c('s10')), 0, 'the empty session expired at Rs. 0');
set local role service_role;
select pg_temp.put('v10', pg_temp.ver()::text);
select is(public.auto_close_stale_table_sessions() - 'ranAt', '{"closed": 0, "failed": 0}'::jsonb, 'a second run closes nothing');
select is(pg_temp.ver(), pg_temp.ct('v10')::bigint, '... and does not bump the version');
reset role;

-- =================================================================================================================
-- 12. Stats (2021-03-01 .. 2021-03-07, fixtures on table 9)
-- =================================================================================================================
--   SA paid cash, closed 03-02: R1 served 10:30 KTM (chai 3 x 10000, momo 1 x 20000); R2 accepted then cancelled 03-02
--   SB void, closed 03-03:      R3 served 09:00 KTM (momo 10 x 20000)            -> a round, not in topItems
--   SC expired at Rs. 0, 03-04: R4 new -> cancelled session_closed (never accepted)
--   SE expired with Rs. 70, 03-05 (no rounds needed for the snapshot sum)
--   SD paid fonepay, closed 03-08 00:00 KTM (out of range): R5 served 03-07 23:59:59 KTM (chai "TO Chai NEW" 1 x 12000)
select pg_temp.flag(true);
insert into public.table_sessions (id, table_id, table_number, status, code, opened_at, closed_at, outcome, paid_via,
                                   prices_include_vat, subtotal_paisa, service_charge_paisa, vat_paisa, total_paisa) values
  ('e6000000-0000-4000-8000-0000000000b1', 'e5000000-0000-4000-8000-000000000009', 9, 'closed', null,
   '2021-03-02 10:00+05:45', '2021-03-02 12:00+05:45', 'paid', 'cash', true, 50000, 0, 5752, 50000),
  ('e6000000-0000-4000-8000-0000000000b2', 'e5000000-0000-4000-8000-000000000009', 9, 'closed', null,
   '2021-03-03 08:30+05:45', '2021-03-03 10:00+05:45', 'void', null, true, 200000, 0, 23009, 200000),
  ('e6000000-0000-4000-8000-0000000000b3', 'e5000000-0000-4000-8000-000000000009', 9, 'closed', null,
   '2021-03-03 23:00+05:45', '2021-03-04 11:00+05:45', 'expired', null, true, 0, 0, 0, 0),
  ('e6000000-0000-4000-8000-0000000000b5', 'e5000000-0000-4000-8000-000000000009', 9, 'closed', null,
   '2021-03-04 23:00+05:45', '2021-03-05 11:00+05:45', 'expired', null, true, 7000, 0, 805, 7000),
  ('e6000000-0000-4000-8000-0000000000b4', 'e5000000-0000-4000-8000-000000000009', 9, 'closed', null,
   '2021-03-07 23:00+05:45', '2021-03-07 18:15:00+00', 'paid', 'fonepay', true, 12000, 0, 1381, 12000);
insert into public.table_orders (id, session_id, round, client_request_id, request_fingerprint, status, cancel_reason, subtotal_paisa,
                                 created_at, accepted_at, served_at, cancelled_at) values
  ('e8000000-0000-4000-8000-0000000000b1', 'e6000000-0000-4000-8000-0000000000b1', 1, pg_temp.rq(301), repeat('0', 64), 'served', null, 50000,
   '2021-03-02 10:30+05:45', '2021-03-02 10:35+05:45', '2021-03-02 10:40+05:45', null),
  ('e8000000-0000-4000-8000-0000000000b2', 'e6000000-0000-4000-8000-0000000000b1', 2, pg_temp.rq(302), repeat('0', 64), 'cancelled', 'mistake', 50000,
   '2021-03-02 11:15+05:45', '2021-03-02 11:16+05:45', null, '2021-03-02 11:20+05:45'),
  ('e8000000-0000-4000-8000-0000000000b3', 'e6000000-0000-4000-8000-0000000000b2', 1, pg_temp.rq(303), repeat('0', 64), 'served', null, 200000,
   '2021-03-03 09:00+05:45', '2021-03-03 09:05+05:45', '2021-03-03 09:10+05:45', null),
  ('e8000000-0000-4000-8000-0000000000b4', 'e6000000-0000-4000-8000-0000000000b3', 1, pg_temp.rq(304), repeat('0', 64), 'cancelled', 'session_closed', 20000,
   '2021-03-03 23:30+05:45', null, null, '2021-03-04 11:00+05:45'),
  ('e8000000-0000-4000-8000-0000000000b5', 'e6000000-0000-4000-8000-0000000000b4', 1, pg_temp.rq(305), repeat('0', 64), 'served', null, 12000,
   '2021-03-07 18:14:59+00', '2021-03-07 18:14:59+00', '2021-03-07 18:14:59+00', null);
insert into public.table_order_items (order_id, line_no, menu_item_ref, name_snapshot, unit_price_paisa, qty) values
  ('e8000000-0000-4000-8000-0000000000b1', 1, 'e3000000-0000-4000-8000-000000000001', 'TO Chai',     10000, 3),
  ('e8000000-0000-4000-8000-0000000000b1', 2, 'e3000000-0000-4000-8000-000000000002', 'TO Momo',     20000, 1),
  ('e8000000-0000-4000-8000-0000000000b2', 1, 'e3000000-0000-4000-8000-000000000001', 'TO Chai',     10000, 5),
  ('e8000000-0000-4000-8000-0000000000b3', 1, 'e3000000-0000-4000-8000-000000000002', 'TO Momo',     20000, 10),
  ('e8000000-0000-4000-8000-0000000000b4', 1, 'e3000000-0000-4000-8000-000000000002', 'TO Momo',     20000, 1),
  ('e8000000-0000-4000-8000-0000000000b5', 1, 'e3000000-0000-4000-8000-000000000001', 'TO Chai NEW', 12000, 1);
select pg_temp.flag(false);

set local role service_role;
select is(public.stats_table_orders('2021-03-01', '2021-03-07', pg_temp.ow()) - 'byHour',
          '{"rounds": 3, "cancelledRounds": 2, "cancelledAfterAccept": 1, "paidTables": 1, "paidTotalPaisa": 50000,
            "voidedTables": 1, "expiredTables": 2, "expiredWithOrdersPaisa": 7000,
            "topItems": [{"menuItemId": "e3000000-0000-4000-8000-000000000001", "name": "TO Chai NEW", "qty": 4, "revenuePaisa": 42000},
                         {"menuItemId": "e3000000-0000-4000-8000-000000000002", "name": "TO Momo", "qty": 1, "revenuePaisa": 20000}]}'::jsonb,
          'stats: exact numbers; void and expired excluded from topItems; cancelledAfterAccept; expiredWithOrdersPaisa; latest name; 23:59:59 in');
select is(jsonb_array_length(public.stats_table_orders('2021-03-01', '2021-03-07', pg_temp.ow()) -> 'byHour'), 24,
          'byHour always has 24 entries');
select is((select jsonb_object_agg(h ->> 'hour', h -> 'rounds') from jsonb_array_elements(
             public.stats_table_orders('2021-03-01', '2021-03-07', pg_temp.ow()) -> 'byHour') h
            where (h ->> 'rounds')::int > 0),
          '{"9": 1, "10": 1, "23": 1}'::jsonb, 'byHour in Kathmandu hours (rounds not cancelled)');
select is(public.stats_table_orders('2020-01-01', '2020-01-07', pg_temp.ow()) - 'byHour',
          '{"rounds": 0, "cancelledRounds": 0, "cancelledAfterAccept": 0, "paidTables": 0, "paidTotalPaisa": 0, "voidedTables": 0,
            "expiredTables": 0, "expiredWithOrdersPaisa": 0, "topItems": []}'::jsonb, 'an empty range: zeros and an empty list');
select ok(pg_temp.err($$select public.stats_table_orders('2021-03-01', '2021-03-07', pg_temp.sf())$$) like 'FORBIDDEN|%', 'staff refused');
select ok(pg_temp.err($$select public.stats_table_orders('2021-03-07', '2021-03-01', pg_temp.ow())$$) like 'VALIDATION|%range%',
          'from after to: VALIDATION range');
select ok(pg_temp.err($$select public.stats_table_orders('2018-01-01', '2021-03-07', pg_temp.ow())$$) like 'VALIDATION|%range%',
          'over 1,096 days: VALIDATION range');
reset role;

-- =================================================================================================================
-- 13. Owner alerts (2.2.0)
-- =================================================================================================================
select is(pg_temp.alerts('table_expired_with_bill'), pg_temp.ct('ex0')::int + 1, 'expiry with a bill wrote one table_expired_with_bill alert');
select is((select count(*)::int from public.admin_alerts where kind = 'table_expired_with_bill' and session_id = pg_temp.c('s10')), 0,
          'expiry at Rs. 0 wrote nothing');
select is((select row(text, data)::text from public.admin_alerts where kind = 'table_expired_with_bill' and session_id = pg_temp.c('s2')),
          row('Table 2 was never closed: it expired with Rs. 500 on the bill.', '{"tableNumber": 2, "amount": 50000}'::jsonb)::text,
          'the table_expired_with_bill text and data');

set local role service_role;
select ok(pg_temp.err($$select public.record_admin_alert('table_void', '{"tableNumber": 1, "failures": 3}')$$) like 'VALIDATION|{"kind": [%',
          'record_admin_alert accepts only table_join_fail');
select ok(pg_temp.err($$select public.record_admin_alert('table_join_fail', '{"tableNumber": 100, "failures": 3}')$$) like 'VALIDATION|{"data": [%',
          'record_admin_alert: table number 1..99 or null');
select ok(pg_temp.err($$select public.record_admin_alert('table_join_fail', '{"tableNumber": 7}')$$) like 'VALIDATION|{"data": [%',
          'record_admin_alert: failures required');
select pg_temp.put('jf', public.record_admin_alert('table_join_fail', '{"tableNumber": 7, "failures": 21, "code": "ZZZZZZ"}')::text);
select pg_temp.put('jf_all', public.record_admin_alert('table_join_fail', '{"tableNumber": null, "failures": 51}')::text);
reset role;
select is((select row(text, data, session_id)::text from public.admin_alerts where id = pg_temp.c('jf')),
          row('Many wrong table codes in the last hour (table 7: 21). If guests are seated there, press New code.',
              '{"tableNumber": 7, "failures": 21}'::jsonb, null::uuid)::text,
          'table_join_fail: fixed text; extra keys (a code) are dropped');
select is((select text from public.admin_alerts where id = pg_temp.c('jf_all')),
          'Many wrong table codes in the last hour (all tables: 51). If guests are seated, press New code on their table.',
          'table_join_fail for all tables');

-- delivery claims
select pg_temp.flag(true);
insert into public.admin_alerts (id, kind, text, created_at) values
  ('e9000000-0000-4000-8000-000000000025', 'table_join_fail', 'TO 25 h old', now() - interval '25 hours'),
  ('e9000000-0000-4000-8000-000000000181', 'table_join_fail', 'TO 181 days old', now() - interval '181 days'),
  ('e9000000-0000-4000-8000-000000000179', 'table_join_fail', 'TO 179 days old', now() - interval '179 days');
insert into public.alert_deliveries (alert_id, channel, status, attempts, claimed_at) values
  ('e9000000-0000-4000-8000-000000000181', 'whatsapp', 'sending', 1, now() - interval '181 days');
select pg_temp.flag(false);
select pg_temp.put('recent', (select count(*) from public.admin_alerts where created_at >= now() - interval '24 hours')::text);

set local role service_role;
select ok(pg_temp.err($$select public.claim_alert_deliveries('telegram', 5)$$) like 'VALIDATION|{"channel": [%', 'claim: only the whatsapp channel exists');
select ok(pg_temp.err($$select public.claim_alert_deliveries('whatsapp', 21)$$) like 'VALIDATION|{"limit": [%', 'claim: limit 1..20');
create temp table claim1 as select * from public.claim_alert_deliveries('whatsapp', 20) as c(j);
select is((select count(*)::int from claim1), pg_temp.ct('recent')::int, 'claim: every alert of the last 24 h, once');
select is((select count(*)::int from claim1 where j ->> 'alertId' in ('e9000000-0000-4000-8000-000000000025',
                                                                      'e9000000-0000-4000-8000-000000000181')), 0,
          'alerts older than 24 h are never claimed');
select is((select array_agg(k order by k) from jsonb_object_keys((select j from claim1 limit 1)) k),
          array['alertId', 'createdAt', 'kind', 'text'], 'claim returns {alertId, kind, text, createdAt}');
select is((select count(*)::int from public.claim_alert_deliveries('whatsapp', 20)), 0,
          'a second claim gets nothing: the same alert is not handed out twice');
-- retries stop after 3 attempts
select lives_ok(format($$select public.finish_alert_delivery(%L, 'whatsapp', false, E'HTTP 500\n131026')$$, pg_temp.c('jf')),
                'finish: failed (attempt 1)');
select is((select array_agg(j ->> 'alertId') from public.claim_alert_deliveries('whatsapp', 20) as c(j)), array[pg_temp.ct('jf')],
          'a failed delivery is claimed again (attempt 2)');
select lives_ok(format($$select public.finish_alert_delivery(%L, 'whatsapp', false, 'HTTP 500')$$, pg_temp.c('jf')), 'finish: failed (attempt 2)');
select is((select array_agg(j ->> 'alertId') from public.claim_alert_deliveries('whatsapp', 20) as c(j)), array[pg_temp.ct('jf')],
          '... and again (attempt 3)');
select lives_ok(format($$select public.finish_alert_delivery(%L, 'whatsapp', false, 'HTTP 500')$$, pg_temp.c('jf')), 'finish: failed (attempt 3)');
select is((select count(*)::int from public.claim_alert_deliveries('whatsapp', 20)), 0, 'after 3 attempts it is never claimed again');
select lives_ok(format($$select public.finish_alert_delivery(%L, 'whatsapp', true, null)$$, pg_temp.c('jf_all')), 'finish: sent');
select ok(pg_temp.err($$select public.finish_alert_delivery('00000000-0000-4000-8000-0000000000aa', 'whatsapp', true, null)$$)
          like 'NOT_FOUND|%', 'finish an unknown delivery: NOT_FOUND');
reset role;
select is((select row(status, attempts, last_error)::text from public.alert_deliveries where alert_id = pg_temp.c('jf')),
          row('failed', 3, 'HTTP 500')::text, 'the delivery row: failed, 3 attempts, short error');
select is((select status from public.alert_deliveries where alert_id = pg_temp.c('jf_all')), 'sent', 'the other: sent');

-- read by the owner
set local role service_role;
select ok(pg_temp.err($$select public.mark_admin_alerts_read(null, true, pg_temp.sf())$$) like 'FORBIDDEN|%', 'mark read: staff FORBIDDEN');
select ok(pg_temp.err($$select public.mark_admin_alerts_read('{}', false, pg_temp.ow())$$) like 'VALIDATION|{"ids": [%', 'mark read: ids or all');
select pg_temp.put('unread0', (select count(*) from public.admin_alerts where read_at is null)::text);
select is(public.mark_admin_alerts_read(array[pg_temp.c('jf')], false, pg_temp.ow()), pg_temp.ct('unread0')::int - 1,
          'mark one read: returns the unread count left');
reset role;
select is((select read_by from public.admin_alerts where id = pg_temp.c('jf')), pg_temp.ow(), 'read_by = the owner');
set local role service_role;
select is(public.mark_admin_alerts_read(null, true, pg_temp.ow()), 0, 'mark all read: 0 unread');
-- purge: alerts older than 180 days go, with their deliveries
select is((public.purge_personal_data() ->> 'alertsDeleted')::int, 1, 'the purge deletes the alert older than 180 days');
reset role;
select is((select count(*)::int from public.admin_alerts where id = 'e9000000-0000-4000-8000-000000000181')
          + (select count(*)::int from public.alert_deliveries where alert_id = 'e9000000-0000-4000-8000-000000000181'), 0,
          '... together with its delivery row');
select is((select count(*)::int from public.admin_alerts where id = 'e9000000-0000-4000-8000-000000000179'), 1, 'a 179-day alert is kept');
select is((select count(*)::int
             from unnest(array['anon', 'authenticated']) r, unnest(array['public.admin_alerts', 'public.alert_deliveries']) t,
                  unnest(array['select', 'insert', 'update', 'delete']) p
            where has_table_privilege(r, t, p)), 0, 'anon and authenticated have no privilege on either alert table');
-- never a code, a note or a phone number in an alert
select is((select count(*)::int from public.admin_alerts a
            where a.text ~ '\+977|98[0-9]{8}' or a.data::text ~ '\+977'
               or a.text like '%less sugar%' or a.data::text like '%less sugar%' or a.text like '%no onion%'
               or a.data ? 'code' or a.data ? 'note'
               or exists (select 1 from pg_temp.ctx c where c.k like 'code%' and c.v ~ '^[2-9A-HJKMNP-Z]{6}$'
                            and (position(c.v in a.text) > 0 or position(c.v in a.data::text) > 0))),
          0, 'no alert text or data contains a code, a note or a phone number');

select * from finish();
rollback;

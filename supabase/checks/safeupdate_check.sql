-- safeupdate_check.sql — LOCAL ONLY. Regression check for SQLSTATE 21000 "UPDATE requires a WHERE clause".
--
-- Why it exists: Supabase preloads pg_safeupdate for API sessions (role `authenticator`), so every RPC the backend
-- calls through PostgREST runs with it. pgTAP (`supabase test db`) connects as `postgres`, which does NOT load it, so a
-- writer with a WHERE-less UPDATE / DELETE passes pgTAP and fails in the app (20261026000003 fixed two of those).
--
-- How it runs: run-safeupdate-check.sh connects as `authenticator` over TCP (so safeupdate is preloaded exactly as
-- for PostgREST), switches to `service_role` like PostgREST does for the service key, and calls every table-ordering
-- writer plus the older writers the API reaches, inside ONE transaction that is ROLLED BACK. Nothing is kept.
-- It needs one owner and one staff profile in public.profiles (service_role cannot create auth users); the local QA
-- users are enough. It is NOT a pgTAP file and lives outside tests/ so `supabase test db` does not pick it up.
-- Exit status: non-zero (ON_ERROR_STOP) if any step fails for any reason; the last line says PASSED otherwise.

\set ON_ERROR_STOP 1
set role service_role;
begin;

create temp table steps (n serial, name text, state text, msg text);
create temp table ctx (k text primary key, v text);

create function pg_temp.step(p_name text, p_sql text) returns void language plpgsql as $$
declare
  v_state text := 'ok';
  v_msg   text := null;
  v_res   text;
begin
  begin
    execute p_sql into v_res;
  exception when others then
    v_state := sqlstate;
    v_msg := sqlerrm;
  end;
  insert into pg_temp.steps (name, state, msg) values (p_name, v_state, v_msg);
end;
$$;
create function pg_temp.c(p_k text) returns text language sql stable as $$ select v from pg_temp.ctx where k = p_k $$;
create function pg_temp.put(p_k text, p_v text) returns void language sql as
  $$ insert into pg_temp.ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;

-- Probe: prove safeupdate is really loaded in this session (a WHERE-less UPDATE must fail with 21000) --------------
create temp table su_probe (x integer);
insert into su_probe values (1);
select pg_temp.step('probe: safeupdate is active (expects 21000)', $q$update su_probe set x = 2$q$);

-- Actors (existing local profiles) ---------------------------------------------------------------------------------
select pg_temp.put('owner', (select id::text from public.profiles where role = 'owner' order by created_at limit 1));
select pg_temp.put('staff', (select id::text from public.profiles where role = 'staff' order by created_at limit 1));
do $$
begin
  if pg_temp.c('owner') is null or pg_temp.c('staff') is null then
    raise exception 'safeupdate_check: needs one owner and one staff profile in public.profiles (see supabase/README.md)';
  end if;
end
$$;

-- Fixtures the service role may write directly (menu has no table_write guard) -----------------------------------
insert into public.menu_categories (id, slug, name) values ('5afe0000-0000-4000-8000-000000000001', 'safeupdate-check', 'SU Cat');
insert into public.menu_items (id, category_id, name, price_paisa)
values ('5afe0000-0000-4000-8000-000000000002', '5afe0000-0000-4000-8000-000000000001', 'SU Momo', 20000);

-- Table ordering writers ---------------------------------------------------------------------------------------------
select pg_temp.step('set_table_ordering paused', format($q$select public.set_table_ordering('paused', %L)$q$, pg_temp.c('owner')));
select pg_temp.step('set_table_ordering on', format($q$select public.set_table_ordering('on', %L)$q$, pg_temp.c('owner')));

-- save_cafe_tables: the current full set plus one table on a free number
select pg_temp.put('free', (select min(n)::text from generate_series(1, 99) n
                             where not exists (select 1 from public.cafe_tables t where t.number = n)));
select pg_temp.step('save_cafe_tables', format($q$select public.save_cafe_tables(%L, %L)$q$,
  (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'number', t.number, 'label', t.label, 'isActive', t.is_active)), '[]'::jsonb)
          || jsonb_build_array(jsonb_build_object('number', pg_temp.c('free')::int, 'label', 'SU check', 'isActive', true))
     from public.cafe_tables t), pg_temp.c('owner')));
select pg_temp.put('table', (select id::text from public.cafe_tables where number = pg_temp.c('free')::int));

select pg_temp.step('open_table_session', format($q$select pg_temp.put('session', (public.open_table_session(%L, %L) ->> 'id'))::text$q$,
  pg_temp.c('table'), pg_temp.c('staff')));
select pg_temp.step('join_table_session', format($q$select public.join_table_session(%s, (select code from public.table_sessions where id = %L))::text$q$,
  pg_temp.c('free'), pg_temp.c('session')));
select pg_temp.step('create_table_order 1', format($q$select public.create_table_order(%L, 1::smallint, '5afe0000-0000-4000-8000-0000000000a1',
  '[{"menuItemId": "5afe0000-0000-4000-8000-000000000002", "qty": 1}]')::text$q$, pg_temp.c('session')));
select pg_temp.step('create_table_order 2', format($q$select public.create_table_order(%L, 1::smallint, '5afe0000-0000-4000-8000-0000000000a2',
  '[{"menuItemId": "5afe0000-0000-4000-8000-000000000002", "qty": 2}]', 'less sugar')::text$q$, pg_temp.c('session')));
select pg_temp.step('create_table_order replay', format($q$select public.create_table_order(%L, 1::smallint, '5afe0000-0000-4000-8000-0000000000a1',
  '[{"menuItemId": "5afe0000-0000-4000-8000-000000000002", "qty": 1}]')::text$q$, pg_temp.c('session')));
select pg_temp.step('transition preparing', format($q$select public.transition_table_order(o.id, 'preparing', null, %L)::text
  from public.table_orders o where o.session_id = %L and o.round = 1$q$, pg_temp.c('staff'), pg_temp.c('session')));
select pg_temp.step('transition served', format($q$select public.transition_table_order(o.id, 'served', null, %L)::text
  from public.table_orders o where o.session_id = %L and o.round = 1$q$, pg_temp.c('staff'), pg_temp.c('session')));
select pg_temp.step('transition cancel accepted (alert)', format($q$select public.transition_table_order(o.id, 'cancelled', 'mistake', %L)::text
  from public.table_orders o where o.session_id = %L and o.round = 1$q$, pg_temp.c('staff'), pg_temp.c('session')));
select pg_temp.step('rotate_table_code', format($q$select public.rotate_table_code(%L, %L)::text$q$, pg_temp.c('session'), pg_temp.c('staff')));
select pg_temp.step('set_table_orders_locked on', format($q$select public.set_table_orders_locked(%L, true, %L)::text$q$, pg_temp.c('session'), pg_temp.c('staff')));
select pg_temp.step('set_table_orders_locked off', format($q$select public.set_table_orders_locked(%L, false, %L)::text$q$, pg_temp.c('session'), pg_temp.c('staff')));
select pg_temp.step('table_board', format($q$select public.table_board(null, %L)::text$q$, pg_temp.c('staff')));
select pg_temp.step('table_session_guest_view', format($q$select public.table_session_guest_view(%L, 2::smallint, null)::text$q$, pg_temp.c('session')));
select pg_temp.step('list_cafe_tables', format($q$select public.list_cafe_tables(%L)::text$q$, pg_temp.c('staff')));
select pg_temp.step('close_table_session void (owner, alert)', format($q$select public.close_table_session(%L, 'void', null,
  (public.table_session_guest_view(%L, 2::smallint, null) -> 'session' -> 'bill' ->> 'total')::int, %L)::text$q$,
  pg_temp.c('session'), pg_temp.c('session'), pg_temp.c('owner')));
select pg_temp.step('open again', format($q$select pg_temp.put('session2', (public.open_table_session(%L, %L) ->> 'id'))::text$q$,
  pg_temp.c('table'), pg_temp.c('staff')));
select pg_temp.step('close_table_session paid (empty)', format($q$select public.close_table_session(%L, 'paid', 'cash', 0, %L)::text$q$,
  pg_temp.c('session2'), pg_temp.c('staff')));
select pg_temp.step('auto_close_stale_table_sessions', $q$select public.auto_close_stale_table_sessions()::text$q$);
select pg_temp.step('stats_table_orders', format($q$select public.stats_table_orders(current_date - 7, current_date, %L)::text$q$, pg_temp.c('owner')));
select pg_temp.step('record_admin_alert', $q$select public.record_admin_alert('table_join_fail', '{"tableNumber": 1, "failures": 21}')::text$q$);
select pg_temp.step('claim_alert_deliveries', $q$select count(*)::text from public.claim_alert_deliveries('whatsapp', 20)$q$);
select pg_temp.step('finish_alert_delivery', $q$select public.finish_alert_delivery(d.alert_id, 'whatsapp', true, null)::text
  from public.alert_deliveries d where d.status = 'sending' limit 1$q$);
select pg_temp.step('mark_admin_alerts_read', format($q$select public.mark_admin_alerts_read(null, true, %L)::text$q$, pg_temp.c('owner')));
select pg_temp.step('save_cafe_tables (remove the check table)', format($q$select public.save_cafe_tables(%L, %L)::text$q$,
  (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'number', t.number, 'label', t.label, 'isActive', t.is_active)), '[]'::jsonb)
     from public.cafe_tables t where t.id <> pg_temp.c('table')::uuid), pg_temp.c('owner')));

-- End-state assertions (a step that selects no rows would otherwise pass silently) -------------------------------------
select pg_temp.step('assert: 2 rounds, first cancelled after acceptance', format($q$select 1 / (case when
  (select count(*) from public.table_orders where session_id = %L) = 2
  and exists (select 1 from public.table_orders where session_id = %L and round = 1 and status = 'cancelled' and accepted_at is not null)
  then 1 else 0 end)$q$, pg_temp.c('session'), pg_temp.c('session')));
select pg_temp.step('assert: both sessions closed, epoch rotated', format($q$select 1 / (case when
  (select count(*) from public.table_sessions where id in (%L, %L) and status = 'closed') = 2
  and (select cookie_epoch from public.table_sessions where id = %L) = 2 then 1 else 0 end)$q$,
  pg_temp.c('session'), pg_temp.c('session2'), pg_temp.c('session')));
select pg_temp.step('assert: void and cancel alerts written', format($q$select 1 / (case when
  (select count(distinct kind) from public.admin_alerts where session_id = %L
     and kind in ('table_void', 'table_round_cancelled_after_accept')) = 2 then 1 else 0 end)$q$, pg_temp.c('session')));

-- Older writers the API reaches ----------------------------------------------------------------------------------
select pg_temp.step('rate_limit_hit_info', $q$select public.rate_limit_hit_info('safeupdate-check', 60, 5)::text$q$);
select pg_temp.step('auto_cancel_unconfirmed_orders', $q$select public.auto_cancel_unconfirmed_orders()::text$q$);
select pg_temp.step('purge_personal_data', $q$select public.purge_personal_data()::text$q$);
select pg_temp.step('upsert_daily_sales', format($q$select public.upsert_daily_sales(date '2020-01-02',
  '[{"menuItemId": "5afe0000-0000-4000-8000-000000000002", "qty": 3}]', null, 'SU check', %L)::text$q$, pg_temp.c('owner')));

-- Result ---------------------------------------------------------------------------------------------------------
select n, name, state, coalesce(msg, '') as msg from pg_temp.steps order by n;
do $$
declare
  v_bad integer;
  v_su  integer;
begin
  if (select state from pg_temp.steps where name like 'probe:%') <> '21000' then
    raise exception 'safeupdate_check: INVALID RUN, safeupdate is not loaded in this session (connect as authenticator)';
  end if;
  select count(*) filter (where state <> 'ok'), count(*) filter (where state = '21000')
    into v_bad, v_su from pg_temp.steps where name not like 'probe:%';
  if v_su > 0 then
    raise exception 'safeupdate_check: FAILED, % step(s) hit 21000 "UPDATE/DELETE requires a WHERE clause"', v_su;
  end if;
  if v_bad > 0 then
    raise exception 'safeupdate_check: FAILED, % step(s) raised another error (see the table above)', v_bad;
  end if;
  raise notice 'safeupdate_check: PASSED (% steps, safeupdate preloaded via authenticator)',
    (select count(*) from pg_temp.steps where name not like 'probe:%');
end
$$;

rollback;

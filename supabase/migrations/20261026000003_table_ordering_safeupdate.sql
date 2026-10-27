-- 20261026000003_table_ordering_safeupdate.sql
-- Fix: every table-ordering write through the API failed with SQLSTATE 21000 "UPDATE requires a WHERE clause".
-- Supabase preloads the pg_safeupdate extension for API sessions (role `authenticator`:
-- session_preload_libraries = supautils, safeupdate; hosted projects do the same). It refuses any UPDATE or DELETE
-- without a WHERE clause, also inside SECURITY DEFINER functions. psql / pgTAP sessions as `postgres` do not load it,
-- so the pgTAP suite passed. Two single-row updates in 20261026000002 had no WHERE:
--   private.table_board_bump()   (called by every table writer)
--   public.set_table_ordering()  (the site_settings.table_ordering update)
-- Both single-row tables use `id boolean primary key default true check (id)`, so `where id` targets the one row.
-- Bodies are otherwise identical to 20261026000002 (which is already applied and is not edited).
-- A scan of every migration found no other UPDATE / DELETE without WHERE in a function the API can reach.
-- Regression check that runs with safeupdate loaded: supabase/checks/safeupdate_check.sql (README "Table ordering").

create or replace function private.table_board_bump()
returns void
language sql
volatile
set search_path = ''
as $$
  update public.table_board_state set version = version + 1, changed_at = now() where id
$$;

create or replace function public.set_table_ordering(p_mode text, p_actor uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_cur  text;
begin
  v_role := private.require_actor_role(p_actor);
  if p_mode is null or p_mode not in ('off', 'on', 'paused') then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('mode', jsonb_build_array('off, on or paused')));
  end if;

  perform private.table_lock_board();
  select s.table_ordering into v_cur from public.site_settings s where s.id for update;

  if v_role <> 'owner' and not (v_cur in ('on', 'paused') and p_mode in ('on', 'paused')) then
    perform private.raise_order_error('FORBIDDEN', null,
      'Staff can pause and resume table ordering. Ask the owner to turn it on or off.');
  end if;
  if v_cur = p_mode then
    return p_mode;
  end if;
  if p_mode = 'off' and exists (select 1 from public.table_sessions s where s.status = 'open') then
    perform private.raise_order_error('CONFLICT', null, 'Close all open tables first.');
  end if;

  perform set_config('app.table_write', 'on', true);
  update public.site_settings set table_ordering = p_mode where id;
  perform private.table_board_bump();
  perform set_config('app.table_write', 'off', true);
  return p_mode;
end;
$$;

-- CREATE OR REPLACE keeps the ACL; restated so the file stands on its own (SEC-007 pattern).
revoke all on function private.table_board_bump() from public, anon, authenticated;
revoke all on function public.set_table_ordering(text, uuid) from public, anon, authenticated;
grant execute on function public.set_table_ordering(text, uuid) to service_role;

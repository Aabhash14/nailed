-- 20261021000001_function_privileges.sql
-- SEC-007: make "deny by default" for functions real.
--
-- Postgres grants EXECUTE on every new function to PUBLIC as a GLOBAL default. The statement in
-- 20261019000001_foundation.sql (`... in schema public revoke execute on functions from public ...`) only edits the
-- schema-specific list and cannot remove a global default, so anon/authenticated still inherited EXECUTE through
-- PUBLIC on any future public function that was not revoked by hand. This migration:
--   1. revokes the global PUBLIC default for functions created by `postgres` (the role that runs our migrations
--      and the dashboard SQL editor) in every schema;
--   2. re-grants PUBLIC by default in schema `extensions` only, so extensions created later by `postgres`
--      (e.g. pgTAP during `supabase test db`) keep working for every role; that schema is not exposed by PostgREST;
--   3. sweeps existing callable functions in `public` and revokes PUBLIC/anon/authenticated EXECUTE from all of
--      them except the four that are meant to be anon-callable (health_ping, current_app_role, is_staff, is_owner).
--      Trigger functions (return type `trigger`) are skipped: PostgREST cannot call them and Postgres refuses to
--      call them outside a trigger, and their EXECUTE grant is not what protects us.
--
-- NOT done on purpose: the same for role `supabase_admin`. That role creates the platform's own functions in the
-- auth/storage/realtime schemas; changing its defaults could break platform upgrades, and `postgres` normally
-- cannot alter another role's defaults anyway.
--
-- Effect on later migrations: a new function is executable only by its owner (and roles granted explicitly, plus
-- Supabase's in-schema grant to service_role in `public`). Keep writing the explicit revoke/grant pair anyway.
-- A pgTAP assertion in tests/database/rls.test.sql pins the anon-callable list.

alter default privileges for role postgres revoke execute on functions from public;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    execute 'alter default privileges for role postgres in schema extensions grant execute on functions to public';
  end if;
end
$$;

-- Sweep: no public function is callable by PUBLIC/anon/authenticated unless it is on the allow-list.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.prorettype <> 'trigger'::regtype
       and p.proname not in ('health_ping', 'current_app_role', 'is_staff', 'is_owner')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end
$$;

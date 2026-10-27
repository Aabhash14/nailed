-- 20261019000001_foundation.sql
-- Foundation: deny-by-default privileges, updated_at trigger, staff profiles, role helpers.
-- Money everywhere in this schema is integer paisa (1 NPR = 100 paisa). Timestamps are timestamptz.

-- ---------------------------------------------------------------------------
-- Deny by default. Supabase grants anon/authenticated ALL on new public objects.
-- We revoke that for everything created later by this role, then grant explicitly
-- per table/function in each migration. RLS is the second layer, not the only one.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

-- Internal helpers live in a schema that PostgREST does not expose.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles: one row per staff login (auth.users). Signups are OFF, so only the
-- backend (service role) creates users + profiles. No client can write here.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  role         text not null check (role in ('owner', 'staff')),
  display_name text not null check (char_length(display_name) between 1 and 80),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Role helpers. SECURITY DEFINER so they can read profiles without recursing into RLS.
-- Role always comes from profiles.role, never from the JWT or the client.
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = (select auth.uid())
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('owner', 'staff'), false)
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() = 'owner', false)
$$;

grant execute on function public.current_app_role(), public.is_staff(), public.is_owner()
  to anon, authenticated, service_role;

-- Staff-column guard: a trigger function used on tables where `staff` may change only
-- a few columns (e.g. menu_items.is_sold_out). Owner and server-side roles
-- (postgres, service_role) are unrestricted. Arguments = allowed column names.
create or replace function public.guard_staff_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed text[] := tg_argv;
begin
  -- Only end-user sessions (PostgREST sets role anon/authenticated) are restricted.
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if public.is_owner() then
    return new;
  end if;
  if (to_jsonb(new) - allowed - 'updated_at') is distinct from (to_jsonb(old) - allowed - 'updated_at') then
    raise exception 'staff may only change: %', array_to_string(allowed, ', ')
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- profiles RLS: read own row; owner reads all. No insert/update/delete grants at all.
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
create policy profiles_select_own_or_owner on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_owner());

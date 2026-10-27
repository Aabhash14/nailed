-- 20261019000005_abuse_controls.sql
-- blocked_contacts (phone / salted IP hash, with expiry) and rate_limits + rate_limit_hit RPC.
-- Neither table is reachable by anon. Staff/owner reach blocked_contacts through RLS; rate_limits is service-only.

create table public.blocked_contacts (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('phone', 'ip_hash')),
  value       text not null,
  reason      text check (reason is null or char_length(reason) <= 200),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  -- Legal retention proposal: entries expire after 12 months unless the owner renews (update expires_at).
  expires_at  timestamptz not null default (now() + interval '12 months'),
  unique (kind, value),
  check (
    (kind = 'phone'   and value ~ '^\+977(97|98)[0-9]{8}$') or
    (kind = 'ip_hash' and value ~ '^[0-9a-f]{64}$')            -- salted SHA-256, lowercase hex, never a raw IP
  )
);
create index blocked_contacts_expires_idx on public.blocked_contacts (expires_at);

-- Staff may add; only the owner may remove or renew (contract: unblockContact is O).
alter table public.blocked_contacts enable row level security;
revoke all on public.blocked_contacts from anon, authenticated;
grant select, insert, update, delete on public.blocked_contacts to authenticated;

create policy blocked_contacts_staff_read on public.blocked_contacts
  for select to authenticated using (public.is_staff());
create policy blocked_contacts_staff_insert on public.blocked_contacts
  for insert to authenticated
  with check (public.is_staff() and created_by = (select auth.uid()));
create policy blocked_contacts_owner_update on public.blocked_contacts
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy blocked_contacts_owner_delete on public.blocked_contacts
  for delete to authenticated using (public.is_owner());

-- ---------------------------------------------------------------------------
-- rate_limits: fixed-window counters keyed by an app-chosen string
-- (e.g. 'checkout:ip:<hash>', 'login:ip:<hash>'). Service role only.
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key           text not null check (char_length(key) between 1 and 200),
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (key, window_start)
);
create index rate_limits_window_idx on public.rate_limits (window_start);

alter table public.rate_limits enable row level security;     -- no policies and no grants: deny all
revoke all on public.rate_limits from anon, authenticated;

-- rate_limit_hit_info: records one hit and says whether it is within the limit.
-- A denied hit still counts (attempts are what we limit). Fixed windows aligned to the epoch.
create or replace function public.rate_limit_hit_info(p_key text, p_window_seconds integer, p_max integer)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_count integer;
  v_end   timestamptz;
begin
  if p_key is null or char_length(p_key) not between 1 and 200
     or p_window_seconds is null or p_window_seconds not between 1 and 604800
     or p_max is null or p_max < 1 then
    raise exception 'VALIDATION' using errcode = 'P0001', detail = 'bad rate limit arguments';
  end if;

  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_end   := v_start + make_interval(secs => p_window_seconds);

  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, v_start, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;

  -- Opportunistic cleanup of this key's expired windows (pg_cron does the global sweep daily).
  delete from public.rate_limits d
   where d.key = p_key and d.window_start < v_start - make_interval(secs => p_window_seconds);

  allowed := v_count <= p_max;
  remaining := greatest(p_max - v_count, 0);
  retry_after_seconds := case when allowed then 0 else greatest(ceil(extract(epoch from (v_end - now())))::integer, 1) end;
  return next;
end;
$$;

-- Contract/architecture shape: returns a plain boolean.
create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select i.allowed from public.rate_limit_hit_info(p_key, p_window_seconds, p_max) i
$$;

revoke all on function public.rate_limit_hit_info(text, integer, integer) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit_info(text, integer, integer) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- Cheap keep-alive RPC for GET /api/health (one round trip, reveals only the server time).
create or replace function public.health_ping()
returns timestamptz
language sql
stable
set search_path = ''
as $$ select now() $$;
revoke all on function public.health_ping() from public;
grant execute on function public.health_ping() to anon, authenticated, service_role;

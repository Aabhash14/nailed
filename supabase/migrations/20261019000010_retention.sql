-- 20261019000010_retention.sql
-- Retention purge per legal's proposal (business/legal/privacy-notice-orders.md, Part B). All numbers are
-- ESTIMATES until Aabhash and the cafe agree; they live in order_rules so they change without a migration.
--   * Completed/cancelled orders older than retention_days (90): blank name, phone, email, address, landmark,
--     area, notes and ip_hash. Totals, items and dates stay for the books. Open orders are never touched.
--   * blocked_contacts past expires_at are deleted. Blanking an order does NOT delete its blocklist entry
--     (separate purpose, separate rule).
--   * rate_limits windows older than 2 days are deleted.
-- Scheduled daily with pg_cron when available. NOT implemented: deleting the whole order row after the
-- tax record-keeping period (legal: "[6] years, UNVERIFIED"); decide with an accountant, then add a migration.

create or replace function public.purge_personal_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days    integer;
  v_orders  integer;
  v_blocks  integer;
  v_rl      integer;
begin
  select retention_days into v_days from public.order_rules limit 1;
  v_days := coalesce(v_days, 90);

  update public.orders
     set customer_name = null, customer_phone = null, customer_email = null,
         address = null, landmark = null, area = null, notes = null, ip_hash = null,
         personal_data_purged_at = now()
   where personal_data_purged_at is null
     and status in ('completed', 'cancelled')
     and coalesce(completed_at, cancelled_at) < now() - make_interval(days => v_days);
  get diagnostics v_orders = row_count;

  delete from public.blocked_contacts where expires_at < now();
  get diagnostics v_blocks = row_count;

  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rl = row_count;

  return jsonb_build_object('ordersPurged', v_orders, 'blocksExpired', v_blocks, 'rateLimitRowsDeleted', v_rl,
                            'retentionDays', v_days, 'ranAt', now());
end;
$$;

revoke all on function public.purge_personal_data() from public, anon, authenticated;
grant execute on function public.purge_personal_data() to service_role;

-- ---------------------------------------------------------------------------
-- pg_cron schedule. Supabase Free supports pg_cron (enable it under Database > Extensions, or this
-- migration does it). If the extension is unavailable (for example a bare Postgres), the migration still
-- succeeds and prints a NOTICE: then run `select public.purge_personal_data();` from a scheduled GitHub
-- Action using the service key (documented in supabase/README.md). 03:00 Nepal time = 21:15 UTC.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('cafe-daily-purge', '15 21 * * *', 'select public.purge_personal_data()');
  else
    raise notice 'pg_cron is not available: schedule public.purge_personal_data() some other way (see supabase/README.md)';
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped (%): schedule public.purge_personal_data() some other way', sqlerrm;
end
$$;

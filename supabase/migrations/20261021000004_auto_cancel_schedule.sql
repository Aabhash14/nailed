-- 20261021000004_auto_cancel_schedule.sql
-- SEC-003: run public.auto_cancel_unconfirmed_orders() every 5 minutes with pg_cron (enabled by
-- 20261019000010_retention.sql). The timeout itself lives in order_rules.auto_cancel_placed_after_minutes
-- (default 120 = ESTIMATE; NULL = off), so the owner changes it without a migration.
-- Same fallback as retention: if pg_cron is not available the migration still succeeds with a NOTICE; then call
-- rpc('auto_cancel_unconfirmed_orders') with the service key from a scheduled job (devops; see supabase/README.md).
-- cron.schedule() with an existing job name updates that job, so re-running is safe.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('cafe-auto-cancel-unconfirmed', '*/5 * * * *',
                          'select public.auto_cancel_unconfirmed_orders()');
  elsif exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('cafe-auto-cancel-unconfirmed', '*/5 * * * *',
                          'select public.auto_cancel_unconfirmed_orders()');
  else
    raise notice 'pg_cron is not available: call public.auto_cancel_unconfirmed_orders() every 5 minutes some other way (see supabase/README.md)';
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped (%): call public.auto_cancel_unconfirmed_orders() some other way', sqlerrm;
end
$$;

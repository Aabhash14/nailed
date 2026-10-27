-- 20261019000009_realtime.sql
-- Realtime publication per api-contract section 5: menu_items, menu_variants, menu_specials, site_settings
-- (public, anon-readable) and orders (RLS limits events to staff/owner). Nothing else is published, so
-- blocked_contacts, rate_limits, profiles, order_items and order_rules never produce Realtime events.
-- Product variants are NOT published (they carry exact stock).

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['menu_items', 'menu_variants', 'menu_specials', 'site_settings', 'orders'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

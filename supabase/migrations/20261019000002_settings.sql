-- 20261019000002_settings.sql
-- site_settings: PUBLIC single-row config (readable by anyone, safe to expose, Realtime-friendly).
-- order_rules:   PRIVATE single-row abuse/retention rules (staff/owner only).
-- DEVIATION from architecture.md section 3 (which lists these in one table): private rules are split
-- out so anon can read site_settings directly and subscribe to it in Realtime without a column filter.

create table public.site_settings (
  id                          boolean primary key default true check (id),   -- enforces exactly one row
  cafe_name                   text not null default 'Nailed Cafe' check (char_length(cafe_name) between 1 and 80),
  -- OpeningHours per contract: weekly keys "0".."6" (0 = Sunday), null = closed; times "HH:mm" Asia/Kathmandu
  hours                       jsonb not null default jsonb_build_object(
                                'weekly', jsonb_build_object('0', null, '1', null, '2', null, '3', null, '4', null, '5', null, '6', null),
                                'closures', '[]'::jsonb),
  announcement                text check (announcement is null or char_length(announcement) <= 300),
  phone                       text,
  whatsapp                    text,
  email                       text,
  address                     text,
  landmark                    text,
  map_url                     text,
  -- ASSUMPTION: unknown until the client answers (brief open question). true = shelf prices already include VAT.
  prices_include_vat          boolean not null default true,
  service_charge_pct          numeric(4,2) not null default 0 check (service_charge_pct between 0 and 30),
  delivery_fee_paisa          integer not null default 0 check (delivery_fee_paisa >= 0),
  delivery_areas              text[] not null default '{}',
  payment_methods_enabled     text[] not null default array['cod', 'pickup']
                                check (payment_methods_enabled <@ array['cod', 'pickup']),
  min_order_delivery_paisa    integer not null default 0 check (min_order_delivery_paisa >= 0),
  min_order_pickup_paisa      integer not null default 0 check (min_order_pickup_paisa >= 0),
  features                    jsonb not null default '{"lodge": false}'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  check (jsonb_typeof(hours) = 'object'),
  check (jsonb_typeof(features) = 'object')
);
create trigger site_settings_set_updated_at before update on public.site_settings
  for each row execute function public.set_updated_at();
-- Staff may change only the announcement (contract: setAnnouncement is S). Everything else is owner only.
create trigger site_settings_guard_staff before update on public.site_settings
  for each row execute function public.guard_staff_update('announcement');

insert into public.site_settings default values;   -- the one row; seed.sql fills placeholder values

create table public.order_rules (
  id                        boolean primary key default true check (id),
  cod_max_total_paisa       integer check (cod_max_total_paisa is null or cod_max_total_paisa > 0),   -- null = no cap
  max_open_orders_per_phone integer not null default 2 check (max_open_orders_per_phone between 1 and 5),
  -- DB-level backstop rate limits inside create_order (the app also limits with rate_limit_hit)
  ip_orders_max             integer not null default 5 check (ip_orders_max >= 1),      -- orders per IP hash ...
  ip_window_minutes         integer not null default 10 check (ip_window_minutes >= 1), -- ... per this many minutes
  phone_orders_max_per_day  integer not null default 5 check (phone_orders_max_per_day >= 1),
  -- Retention (legal proposal, ESTIMATE until Aabhash/client agree; see 20261019000010_retention.sql)
  retention_days            integer not null default 90 check (retention_days between 7 and 3650),
  blocklist_months          integer not null default 12 check (blocklist_months between 1 and 120),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create trigger order_rules_set_updated_at before update on public.order_rules
  for each row execute function public.set_updated_at();

insert into public.order_rules default values;

-- Public view with contract-shaped extras (vat_pct is a constant 13). security_invoker: the caller's RLS applies.
create view public.public_settings with (security_invoker = true) as
  select cafe_name, hours, announcement, phone, whatsapp, email, address, landmark, map_url,
         prices_include_vat, service_charge_pct, 13::integer as vat_pct,
         delivery_fee_paisa, delivery_areas,
         min_order_delivery_paisa, min_order_pickup_paisa,
         payment_methods_enabled, features, updated_at
  from public.site_settings;

-- RLS + grants
alter table public.site_settings enable row level security;
alter table public.order_rules   enable row level security;

revoke all on public.site_settings, public.order_rules, public.public_settings from anon, authenticated;
grant select on public.site_settings, public.public_settings to anon, authenticated;
grant update on public.site_settings to authenticated;     -- RLS + guard trigger decide who/what
grant select, update on public.order_rules to authenticated;

create policy site_settings_public_read on public.site_settings
  for select to anon, authenticated using (true);
create policy site_settings_staff_update on public.site_settings
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

create policy order_rules_staff_read on public.order_rules
  for select to authenticated using (public.is_staff());
create policy order_rules_owner_update on public.order_rules
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
-- No insert/delete grants: the single row is created here and never removed.

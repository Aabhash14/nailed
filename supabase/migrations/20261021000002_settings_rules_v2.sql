-- 20261021000002_settings_rules_v2.sql
-- Settings and order-rule changes from the 2026-10-21 security review and QA pass.
--   BUG-003 (Manager decision): order_rules.cod_max_total_paisa = 0 or NULL means NO limit (0 was rejected
--           by the old check; create_order now treats both as "no cap").
--   SEC-003: per-IP-hash caps (open orders, orders per 24 h), the auto-cancel timeout for unconfirmed orders, and
--           a public owner kill switch site_settings.orders_paused (shown in public_settings).
--   BUG-006 (DB side): delivery (= 'cod' in payment_methods_enabled, delivery always pairs with COD) cannot be
--           enabled with no delivery area, and every opening-hours range must have close > open ("HH:mm").
-- All default numbers are ESTIMATES (Manager): owner-tunable in order_rules, no migration needed to change them.

-- ---------------------------------------------------------------------------
-- BUG-003: replace the single-column check on cod_max_total_paisa (found by catalog lookup, not by guessing
-- the generated name) with one that accepts 0.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.order_rules'::regclass
       and c.contype = 'c'
       and c.conkey = array[(select a.attnum from pg_attribute a
                              where a.attrelid = 'public.order_rules'::regclass
                                and a.attname = 'cod_max_total_paisa')]::int2[]
  loop
    execute format('alter table public.order_rules drop constraint %I', r.conname);
  end loop;
end
$$;

alter table public.order_rules
  add constraint order_rules_cod_max_total_valid
  check (cod_max_total_paisa is null or cod_max_total_paisa >= 0);
comment on column public.order_rules.cod_max_total_paisa is
  'Largest cash order total in paisa. NULL or 0 = no limit (BUG-003). Above it create_order returns ORDER_REFUSED.';

-- ---------------------------------------------------------------------------
-- SEC-003: new abuse rules (ESTIMATE defaults; owner-tunable)
-- ---------------------------------------------------------------------------
alter table public.order_rules
  add column ip_open_orders_max integer not null default 3
    constraint order_rules_ip_open_orders_max_range check (ip_open_orders_max between 1 and 100),
  add column ip_orders_max_per_day integer not null default 10
    constraint order_rules_ip_orders_max_per_day_range check (ip_orders_max_per_day between 1 and 1000),
  add column auto_cancel_placed_after_minutes integer default 120
    constraint order_rules_auto_cancel_range
    check (auto_cancel_placed_after_minutes is null or auto_cancel_placed_after_minutes between 15 and 10080);

comment on column public.order_rules.ip_open_orders_max is
  'Max open (placed/confirmed/out_for_delivery/ready_for_pickup) orders per salted IP hash. Over it: ORDER_REFUSED. Default 3 = ESTIMATE.';
comment on column public.order_rules.ip_orders_max_per_day is
  'Max orders per salted IP hash in a rolling 24 h (cancelled ones count). Over it: RATE_LIMITED. Default 10 = ESTIMATE.';
comment on column public.order_rules.auto_cancel_placed_after_minutes is
  'Orders still placed this many minutes after creation are cancelled (reason auto_unconfirmed) and restocked by auto_cancel_unconfirmed_orders(). NULL = auto-cancel off. Default 120 = ESTIMATE.';

-- Owner kill switch. Public on purpose: the checkout page shows "please phone us" when it is on.
alter table public.site_settings add column orders_paused boolean not null default false;
comment on column public.site_settings.orders_paused is
  'Owner kill switch (SEC-003). true = create_order refuses every order with ORDERS_PAUSED. Owner only (staff guard trigger).';

-- public_settings gains orders_paused (appended last, as CREATE OR REPLACE VIEW requires). security_invoker must be
-- restated or it would be dropped by the replace. Existing grants on the view are kept.
create or replace view public.public_settings with (security_invoker = true) as
  select cafe_name, hours, announcement, phone, whatsapp, email, address, landmark, map_url,
         prices_include_vat, service_charge_pct, 13::integer as vat_pct,
         delivery_fee_paisa, delivery_areas,
         min_order_delivery_paisa, min_order_pickup_paisa,
         payment_methods_enabled, features, updated_at,
         orders_paused
  from public.site_settings;

-- ---------------------------------------------------------------------------
-- BUG-006: delivery needs at least one non-blank area.
-- Bring the existing row in line first, matching what checkout already did (it hid delivery when there were no
-- areas): if COD/delivery is on with no usable area, turn COD off. The new column default follows suit.
-- ---------------------------------------------------------------------------
update public.site_settings
   set payment_methods_enabled = array_remove(payment_methods_enabled, 'cod')
 where 'cod' = any (payment_methods_enabled)
   and coalesce(array_to_string(delivery_areas, ''), '') !~ '[^[:space:]]';

alter table public.site_settings alter column payment_methods_enabled set default array['pickup'];

alter table public.site_settings
  add constraint site_settings_delivery_needs_area
  check ('cod' <> all (payment_methods_enabled)
         or coalesce(array_to_string(delivery_areas, ''), '') ~ '[^[:space:]]');

-- BUG-006: every weekly range is {"open": "HH:mm", "close": "HH:mm"} with close > open (same day; no overnight
-- ranges). "24:00" is accepted as a close time. null days (closed) and empty arrays are fine.
-- The jsonpath flags a range when it is not an object, when either time is missing / not a string / badly formed,
-- or when close <= open. String comparison in jsonpath is by code point, so zero-padded "HH:mm" compares as time,
-- and jsonb_path_exists(jsonb, jsonpath) is immutable (allowed in a CHECK).
-- Added NOT VALID, then validated in a guarded block: if an existing row is already bad (possible on an
-- environment where an owner saved reversed hours), the migration still applies, the rule holds for every new
-- write, and the NOTICE says how to validate after fixing the row.
alter table public.site_settings
  add constraint site_settings_hours_ranges_valid
  check (not jsonb_path_exists(hours,
    '$.weekly.*[*] ? (@.type() != "null" && (@.type() != "object"
        || !(@.open like_regex "^([01][0-9]|2[0-3]):[0-5][0-9]$"
             && @.close like_regex "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$"
             && @.close > @.open)
        || (@.open like_regex "^([01][0-9]|2[0-3]):[0-5][0-9]$"
             && @.close like_regex "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$"
             && @.close > @.open) is unknown))'::jsonpath))
  not valid;

do $$
begin
  alter table public.site_settings validate constraint site_settings_hours_ranges_valid;
exception when check_violation then
  raise notice 'site_settings.hours has a bad range (close <= open or bad time). Fix it in Settings, then run: alter table public.site_settings validate constraint site_settings_hours_ranges_valid';
end
$$;

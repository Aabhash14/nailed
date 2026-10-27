-- 20261019000006_orders.sql
-- Orders + order items. Customers have NO direct access (the token endpoint runs server-side with the
-- service role). Staff/owner can read. Nobody can write directly: all writes go through
-- create_order / set_order_status / customer_cancel_order (next migration).
-- No payment_events table, no provider columns (architecture rev 3, section 9).

create sequence public.order_number_seq start with 1001;

create table public.orders (
  id                   uuid primary key default gen_random_uuid(),
  number               text not null unique default ('NC-' || nextval('public.order_number_seq')::text),
  public_token         uuid not null unique default gen_random_uuid(),     -- the customer's credential (UUID v4)
  status               text not null default 'placed'
                         check (status in ('placed', 'confirmed', 'out_for_delivery', 'ready_for_pickup', 'completed', 'cancelled')),
  fulfilment           text not null check (fulfilment in ('pickup', 'delivery')),
  payment_method       text not null check (payment_method in ('cod', 'pickup')),   -- widen by migration if payments are ever built
  payment_status       text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),

  -- Money, integer paisa. total = subtotal + service_charge + delivery_fee + (vat unless vat_included)
  prices_include_vat   boolean not null,
  subtotal_paisa       integer not null check (subtotal_paisa >= 0),
  service_charge_paisa integer not null default 0 check (service_charge_paisa >= 0),
  delivery_fee_paisa   integer not null default 0 check (delivery_fee_paisa >= 0),
  vat_paisa            integer not null default 0 check (vat_paisa >= 0),
  total_paisa          integer not null check (total_paisa >= 0),

  -- Personal data. Nullable ONLY so the retention job can blank it (see personal_data_purged_at).
  customer_name        text check (customer_name is null or char_length(customer_name) between 2 and 80),
  customer_phone       text check (customer_phone is null or customer_phone ~ '^\+977(97|98)[0-9]{8}$'),
  customer_email       text check (customer_email is null or (char_length(customer_email) <= 254 and customer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  address              text check (address is null or char_length(address) <= 300),
  landmark             text check (landmark is null or char_length(landmark) <= 200),
  area                 text check (area is null or char_length(area) <= 100),
  notes                text check (notes is null or char_length(notes) <= 300),
  ip_hash              text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),   -- salted SHA-256, never the raw IP
  personal_data_purged_at timestamptz,

  cancel_reason        text check (cancel_reason in ('customer_request', 'unreachable', 'no_show', 'refused', 'fake', 'out_of_stock', 'other')),
  stock_restocked_at   timestamptz,                                    -- makes cancel-and-restock idempotent

  created_at           timestamptz not null default now(),
  confirmed_at         timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  updated_at           timestamptz not null default now(),

  -- Delivery pairs with COD, pickup pairs with pay-at-pickup.
  constraint orders_fulfilment_payment_match check (
    (fulfilment = 'delivery' and payment_method = 'cod') or (fulfilment = 'pickup' and payment_method = 'pickup')),
  -- Paid if and only if completed ("paid" is only ever set by completing the order).
  constraint orders_paid_iff_completed check ((payment_status = 'paid') = (status = 'completed')),
  constraint orders_cancel_reason_iff_cancelled check ((status = 'cancelled') = (cancel_reason is not null)),
  constraint orders_timestamps_match_status check (
    (status <> 'completed' or completed_at is not null) and (status <> 'cancelled' or cancelled_at is not null)),
  constraint orders_total_matches_parts check (
    total_paisa = subtotal_paisa + service_charge_paisa + delivery_fee_paisa
                  + case when prices_include_vat then 0 else vat_paisa end),
  -- While the order is not purged, name + phone must be present; delivery needs an address.
  constraint orders_personal_present_until_purged check (
    personal_data_purged_at is not null
    or (customer_name is not null and customer_phone is not null
        and (fulfilment = 'pickup' or (address is not null and landmark is not null and area is not null))))
);
create index orders_status_created_idx   on public.orders (status, created_at desc);
create index orders_created_idx          on public.orders (created_at desc);
create index orders_open_phone_idx       on public.orders (customer_phone)
  where status in ('placed', 'confirmed', 'out_for_delivery', 'ready_for_pickup');
create index orders_phone_created_idx    on public.orders (customer_phone, created_at desc) where customer_phone is not null;
create index orders_ip_created_idx       on public.orders (ip_hash, created_at desc) where ip_hash is not null;
create index orders_purge_idx            on public.orders (status, completed_at, cancelled_at) where personal_data_purged_at is null;

create trigger orders_set_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

-- Status, payment, money, identity and timestamp columns can change ONLY inside the transition functions
-- (they set the transaction-local flag app.order_transition). So a bug in app code, or a stray UPDATE by
-- the service role, cannot jump placed -> completed or rewrite totals. Personal-data columns stay editable
-- (the retention job blanks them).
create or replace function private.orders_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.order_transition', true), 'off') <> 'on' then
    if (new.id, new.number, new.public_token, new.status, new.fulfilment, new.payment_method, new.payment_status,
        new.prices_include_vat, new.subtotal_paisa, new.service_charge_paisa, new.delivery_fee_paisa, new.vat_paisa,
        new.total_paisa, new.cancel_reason, new.stock_restocked_at, new.created_at, new.confirmed_at,
        new.completed_at, new.cancelled_at)
       is distinct from
       (old.id, old.number, old.public_token, old.status, old.fulfilment, old.payment_method, old.payment_status,
        old.prices_include_vat, old.subtotal_paisa, old.service_charge_paisa, old.delivery_fee_paisa, old.vat_paisa,
        old.total_paisa, old.cancel_reason, old.stock_restocked_at, old.created_at, old.confirmed_at,
        old.completed_at, old.cancelled_at) then
      raise exception 'orders: status, money and timestamps change only through set_order_status()'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger orders_guard_trg before update on public.orders
  for each row execute function private.orders_guard();

create table public.order_items (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete cascade,
  product_variant_id  uuid not null references public.product_variants (id) on delete restrict,
  name                text not null,                       -- snapshot: product name
  variant_label       text not null,                       -- snapshot: "M / Black"
  unit_price_paisa    integer not null check (unit_price_paisa >= 0),
  qty                 integer not null check (qty between 1 and 10),
  created_at          timestamptz not null default now()
);
create index order_items_order_idx   on public.order_items (order_id);
create index order_items_variant_idx on public.order_items (product_variant_id);

-- Items are immutable after insert.
create or replace function private.order_items_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'order_items are immutable' using errcode = '42501';
end;
$$;
create trigger order_items_no_update before update on public.order_items
  for each row execute function private.order_items_immutable();

-- RLS: staff/owner read only. No client write grants whatsoever.
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
revoke all on public.orders, public.order_items from anon, authenticated;
revoke all on sequence public.order_number_seq from anon, authenticated;
grant select on public.orders, public.order_items to authenticated;

create policy orders_staff_read on public.orders
  for select to authenticated using (public.is_staff());
create policy order_items_staff_read on public.order_items
  for select to authenticated using (public.is_staff());

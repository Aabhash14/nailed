-- 20261019000004_shop.sql
-- Shop: products, images, variants (size/colour) with stock counts.
-- Hard delete is allowed only while no order references a variant (order_items FK is RESTRICT);
-- otherwise the owner unpublishes (contract deleteProduct returns CONFLICT).

create table public.products (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name         text not null check (char_length(name) between 1 and 120),
  description  text check (description is null or char_length(description) <= 2000),
  price_paisa  integer not null check (price_paisa between 0 and 10000000),
  is_published boolean not null default false,
  -- { fabric, gsm, printMethod, credit, sizeChartCm } per contract Product.details
  details      jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger products_set_updated_at before update on public.products
  for each row execute function public.set_updated_at();

create table public.product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products (id) on delete cascade,
  path        text not null,                                    -- group path, e.g. products/<uuid>
  alt         text not null default '' check (char_length(alt) <= 200),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index product_images_product_idx on public.product_images (product_id, sort_order);

create table public.product_variants (
  id                   uuid primary key default gen_random_uuid(),
  product_id           uuid not null references public.products (id) on delete cascade,
  size                 text not null check (char_length(size) between 1 and 20),
  colour               text not null check (char_length(colour) between 1 and 40),
  sku                  text check (sku is null or char_length(sku) between 1 and 60),
  stock                integer not null default 0 check (stock >= 0),    -- never below 0, enforced here
  price_override_paisa integer check (price_override_paisa is null or price_override_paisa between 0 and 10000000),
  -- Public-safe derived state. Threshold 3 is fixed; change it with a migration.
  stock_state          text generated always as (
                         case when stock <= 0 then 'sold_out'
                              when stock <= 3 then 'few_left'
                              else 'in_stock' end) stored,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (product_id, size, colour)
);
create unique index product_variants_sku_key on public.product_variants (sku) where sku is not null;
create trigger product_variants_set_updated_at before update on public.product_variants
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS and grants.
-- Public never sees exact stock: anon gets COLUMN-level select on product_variants (no `stock`),
-- so supabase-js must list columns explicitly (select('*') is denied for anon by design).
-- ---------------------------------------------------------------------------
alter table public.products         enable row level security;
alter table public.product_images   enable row level security;
alter table public.product_variants enable row level security;

revoke all on public.products, public.product_images, public.product_variants from anon, authenticated;
grant select on public.products, public.product_images to anon;
grant select (id, product_id, size, colour, sku, price_override_paisa, stock_state) on public.product_variants to anon;
grant select, insert, update, delete on public.products, public.product_images, public.product_variants to authenticated;

create policy products_public_read on public.products
  for select to anon, authenticated using (is_published);
create policy products_staff_read on public.products
  for select to authenticated using (public.is_staff());
create policy products_owner_write on public.products
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

create policy product_images_public_read on public.product_images
  for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id));
create policy product_images_staff_read on public.product_images
  for select to authenticated using (public.is_staff());
create policy product_images_owner_write on public.product_images
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

create policy product_variants_public_read on public.product_variants
  for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id));
create policy product_variants_staff_read on public.product_variants
  for select to authenticated using (public.is_staff());
create policy product_variants_owner_write on public.product_variants
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

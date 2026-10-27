-- 20261019000003_menu.sql
-- Menu: categories, items (with sold-out flag), variants, specials.
-- Soft delete for items (deleted_at) per contract deleteMenuItem. Menu is view-only for customers.

create table public.menu_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null check (char_length(name) between 1 and 80),
  sort_order  integer not null default 0,
  is_visible  boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger menu_categories_set_updated_at before update on public.menu_categories
  for each row execute function public.set_updated_at();

create table public.menu_items (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references public.menu_categories (id) on delete restrict,
  name         text not null check (char_length(name) between 1 and 80),
  description  text check (description is null or char_length(description) <= 240),
  price_paisa  integer not null check (price_paisa between 0 and 1000000),          -- max Rs. 10,000 per contract
  diet         text not null default 'veg' check (diet in ('veg', 'non_veg', 'egg')),
  tags         text[] not null default '{}' check (tags <@ array['spicy', 'new', 'bestseller', 'chef_pick']),
  is_sold_out  boolean not null default false,
  is_visible   boolean not null default true,
  image_path   text,                                                                 -- group path, e.g. menu/<uuid>
  sort_order   integer not null default 0,
  deleted_at   timestamptz,                                                          -- soft delete
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
  -- available_from / available_to are v1.1 (architecture section 3); add by migration when scheduled.
);
create index menu_items_category_sort_idx on public.menu_items (category_id, sort_order) where deleted_at is null;
create trigger menu_items_set_updated_at before update on public.menu_items
  for each row execute function public.set_updated_at();
-- Staff may only flip the sold-out flag (contract: toggleSoldOut is S; everything else is O).
create trigger menu_items_guard_staff before update on public.menu_items
  for each row execute function public.guard_staff_update('is_sold_out');

create table public.menu_variants (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid not null references public.menu_items (id) on delete cascade,
  kind               text not null check (kind in ('size', 'milk', 'addon', 'temperature')),
  label              text not null check (char_length(label) between 1 and 60),
  price_delta_paisa  integer not null default 0 check (price_delta_paisa between -1000000 and 1000000),
  is_sold_out        boolean not null default false,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index menu_variants_item_idx on public.menu_variants (item_id, sort_order);
create trigger menu_variants_set_updated_at before update on public.menu_variants
  for each row execute function public.set_updated_at();
create trigger menu_variants_guard_staff before update on public.menu_variants
  for each row execute function public.guard_staff_update('is_sold_out');

-- Max 12 variants per item (contract limit), enforced here, not only in the app.
create or replace function public.menu_variants_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.menu_variants v where v.item_id = new.item_id) >= 12 then
    raise exception 'a menu item can have at most 12 variants' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger menu_variants_limit_trg before insert on public.menu_variants
  for each row execute function public.menu_variants_limit();

create table public.menu_specials (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid references public.menu_items (id) on delete set null,   -- null = free-text special
  title       text not null check (char_length(title) between 1 and 80),
  note        text check (note is null or char_length(note) <= 240),
  ends_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger menu_specials_set_updated_at before update on public.menu_specials
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: public reads only visible/available rows; staff read all; owner writes; staff only toggle sold-out.
-- ---------------------------------------------------------------------------
alter table public.menu_categories enable row level security;
alter table public.menu_items      enable row level security;
alter table public.menu_variants   enable row level security;
alter table public.menu_specials   enable row level security;

revoke all on public.menu_categories, public.menu_items, public.menu_variants, public.menu_specials from anon, authenticated;
grant select on public.menu_categories, public.menu_items, public.menu_variants, public.menu_specials to anon;
grant select, insert, update, delete on public.menu_categories, public.menu_items, public.menu_variants, public.menu_specials to authenticated;

-- categories
create policy menu_categories_public_read on public.menu_categories
  for select to anon, authenticated using (is_visible);
create policy menu_categories_staff_read on public.menu_categories
  for select to authenticated using (public.is_staff());
create policy menu_categories_owner_write on public.menu_categories
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- items (the exists() subqueries run under the caller's RLS, so a hidden category hides its items)
create policy menu_items_public_read on public.menu_items
  for select to anon, authenticated
  using (is_visible and deleted_at is null
         and exists (select 1 from public.menu_categories c where c.id = category_id));
create policy menu_items_staff_read on public.menu_items
  for select to authenticated using (public.is_staff());
create policy menu_items_staff_update on public.menu_items
  for update to authenticated using (public.is_staff()) with check (public.is_staff());   -- guard trigger limits columns
create policy menu_items_owner_write on public.menu_items
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- variants
create policy menu_variants_public_read on public.menu_variants
  for select to anon, authenticated
  using (exists (select 1 from public.menu_items i where i.id = item_id));
create policy menu_variants_staff_read on public.menu_variants
  for select to authenticated using (public.is_staff());
create policy menu_variants_staff_update on public.menu_variants
  for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy menu_variants_owner_write on public.menu_variants
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- specials
create policy menu_specials_public_read on public.menu_specials
  for select to anon, authenticated using (ends_at is null or ends_at > now());
create policy menu_specials_staff_read on public.menu_specials
  for select to authenticated using (public.is_staff());
create policy menu_specials_owner_write on public.menu_specials
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

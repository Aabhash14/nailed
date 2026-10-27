-- 20261023000002_product_variant_size_rank.sql
-- BUG-015 (db part): product sizes had no stable order. Reads without ORDER BY follow the physical row order, which
-- changes on every stock UPDATE, so the picker reshuffled after each order.
--
-- Fix: a generated column `size_rank` on product_variants, derived from the size label, so every read can
-- ORDER BY it. Generated (not owner-entered) on purpose: no backfill, no admin UI change, can never drift from
-- `size`, and new variants are ranked the moment they are saved. If the owner later needs a hand-picked order,
-- add a nullable override column in front of it; nothing here has to change.
--
-- Rank (case and surrounding spaces ignored; "2XL" = "XXL" etc.):
--   XXS 10, XS 20, S 30, M 40, L 50, XL 60, XXL/2XL 70, XXXL/3XL 80, 4XL 90, 5XL 100,
--   numeric sizes (e.g. 28, 30, 32 or kids' 2, 4, 6) 200 + the number (up to 3 digits),
--   "One size" / "Free size" / "OS" 1500, anything else 1000 (then tie-broken by the size text in the ORDER BY).
--
-- Backend must use (supabase-js), for product page, shop list and getAdminProducts:
--   .order("colour").order("size_rank").order("size").order("id")
-- i.e. ORDER BY colour, size_rank, size, id  -> "Black S, M, L, XL, Cream M, L".
-- If sizes should lead instead of colours: .order("size_rank").order("size").order("colour").order("id").
-- With nested selects use the referencedTable option, e.g. .order("size_rank", { referencedTable: "product_variants" }).
-- anon has a column-level SELECT grant on this table (no `stock`), so the new column is granted explicitly below;
-- ordering by a column anon cannot select would fail with 42501.

alter table public.product_variants
  add column size_rank smallint generated always as (
    case
      when upper(btrim(size)) = 'XXS'                              then 10
      when upper(btrim(size)) = 'XS'                               then 20
      when upper(btrim(size)) = 'S'                                then 30
      when upper(btrim(size)) = 'M'                                then 40
      when upper(btrim(size)) = 'L'                                then 50
      when upper(btrim(size)) = 'XL'                               then 60
      when upper(btrim(size)) in ('XXL', '2XL')                    then 70
      when upper(btrim(size)) in ('XXXL', '3XL')                   then 80
      when upper(btrim(size)) = '4XL'                              then 90
      when upper(btrim(size)) = '5XL'                              then 100
      when btrim(size) ~ '^[0-9]{1,3}$'                            then 200 + btrim(size)::smallint
      when upper(btrim(size)) in ('ONE SIZE', 'FREE SIZE', 'OS')   then 1500
      else 1000
    end
  ) stored;

comment on column public.product_variants.size_rank is
  'BUG-015: generated sort key from `size` (S 30 < M 40 < L 50 < XL 60 < XXL 70 ...). '
  'Read variants ORDER BY colour, size_rank, size, id.';

grant select (size_rank) on public.product_variants to anon;

-- Serves "variants of product X in display order".
create index product_variants_display_order_idx
  on public.product_variants (product_id, colour, size_rank, size, id);

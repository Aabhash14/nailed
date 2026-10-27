import type { Db } from "./types";
import { AppError } from "@/lib/errors";
import {
  categoryTranslationsFromRow,
  itemTranslationsFromRow,
  variantTranslationsFromRow,
} from "@/lib/menu-translations";
import type {
  MenuCategoryRow,
  MenuCategoryTranslations,
  MenuItemRow,
  MenuItemTranslations,
  MenuSpecialRow,
  MenuVariantRow,
  MenuVariantTranslations,
  PublicSettingsRow,
  TableOrderingMode,
} from "@/types/db";
import type { TableOccupancy } from "@/lib/tables/types";

/** Public menu read model = api-contract.md section 1 + GET /api/menu. */
export type ImageVariant = { widthPx: 480 | 960 | 1600; url: string };
/**
 * Secondary-language text (api-contract 1.4.0). Same shape as the database jsonb; English stays in name /
 * description / label. `{}` = English only. Never null.
 */
export type MenuItemTranslationsDto = MenuItemTranslations;
export type MenuCategoryTranslationsDto = MenuCategoryTranslations;
export type MenuVariantTranslationsDto = MenuVariantTranslations;
export type MenuVariantDto = {
  id: string;
  kind: MenuVariantRow["kind"];
  label: string;
  priceDelta: number;
  isSoldOut: boolean;
  translations: MenuVariantTranslationsDto;
};
export type MenuItemDto = {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  price: number;
  diet: MenuItemRow["diet"];
  tags: MenuItemRow["tags"];
  isSoldOut: boolean;
  imageUrl: string | null;
  imageVariants: ImageVariant[];
  variants: MenuVariantDto[];
  sortOrder: number;
  translations: MenuItemTranslationsDto;
};
export type MenuCategoryDto = {
  id: string;
  slug: string;
  name: string;
  sortOrder: number;
  translations: MenuCategoryTranslationsDto;
  items: MenuItemDto[];
};
export type MenuSpecialDto = { id: string; title: string; note: string | null; endsAt: string | null; itemId: string | null };
export type MenuPayload = {
  categories: MenuCategoryDto[];
  specials: MenuSpecialDto[];
  settings: {
    hours: PublicSettingsRow["hours"];
    announcement: string | null;
    pricesIncludeVat: boolean;
    serviceChargePct: number;
    vatPct: 13;
    /** 2.0.0: the live table-ordering mode (public). The frontend trusts the polled value over the ISR copy. */
    tableOrdering: TableOrderingMode;
  };
  updatedAt: string;
  degraded?: boolean;
  /**
   * 2.0.0 (ADR 0002 option 4C): table occupancy. Added ONLY by GET /api/menu (src/lib/menu-route.ts), read fresh on every
   * answer with the service client. getPublicMenu never sets it, so it is never in the ISR page, the remembered copy
   * or the break-glass snapshot. null when the mode is "off", the answer is degraded, or the read failed.
   */
  tables?: TableOccupancy | null;
};

export const IMAGE_WIDTHS = [480, 960, 1600] as const;

/**
 * Explicit column lists for the public (anon) menu reads: exactly what the DTO needs, nothing else, so a future
 * private column never rides along. `translations` added in api-contract 1.4.0 (anon has a column grant on it).
 * Filters (is_visible, deleted_at) do not need their columns selected.
 */
export const PUBLIC_MENU_COLUMNS = {
  categories: "id, slug, name, sort_order, translations",
  items:
    "id, category_id, name, description, price_paisa, diet, tags, is_sold_out, image_path, sort_order, translations",
  variants: "id, item_id, kind, label, price_delta_paisa, is_sold_out, sort_order, translations",
  specials: "id, title, note, ends_at, item_id",
  settings: "hours, announcement, prices_include_vat, service_charge_pct, vat_pct, table_ordering",
} as const;

type PublicItemRow = Pick<
  MenuItemRow,
  | "id"
  | "category_id"
  | "name"
  | "description"
  | "price_paisa"
  | "diet"
  | "tags"
  | "is_sold_out"
  | "image_path"
  | "sort_order"
  | "translations"
>;
type PublicVariantRow = Pick<
  MenuVariantRow,
  "id" | "item_id" | "kind" | "label" | "price_delta_paisa" | "is_sold_out" | "sort_order" | "translations"
>;
type PublicCategoryRow = Pick<MenuCategoryRow, "id" | "slug" | "name" | "sort_order" | "translations">;
type PublicSpecialRow = Pick<MenuSpecialRow, "id" | "title" | "note" | "ends_at" | "item_id">;
const BUCKET = "public-media";

/** Public Storage URLs for the three WebP variants of a group path like "menu/<groupId>". */
export function imageVariantsFor(path: string | null, supabaseUrl: string): ImageVariant[] {
  if (!path) return [];
  const base = supabaseUrl.replace(/\/$/, "");
  return IMAGE_WIDTHS.map((w) => ({
    widthPx: w,
    url: `${base}/storage/v1/object/public/${BUCKET}/${path}/${w}.webp`,
  }));
}

export function mapMenuItem(row: PublicItemRow, variants: PublicVariantRow[], supabaseUrl: string): MenuItemDto {
  const imageVariants = imageVariantsFor(row.image_path, supabaseUrl);
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    price: row.price_paisa,
    diet: row.diet,
    tags: row.tags ?? [],
    isSoldOut: row.is_sold_out,
    imageUrl: imageVariants.find((v) => v.widthPx === 960)?.url ?? null,
    imageVariants,
    variants: variants
      .filter((v) => v.item_id === row.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((v) => ({
        id: v.id,
        kind: v.kind,
        label: v.label,
        priceDelta: v.price_delta_paisa,
        isSoldOut: v.is_sold_out,
        translations: variantTranslationsFromRow(v.translations),
      })),
    sortOrder: row.sort_order,
    translations: itemTranslationsFromRow(row.translations),
  };
}

export function mapMenuCategory(row: PublicCategoryRow): Omit<MenuCategoryDto, "items"> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    sortOrder: row.sort_order,
    translations: categoryTranslationsFromRow(row.translations),
  };
}

/**
 * Read the live public menu with the ANON client (RLS: visible rows only). Throws AppError INTERNAL on any
 * database failure; the caller decides about the degraded copy.
 */
export async function getPublicMenu(db: Db, supabaseUrl: string, now: Date = new Date()): Promise<MenuPayload> {
  const [cats, items, variants, specials, settings] = await Promise.all([
    db.from("menu_categories").select(PUBLIC_MENU_COLUMNS.categories).eq("is_visible", true).order("sort_order"),
    db
      .from("menu_items")
      .select(PUBLIC_MENU_COLUMNS.items)
      .eq("is_visible", true)
      .is("deleted_at", null)
      .order("sort_order"),
    db.from("menu_variants").select(PUBLIC_MENU_COLUMNS.variants).order("sort_order"),
    db
      .from("menu_specials")
      .select(PUBLIC_MENU_COLUMNS.specials)
      .or(`ends_at.is.null,ends_at.gt.${now.toISOString()}`)
      .order("created_at"),
    db.from("public_settings").select(PUBLIC_MENU_COLUMNS.settings).limit(1).maybeSingle(),
  ]);
  for (const r of [cats, items, variants, specials, settings]) {
    if (r.error) throw new AppError("INTERNAL", undefined, { logDetail: `menu read: ${r.error.code}` });
  }
  const s = settings.data as Pick<
    PublicSettingsRow,
    "hours" | "announcement" | "prices_include_vat" | "service_charge_pct" | "vat_pct" | "table_ordering"
  > | null;
  if (!s) throw new AppError("INTERNAL", undefined, { logDetail: "public_settings row missing" });

  const itemRows = (items.data ?? []) as unknown as PublicItemRow[];
  const variantRows = (variants.data ?? []) as unknown as PublicVariantRow[];
  const categories: MenuCategoryDto[] = ((cats.data ?? []) as unknown as PublicCategoryRow[]).map((c) => ({
    ...mapMenuCategory(c),
    items: itemRows
      .filter((i) => i.category_id === c.id)
      .map((i) => mapMenuItem(i, variantRows, supabaseUrl)),
  }));

  return {
    categories,
    specials: ((specials.data ?? []) as unknown as PublicSpecialRow[]).map((sp) => ({
      id: sp.id,
      title: sp.title,
      note: sp.note,
      endsAt: sp.ends_at,
      itemId: sp.item_id,
    })),
    settings: {
      hours: s.hours,
      announcement: s.announcement,
      pricesIncludeVat: s.prices_include_vat,
      serviceChargePct: Number(s.service_charge_pct),
      vatPct: 13,
      // Unknown or absent (view not migrated yet) = "off", the safe default.
      tableOrdering: s.table_ordering === "on" || s.table_ordering === "paused" ? s.table_ordering : "off",
    },
    updatedAt: now.toISOString(),
  };
}

/**
 * Last good payload kept per Worker isolate (module memory). Not shared across isolates and lost on restart:
 * it only softens a short database outage. If it is empty, /api/menu returns INTERNAL and the page falls
 * back to the static break-glass menu (src/data/menu-fallback.json).
 */
let lastGood: MenuPayload | null = null;
export function rememberMenu(p: MenuPayload) {
  // Never remember occupancy (threat model B6): the degraded copy answers `tables: null`.
  const { tables: _tables, ...rest } = p;
  void _tables;
  lastGood = rest;
}
export function cachedMenu(): MenuPayload | null {
  return lastGood;
}
export function clearMenuCache() {
  lastGood = null;
}

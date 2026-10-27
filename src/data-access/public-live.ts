import "server-only";
import { READ_TAGS } from "@/lib/cache-tags";
import { createPublicClient } from "@/lib/data/public-client";
import { getPublicMenu, imageVariantsFor } from "@/lib/data/menu";
import type { MenuSnapshot, Product, PublicSettings, StockState } from "@/types/contract";

/**
 * LIVE public reads for Server Components: anon-key Supabase client (RLS limits it to visible / published rows),
 * reusing backend's getPublicMenu and imageVariantsFor. Shop and settings queries are written here because
 * src/lib/data has no reader for them (the contract says pages read via lib/data; see report, request to backend).
 */
const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

/**
 * Contract 1.4.0: categories, items and variants carry `translations`. backend's getPublicMenu selects the columns
 * explicitly (PUBLIC_MENU_COLUMNS) and copies translations through an allow-list, so this seam passes them on as-is;
 * the menu's i18n helpers still treat any missing / non-string value as "English only".
 */
export async function liveMenuSnapshot(): Promise<MenuSnapshot> {
  // cache tags (backend-engineer, 2026-10-21): lets revalidateTag("menu" / "settings") reach the ISR pages
  const payload = await getPublicMenu(createPublicClient({ tags: READ_TAGS.menu }), supabaseUrl());
  return payload as unknown as MenuSnapshot;
}

export async function liveSettings(): Promise<PublicSettings> {
  const db = createPublicClient({ tags: READ_TAGS.settings });
  const { data, error } = await db.from("public_settings").select("*").limit(1).maybeSingle();
  if (error || !data) throw new Error("public_settings unavailable");
  const r = data as Record<string, unknown>;
  const weekly = (r.hours as { weekly: Record<string, never>; closures: never[] }) ?? {
    weekly: {},
    closures: [],
  };
  return {
    cafeName: r.cafe_name as string,
    hours: {
      weekly: {
        0: weekly.weekly["0"] ?? null,
        1: weekly.weekly["1"] ?? null,
        2: weekly.weekly["2"] ?? null,
        3: weekly.weekly["3"] ?? null,
        4: weekly.weekly["4"] ?? null,
        5: weekly.weekly["5"] ?? null,
        6: weekly.weekly["6"] ?? null,
      },
      closures: weekly.closures ?? [],
    },
    announcement: (r.announcement as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    whatsapp: (r.whatsapp as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    landmark: (r.landmark as string | null) ?? null,
    mapUrl: (r.map_url as string | null) ?? null,
    pricesIncludeVat: r.prices_include_vat as boolean,
    serviceChargePct: Number(r.service_charge_pct),
    vatPct: 13,
    deliveryFee: r.delivery_fee_paisa as number,
    deliveryAreas: (r.delivery_areas as string[]) ?? [],
    minOrderDelivery: r.min_order_delivery_paisa as number,
    minOrderPickup: r.min_order_pickup_paisa as number,
    paymentMethods: r.payment_methods_enabled as PublicSettings["paymentMethods"],
    features: (r.features as { lodge: boolean }) ?? { lodge: false },
    // Owner kill switch (SEC-003). Column added by database-engineer to the public view; absent = not paused.
    ordersPaused: r.orders_paused === true,
    // 2.0.0: public_settings.table_ordering (data-model decision 22). Unknown or absent (view not migrated yet) = "off".
    tableOrdering:
      r.table_ordering === "on" || r.table_ordering === "paused" ? r.table_ordering : "off",
  };
}

export async function liveProducts(): Promise<Product[]> {
  const db = createPublicClient({ tags: READ_TAGS.shop });
  const [p, im, v] = await Promise.all([
    db.from("products").select("*").eq("is_published", true).order("created_at"),
    db.from("product_images").select("*").order("sort_order"),
    // BUG-015: a stable order (the database returns rows in any order). size_rank is a generated column (S < M < L ...).
    db
      .from("product_variants")
      .select("id, product_id, size, colour, size_rank, price_override_paisa, stock_state")
      .order("colour")
      .order("size_rank")
      .order("size")
      .order("id"),
  ]);
  if (p.error || im.error || v.error) throw new Error("shop read failed");
  type PRow = {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    price_paisa: number;
    details: Product["details"];
  };
  type IRow = { product_id: string; path: string; alt: string };
  type VRow = {
    id: string;
    product_id: string;
    size: string;
    colour: string;
    price_override_paisa: number | null;
    stock_state: StockState;
  };
  const images = (im.data ?? []) as IRow[];
  const variants = (v.data ?? []) as VRow[];
  return ((p.data ?? []) as PRow[]).map((pr) => ({
    id: pr.id,
    slug: pr.slug,
    name: pr.name,
    description: pr.description,
    price: pr.price_paisa,
    details: pr.details ?? {},
    images: images
      .filter((i) => i.product_id === pr.id)
      .map((i) => {
        const vs = imageVariantsFor(i.path, supabaseUrl());
        return { url: vs.find((x) => x.widthPx === 960)?.url ?? "", alt: i.alt, variants: vs };
      }),
    variants: variants
      .filter((x) => x.product_id === pr.id)
      .map((x) => ({
        id: x.id,
        size: x.size,
        colour: x.colour,
        stockState: x.stock_state,
        price: x.price_override_paisa ?? pr.price_paisa,
      })),
  }));
}

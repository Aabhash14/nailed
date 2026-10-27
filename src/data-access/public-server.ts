import { cache } from "react";
import { unstable_cache } from "next/cache";
import { CACHE_TAG } from "@/lib/cache-tags";
import { toMenuSnapshot, toPublicProducts } from "@/mocks/engine";
import { seedDb } from "@/mocks/seed";
import type { MenuSnapshot, Product, PublicSettings } from "@/types/contract";
import { isMock } from "./mode";
import { liveMenuSnapshot, liveProducts, liveSettings } from "./public-live";

/**
 * SERVER-SIDE reads for public pages (Server Components, ISR). Same shapes as the contract.
 *
 * Mock mode (NEXT_PUBLIC_DATA_MODE=mock only) returns typed sample data. Live mode (the default) reads Supabase with the
 * anon key through ./public-live. Failures throw; pages catch them and show their error / break-glass state.
 */

export async function getMenuSnapshot(): Promise<MenuSnapshot> {
  if (isMock) return toMenuSnapshot(seedDb());
  return liveMenuSnapshot();
}

export async function getPublicSettings(): Promise<PublicSettings> {
  if (isMock) return seedDb().settings;
  return liveSettings();
}

export async function listProducts(): Promise<Product[]> {
  if (isMock) return toPublicProducts(seedDb());
  return liveProducts();
}

/** Same shape rule as the server's product slug (upsertProductSchema: lowercase words joined by "-", max 80). */
const PRODUCT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function isWellFormedProductSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 80 && PRODUCT_SLUG.test(slug);
}

/**
 * SEC-021: the product page is rendered per request (no ISR entry per slug), so it must not cost database reads per
 * request either. The published product list is cached once in the Next data cache, tagged "shop" (the admin
 * product/stock actions already call revalidateTag("shop")), with the same 1-hour safety net as the ISR pages.
 * One cache entry for the whole list, not one per slug, so random slugs cause no cache writes.
 */
const cachedLiveProducts = unstable_cache(() => liveProducts(), ["shop-published-products-v1"], {
  tags: [CACHE_TAG.shop],
  revalidate: 3600,
});

/**
 * One product page read. A badly shaped slug is refused before any data read (SEC-021); otherwise the cached list is
 * searched. React `cache` shares the result between generateMetadata and the page within one request.
 */
export const getProductBySlug = cache(async (slug: string): Promise<Product | null> => {
  if (!isWellFormedProductSlug(slug)) return null;
  const all = isMock ? toPublicProducts(seedDb()) : await cachedLiveProducts();
  return all.find((p) => p.slug === slug) ?? null;
});

/** For pages that can still render without settings (home, story, visit): null on failure. */
export async function getPublicSettingsSafe(): Promise<PublicSettings | null> {
  try {
    return await getPublicSettings();
  } catch {
    return null;
  }
}

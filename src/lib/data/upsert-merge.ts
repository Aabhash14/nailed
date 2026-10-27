import type { ProductRow } from "@/types/db";

/**
 * Pure helpers for the upsert actions (api-contract 1.3.1, "omitted means unchanged"). Kept out of the
 * "use server" action files so they can be unit-tested directly.
 */

export type ProductDetails = ProductRow["details"];

/** The details patch as validated by upsertProductSchema: each key omitted (keep), null (remove) or a value. */
export type ProductDetailsPatch = { [K in keyof ProductDetails]?: ProductDetails[K] | null };

const DETAIL_KEYS = ["fabric", "gsm", "printMethod", "credit", "sizeChartCm"] as const;

/**
 * Merge a details patch into the stored details. Omitted keys are kept, `null` removes a key, a value replaces
 * it. `sizeChartCm` is one value (replaced whole, not merged per size). Unknown keys already stored (for example
 * written by an older version) are kept as they are. `patch` undefined = stored details unchanged.
 */
export function mergeProductDetails(
  stored: Record<string, unknown> | null | undefined,
  patch: ProductDetailsPatch | undefined,
): ProductDetails {
  const base: Record<string, unknown> =
    stored && typeof stored === "object" && !Array.isArray(stored) ? { ...stored } : {};
  if (!patch) return base as ProductDetails;
  for (const key of DETAIL_KEYS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === undefined) continue; // present but undefined (e.g. serialised "$undefined") = omitted
    if (v === null) delete base[key];
    else base[key] = v;
  }
  return base as ProductDetails;
}

/**
 * Which stored image groups an explicit image set removes. Only these may have their files deleted.
 * `next` undefined (images omitted) removes nothing.
 */
export function removedImagePaths(storedPaths: readonly string[], next: readonly { path: string }[] | undefined): string[] {
  if (next === undefined) return [];
  const kept = new Set(next.map((im) => im.path));
  return [...new Set(storedPaths.filter((p) => !kept.has(p)))];
}

/**
 * The menu item image after an upsert. `requested` undefined (omitted) keeps the stored path; null removes it;
 * a path replaces it. `remove` is the stored group whose files may be deleted (only when explicitly replaced
 * or removed).
 */
export function resolveMenuImage(
  storedPath: string | null,
  requested: string | null | undefined,
): { path: string | null; remove: string | null; isNew: boolean } {
  if (requested === undefined) return { path: storedPath, remove: null, isNew: false };
  const remove = storedPath && storedPath !== requested ? storedPath : null;
  return { path: requested, remove, isNew: requested !== null && requested !== storedPath };
}

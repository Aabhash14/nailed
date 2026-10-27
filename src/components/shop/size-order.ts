/** Pure ordering helpers for sizes and size-chart columns (no React, unit-tested). */

/**
 * Same ranks as the database's generated `product_variants.size_rank` (migration 20261023000002, BUG-015), so the
 * size chart, the size picker and the server all agree: XXS < XS < S < M < L < XL < XXL/2XL < XXXL/3XL < 4XL < 5XL
 * < numeric sizes (200 + n) < anything else (1000) < One size / Free size (1500).
 */
export function sizeRank(size: string): number {
  const s = size.trim().toUpperCase();
  const named: Record<string, number> = {
    XXS: 10,
    XS: 20,
    S: 30,
    M: 40,
    L: 50,
    XL: 60,
    XXL: 70,
    "2XL": 70,
    XXXL: 80,
    "3XL": 80,
    "4XL": 90,
    "5XL": 100,
    "ONE SIZE": 1500,
    "FREE SIZE": 1500,
    OS: 1500,
  };
  if (named[s] !== undefined) return named[s];
  if (/^[0-9]{1,3}$/.test(s)) return 200 + Number(s);
  return 1000;
}

/**
 * BUG-015 (frontend part): the size chart comes back from jsonb with its keys reordered (L, M, S, XL). Order the rows
 * by size rank, then by the order the sizes appear in the product's variants, then alphabetically.
 */
export function orderSizes(sizes: string[], variantSizes: string[] = []): string[] {
  const seen = (s: string) => {
    const i = variantSizes.indexOf(s);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  return [...sizes].sort((a, b) => sizeRank(a) - sizeRank(b) || seen(a) - seen(b) || a.localeCompare(b));
}

/** Size-chart columns in a fixed reading order (jsonb reorders keys too); unknown columns keep their order after these. */
const COLUMN_RANK = ["chest", "length", "sleeve"];
export function orderChartColumns(keys: string[]): string[] {
  const rank = (k: string) => {
    const i = COLUMN_RANK.indexOf(k.trim().toLowerCase());
    return i === -1 ? COLUMN_RANK.length : i;
  };
  return keys
    .map((k, i) => ({ k, i }))
    .sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i)
    .map((x) => x.k);
}

/**
 * Variants in the server's order rule (colour, size rank, size), so the picker never reshuffles even if a read
 * comes back unordered (BUG-015). Ties keep their incoming order (Array.prototype.sort is stable).
 */
export function orderVariants<T extends { size: string; colour: string }>(variants: T[]): T[] {
  return [...variants].sort(
    (a, b) => a.colour.localeCompare(b.colour) || sizeRank(a.size) - sizeRank(b.size) || a.size.localeCompare(b.size),
  );
}

import type { AdminProduct, ProductDetails, ProductDetailsPatch, UpsertProductInput } from "@/types/contract";

/**
 * Pure helpers for the product editor (no React), unit-tested in tests/unit/product-form-logic.test.ts.
 *
 * Why this exists: an explicit `images` array is the FULL image set (contract section 4). The editor used to send
 * only newly uploaded photos and only the three details it shows, so saving a product deleted its photos (and their
 * files) and dropped `gsm` / `sizeChartCm` (contract section 8, gap 3).
 * Contract 1.3.1 rules the editor follows: `images` omitted = unchanged, so it is sent (kept + new, in order) only when
 * the photos changed; `details` is merged, a cleared field is sent as null.
 */

export const MAX_PRODUCT_PHOTOS = 10; // contract: images max 10
export const MAX_ALT_LENGTH = 200; // contract: alt max 200

/** The details the form edits. Everything else in `details` is carried over untouched. */
export type EditedDetails = { fabric: string; printMethod: string; credit: string };

/**
 * The `details` to send: the stored details first, then the edited fields on top. A filled field is sent trimmed; a
 * field the user CLEARED is sent as null (1.3.1: null removes the key); an empty field that was never stored is left
 * out. Fields the form does not show (gsm, sizeChartCm, anything added later) are resent unchanged, so they survive
 * on a merging server (1.3.1) and on a replacing one (1.3.0) alike.
 */
export function detailsPatch(base: ProductDetails | null | undefined, edits: EditedDetails): ProductDetailsPatch {
  const out: ProductDetailsPatch = { ...(base ?? {}) };
  for (const key of ["fabric", "printMethod", "credit"] as const) {
    const v = edits[key].trim();
    if (v) out[key] = v;
    else if (base?.[key] !== undefined) out[key] = null;
    else delete out[key];
  }
  return out;
}

/** What the server stores after merging a details patch (1.3.1): null removes a key, a value replaces it. */
export function applyDetailsPatch(stored: ProductDetails | null | undefined, patch: ProductDetailsPatch | undefined): ProductDetails {
  const out: Record<string, unknown> = { ...(stored ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out as ProductDetails;
}

/** Short, human description of the stored details the form keeps but does not edit (null when there are none). */
export function keptDetailsSummary(d: ProductDetails | null | undefined): string | null {
  if (!d) return null;
  const parts: string[] = [];
  if (typeof d.gsm === "number") parts.push(`fabric weight ${d.gsm} GSM`);
  const sizes = d.sizeChartCm ? Object.keys(d.sizeChartCm) : [];
  if (sizes.length > 0) parts.push(`size chart (${sizes.join(", ")})`);
  return parts.length > 0 ? parts.join(" and ") : null;
}

/**
 * One photo row in the editor. `previewUrl` is the stored 960 URL, a local blob preview for a new upload, or null.
 * `removed` (design review T-048 fix 3): Remove is STAGED. The row stays in its place with an Undo until Save; removed
 * rows are not sent, not validated, not moved and do not count towards the 10-photo limit.
 */
export type PhotoRow = { path: string; alt: string; previewUrl: string | null; isNew: boolean; removed: boolean };

/** Every stored photo, in its stored order, each with its OWN alt text. */
export function photosFromProduct(p: Pick<AdminProduct, "images"> | null | undefined): PhotoRow[] {
  return (p?.images ?? []).map((im) => ({ path: im.path, alt: im.alt, previewUrl: im.url || null, isNew: false, removed: false }));
}

/** Photos that will be saved (not staged for removal). */
export function keptCount(rows: PhotoRow[]): number {
  return rows.filter((r) => !r.removed).length;
}

export function addPhoto(rows: PhotoRow[], path: string, previewUrl: string | null): PhotoRow[] {
  if (rows.some((r) => r.path === path) || keptCount(rows) >= MAX_PRODUCT_PHOTOS) return rows;
  return [...rows, { path, alt: "", previewUrl, isNew: true, removed: false }];
}

/** Stage a removal: the row stays where it is until Save (Undo = restorePhoto). */
export function removePhoto(rows: PhotoRow[], index: number): PhotoRow[] {
  return rows.map((r, i) => (i === index ? { ...r, removed: true } : r));
}

/** Undo a staged removal. Refused (list unchanged) when the kept photos are already at the limit. */
export function restorePhoto(rows: PhotoRow[], index: number): PhotoRow[] {
  if (!rows[index]?.removed || keptCount(rows) >= MAX_PRODUCT_PHOTOS) return rows;
  return rows.map((r, i) => (i === index ? { ...r, removed: false } : r));
}

/** The index of the nearest kept row from `index` in direction `dir`, or -1. */
function nearestKept(rows: PhotoRow[], index: number, dir: -1 | 1): number {
  for (let j = index + dir; j >= 0 && j < rows.length; j += dir) if (!rows[j]!.removed) return j;
  return -1;
}

/**
 * Move a photo one place up (-1) or down (+1) among the KEPT photos: staged removals are skipped over and stay where
 * they are. Out-of-range moves, and moves of a removed row, return the list unchanged.
 */
export function movePhoto(rows: PhotoRow[], index: number, dir: -1 | 1): PhotoRow[] {
  if (index < 0 || index >= rows.length || rows[index]!.removed) return rows;
  const to = nearestKept(rows, index, dir);
  if (to < 0) return rows;
  const next = [...rows];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** True when the kept photo at `index` can move in that direction (drives the disabled state of the buttons). */
export function canMovePhoto(rows: PhotoRow[], index: number, dir: -1 | 1): boolean {
  return !!rows[index] && !rows[index].removed && nearestKept(rows, index, dir) >= 0;
}

/** 1-based position of a kept photo in the shop order (removed rows are not counted), or 0 for a removed row. */
export function photoNumber(rows: PhotoRow[], index: number): number {
  if (!rows[index] || rows[index].removed) return 0;
  return rows.slice(0, index + 1).filter((r) => !r.removed).length;
}

export function setPhotoAlt(rows: PhotoRow[], index: number, alt: string): PhotoRow[] {
  return rows.map((r, i) => (i === index ? { ...r, alt } : r));
}

/**
 * Field errors keyed `photo<index>` (index in the full list, removed rows included). Removed rows are not checked.
 * ASSUMPTION (for ux-ui-designer): every photo needs a description, including stored ones; the old form already
 * required it for every upload, so stored photos should have one.
 */
export function photoErrors(rows: PhotoRow[]): Record<string, string> {
  const errs: Record<string, string> = {};
  rows.forEach((r, i) => {
    if (r.removed) return;
    const alt = r.alt.trim();
    if (!alt) errs[`photo${i}`] = "Describe the photo for people who cannot see it";
    else if (alt.length > MAX_ALT_LENGTH) errs[`photo${i}`] = `Up to ${MAX_ALT_LENGTH} characters`;
  });
  return errs;
}

/** The full set for upsertProduct, in display order (first = main photo). Staged removals are left out. */
export function photosToInput(rows: PhotoRow[]): NonNullable<UpsertProductInput["images"]> {
  return rows.filter((r) => !r.removed).map((r) => ({ path: r.path, alt: r.alt.trim() }));
}

/** True when the set, the order or any alt text differs from what is stored (staged removals count as a change). */
export function photosChanged(storedRows: PhotoRow[], rows: PhotoRow[]): boolean {
  const a = photosToInput(storedRows);
  const b = photosToInput(rows);
  return a.length !== b.length || a.some((x, i) => x.path !== b[i]!.path || x.alt !== b[i]!.alt);
}

/** One "Sizes and stock" row as the form holds it (strings, as typed). */
export type VariantFormRow = { id?: string; size: string; colour: string; stock: string; sku: string; override: string };

/** The list-editable parts of a product: what Publish/Unpublish and the stock table in the list can change. */
export type ListFields = Pick<AdminProduct, "isPublished" | "variants">;

/**
 * BUG-007: `upsertProduct` always sends `isPublished` and every size's `stock` (both required by the contract), so a
 * form opened before a Publish or stock change in the list used to write the old values back.
 *
 * Three-way merge for those values: `base` is the product as the form last synced it, `latest` the stored product
 * now. A value the form still shows unchanged from `base` takes the newer stored value; a value the person changed in
 * the form wins (they chose it on purpose). Rows the list cannot touch (size, colour, own price) are left alone.
 * Returns the merged values and which kinds changed (for a short note in the form).
 */
export function rebaseListFields(
  base: ListFields,
  latest: ListFields,
  form: { published: boolean; rows: VariantFormRow[] },
): { published: boolean; rows: VariantFormRow[]; changed: ("published" | "stock")[] } {
  const changed: ("published" | "stock")[] = [];
  let published = form.published;
  if (form.published === base.isPublished && latest.isPublished !== base.isPublished) {
    published = latest.isPublished;
    changed.push("published");
  }
  let stockChanged = false;
  const rows = form.rows.map((r) => {
    if (!r.id) return r;
    const b = base.variants.find((v) => v.id === r.id);
    const l = latest.variants.find((v) => v.id === r.id);
    if (!b || !l || l.stock === b.stock || r.stock.trim() !== String(b.stock)) return r;
    stockChanged = true;
    return { ...r, stock: String(l.stock) };
  });
  if (stockChanged) changed.push("stock");
  return { published, rows: stockChanged ? rows : form.rows, changed };
}

/**
 * The `images` part of the upsertProduct input: left out when nothing changed (1.3.1: omitted = untouched, so a save
 * that does not touch photos can never delete any), otherwise the FULL set (kept + new, in order).
 */
export function imagesField(storedRows: PhotoRow[], rows: PhotoRow[]): Pick<UpsertProductInput, "images"> {
  return photosChanged(storedRows, rows) ? { images: photosToInput(rows) } : {};
}

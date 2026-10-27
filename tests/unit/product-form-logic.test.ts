import { describe, expect, it } from "vitest";
import {
  MAX_PRODUCT_PHOTOS,
  addPhoto,
  applyDetailsPatch,
  canMovePhoto,
  detailsPatch,
  imagesField,
  keptCount,
  keptDetailsSummary,
  movePhoto,
  photoErrors,
  photoNumber,
  photosFromProduct,
  photosToInput,
  rebaseListFields,
  removePhoto,
  restorePhoto,
  setPhotoAlt,
  type VariantFormRow,
} from "@/components/admin/product-form-logic";
import { toPublicProducts } from "@/mocks/engine";
import { seedDb, uid } from "@/mocks/seed";

/** Contract section 8, gap 3 (+ 1.3.1 rules): the product editor must never lose stored photos or unedited details. */

const draft = () => seedDb().products.find((p) => p.id === uid(3, 5))!;

describe("product editor: photos", () => {
  it("starts from every stored photo, in order, each with its own alt text", () => {
    const rows = photosFromProduct(draft());
    expect(rows.map((r) => r.path)).toEqual(draft().images.map((i) => i.path));
    expect(rows.map((r) => r.alt)).toEqual(["Sample photo one: front of the draft tee", "Sample photo two: back of the draft tee"]);
    expect(rows.every((r) => !r.isNew && r.previewUrl)).toBe(true);
  });

  it("the stored photos round-trip to the same full set (the bug sent [])", () => {
    expect(photosToInput(photosFromProduct(draft()))).toEqual(draft().images.map((i) => ({ path: i.path, alt: i.alt })));
  });

  it("a new product starts with no photos", () => {
    expect(photosFromProduct(null)).toEqual([]);
  });

  it("existing plus new photos are sent together; the new one needs its own alt text", () => {
    let rows = addPhoto(photosFromProduct(draft()), `products/${uid(99, 13)}`, null);
    expect(rows).toHaveLength(3);
    expect(photoErrors(rows)).toEqual({ photo2: "Describe the photo for people who cannot see it" });
    rows = setPhotoAlt(rows, 2, "  Sample new photo  ");
    expect(photoErrors(rows)).toEqual({});
    expect(photosToInput(rows).map((i) => i.alt)).toEqual([
      "Sample photo one: front of the draft tee",
      "Sample photo two: back of the draft tee",
      "Sample new photo",
    ]);
  });

  it("adding the same path twice, or past the limit, changes nothing", () => {
    const one = addPhoto([], "products/a", null);
    expect(addPhoto(one, "products/a", null)).toBe(one);
    let full: ReturnType<typeof addPhoto> = [];
    for (let i = 0; i < MAX_PRODUCT_PHOTOS; i++) full = addPhoto(full, `products/${i}`, null);
    expect(addPhoto(full, "products/extra", null)).toBe(full);
  });

  it("remove is staged: the row stays in place, is not sent and not checked; Undo brings it back", () => {
    const rows = photosFromProduct(draft());
    const removed = removePhoto(setPhotoAlt(rows, 0, ""), 0);
    expect(removed.map((r) => r.path)).toEqual(rows.map((r) => r.path)); // still listed, same order
    expect(removed[0]!.removed).toBe(true);
    expect(photosToInput(removed).map((i) => i.path)).toEqual([rows[1]!.path]);
    expect(photoErrors(removed)).toEqual({}); // its empty alt text no longer blocks Save
    expect(keptCount(removed)).toBe(1);
    expect(photoNumber(removed, 0)).toBe(0);
    expect(photoNumber(removed, 1)).toBe(1); // the second photo is now the main one
    expect(restorePhoto(removed, 0)[0]!.removed).toBe(false);
    expect(restorePhoto(rows, 0)).toBe(rows); // nothing to undo
  });

  it("move reorders kept photos, skips staged removals and ignores out-of-range moves", () => {
    const rows = photosFromProduct(draft());
    expect(movePhoto(rows, 1, -1).map((r) => r.path)).toEqual([rows[1]!.path, rows[0]!.path]);
    expect(movePhoto(rows, 0, -1)).toBe(rows);
    expect(movePhoto(rows, 1, 1)).toBe(rows);
    const three = removePhoto(addPhoto(rows, "products/new", null), 1); // [a, (b removed), new]
    expect(movePhoto(three, 2, -1).map((r) => r.path)).toEqual(["products/new", rows[1]!.path, rows[0]!.path]);
    expect(movePhoto(three, 1, -1)).toBe(three); // a removed row does not move
    expect(canMovePhoto(three, 0, -1)).toBe(false);
    expect(canMovePhoto(three, 0, 1)).toBe(true); // jumps over the removed row
    expect(canMovePhoto(three, 1, 1)).toBe(false);
  });

  it("staged removals do not count towards the 10-photo limit; Undo is refused while the list is full", () => {
    let rows: ReturnType<typeof addPhoto> = [];
    for (let i = 0; i < MAX_PRODUCT_PHOTOS; i++) rows = addPhoto(rows, `products/${i}`, null);
    rows = removePhoto(rows, 3);
    rows = addPhoto(rows, "products/extra", null); // allowed: 9 kept + 1
    expect(keptCount(rows)).toBe(MAX_PRODUCT_PHOTOS);
    expect(rows).toHaveLength(MAX_PRODUCT_PHOTOS + 1);
    expect(restorePhoto(rows, 3)).toBe(rows);
  });

  it("alt text over 200 characters is refused before it reaches the server", () => {
    expect(photoErrors(setPhotoAlt(photosFromProduct(draft()), 0, "x".repeat(201)))).toEqual({ photo0: "Up to 200 characters" });
  });
});

describe("product editor: details (1.3.1 merge)", () => {
  it("resends gsm and sizeChartCm unchanged when the edited fields are unchanged", () => {
    const d = draft().details;
    const patch = detailsPatch(d, { fabric: d.fabric!, printMethod: d.printMethod!, credit: d.credit! });
    expect(patch).toEqual(d);
    expect(applyDetailsPatch(d, patch)).toEqual(d);
  });

  it("a cleared field is sent as null (removes it); an edited one replaces it; the rest survive", () => {
    const d = draft().details;
    const patch = detailsPatch(d, { fabric: " Sample linen ", printMethod: "", credit: d.credit! });
    expect(patch).toMatchObject({ fabric: "Sample linen", printMethod: null, gsm: 180, sizeChartCm: d.sizeChartCm });
    expect(applyDetailsPatch(d, patch)).toEqual({ fabric: "Sample linen", gsm: 180, credit: "Sample artist", sizeChartCm: d.sizeChartCm });
    expect(d.printMethod).toBe("Sample screen print"); // input not mutated
  });

  it("an empty field that was never stored is left out, not sent as null", () => {
    expect(detailsPatch(undefined, { fabric: "", printMethod: "", credit: "" })).toEqual({});
    expect(detailsPatch({ gsm: 200 }, { fabric: "", printMethod: "Sample DTF", credit: "" })).toEqual({ gsm: 200, printMethod: "Sample DTF" });
  });

  it("the mock server merges like the real one: omitted keeps everything, null removes", () => {
    const d = draft().details;
    expect(applyDetailsPatch(d, undefined)).toEqual(d);
    expect(applyDetailsPatch(d, { gsm: null })).not.toHaveProperty("gsm");
    expect(applyDetailsPatch(d, { sizeChartCm: { S: { chest: 96 } } }).sizeChartCm).toEqual({ S: { chest: 96 } }); // whole chart replaced
  });

  it("summarises the kept fields the form cannot edit", () => {
    expect(keptDetailsSummary(draft().details)).toBe("fabric weight 180 GSM and size chart (M, L)");
    expect(keptDetailsSummary({ fabric: "x" })).toBeNull();
  });
});

describe("product editor: images field (1.3.1: omitted = unchanged)", () => {
  it("is left out when the photos did not change", () => {
    const stored = photosFromProduct(draft());
    expect(imagesField(stored, [...stored])).toEqual({});
    expect(imagesField([], [])).toEqual({}); // new product without photos
  });

  it("is the FULL set (kept + new, in order) when anything changed: add, remove, reorder or alt text", () => {
    const stored = photosFromProduct(draft());
    const all = stored.map((r) => ({ path: r.path, alt: r.alt }));
    expect(imagesField(stored, setPhotoAlt(stored, 0, "Changed"))).toEqual({ images: [{ ...all[0], alt: "Changed" }, all[1]] });
    expect(imagesField(stored, movePhoto(stored, 1, -1))).toEqual({ images: [all[1], all[0]] });
    expect(imagesField(stored, removePhoto(stored, 0))).toEqual({ images: [all[1]] });
    expect(imagesField(stored, removePhoto(removePhoto(stored, 0), 1))).toEqual({ images: [] }); // explicit: remove all
    expect(imagesField(stored, restorePhoto(removePhoto(stored, 0), 0))).toEqual({}); // removed, then Undo: unchanged
    const added = setPhotoAlt(addPhoto(stored, "products/new", null), 2, "New");
    expect(imagesField(stored, added)).toEqual({ images: [...all, { path: "products/new", alt: "New" }] });
  });
});

describe("mock public products", () => {
  it("never expose the storage path of a photo", () => {
    const db = seedDb();
    db.products[0]!.images = draft().images;
    const pub = toPublicProducts(db)[0]!;
    expect(pub.images).toHaveLength(2);
    expect(pub.images.every((i) => !("path" in i))).toBe(true);
  });
});

describe("product editor: list changes while the form is open (BUG-007)", () => {
  const base = () => draft();
  const formRows = (p: ReturnType<typeof draft>): VariantFormRow[] =>
    p.variants.map((v) => ({ id: v.id, size: v.size, colour: v.colour, stock: String(v.stock), sku: v.sku ?? "", override: "" }));

  it("untouched Published and stock follow the stored values", () => {
    const b = base();
    const latest = { ...b, isPublished: !b.isPublished, variants: b.variants.map((v, i) => (i === 0 ? { ...v, stock: 42 } : v)) };
    const r = rebaseListFields(b, latest, { published: b.isPublished, rows: formRows(b) });
    expect(r.published).toBe(!b.isPublished);
    expect(r.rows[0]!.stock).toBe("42");
    expect(r.changed).toEqual(["published", "stock"]);
  });

  it("a value the person changed in the form wins", () => {
    const b = base();
    const latest = { ...b, isPublished: !b.isPublished, variants: b.variants.map((v) => ({ ...v, stock: 42 })) };
    const rows = formRows(b).map((r, i) => (i === 0 ? { ...r, stock: "7" } : r));
    const r = rebaseListFields(b, latest, { published: !b.isPublished, rows });
    expect(r.published).toBe(!b.isPublished);
    expect(r.rows[0]!.stock).toBe("7");
    expect(r.changed).toEqual(rows.length > 1 ? ["stock"] : []);
  });

  it("nothing changed in the list: same rows object, no note", () => {
    const b = base();
    const form = { published: b.isPublished, rows: formRows(b) };
    const r = rebaseListFields(b, structuredClone(b), form);
    expect(r.rows).toBe(form.rows);
    expect(r.changed).toEqual([]);
  });

  it("new size rows (no id) are left alone", () => {
    const b = base();
    const rows: VariantFormRow[] = [...formRows(b), { size: "XL", colour: "Black", stock: "3", sku: "", override: "" }];
    const r = rebaseListFields(b, b, { published: b.isPublished, rows });
    expect(r.rows.at(-1)).toEqual(rows.at(-1));
  });
});

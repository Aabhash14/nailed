import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, ok, type Call, type PgResult } from "./helpers/fake-db";

/**
 * api-contract 1.3.1: in upsertProduct / upsertMenuItem an OMITTED image field means "leave images unchanged"
 * (rows and files), only an explicit value replaces them, and product details MERGE (omitted keys kept,
 * null removes a key). Regression tests for the data-loss bug in contract section 8 item 3.
 */

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/data/server-admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/images/verify", () => ({ assertImageGroupsValid: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "owner", displayName: "Owner" }),
  getCurrentUser: async () => null,
}));

import { revalidateTag } from "next/cache";
import { assertImageGroupsValid } from "@/lib/images/verify";
import { upsertMenuItem } from "@/app/admin/_actions/menu";
import { upsertProduct } from "@/app/admin/_actions/products";
import { mergeProductDetails, removedImagePaths, resolveMenuImage } from "@/lib/data/upsert-merge";
import { inviteStaffSchema } from "@/lib/validation/admin";

const PID = "3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";
const VID = "4f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3c";
const CAT = "5f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3d";
const G1 = "products/11111111-1111-4111-8111-111111111111";
const G2 = "products/22222222-2222-4222-8222-222222222222";
const G3 = "products/33333333-3333-4333-8333-333333333333";
const M1 = "menu/44444444-4444-4444-8444-444444444444";
const M2 = "menu/55555555-5555-4555-8555-555555555555";

const has = (calls: Call[], op: string) => calls.some((c) => c.op === op);
const arg = (calls: Call[], op: string) => calls.find((c) => c.op === op)?.args[0];

/** Fake db plus a storage spy (records every removed path). */
function withStorage(f: ReturnType<typeof fakeDb>) {
  const removed: string[] = [];
  (f.db as unknown as { storage: unknown }).storage = {
    from: () => ({ remove: async (paths: string[]) => (removed.push(...paths), { data: null, error: null }) }),
  };
  state.db = f.db;
  return { ...f, removed };
}

const storedDetails = { fabric: "Cotton", gsm: 180, printMethod: "DTF", sizeChartCm: { M: { chest: 52 } } };

function productDb(images: { id: string; path: string }[] = [{ id: "i1", path: G1 }, { id: "i2", path: G2 }]) {
  return withStorage(
    fakeDb({
      tables: {
        products: (calls): PgResult =>
          has(calls, "update") ? ok({ id: PID, slug: "tee" }) : ok({ details: storedDetails }),
        product_images: (calls): PgResult => (has(calls, "select") ? ok(images) : ok(null)),
        product_variants: (calls): PgResult => (has(calls, "select") ? ok([{ id: VID }]) : ok(null)),
      },
    }),
  );
}

const productBase = {
  id: PID,
  name: "Nailed Tee",
  price: 150000,
  isPublished: true,
  variants: [{ id: VID, size: "M", colour: "Black", stock: 5 }],
};

const tables = (f: { tableCalls: { table: string; calls: Call[] }[] }, t: string) =>
  f.tableCalls.filter((c) => c.table === t).map((c) => c.calls);

beforeEach(() => {
  vi.mocked(revalidateTag).mockClear();
  vi.mocked(assertImageGroupsValid).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("pure helpers", () => {
  it("mergeProductDetails keeps omitted keys, removes null keys, replaces given keys", () => {
    expect(mergeProductDetails(storedDetails, undefined)).toEqual(storedDetails);
    expect(mergeProductDetails(storedDetails, {})).toEqual(storedDetails);
    expect(mergeProductDetails(storedDetails, { fabric: "Linen" })).toEqual({ ...storedDetails, fabric: "Linen" });
    expect(mergeProductDetails(storedDetails, { gsm: null, sizeChartCm: { L: { chest: 56 } } })).toEqual({
      fabric: "Cotton",
      printMethod: "DTF",
      sizeChartCm: { L: { chest: 56 } },
    });
    expect(mergeProductDetails(storedDetails, { credit: undefined })).toEqual(storedDetails);
    expect(mergeProductDetails(null, { gsm: 200, fabric: null })).toEqual({ gsm: 200 });
    // keys stored by an older version are not dropped
    expect(mergeProductDetails({ legacy: 1 }, { gsm: 1 })).toEqual({ legacy: 1, gsm: 1 });
    // never mutates the stored object
    const s = { gsm: 1 };
    mergeProductDetails(s, { gsm: null });
    expect(s).toEqual({ gsm: 1 });
  });
  it("removedImagePaths: omitted set removes nothing; explicit set removes only the left-out groups", () => {
    expect(removedImagePaths([G1, G2], undefined)).toEqual([]);
    expect(removedImagePaths([G1, G2], [{ path: G2 }, { path: G3 }])).toEqual([G1]);
    expect(removedImagePaths([G1, G2], [])).toEqual([G1, G2]);
  });
  it("resolveMenuImage: omitted keeps, null removes, new path replaces, same path is a no-op", () => {
    expect(resolveMenuImage(M1, undefined)).toEqual({ path: M1, remove: null, isNew: false });
    expect(resolveMenuImage(M1, null)).toEqual({ path: null, remove: M1, isNew: false });
    expect(resolveMenuImage(M1, M2)).toEqual({ path: M2, remove: M1, isNew: true });
    expect(resolveMenuImage(M1, M1)).toEqual({ path: M1, remove: null, isNew: false });
    expect(resolveMenuImage(null, M2)).toEqual({ path: M2, remove: null, isNew: true });
  });
});

describe("upsertProduct (api-contract 1.3.1)", () => {
  it("omitted images: no image rows touched, no files deleted, no image check", async () => {
    const f = productDb();
    const r = await upsertProduct({ ...productBase, details: { fabric: "Cotton" } });
    expect(r).toEqual({ ok: true, data: { id: PID, slug: "tee" } });
    expect(tables(f, "product_images")).toHaveLength(0);
    expect(f.removed).toEqual([]);
    expect(assertImageGroupsValid).not.toHaveBeenCalled();
    expect(revalidateTag).toHaveBeenCalledWith("shop");
  });

  it("omitted details keys are kept (gsm and sizeChartCm survive a form that only sends fabric)", async () => {
    const f = productDb();
    await upsertProduct({ ...productBase, details: { fabric: "Organic cotton" } });
    const update = tables(f, "products").find((c) => has(c, "update"));
    expect(arg(update ?? [], "update")).toMatchObject({
      details: { fabric: "Organic cotton", gsm: 180, printMethod: "DTF", sizeChartCm: { M: { chest: 52 } } },
    });
  });

  it("omitted details entirely keeps all stored details; null removes one key", async () => {
    let f = productDb();
    await upsertProduct(productBase);
    expect(arg(tables(f, "products").find((c) => has(c, "update")) ?? [], "update")).toMatchObject({ details: storedDetails });

    f = productDb();
    await upsertProduct({ ...productBase, details: { gsm: null } });
    const details = (arg(tables(f, "products").find((c) => has(c, "update")) ?? [], "update") as { details: object }).details;
    expect(details).toEqual({ fabric: "Cotton", printMethod: "DTF", sizeChartCm: { M: { chest: 52 } } });
  });

  it("explicit set: new rows inserted BEFORE old rows deleted, only the left-out group's files deleted", async () => {
    const f = productDb();
    const r = await upsertProduct({ ...productBase, images: [{ path: G2, alt: "Back" }, { path: G3, alt: "Front" }] });
    expect(r.ok).toBe(true);
    // only the NEW group is checked (SEC-018); the stored G2 is not re-downloaded
    expect(assertImageGroupsValid).toHaveBeenCalledWith(expect.anything(), [G3], "images");
    const imgCalls = tables(f, "product_images");
    const insertIdx = imgCalls.findIndex((c) => has(c, "insert"));
    const deleteIdx = imgCalls.findIndex((c) => has(c, "delete"));
    expect(insertIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(insertIdx);
    expect(arg(imgCalls[insertIdx] ?? [], "insert")).toEqual([
      { product_id: PID, path: G2, alt: "Back", sort_order: 0 },
      { product_id: PID, path: G3, alt: "Front", sort_order: 1 },
    ]);
    // old rows deleted by id, not by product (so nothing else can be swept away)
    expect(imgCalls[deleteIdx]?.find((c) => c.op === "in")?.args).toEqual(["id", ["i1", "i2"]]);
    expect(f.removed).toEqual([480, 960, 1600].map((w) => `${G1}/${w}.webp`));
  });

  it("explicit empty set removes all images and their files (explicit removal)", async () => {
    const f = productDb();
    await upsertProduct({ ...productBase, images: [] });
    expect(tables(f, "product_images").some((c) => has(c, "insert"))).toBe(false);
    expect(f.removed).toHaveLength(6);
  });

  it("a failed insert of the new set deletes no rows and no files", async () => {
    const f = withStorage(
      fakeDb({
        tables: {
          products: (calls): PgResult => (has(calls, "update") ? ok({ id: PID, slug: "tee" }) : ok({ details: {} })),
          product_images: (calls): PgResult =>
            has(calls, "insert")
              ? { data: null, error: { code: "57014", message: "timeout" } }
              : has(calls, "select")
                ? ok([{ id: "i1", path: G1 }])
                : ok(null),
        },
      }),
    );
    const r = (await upsertProduct({ ...productBase, images: [{ path: G3, alt: "" }] })) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(tables(f, "product_images").some((c) => has(c, "delete"))).toBe(false);
    expect(f.removed).toEqual([]);
  });

  it("unknown product id -> NOT_FOUND before anything is written", async () => {
    const f = withStorage(fakeDb({ tables: { products: ok(null) } }));
    const r = (await upsertProduct({ ...productBase, images: [] })) as { error: { code: string } };
    expect(r.error.code).toBe("NOT_FOUND");
    expect(tables(f, "products").some((c) => has(c, "update"))).toBe(false);
    expect(tables(f, "product_images")).toHaveLength(0);
  });

  it("create without images or details: details {} and no image rows", async () => {
    const f = withStorage(
      fakeDb({
        tables: {
          products: ok({ id: PID, slug: "nailed-tee" }),
          product_variants: (calls): PgResult => (has(calls, "select") ? ok([]) : ok(null)),
        },
      }),
    );
    const { id: _omit, ...create } = productBase;
    void _omit;
    const r = await upsertProduct({ ...create, variants: [{ size: "M", colour: "Black", stock: 5 }] });
    expect(r.ok).toBe(true);
    expect(arg(tables(f, "products")[0] ?? [], "insert")).toMatchObject({ details: {} });
    expect(tables(f, "product_images")).toHaveLength(0);
  });
});

describe("upsertMenuItem (api-contract 1.3.1)", () => {
  const ITEM = "66666666-6666-4666-8666-666666666666";
  const itemRow = {
    id: ITEM, category_id: CAT, name: "Latte", description: null, price_paisa: 25000, diet: "veg", tags: [],
    is_sold_out: false, is_visible: true, image_path: M1, sort_order: 1, deleted_at: null,
  };
  function menuDb() {
    return withStorage(
      fakeDb({
        tables: {
          menu_categories: ok({ id: CAT }),
          menu_items: (calls): PgResult => (has(calls, "update") ? ok(null) : ok(itemRow)),
          menu_variants: ok([]),
        },
      }),
    );
  }
  const base = { id: ITEM, categoryId: CAT, name: "Latte", price: 25000, diet: "veg", tags: [], isVisible: true, variants: [] };
  const updateArgs = (f: ReturnType<typeof menuDb>) =>
    arg(tables(f, "menu_items").find((c) => has(c, "update")) ?? [], "update") as Record<string, unknown>;

  it("omitted imagePath keeps the stored image: image_path not written, files not deleted", async () => {
    const f = menuDb();
    const r = await upsertMenuItem(base);
    expect(r.ok).toBe(true);
    expect(updateArgs(f)).not.toHaveProperty("image_path");
    expect(f.removed).toEqual([]);
    expect(assertImageGroupsValid).not.toHaveBeenCalled();
  });

  it("imagePath: null removes the image and deletes its files (explicit)", async () => {
    const f = menuDb();
    await upsertMenuItem({ ...base, imagePath: null });
    expect(updateArgs(f)).toMatchObject({ image_path: null });
    expect(f.removed).toEqual([480, 960, 1600].map((w) => `${M1}/${w}.webp`));
  });

  it("a new imagePath is checked, saved, and only then the old group is deleted", async () => {
    const f = menuDb();
    await upsertMenuItem({ ...base, imagePath: M2 });
    expect(assertImageGroupsValid).toHaveBeenCalledWith(expect.anything(), [M2], "imagePath");
    expect(updateArgs(f)).toMatchObject({ image_path: M2 });
    expect(f.removed).toEqual([480, 960, 1600].map((w) => `${M1}/${w}.webp`));
  });

  it("re-sending the same imagePath changes nothing on disk", async () => {
    const f = menuDb();
    await upsertMenuItem({ ...base, imagePath: M1 });
    expect(assertImageGroupsValid).not.toHaveBeenCalled();
    expect(f.removed).toEqual([]);
  });
});

/**
 * api-contract 1.3.2 section 4 "Omitted description" (section 8 item 12): on UPDATE an omitted description keeps
 * the stored text (the column is not written at all); "" / whitespace (and null for menu items) clear it, stored as
 * null, never "". On CREATE an omitted description is null.
 */
describe("omitted description (api-contract 1.3.2, section 8 item 12)", () => {
  const ITEM = "77777777-7777-4777-8777-777777777777";
  const STORED = "Double shot, steamed milk, a little foam.";
  const itemRow = {
    id: ITEM, category_id: CAT, name: "Latte", description: STORED, price_paisa: 25000, diet: "veg", tags: [],
    is_sold_out: false, is_visible: true, image_path: null, sort_order: 1, deleted_at: null,
  };
  const menuBase = { categoryId: CAT, name: "Latte", price: 25000, diet: "veg", tags: [], isVisible: true, variants: [] };
  function menuDb() {
    return withStorage(
      fakeDb({
        tables: {
          menu_categories: ok({ id: CAT }),
          menu_items: (calls): PgResult => (has(calls, "update") ? ok(null) : ok(itemRow)),
          menu_variants: ok([]),
        },
      }),
    );
  }
  const written = (f: { tableCalls: { table: string; calls: Call[] }[] }, t: string, op: "update" | "insert") =>
    arg(tables(f, t).find((c) => has(c, op)) ?? [], op) as Record<string, unknown>;

  it("upsertMenuItem update WITHOUT description keeps the stored text (column not written)", async () => {
    const f = menuDb();
    const r = (await upsertMenuItem({ ...menuBase, id: ITEM, name: "Latte (large)" })) as {
      ok: boolean;
      data: { description: string | null };
    };
    expect(r.ok).toBe(true);
    const upd = written(f, "menu_items", "update");
    expect(upd).toMatchObject({ name: "Latte (large)" });
    expect(upd).not.toHaveProperty("description");
    expect(r.data.description).toBe(STORED);
  });

  it("upsertMenuItem update: a new text replaces it; '', whitespace and null clear it to null (never '')", async () => {
    for (const [sent, stored] of [
      ["Oat milk on request", "Oat milk on request"],
      ["", null],
      ["   ", null],
      [null, null],
    ] as const) {
      const f = menuDb();
      const r = await upsertMenuItem({ ...menuBase, id: ITEM, description: sent });
      expect(r.ok).toBe(true);
      expect(written(f, "menu_items", "update")).toHaveProperty("description", stored);
    }
  });

  it("upsertMenuItem create without description stores null", async () => {
    const f = menuDb();
    const r = await upsertMenuItem(menuBase);
    expect(r.ok).toBe(true);
    expect(written(f, "menu_items", "insert")).toHaveProperty("description", null);
  });

  it("upsertProduct update WITHOUT description keeps the stored text (column not written)", async () => {
    const f = productDb();
    const r = await upsertProduct({ ...productBase, name: "Nailed Tee v2" });
    expect(r.ok).toBe(true);
    const upd = written(f, "products", "update");
    expect(upd).toMatchObject({ name: "Nailed Tee v2" });
    expect(upd).not.toHaveProperty("description");
  });

  it("upsertProduct update: a new text replaces it; '' and whitespace clear it to null (never '')", async () => {
    for (const [sent, stored] of [
      ["Heavyweight cotton tee", "Heavyweight cotton tee"],
      ["", null],
      ["  ", null],
    ] as const) {
      const f = productDb();
      const r = await upsertProduct({ ...productBase, description: sent });
      expect(r.ok).toBe(true);
      expect(written(f, "products", "update")).toHaveProperty("description", stored);
    }
  });

  it("upsertProduct still rejects description: null (contract 1.3.2: menu items only)", async () => {
    productDb();
    const r = (await upsertProduct({ ...productBase, description: null })) as { ok: boolean; error?: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("VALIDATION");
  });

  it("upsertProduct create without description stores null", async () => {
    const f = withStorage(
      fakeDb({
        tables: {
          products: ok({ id: PID, slug: "nailed-tee" }),
          product_variants: (calls): PgResult => (has(calls, "select") ? ok([]) : ok(null)),
        },
      }),
    );
    const { id: _omit, ...create } = productBase;
    void _omit;
    const r = await upsertProduct({ ...create, variants: [{ size: "M", colour: "Black", stock: 5 }] });
    expect(r.ok).toBe(true);
    expect(written(f, "products", "insert")).toHaveProperty("description", null);
  });
});

describe("inviteStaff password (72 bytes, like changePassword)", () => {
  const input = (password: string) => ({ email: "staff@example.com", displayName: "Staff", password });
  it("accepts 12..72 characters, rejects 73 characters and anything over 72 UTF-8 bytes", () => {
    expect(inviteStaffSchema.safeParse(input("a".repeat(12))).success).toBe(true);
    expect(inviteStaffSchema.safeParse(input("a".repeat(72))).success).toBe(true);
    expect(inviteStaffSchema.safeParse(input("a".repeat(11))).success).toBe(false);
    expect(inviteStaffSchema.safeParse(input("a".repeat(73))).success).toBe(false);
    // 30 Devanagari letters = 30 characters but 90 bytes
    expect(inviteStaffSchema.safeParse(input("क".repeat(30))).success).toBe(false);
    // 24 x 3 bytes = 72 bytes exactly
    expect(inviteStaffSchema.safeParse(input("क".repeat(24))).success).toBe(true);
  });
});

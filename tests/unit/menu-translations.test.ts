import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, ok, pgErr, type Call, type PgResult } from "./helpers/fake-db";

/**
 * Multi-language menu (api-contract 1.4.0; data-model decision 19; migration 20261024000001).
 * Fake Supabase client only: NO real database. Covers the Zod rules (mirror of the DB CHECKs), the public read
 * (explicit anon column lists + DTO shape), the admin read and writes ("omitted = unchanged", explicit object
 * replaces), the 23514 backstop mapping and the staff refusal.
 */

const state = vi.hoisted(() => ({
  user: null as null | { userId: string; role: "owner" | "staff"; displayName: string },
  db: null as unknown,
}));

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/data/server-admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/images/verify", () => ({ assertImageGroupsValid: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", async () => {
  const { AppError } = await import("@/lib/errors");
  const { roleAllows } = await import("@/lib/auth/roles");
  return {
    getCurrentUser: async () => state.user,
    requireRole: async (need: "owner" | "staff") => {
      if (!state.user) throw new AppError("UNAUTHENTICATED");
      if (!roleAllows(state.user.role, need)) throw new AppError("FORBIDDEN");
      return state.user;
    },
  };
});

import { getAdminMenu, toggleSoldOut, toggleVariantSoldOut, upsertCategory, upsertMenuItem } from "@/app/admin/_actions/menu";
import { mapDbError } from "@/lib/data/db-errors";
import { getPublicMenu, PUBLIC_MENU_COLUMNS } from "@/lib/data/menu";
import { handleMenu } from "@/lib/menu-route";
import {
  categoryTranslationsFromRow,
  charCount,
  itemTranslationsFromRow,
  MENU_TRANSLATION_LANGS,
  variantTranslationsFromRow,
} from "@/lib/menu-translations";
import {
  categoryTranslationsSchema,
  itemTranslationsSchema,
  upsertCategorySchema,
  upsertMenuItemSchema,
  variantTranslationsSchema,
} from "@/lib/validation/admin";
import { fieldErrorsFromZod } from "@/lib/validation/common";

const OWNER = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "owner", displayName: "Owner" } as const;
const STAFF = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "staff", displayName: "Staff" } as const;
const CAT = "5f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3d";
const ITEM = "66666666-6666-4666-8666-666666666666";
const VAR1 = "77777777-7777-4777-8777-777777777777";
const VAR2 = "88888888-8888-4888-8888-888888888888";

/** Field-error keys of a failed parse (same keys the actions return in fieldErrors). */
function errorKeys(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, v: unknown) {
  const r = schema.safeParse(v);
  if (r.success) return null;
  return fieldErrorsFromZod(r.error as Parameters<typeof fieldErrorsFromZod>[0]);
}
const parse = <T,>(schema: { parse: (v: unknown) => T }, v: unknown) => schema.parse(v);
const rep = (ch: string, n: number) => ch.repeat(n);

// ---------------------------------------------------------------------------------------------------------------
describe("charCount counts like Postgres char_length (code points)", () => {
  it("BMP scripts, astral characters and combining marks", () => {
    expect(charCount("मसला चिया")).toBe([..."मसला चिया"].length);
    expect(charCount("😀")).toBe(1); // String.length is 2
    expect(charCount("커피")).toBe(2);
    expect(charCount("")).toBe(0);
  });
});

describe("item translations schema (mirrors menu_items_translations_valid)", () => {
  it("accepts all five languages; trims; keeps pronunciation on ne; output keys in ne, zh, ja, ko, pt order", () => {
    const out = parse(itemTranslationsSchema, {
      pt: { name: " Chá masala " },
      zh: { name: "马萨拉奶茶", description: "  香料奶茶  " },
      ne: { name: "मसला चिया", description: "दूध र मसला", pronunciation: "  masala chiya " },
      ko: { name: "마살라 차이" },
      ja: { name: "マサラチャイ" },
    });
    expect(out).toEqual({
      ne: { name: "मसला चिया", description: "दूध र मसला", pronunciation: "masala chiya" },
      zh: { name: "马萨拉奶茶", description: "香料奶茶" },
      ja: { name: "マサラチャイ" },
      ko: { name: "마살라 차이" },
      pt: { name: "Chá masala" },
    });
    expect(Object.keys(out)).toEqual(["ne", "zh", "ja", "ko", "pt"]);
  });

  it("drops blank optional fields (never stores \"\"), and null / undefined ones", () => {
    expect(parse(itemTranslationsSchema, { ne: { name: "चिया", description: "   ", pronunciation: "" } })).toEqual({
      ne: { name: "चिया" },
    });
    expect(parse(itemTranslationsSchema, { ja: { name: "茶", description: null } })).toEqual({ ja: { name: "茶" } });
  });

  it("drops a language whose name is blank or missing, and a language set to null", () => {
    expect(
      parse(itemTranslationsSchema, {
        ne: { name: "  ", description: "only a description" },
        zh: { description: "no name" },
        ja: null,
        ko: { name: "커피" },
      }),
    ).toEqual({ ko: { name: "커피" } });
    expect(parse(itemTranslationsSchema, {})).toEqual({});
    expect(parse(itemTranslationsSchema, { ne: { name: "" } })).toEqual({});
  });

  it("refuses an unknown language (fr, en, zh-Hans, NE) on `translations`", () => {
    for (const lang of ["fr", "en", "zh-Hans", "NE"]) {
      const e = errorKeys(itemTranslationsSchema, { [lang]: { name: "x" } });
      expect(Object.keys(e ?? {}), lang).toEqual(["_"]); // root of this schema = `translations` in the action
      expect(e?._?.[0]).toMatch(/ne, zh, ja, ko, pt/);
    }
  });

  it("refuses an unknown field per language", () => {
    expect(Object.keys(errorKeys(itemTranslationsSchema, { ne: { name: "x", label: "y" } }) ?? {})).toEqual(["ne"]);
  });

  it("pronunciation is for ne only (a blank one on another language is simply dropped)", () => {
    expect(errorKeys(itemTranslationsSchema, { zh: { name: "拿铁", pronunciation: "na tie" } })).toEqual({
      "zh.pronunciation": ["Pronunciation is only for Nepali (ne)"],
    });
    expect(parse(itemTranslationsSchema, { zh: { name: "拿铁", pronunciation: "  " } })).toEqual({ zh: { name: "拿铁" } });
  });

  it("lengths in characters: name 80, description 240, pronunciation 80 (boundary ok, +1 refused)", () => {
    const ok80 = rep("क", 80);
    expect(
      parse(itemTranslationsSchema, { ne: { name: ok80, description: rep("ह", 240), pronunciation: rep("a", 80) } }),
    ).toEqual({ ne: { name: ok80, description: rep("ह", 240), pronunciation: rep("a", 80) } });
    expect(errorKeys(itemTranslationsSchema, { ne: { name: rep("क", 81) } })).toHaveProperty(["ne.name"]);
    expect(errorKeys(itemTranslationsSchema, { ko: { name: "x", description: rep("가", 241) } })).toHaveProperty([
      "ko.description",
    ]);
    expect(errorKeys(itemTranslationsSchema, { ne: { name: "x", pronunciation: rep("a", 81) } })).toHaveProperty([
      "ne.pronunciation",
    ]);
    // 80 emoji = 160 UTF-16 units but 80 characters for Postgres: accepted
    expect(parse(itemTranslationsSchema, { pt: { name: rep("😀", 80) } })).toEqual({ pt: { name: rep("😀", 80) } });
    // trimming happens before the length check
    expect(parse(itemTranslationsSchema, { pt: { name: ` ${rep("a", 80)} ` } })).toEqual({ pt: { name: rep("a", 80) } });
  });

  it("refuses wrong types (number, boolean, array, string map, non-object language)", () => {
    expect(errorKeys(itemTranslationsSchema, { ne: { name: 3 } })).toHaveProperty(["ne.name"]);
    expect(errorKeys(itemTranslationsSchema, { ne: { name: "x", description: true } })).toHaveProperty(["ne.description"]);
    expect(errorKeys(itemTranslationsSchema, { ne: "चिया" })).toHaveProperty(["ne"]);
    expect(errorKeys(itemTranslationsSchema, { ne: ["चिया"] })).toHaveProperty(["ne"]);
    expect(errorKeys(itemTranslationsSchema, [{ name: "x" }])).not.toBeNull();
    expect(errorKeys(itemTranslationsSchema, "ne")).not.toBeNull();
    expect(errorKeys(itemTranslationsSchema, null)).not.toBeNull();
  });
});

describe("category and variant translations schemas", () => {
  it("category: { lang: { name 1..80 } }, trimmed, blanks dropped, nothing else", () => {
    expect(parse(categoryTranslationsSchema, { ne: { name: " कफी " }, zh: { name: "" }, ja: null })).toEqual({
      ne: { name: "कफी" },
    });
    expect(parse(categoryTranslationsSchema, { ko: { name: rep("가", 80) } })).toEqual({ ko: { name: rep("가", 80) } });
    expect(errorKeys(categoryTranslationsSchema, { ko: { name: rep("가", 81) } })).toHaveProperty(["ko.name"]);
    expect(errorKeys(categoryTranslationsSchema, { ne: { name: "x", description: "y" } })).toHaveProperty(["ne"]);
    expect(errorKeys(categoryTranslationsSchema, { en: { name: "Coffee" } })).toHaveProperty(["_"]);
  });

  it("variant: { lang: { label 1..40 } } (the English label allows more; the translation does not)", () => {
    expect(parse(variantTranslationsSchema, { ne: { label: " ठूलो " }, pt: { label: " " } })).toEqual({ ne: { label: "ठूलो" } });
    expect(parse(variantTranslationsSchema, { ja: { label: rep("ラ", 40) } })).toEqual({ ja: { label: rep("ラ", 40) } });
    expect(errorKeys(variantTranslationsSchema, { ja: { label: rep("ラ", 41) } })).toHaveProperty(["ja.label"]);
    expect(errorKeys(variantTranslationsSchema, { ne: { name: "ठूलो" } })).toHaveProperty(["ne"]);
  });
});

describe("action input schemas: translations are optional (omitted = unchanged)", () => {
  const item = { categoryId: CAT, name: "Latte", price: 25000, diet: "veg", tags: [], isVisible: true };
  it("upsertMenuItem: omitted stays undefined, {} stays {}, per-variant translations are cleaned; paths are nested", () => {
    const omitted = upsertMenuItemSchema.parse({ ...item, variants: [{ kind: "size", label: "Large", priceDelta: 0 }] });
    expect(omitted.translations).toBeUndefined();
    expect(omitted.variants[0]?.translations).toBeUndefined();
    const explicit = upsertMenuItemSchema.parse({
      ...item,
      translations: {},
      variants: [{ kind: "size", label: "Large", priceDelta: 0, translations: { ne: { label: " ठूलो " }, zh: { label: "" } } }],
    });
    expect(explicit.translations).toEqual({});
    expect(explicit.variants[0]?.translations).toEqual({ ne: { label: "ठूलो" } });
    expect(
      errorKeys(upsertMenuItemSchema, {
        ...item,
        translations: { zh: { name: "x", pronunciation: "y" } },
        variants: [{ kind: "size", label: "L", priceDelta: 0, translations: { fr: { label: "Grand" } } }],
      }),
    ).toEqual({
      "translations.zh.pronunciation": ["Pronunciation is only for Nepali (ne)"],
      "variants.0.translations": [expect.stringMatching(/ne, zh, ja, ko, pt/)],
    });
    // null is not "clear": send {} for that
    expect(errorKeys(upsertMenuItemSchema, { ...item, variants: [], translations: null })).toHaveProperty(["translations"]);
  });
  it("upsertCategory: omitted stays undefined; explicit is cleaned", () => {
    expect(upsertCategorySchema.parse({ name: "Coffee", isVisible: true }).translations).toBeUndefined();
    expect(upsertCategorySchema.parse({ name: "Coffee", isVisible: true, translations: { ne: { name: "कफी" } } }).translations).toEqual({
      ne: { name: "कफी" },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("read-side sanitizers (defence in depth; the DB CHECK already guarantees the shape)", () => {
  it("keep allowed languages and keys only; missing / null / malformed column = {}", () => {
    expect(
      itemTranslationsFromRow({
        ne: { name: "चिया", description: "दूध", pronunciation: "chiya", extra: "x" },
        zh: { name: "茶", pronunciation: "cha" },
        ja: { description: "no name" },
        ko: { name: 5 },
        pt: { name: "" },
        fr: { name: "Thé" },
      }),
    ).toEqual({ ne: { name: "चिया", description: "दूध", pronunciation: "chiya" }, zh: { name: "茶" } });
    for (const bad of [undefined, null, "x", 3, [], [{ name: "x" }]]) {
      expect(itemTranslationsFromRow(bad)).toEqual({});
      expect(categoryTranslationsFromRow(bad)).toEqual({});
      expect(variantTranslationsFromRow(bad)).toEqual({});
    }
    expect(categoryTranslationsFromRow({ ne: { name: "कफी", label: "x" }, en: { name: "Coffee" } })).toEqual({ ne: { name: "कफी" } });
    expect(variantTranslationsFromRow({ ko: { label: "라지" }, ja: { name: "ラージ" } })).toEqual({ ko: { label: "라지" } });
    expect(MENU_TRANSLATION_LANGS).toEqual(["ne", "zh", "ja", "ko", "pt"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
const settingsRow = { hours: { weekly: {}, closures: [] }, announcement: null, prices_include_vat: true, service_charge_pct: "0", vat_pct: 13 };
const catRow = {
  id: CAT, slug: "tea", name: "Tea", sort_order: 1, is_visible: true,
  translations: { ne: { name: "चिया" }, zh: { name: "茶" } },
};
const itemRow = {
  id: ITEM, category_id: CAT, name: "Masala chai", description: "Milk and spices", price_paisa: 15000, diet: "veg",
  tags: [], is_sold_out: false, is_visible: true, image_path: null, sort_order: 1, deleted_at: null,
  translations: { ne: { name: "मसला चिया", pronunciation: "masala chiya" }, ja: { name: "マサラチャイ", description: "スパイス" } },
};
const variantRows = [
  { id: VAR1, item_id: ITEM, kind: "size", label: "Large", price_delta_paisa: 4000, is_sold_out: false, sort_order: 0, translations: { ne: { label: "ठूलो" } } },
  { id: VAR2, item_id: ITEM, kind: "milk", label: "Oat milk", price_delta_paisa: 5000, is_sold_out: false, sort_order: 1, translations: {} },
];
const expectedItemTranslations = { ne: { name: "मसला चिया", pronunciation: "masala chiya" }, ja: { name: "マサラチャイ", description: "スパイス" } };

function publicDb() {
  return fakeDb({
    tables: {
      menu_categories: ok([catRow]),
      menu_items: ok([itemRow]),
      menu_variants: ok(variantRows),
      menu_specials: ok([]),
      public_settings: ok(settingsRow),
    },
  });
}
const selectArg = (f: ReturnType<typeof fakeDb>, table: string) =>
  f.tableCalls.find((c) => c.table === table)?.calls.find((c) => c.op === "select")?.args[0];

describe("public menu read (getPublicMenu, GET /api/menu)", () => {
  it("anon reads use explicit column lists that include translations (no select *)", async () => {
    const f = publicDb();
    await getPublicMenu(f.db, "https://proj.supabase.co", new Date("2026-10-24T00:00:00Z"));
    expect(selectArg(f, "menu_categories")).toBe("id, slug, name, sort_order, translations");
    expect(selectArg(f, "menu_items")).toBe(
      "id, category_id, name, description, price_paisa, diet, tags, is_sold_out, image_path, sort_order, translations",
    );
    expect(selectArg(f, "menu_variants")).toBe("id, item_id, kind, label, price_delta_paisa, is_sold_out, sort_order, translations");
    expect(selectArg(f, "menu_specials")).toBe("id, title, note, ends_at, item_id");
    expect(selectArg(f, "public_settings")).toBe("hours, announcement, prices_include_vat, service_charge_pct, vat_pct, table_ordering");
    for (const t of ["menu_categories", "menu_items", "menu_variants", "menu_specials", "public_settings"]) {
      expect(selectArg(f, t), t).not.toContain("*");
    }
    expect(PUBLIC_MENU_COLUMNS.items).not.toMatch(/is_visible|deleted_at|created_at/);
  });

  it("DTO carries translations on categories, items and variants with the contract shape", async () => {
    const p = await getPublicMenu(publicDb().db, "https://proj.supabase.co", new Date("2026-10-24T00:00:00Z"));
    const cat = p.categories[0]!;
    expect(cat.translations).toEqual({ ne: { name: "चिया" }, zh: { name: "茶" } });
    expect(cat.items[0]!.translations).toEqual(expectedItemTranslations);
    expect(cat.items[0]!.variants.map((v) => v.translations)).toEqual([{ ne: { label: "ठूलो" } }, {}]);
    // English stays in the existing fields
    expect(cat.items[0]!.name).toBe("Masala chai");
    expect(cat.items[0]!.variants[0]!.label).toBe("Large");
  });

  it("GET /api/menu returns the translations in the JSON envelope", async () => {
    const f = publicDb();
    const res = await handleMenu(new Request("https://cafe.test/api/menu", { headers: { "cf-connecting-ip": "198.51.100.7" } }), {
      db: () => f.db,
      supabaseUrl: () => "https://proj.supabase.co",
      limiterDb: () => f.db, // no rate_limit_hit_info handler: the limiter fails open
      salt: () => "test-salt-0123456789-0123456789-abc",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { categories: { translations: unknown; items: { translations: unknown; variants: { translations: unknown }[] }[] }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.categories[0]!.translations).toEqual({ ne: { name: "चिया" }, zh: { name: "茶" } });
    expect(body.data.categories[0]!.items[0]!.translations).toEqual(expectedItemTranslations);
    expect(body.data.categories[0]!.items[0]!.variants[0]!.translations).toEqual({ ne: { label: "ठूलो" } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
const has = (calls: Call[], op: string) => calls.some((c) => c.op === op);
const arg = (calls: Call[], op: string) => calls.find((c) => c.op === op)?.args[0] as Record<string, unknown> | undefined;
const callsOf = (f: ReturnType<typeof fakeDb>, t: string) => f.tableCalls.filter((c) => c.table === t).map((c) => c.calls);
const writes = (f: ReturnType<typeof fakeDb>, t: string, op: "update" | "insert") =>
  callsOf(f, t).filter((c) => has(c, op)).map((c) => arg(c, op)!);

function adminMenuDb(over: { items?: (calls: Call[]) => PgResult; variants?: (calls: Call[]) => PgResult; categories?: (calls: Call[]) => PgResult } = {}) {
  const f = fakeDb({
    tables: {
      menu_categories:
        over.categories ??
        ((calls) => (has(calls, "update") || has(calls, "insert") ? ok({ id: CAT, slug: "tea" }) : has(calls, "maybeSingle") ? ok({ id: CAT }) : ok([catRow]))),
      menu_items:
        over.items ??
        ((calls) => (has(calls, "update") ? ok(null) : has(calls, "insert") ? ok({ id: ITEM }) : has(calls, "maybeSingle") ? ok(itemRow) : ok([itemRow]))),
      menu_variants: over.variants ?? ((calls) => (has(calls, "update") || has(calls, "insert") ? ok(null) : ok(variantRows))),
    },
  });
  (f.db as unknown as { storage: unknown }).storage = { from: () => ({ remove: async () => ({ data: null, error: null }) }) };
  state.db = f.db;
  return f;
}

const itemInput = {
  id: ITEM, categoryId: CAT, name: "Masala chai", description: "Milk and spices", price: 15000, diet: "veg", tags: [], isVisible: true,
  variants: [
    { id: VAR1, kind: "size", label: "Large", priceDelta: 4000 },
    { id: VAR2, kind: "milk", label: "Oat milk", priceDelta: 5000 },
  ],
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.user = OWNER;
});

describe("getAdminMenu returns translations", () => {
  it("categories, items and variants (owner and staff can read)", async () => {
    for (const user of [OWNER, STAFF]) {
      state.user = user;
      adminMenuDb();
      const r = await getAdminMenu();
      expect(r.ok).toBe(true);
      const cats = (r as { ok: true; data: { translations: unknown; isVisible: boolean; items: { translations: unknown; variants: { translations: unknown }[] }[] }[] }).data;
      expect(cats[0]).toMatchObject({ id: CAT, slug: "tea", name: "Tea", sortOrder: 1, isVisible: true, translations: { ne: { name: "चिया" }, zh: { name: "茶" } } });
      expect(cats[0]!.items[0]!.translations).toEqual(expectedItemTranslations);
      expect(cats[0]!.items[0]!.variants.map((v) => v.translations)).toEqual([{ ne: { label: "ठूलो" } }, {}]);
    }
  });
});

describe("upsertMenuItem translations (1.4.0: omitted = unchanged, an object replaces)", () => {
  it("omitted item and variant translations: the column is not written at all", async () => {
    const f = adminMenuDb();
    const r = await upsertMenuItem(itemInput);
    expect(r.ok).toBe(true);
    expect(writes(f, "menu_items", "update")[0]).not.toHaveProperty("translations");
    const vUpdates = writes(f, "menu_variants", "update");
    expect(vUpdates).toHaveLength(2);
    for (const u of vUpdates) expect(u).not.toHaveProperty("translations");
  });

  it("an explicit object is cleaned (trim, blanks dropped) and written as the whole value; {} clears", async () => {
    let f = adminMenuDb();
    await upsertMenuItem({
      ...itemInput,
      translations: { ne: { name: " मसला चिया ", description: "", pronunciation: " masala chiya " }, zh: { name: "  " } },
    });
    expect(writes(f, "menu_items", "update")[0]!.translations).toEqual({ ne: { name: "मसला चिया", pronunciation: "masala chiya" } });

    f = adminMenuDb();
    await upsertMenuItem({ ...itemInput, translations: {} });
    expect(writes(f, "menu_items", "update")[0]!.translations).toEqual({});
  });

  it("per-variant: an object replaces that variant's translations, an omitted one keeps them; new variants too", async () => {
    const f = adminMenuDb();
    await upsertMenuItem({
      ...itemInput,
      variants: [
        { id: VAR1, kind: "size", label: "Large", priceDelta: 4000, translations: { ne: { label: "ठूलो" }, ja: { label: " ラージ " } } },
        { id: VAR2, kind: "milk", label: "Oat milk", priceDelta: 5000 },
        { kind: "temperature", label: "Iced", priceDelta: 0, translations: { ko: { label: "아이스" } } },
        { kind: "addon", label: "Extra shot", priceDelta: 6000 },
      ],
    });
    const [u1, u2] = writes(f, "menu_variants", "update");
    expect(u1!.translations).toEqual({ ne: { label: "ठूलो" }, ja: { label: "ラージ" } });
    expect(u2).not.toHaveProperty("translations");
    const [i1, i2] = writes(f, "menu_variants", "insert");
    expect(i1!.translations).toEqual({ ko: { label: "아이스" } });
    expect(i2).not.toHaveProperty("translations"); // the column default '{}' applies
  });

  it("create: omitted translations leave the column default; explicit ones are inserted", async () => {
    let f = adminMenuDb({ items: (calls) => (has(calls, "insert") ? ok({ id: ITEM }) : has(calls, "maybeSingle") ? ok(itemRow) : ok([])) });
    const { id: _drop, ...createInput } = itemInput;
    void _drop;
    await upsertMenuItem({ ...createInput, variants: [] });
    expect(writes(f, "menu_items", "insert")[0]).not.toHaveProperty("translations");

    f = adminMenuDb({ items: (calls) => (has(calls, "insert") ? ok({ id: ITEM }) : has(calls, "maybeSingle") ? ok(itemRow) : ok([])) });
    await upsertMenuItem({ ...createInput, variants: [], translations: { pt: { name: "Chai masala" } } });
    expect(writes(f, "menu_items", "insert")[0]!.translations).toEqual({ pt: { name: "Chai masala" } });
  });

  it("the returned MenuItem carries translations (item and variants)", async () => {
    adminMenuDb();
    const r = (await upsertMenuItem(itemInput)) as { ok: true; data: { translations: unknown; variants: { translations: unknown }[] } };
    expect(r.data.translations).toEqual(expectedItemTranslations);
    expect(r.data.variants.map((v) => v.translations)).toEqual([{ ne: { label: "ठूलो" } }, {}]);
  });

  it("Zod refuses bad translations before any database write (VALIDATION, nested field paths)", async () => {
    const f = adminMenuDb();
    const r = (await upsertMenuItem({
      ...itemInput,
      translations: { fr: { name: "Chai" } },
      variants: [{ id: VAR1, kind: "size", label: "Large", priceDelta: 0, translations: { ne: { label: rep("ठ", 41) } } }],
    })) as { ok: false; error: { code: string; fieldErrors: Record<string, string[]> } };
    expect(r.error.code).toBe("VALIDATION");
    expect(Object.keys(r.error.fieldErrors).sort()).toEqual(["translations", "variants.0.translations.ne.label"]);
    expect(f.tableCalls).toHaveLength(0);
  });

  it("DB backstop: 23514 on menu_items_translations_valid -> VALIDATION fieldErrors.translations (no SQL in the reply)", async () => {
    adminMenuDb({
      items: (calls) =>
        has(calls, "update")
          ? pgErr("23514", 'new row for relation "menu_items" violates check constraint "menu_items_translations_valid"', "Failing row contains (secret...)")
          : ok(itemRow),
    });
    const r = (await upsertMenuItem({ ...itemInput, translations: { ne: { name: "x" } } })) as { ok: false; error: { code: string; message: string; fieldErrors: Record<string, string[]> } };
    expect(r.error.code).toBe("VALIDATION");
    expect(Object.keys(r.error.fieldErrors)).toEqual(["translations"]);
    expect(JSON.stringify(r)).not.toMatch(/Failing row|secret|violates/);
  });

  it("DB backstop on a variant: 23514 on menu_variants_translations_valid -> fieldErrors[\"variants.N.translations\"]", async () => {
    adminMenuDb({
      variants: (calls) => {
        if (has(calls, "update") && arg(calls, "update")?.label === "Oat milk") {
          return pgErr("23514", 'new row for relation "menu_variants" violates check constraint "menu_variants_translations_valid"');
        }
        return has(calls, "update") || has(calls, "insert") ? ok(null) : ok(variantRows);
      },
    });
    const r = (await upsertMenuItem({
      ...itemInput,
      variants: [itemInput.variants[0]!, { ...itemInput.variants[1]!, translations: { ne: { label: "ओट" } } }],
    })) as { ok: false; error: { code: string; fieldErrors: Record<string, string[]> } };
    expect(r.error.code).toBe("VALIDATION");
    expect(Object.keys(r.error.fieldErrors)).toEqual(["variants.1.translations"]);
  });
});

describe("upsertCategory translations", () => {
  it("update: omitted = not written; explicit = cleaned and written; {} clears", async () => {
    let f = adminMenuDb();
    expect((await upsertCategory({ id: CAT, name: "Tea", isVisible: true })).ok).toBe(true);
    expect(writes(f, "menu_categories", "update")[0]).not.toHaveProperty("translations");

    f = adminMenuDb();
    await upsertCategory({ id: CAT, name: "Tea", isVisible: true, translations: { ne: { name: " चिया " }, ko: { name: "" } } });
    expect(writes(f, "menu_categories", "update")[0]!.translations).toEqual({ ne: { name: "चिया" } });

    f = adminMenuDb();
    await upsertCategory({ id: CAT, name: "Tea", isVisible: true, translations: {} });
    expect(writes(f, "menu_categories", "update")[0]!.translations).toEqual({});
  });

  it("create: translations inserted ({} when omitted)", async () => {
    const created = (calls: Call[]) => (has(calls, "insert") ? ok({ id: CAT, slug: "tea" }) : ok([{ sort_order: 3 }]));
    let f = adminMenuDb({ categories: created });
    await upsertCategory({ name: "Tea", isVisible: true, translations: { zh: { name: "茶" } } });
    expect(writes(f, "menu_categories", "insert")[0]).toMatchObject({ translations: { zh: { name: "茶" } }, sort_order: 4 });
    f = adminMenuDb({ categories: created });
    await upsertCategory({ name: "Tea", isVisible: true });
    expect(writes(f, "menu_categories", "insert")[0]!.translations).toEqual({});
  });

  it("invalid input is VALIDATION on translations.*; a 23514 backstop is VALIDATION on translations", async () => {
    adminMenuDb();
    const bad = (await upsertCategory({ id: CAT, name: "Tea", isVisible: true, translations: { ne: { name: rep("क", 81) } } })) as {
      ok: false;
      error: { code: string; fieldErrors: Record<string, string[]> };
    };
    expect(bad.error.code).toBe("VALIDATION");
    expect(Object.keys(bad.error.fieldErrors)).toEqual(["translations.ne.name"]);

    adminMenuDb({
      categories: (calls) =>
        has(calls, "update") ? pgErr("23514", 'new row for relation "menu_categories" violates check constraint "menu_categories_translations_valid"') : ok([]),
    });
    const db = (await upsertCategory({ id: CAT, name: "Tea", isVisible: true, translations: { ne: { name: "चिया" } } })) as {
      ok: false;
      error: { code: string; fieldErrors: Record<string, string[]> };
    };
    expect(db.error).toMatchObject({ code: "VALIDATION", fieldErrors: { translations: [expect.any(String)] } });
  });
});

describe("staff cannot edit translations: FORBIDDEN, cleanly", () => {
  it("upsertMenuItem / upsertCategory with translations -> FORBIDDEN before any database call", async () => {
    state.user = STAFF;
    const f = adminMenuDb();
    const a = (await upsertMenuItem({ ...itemInput, translations: { ne: { name: "चिया" } } })) as { ok: false; error: { code: string } };
    const b = (await upsertCategory({ id: CAT, name: "Tea", isVisible: true, translations: { ne: { name: "चिया" } } })) as {
      ok: false;
      error: { code: string };
    };
    expect(a.error.code).toBe("FORBIDDEN");
    expect(b.error.code).toBe("FORBIDDEN");
    expect(f.tableCalls).toHaveLength(0);
  });

  it("sold-out toggles ignore a smuggled translations field and write is_sold_out only", async () => {
    state.user = STAFF;
    const f = fakeDb({ tables: { menu_items: ok([{ id: ITEM }]), menu_variants: ok([{ id: VAR1 }]) } });
    state.db = f.db;
    expect((await toggleSoldOut({ itemId: ITEM, isSoldOut: true, translations: { ne: { name: "x" } } })).ok).toBe(true);
    expect((await toggleVariantSoldOut({ variantId: VAR1, isSoldOut: true, translations: { ne: { label: "x" } } })).ok).toBe(true);
    expect(writes(f, "menu_items", "update")).toEqual([{ is_sold_out: true }]);
    expect(writes(f, "menu_variants", "update")).toEqual([{ is_sold_out: true }]);
  });

  it("if the database refuses a staff write (guard trigger 42501), it maps to FORBIDDEN, not INTERNAL", () => {
    const e = mapDbError({ code: "42501", message: "staff may only change: is_sold_out" });
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).not.toContain("is_sold_out");
  });
});

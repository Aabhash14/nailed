import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, ok, pgErr, type PgResult } from "./helpers/fake-db";

/**
 * T-037: break-glass menu export (src/lib/data/menu-fallback-export.ts, used by scripts/export-menu-fallback.ts).
 * Fake Supabase client only: NO real database. The fake rows deliberately carry private columns that the anon
 * client could never see, to prove the snapshot is built from an allow-list and cannot leak them.
 */

// The generated JSON is fed to the real getFallbackMenu() / frontend fallbackSnapshot() through this mock.
const state = vi.hoisted(() => ({ json: {} as Record<string, unknown> }));
vi.mock("@/data/menu-fallback.json", () => ({ default: state.json }));

import { AppError } from "@/lib/errors";
import { getFallbackMenu } from "@/lib/data/menu-fallback";
import {
  assertOnlyAllowedKeys,
  exportMenuFallback,
  FALLBACK_NOTE,
  FallbackExportError,
  keyLooksPrivileged,
} from "@/lib/data/menu-fallback-export";
import { fallbackSnapshot } from "@/components/menu/fallback";

const NOW = new Date("2026-10-23T05:15:00.000Z");
const CAT = "c0000000-0000-4000-8000-000000000001";
const ITEM = "10000000-0000-4000-8000-000000000001";
const ITEM2 = "10000000-0000-4000-8000-000000000002";
const VAR = "20000000-0000-4000-8000-000000000001";

const categories = [
  {
    id: CAT, slug: "coffee", name: "Coffee", sort_order: 1, is_visible: true, created_at: "x", updated_at: "x",
    translations: { ne: { name: "कफी" }, ja: { name: "コーヒー" } },
  },
];
const items = [
  {
    id: ITEM, category_id: CAT, name: "Latte", description: "Double shot", price_paisa: 35000, diet: "veg",
    tags: ["bestseller"], is_sold_out: true, is_visible: true, image_path: "menu/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sort_order: 1, deleted_at: null, created_at: "x", updated_at: "x",
    // private-looking extras that must never reach the snapshot
    stock: 7, cost_paisa: 12000, internal_note: "supplier X",
    // 1.4.0: real translations are kept; anything outside the allow-list inside them is dropped
    translations: {
      ne: { name: "लाटे", description: "डबल सट", pronunciation: "laate", reviewer: "translator-notes" },
      zh: { name: "拿铁", pronunciation: "na tie" },
      fr: { name: "Café latte" },
      internal: { name: "cost 12000" },
    },
  },
  {
    id: ITEM2, category_id: CAT, name: "Americano", description: "", price_paisa: 25000, diet: "veg", tags: [],
    is_sold_out: false, is_visible: true, image_path: null, sort_order: 2, deleted_at: null, created_at: "x", updated_at: "x",
  },
];
const variants = [
  {
    id: VAR, item_id: ITEM, kind: "milk", label: "Oat milk", price_delta_paisa: 5000, is_sold_out: true, sort_order: 0, stock: 3,
    translations: { ne: { label: "ओट दूध" }, ko: { label: "" } },
  },
];
const specials = [{ id: "s1", item_id: ITEM, title: "Pumpkin latte", note: null, ends_at: null }];
const hours = {
  weekly: { "0": null, "1": [{ open: "08:00", close: "20:00" }], "2": [{ open: "08:00", close: "20:00" }], "3": null, "4": null, "5": null, "6": null },
  closures: [{ date: "2026-10-24", label: "Dashain" }],
};
const publicSettings = {
  hours, announcement: "Closed early today", prices_include_vat: true, service_charge_pct: "10", vat_pct: 13,
  // a misconfigured view or a privileged key could return these; the snapshot must not carry them
  cod_max_total_paisa: 500000, max_open_orders_per_phone: 2, orders_paused: false, phone: "+9779800000000",
};

function liveDb(over: Partial<Record<string, PgResult>> = {}) {
  return fakeDb({
    tables: {
      menu_categories: ok(categories),
      menu_items: ok(items),
      menu_variants: ok(variants),
      menu_specials: ok(specials),
      public_settings: ok(publicSettings),
      ...over,
    },
  });
}

beforeEach(() => {
  for (const k of Object.keys(state.json)) delete state.json[k];
});

describe("exportMenuFallback (T-037)", () => {
  it("builds the snapshot in the getFallbackMenu shape, with generatedAt", async () => {
    const { snapshot, json, stats } = await exportMenuFallback(liveDb().db, { now: NOW });
    expect(stats).toEqual({ categories: 1, items: 2, variants: 1 });
    expect(JSON.parse(json)).toEqual(snapshot);
    expect(json.endsWith("}\n")).toBe(true);
    expect(snapshot).toEqual({
      generatedAt: "2026-10-23T05:15:00.000Z",
      note: FALLBACK_NOTE,
      settings: {
        hours,
        announcement: null, // may be stale; never copied
        pricesIncludeVat: true,
        serviceChargePct: 10,
        vatPct: 13,
      },
      categories: [
        {
          id: CAT,
          slug: "coffee",
          name: "Coffee",
          sortOrder: 1,
          translations: { ne: { name: "कफी" }, ja: { name: "コーヒー" } },
          items: [
            {
              id: ITEM, categoryId: CAT, name: "Latte", description: "Double shot", price: 35000, diet: "veg",
              tags: ["bestseller"],
              isSoldOut: false, // same-day state, reset
              imageUrl: null, imageVariants: [], // images live in the (down) Supabase project, stripped
              variants: [
                { id: VAR, kind: "milk", label: "Oat milk", priceDelta: 5000, isSoldOut: false, translations: { ne: { label: "ओट दूध" } } },
              ],
              sortOrder: 1,
              // pronunciation kept on ne only; unknown languages and fields dropped
              translations: { ne: { name: "लाटे", description: "डबल सट", pronunciation: "laate" }, zh: { name: "拿铁" } },
            },
            {
              id: ITEM2, categoryId: CAT, name: "Americano", description: null, price: 25000, diet: "veg", tags: [],
              isSoldOut: false, imageUrl: null, imageVariants: [], variants: [], sortOrder: 2,
              translations: {}, // row without the column (pre-1.4.0 data) reads as English only
            },
          ],
        },
      ],
    });
  });

  it("never carries private settings, order rules, stock numbers, specials or image paths", async () => {
    const { json } = await exportMenuFallback(liveDb().db, { now: NOW });
    for (const leak of [
      "stock", "cost_paisa", "internal_note", "supplier X", "cod_max", "codMax", "max_open_orders", "orders_paused",
      "ordersPaused", "phone", "+9779800000000", "Closed early today", "Pumpkin latte", "specials", "menu/aaaaaaaa",
      "storage/v1", "translator-notes", "reviewer", "Café latte", "cost 12000", "internal", "na tie",
    ]) {
      expect(json).not.toContain(leak);
    }
  });

  it("reads only the public menu tables and the public_settings view (display columns), with no RPC", async () => {
    const f = liveDb();
    await exportMenuFallback(f.db, { now: NOW });
    const touched = [...new Set(f.tableCalls.map((c) => c.table))].sort();
    expect(touched).toEqual(["menu_categories", "menu_items", "menu_specials", "menu_variants", "public_settings"]);
    const settingsSelect = f.tableCalls.find((c) => c.table === "public_settings")?.calls.find((c) => c.op === "select");
    expect(settingsSelect?.args[0]).toBe("hours, announcement, prices_include_vat, service_charge_pct, vat_pct, table_ordering");
    // only visible, non-deleted rows are asked for (RLS enforces the same for anon)
    const itemCalls = f.tableCalls.find((c) => c.table === "menu_items")?.calls ?? [];
    expect(itemCalls).toContainEqual({ op: "eq", args: ["is_visible", true] });
    expect(itemCalls).toContainEqual({ op: "is", args: ["deleted_at", null] });
    expect(f.rpcCalls).toEqual([]);
  });

  it("output is what getFallbackMenu returns and what the /menu break-glass view renders", async () => {
    const { json } = await exportMenuFallback(liveDb().db, { now: NOW });
    Object.assign(state.json, JSON.parse(json)); // same object the mocked module exported
    const fb = getFallbackMenu();
    expect(fb.generatedAt).toBe("2026-10-23T05:15:00.000Z");
    expect(fb.categories[0]?.items[0]?.name).toBe("Latte");
    const view = fallbackSnapshot();
    expect(view.categories).toEqual(fb.categories);
    expect(view.updatedAt).toBe("2026-10-23T05:15:00.000Z");
    expect(view.degraded).toBe(true);
  });

  it("refuses an empty live menu unless allowEmpty is set", async () => {
    const empty = () => liveDb({ menu_categories: ok([]), menu_items: ok([]), menu_variants: ok([]) }).db;
    await expect(exportMenuFallback(empty(), { now: NOW })).rejects.toBeInstanceOf(FallbackExportError);
    const r = await exportMenuFallback(empty(), { now: NOW, allowEmpty: true });
    expect(r.snapshot.categories).toEqual([]);
    expect(r.stats.items).toBe(0);
  });

  it("a database error is INTERNAL and produces no snapshot", async () => {
    const f = liveDb({ menu_items: pgErr("PGRST301", "JWT expired") });
    const err = await exportMenuFallback(f.db, { now: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("INTERNAL");
    expect((err as AppError).logDetail).toBe("menu read: PGRST301");
  });

  it("a missing public_settings row is INTERNAL", async () => {
    const err = await exportMenuFallback(liveDb({ public_settings: ok(null) }).db, { now: NOW }).catch((e: unknown) => e);
    expect((err as AppError).code).toBe("INTERNAL");
  });
});

describe("assertOnlyAllowedKeys", () => {
  it("rejects any key outside the snapshot allow-list, at any depth", () => {
    expect(() => assertOnlyAllowedKeys({ generatedAt: null, categories: [], stock: 1 })).toThrow(/"stock" at \$/);
    expect(() =>
      assertOnlyAllowedKeys({ categories: [{ id: "c", items: [{ id: "i", variants: [{ id: "v", stock: 3 }] }] }] }),
    ).toThrow(/"stock" at \$\.categories\[0\]\.items\[0\]\.variants\[0\]/);
    expect(() => assertOnlyAllowedKeys({ settings: { codMaxTotal: 1 } })).toThrow(FallbackExportError);
  });

  it("1.4.0: translations pass only as { ne|zh|ja|ko|pt: { name|description|pronunciation|label: string } }", () => {
    const item = (translations: unknown) => ({ categories: [{ id: "c", items: [{ id: "i", translations }] }] });
    expect(() =>
      assertOnlyAllowedKeys(item({ ne: { name: "क", description: "ख", pronunciation: "ka" }, pt: { name: "x" } })),
    ).not.toThrow();
    expect(() => assertOnlyAllowedKeys({ categories: [{ translations: { ko: { name: "커피" } } }] })).not.toThrow();
    expect(() => assertOnlyAllowedKeys(item({}))).not.toThrow();
    // unknown language, unknown field, non-string value, non-object entry or map
    expect(() => assertOnlyAllowedKeys(item({ fr: { name: "x" } }))).toThrow(/"fr" at \$\.categories\[0\]\.items\[0\]\.translations/);
    expect(() => assertOnlyAllowedKeys(item({ ne: { name: "x", stock: "3" } }))).toThrow(/"stock" at .*translations\.ne/);
    expect(() => assertOnlyAllowedKeys(item({ ne: { name: 3 } }))).toThrow(FallbackExportError);
    expect(() => assertOnlyAllowedKeys(item({ ne: "x" }))).toThrow(FallbackExportError);
    expect(() => assertOnlyAllowedKeys(item([{ name: "x" }]))).toThrow(FallbackExportError);
    // language codes and "pronunciation" are NOT allowed outside a translations map
    expect(() => assertOnlyAllowedKeys({ settings: { ne: 1 } })).toThrow(/"ne" at \$\.settings/);
    expect(() => assertOnlyAllowedKeys({ categories: [{ id: "c", pronunciation: "x" }] })).toThrow(FallbackExportError);
  });

  it("the committed src/data/menu-fallback.json passes the same check (no hand-added private data)", () => {
    const path = fileURLToPath(new URL("../../src/data/menu-fallback.json", import.meta.url));
    const committed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(() => assertOnlyAllowedKeys(committed)).not.toThrow();
  });
});

describe("keyLooksPrivileged (the export must use the anon key)", () => {
  const jwt = (payload: object) =>
    [{ alg: "HS256", typ: "JWT" }, payload].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".sig";
  it("flags service-role JWTs and sb_secret_ keys; passes anon JWTs and publishable keys", () => {
    expect(keyLooksPrivileged(jwt({ iss: "supabase", role: "service_role" }))).toBe(true);
    expect(keyLooksPrivileged(` ${jwt({ role: "service_role", ref: "abc" })} `)).toBe(true);
    expect(keyLooksPrivileged("sb_secret_abc123")).toBe(true);
    expect(keyLooksPrivileged(jwt({ iss: "supabase", role: "anon" }))).toBe(false);
    expect(keyLooksPrivileged("sb_publishable_abc123")).toBe(false);
    expect(keyLooksPrivileged("not.a.jwt")).toBe(false);
    expect(keyLooksPrivileged("")).toBe(false);
  });
});

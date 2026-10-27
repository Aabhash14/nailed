import { describe, expect, it } from "vitest";
import {
  parseCodeParam,
  parseHint,
  parseTableParam,
  takeScannedCode,
  TABLE_HINT_MAX_AGE_MS,
} from "@/components/menu/table/hint";
import {
  addToCart,
  billRows,
  cartCount,
  classifySendError,
  cleanNote,
  describeLine,
  EMPTY_CART,
  formatTableCode,
  guestPollDelay,
  hasLiveRound,
  isTableCodeShape,
  itemQtyInCart,
  lineErrorsFrom,
  lineKey,
  newRequestId,
  normaliseTableCode,
  optionGroups,
  parseStoredCart,
  prepareSend,
  setLineQty,
  unitPriceWith,
  type TableCart,
} from "@/components/menu/table/table-logic";
import { buildTableText, TABLE_EN } from "@/components/menu/table/i18n";
import { TABLE_NE } from "@/components/menu/table/i18n/ne";
import { TABLE_PT } from "@/components/menu/table/i18n/pt";
import { TABLE_JA } from "@/components/menu/table/i18n/ja";
import { TABLE_KO } from "@/components/menu/table/i18n/ko";
import { TABLE_ZH } from "@/components/menu/table/i18n/zh";
import type { MenuCategory, MenuItem } from "@/types/contract";

/** Guest table ordering (contract 2.2.0 section 9): join hint, scanned code, cart, send ids, notes, messages. */

const NOW = Date.parse("2026-10-25T08:00:00Z");
const A = "00000000-0000-4000-8002-000000000001";
const B = "00000000-0000-4000-8002-000000000002";
const LARGE = "00000000-0000-4000-8004-000000000002";
const OAT = "00000000-0000-4000-8004-000000000001";

const item = (over: Partial<MenuItem> = {}): MenuItem => ({
  id: B,
  categoryId: "c",
  name: "Black coffee",
  description: null,
  price: 15000,
  diet: "veg",
  tags: [],
  isSoldOut: false,
  imageUrl: null,
  imageVariants: [],
  variants: [
    { id: OAT, kind: "milk", label: "Oat milk", priceDelta: 5000, isSoldOut: true, translations: {} },
    { id: LARGE, kind: "size", label: "Large", priceDelta: 3000, isSoldOut: false, translations: {} },
  ],
  sortOrder: 1,
  translations: {},
  ...over,
});
const menu = (items: MenuItem[]): MenuCategory[] => [{ id: "c", slug: "c", name: "C", sortOrder: 1, translations: {}, items }];

describe("nc_table_hint (9.2): { tableNumber, joinedAt } only, under 12 h", () => {
  const raw = (o: unknown) => JSON.stringify(o);
  it("accepts a fresh hint", () => {
    expect(parseHint(raw({ tableNumber: 7, joinedAt: new Date(NOW - 60_000).toISOString() }), NOW)).toEqual({
      tableNumber: 7,
      joinedAt: new Date(NOW - 60_000).toISOString(),
    });
  });
  it("drops an old, future, malformed or out-of-range hint (so no session request is made)", () => {
    expect(parseHint(raw({ tableNumber: 7, joinedAt: new Date(NOW - TABLE_HINT_MAX_AGE_MS).toISOString() }), NOW)).toBeNull();
    expect(parseHint(raw({ tableNumber: 7, joinedAt: new Date(NOW + 5 * 60_000).toISOString() }), NOW)).toBeNull();
    expect(parseHint(raw({ tableNumber: 0, joinedAt: new Date(NOW).toISOString() }), NOW)).toBeNull();
    expect(parseHint(raw({ tableNumber: "7", joinedAt: new Date(NOW).toISOString() }), NOW)).toBeNull();
    expect(parseHint("{not json", NOW)).toBeNull();
    expect(parseHint(null, NOW)).toBeNull();
  });
});

describe("QR parameters (SEC-024)", () => {
  it("reads ?t= in range only", () => {
    expect(parseTableParam("7")).toBe(7);
    expect(parseTableParam("99")).toBe(99);
    for (const bad of ["0", "100", "7a", "", null, "-1"]) expect(parseTableParam(bad)).toBeNull();
  });
  it("takes the code from the fragment and leaves t (and other values) in the address", () => {
    expect(takeScannedCode("https://cafe.example/menu?t=7#c=K7M4QX")).toEqual({ code: "K7M4QX", cleanUrl: "/menu?t=7" });
    expect(takeScannedCode("https://cafe.example/menu?t=7&lang=ne#c=K7M4QX&x=1")).toEqual({
      code: "K7M4QX",
      cleanUrl: "/menu?t=7&lang=ne#x=1",
    });
  });
  it("also strips a legacy ?code=, and does nothing when there is no code", () => {
    expect(takeScannedCode("https://cafe.example/menu?t=3&code=k7m-4qx")).toEqual({ code: "k7m-4qx", cleanUrl: "/menu?t=3" });
    expect(takeScannedCode("https://cafe.example/menu?t=3")).toEqual({ code: null, cleanUrl: null });
    expect(takeScannedCode("https://cafe.example/menu#cat-food")).toEqual({ code: null, cleanUrl: null });
  });
  it("strips an implausible code from the address but does not use it", () => {
    expect(takeScannedCode("https://cafe.example/menu?t=3#c=<script>")).toEqual({ code: null, cleanUrl: "/menu?t=3" });
    expect(parseCodeParam("x".repeat(21))).toBeNull();
  });
});

describe("table codes (ADR 0002 decision 2)", () => {
  it("normalises spaces, dashes and case; checks the 31-symbol alphabet", () => {
    expect(normaliseTableCode(" k7m-4qx ")).toBe("K7M4QX");
    expect(isTableCodeShape("k7m 4qx")).toBe(true);
    expect(isTableCodeShape("K0M4QX")).toBe(false); // 0 is not in the alphabet
    expect(isTableCodeShape("KIM4QX")).toBe(false); // nor I
    expect(isTableCodeShape("K7M4Q")).toBe(false);
    expect(formatTableCode("K7M4QX")).toBe("K7M 4QX");
  });
});

describe("table cart", () => {
  it("merges the same item with the same SET of options, whatever the order", () => {
    let c = addToCart(EMPTY_CART, B, [LARGE, OAT], 1).cart;
    c = addToCart(c, B, [OAT, LARGE], 2).cart;
    c = addToCart(c, B, [], 1).cart;
    expect(c.lines).toHaveLength(2);
    expect(c.lines[0]).toMatchObject({ key: lineKey(B, [OAT, LARGE]), qty: 3 });
    expect(cartCount(c)).toBe(4);
    expect(itemQtyInCart(c, B)).toBe(4);
  });
  it("caps qty at 20 per line and lines at 20 per cart", () => {
    const r = addToCart(addToCart(EMPTY_CART, A, [], 18).cart, A, [], 5);
    expect(r.cart.lines[0]!.qty).toBe(20);
    expect(r.added).toBe(2);
    let c: TableCart = EMPTY_CART;
    for (let i = 0; i < 20; i++) c = addToCart(c, `item-${i}`, [], 1).cart;
    const over = addToCart(c, "item-20", [], 1);
    expect(over.tooManyLines).toBe(true);
    expect(over.cart.lines).toHaveLength(20);
  });
  it("setLineQty: 0 removes the line; values above 20 are capped", () => {
    const c = addToCart(EMPTY_CART, A, [], 1).cart;
    expect(setLineQty(c, c.lines[0]!.key, 0).lines).toEqual([]);
    expect(setLineQty(c, c.lines[0]!.key, 99).lines[0]!.qty).toBe(20);
  });
  it("describes a line against the latest menu: price with options, sold out, gone", () => {
    const c = addToCart(EMPTY_CART, B, [LARGE], 2).cart;
    const d = describeLine(c.lines[0]!, menu([item()]));
    expect(d).toMatchObject({ unitPrice: 18000, lineTotal: 36000, problem: null });
    expect(describeLine(c.lines[0]!, menu([item({ isSoldOut: true })])).problem).toBe("sold_out");
    expect(describeLine(addToCart(EMPTY_CART, B, [OAT], 1).cart.lines[0]!, menu([item()])).problem).toBe("sold_out");
    expect(describeLine(c.lines[0]!, menu([])).problem).toBe("gone");
  });
  it("groups options by kind in the item's order, and prices never go below 0", () => {
    expect(optionGroups(item()).map((g) => g.kind)).toEqual(["milk", "size"]);
    expect(unitPriceWith(item({ price: 1000, variants: [{ id: "s", kind: "size", label: "Small", priceDelta: -5000, isSoldOut: false, translations: {} }] }), ["s"])).toBe(0);
  });
  it("parses a stored cart strictly (never a code; malformed lines dropped)", () => {
    const raw = JSON.stringify({ tableNumber: 7, lines: [{ menuItemId: A, variantIds: [], qty: 99 }, { menuItemId: 5 }], note: "hi", pending: null, code: "K7M4QX" });
    const c = parseStoredCart(raw);
    expect(c.lines).toEqual([{ key: lineKey(A, []), menuItemId: A, variantIds: [], qty: 20 }]);
    expect(c).not.toHaveProperty("code");
    expect(parseStoredCart("nonsense")).toEqual(EMPTY_CART);
  });
});

describe("clientRequestId (SEC-027 / F3)", () => {
  const cart = addToCart(EMPTY_CART, A, [], 2).cart;
  it("a new press uses the new id; re-sending the identical cart reuses the pending one", () => {
    const first = prepareSend(cart, "id-1");
    expect(first.request.clientRequestId).toBe("id-1");
    const again = prepareSend(first.cart, "id-2");
    expect(again.request.clientRequestId).toBe("id-1");
  });
  it("any edit (qty, item or note) gets a new id", () => {
    const first = prepareSend(cart, "id-1").cart;
    expect(prepareSend(setLineQty(first, first.lines[0]!.key, 3), "id-2").request.clientRequestId).toBe("id-2");
    expect(prepareSend({ ...first, note: "less sugar" }, "id-3").request.clientRequestId).toBe("id-3");
    expect(prepareSend(addToCart(first, B, [], 1).cart, "id-4").request.clientRequestId).toBe("id-4");
  });
  it("builds the request without prices, with options only when chosen", () => {
    const c = addToCart(cart, B, [LARGE], 1).cart;
    expect(prepareSend({ ...c, note: "  " }, "x").request).toEqual({
      clientRequestId: "x",
      items: [
        { menuItemId: A, qty: 2 },
        { menuItemId: B, variantIds: [LARGE], qty: 1 },
      ],
    });
  });
  it("newRequestId: crypto.randomUUID when present, else a v4 UUID from getRandomValues", () => {
    expect(newRequestId({ getRandomValues: (a: Uint8Array) => a, randomUUID: () => "from-random-uuid" } as never)).toBe("from-random-uuid");
    const id = newRequestId({ getRandomValues: <T extends ArrayBufferView | null>(a: T) => { (a as unknown as Uint8Array).fill(0xab); return a; } } as never);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newRequestId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("notes (F5): one line of plain text", () => {
  it("strips control characters and bidi overrides, collapses whitespace, caps at 200", () => {
    expect(cleanNote("less\nsugar\t please")).toBe("less sugar please");
    expect(cleanNote("abc‮def⁦x\u0000y\u0085z")).toBe("abc def x y z");
    expect(cleanNote("a".repeat(250))).toHaveLength(200);
  });
  it("the request carries the cleaned note", () => {
    const c = { ...addToCart(EMPTY_CART, A, [], 1).cart, note: " no‮ice " };
    expect(prepareSend(c, "x").request.note).toBe("no ice");
  });
});

describe("send failures (9.5, 9.9, 9.12)", () => {
  it("unknown outcome keeps the id for 'Send again'; definite answers do not", () => {
    expect(classifySendError({ code: "INTERNAL" }, true)).toBe("retry");
    expect(classifySendError({ code: "INTERNAL" })).toBe("retry");
    expect(classifySendError({ code: "TABLE_SESSION_INVALID" })).toBe("session");
    expect(classifySendError({ code: "TABLE_ORDERS_PAUSED" })).toBe("paused");
    expect(classifySendError({ code: "OUT_OF_STOCK" })).toBe("fix");
    expect(classifySendError({ code: "VALIDATION" })).toBe("fix");
    expect(classifySendError({ code: "CONFLICT" })).toBe("wait");
    expect(classifySendError({ code: "RATE_LIMITED" })).toBe("wait");
    expect(classifySendError({ code: "NOT_FOUND" })).toBe("off");
    expect(classifySendError({ code: "FORBIDDEN" })).toBe("other");
  });
  it("maps items.N back to the cart line that was sent at index N", () => {
    const c = addToCart(addToCart(EMPTY_CART, A, [], 1).cart, B, [LARGE], 1).cart;
    expect(lineErrorsFrom({ "items.1": ["sold out"], "items.0.qty": ["Choose 1 to 20."], note: ["x"] }, c.lines)).toEqual({
      [c.lines[1]!.key]: "sold out",
      [c.lines[0]!.key]: "Choose 1 to 20.",
    });
  });
});

describe("guest polling and summary", () => {
  const round = (status: "new" | "preparing" | "served" | "cancelled") => ({ round: 1, status, items: [], note: null, subtotal: 0, createdAt: "" });
  it("polls only while a round is new or preparing, never faster than 30 s", () => {
    expect(hasLiveRound({ rounds: [round("served"), round("cancelled")] })).toBe(false);
    expect(hasLiveRound({ rounds: [round("served"), round("preparing")] })).toBe(true);
    expect(hasLiveRound(null)).toBe(false);
    expect(guestPollDelay(null)).toBe(30_000);
    expect(guestPollDelay(1_000)).toBe(30_000);
    expect(guestPollDelay(90_000)).toBe(90_000);
  });
  it("order summary rows: VAT inside shown as included; service charge only when set", () => {
    expect(billRows({ subtotal: 50000, serviceCharge: 0, vat: 5752, total: 50000, pricesIncludeVat: true, serviceChargePct: 0 }).map((r) => r.key)).toEqual([
      "subtotal",
      "vat_included",
      "total",
    ]);
    expect(billRows({ subtotal: 10000, serviceCharge: 1000, vat: 1430, total: 12430, pricesIncludeVat: false, serviceChargePct: 10 }).map((r) => r.key)).toEqual([
      "subtotal",
      "service",
      "vat_added",
      "total",
    ]);
  });
});

describe("table UI strings", () => {
  it("contract wording is kept exactly", () => {
    expect(TABLE_EN["summary.title"]).toBe("Order summary, not a bill or tax invoice");
    expect(TABLE_EN["msg.unavailable"]).toBe("Ordering is not available right now. Please order with our staff.");
    expect(TABLE_EN["msg.paused"]).toBe("The kitchen is not taking orders from the app right now. Please order with our staff.");
    expect(TABLE_EN["msg.locked"]).toBe("Ordering from the app is stopped for this table. Please order with our staff.");
    expect(TABLE_EN["msg.session_invalid"]).toBe("Your table is not open for ordering. Enter the code from our staff to order.");
  });
  it("secondary text follows the menu rule: missing or equal to English = English only", () => {
    const ne = buildTableText("ne", TABLE_NE);
    expect(ne.sec("occupancy.free")).toBe("खाली");
    expect(ne.sec("summary.title")).toBeNull(); // left for the translator
    expect(ne.lang).toBe("ne");
    const pt = buildTableText("pt", { ...TABLE_PT, "summary.total": "Total" });
    expect(pt.sec("summary.total")).toBeNull();
    expect(pt.sec("occupancy.table", { n: 4 })).toBe("Mesa 4");
    expect(buildTableText(null, null).sec("occupancy.free")).toBeNull();
  });
  it("every pack uses only known keys, and keeps the English placeholders", () => {
    for (const pack of [TABLE_NE, TABLE_ZH, TABLE_JA, TABLE_KO, TABLE_PT]) {
      for (const [k, v] of Object.entries(pack)) {
        expect(k in TABLE_EN).toBe(true);
        const tokens = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
        expect(tokens(v!)).toEqual(tokens(TABLE_EN[k as keyof typeof TABLE_EN]));
      }
    }
  });
});

describe("tableOrderingOf: any snapshot without a valid mode is 'off'", () => {
  it("reads on / paused; missing, unknown or no settings = off (break-glass snapshot)", async () => {
    const { tableOrderingOf } = await import("@/types/contract");
    expect(tableOrderingOf({ tableOrdering: "on" })).toBe("on");
    expect(tableOrderingOf({ tableOrdering: "paused" })).toBe("paused");
    expect(tableOrderingOf({})).toBe("off");
    expect(tableOrderingOf({ tableOrdering: "ON" })).toBe("off");
    expect(tableOrderingOf(null)).toBe("off");
  });
});

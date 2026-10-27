import { describe, expect, it } from "vitest";
import {
  addLine,
  estimateTotals,
  parseStoredCart,
  removeLine,
  setQty,
  subtotal,
  type CartLine,
} from "@/components/shop/cart-logic";
import {
  availableFulfilments,
  buildRequest,
  mapServerFieldErrors,
  payLine,
  refusedMessage,
  validateCheckout,
  type CheckoutValues,
} from "@/components/shop/checkout-logic";
import {
  hasLeadingZeroMobile,
  hoursRows,
  isPlausiblePhone,
  normaliseNepalPhone,
  paisaToRupees,
  parseSlots,
  rupeesToPaisa,
  safeHttpsUrl,
  slotsProblem,
} from "@/components/format";
import { normalizeNepalPhone } from "@/lib/phone";
import { targetSize } from "@/components/admin/image-resize";
import { canCancelAs, canTransition, nextForwardStatus } from "@/types/order-flow";
import {
  mockBlock,
  mockCancelOrder,
  mockCheckout,
  mockCustomerCancel,
  mockOrderByToken,
  mockUpdateStatus,
  sweepAutoCancel,
  toMenuSnapshot,
  toPublicProducts,
} from "@/mocks/engine";
import { seedDb, uid } from "@/mocks/seed";

const line = (n: number, price = 149900, qty = 1): CartLine => ({
  variantId: uid(n, 6),
  productSlug: "sample-tee",
  productName: "Sample tee",
  size: "M",
  colour: "Black",
  unitPrice: price,
  qty,
});

const settings = seedDb().settings;

const values = (over: Partial<CheckoutValues> = {}): CheckoutValues => ({
  fulfilment: "pickup",
  name: "Sita",
  phone: "9812345678",
  email: "",
  address: "",
  landmark: "",
  area: "",
  notes: "",
  ...over,
});

describe("cart logic", () => {
  it("merges the same variant and caps quantity at 10", () => {
    let l = addLine([], line(1), 8);
    l = addLine(l, line(1), 8);
    expect(l).toHaveLength(1);
    expect(l[0]?.qty).toBe(10);
  });
  it("setQty to 0 removes the line; removeLine works", () => {
    const l = addLine([], line(1));
    expect(setQty(l, uid(1, 6), 0)).toEqual([]);
    expect(removeLine(l, uid(1, 6))).toEqual([]);
  });
  it("adds delivery fee only for delivery, VAT only when prices exclude it", () => {
    const l = [line(1, 100000, 2)];
    expect(subtotal(l)).toBe(200000);
    expect(estimateTotals(l, "pickup", { deliveryFee: 15000, pricesIncludeVat: true, vatPct: 13 }).total).toBe(200000);
    expect(estimateTotals(l, "delivery", { deliveryFee: 15000, pricesIncludeVat: true, vatPct: 13 }).total).toBe(215000);
    expect(estimateTotals(l, "pickup", { deliveryFee: 0, pricesIncludeVat: false, vatPct: 13 }).total).toBe(226000);
  });
  it("ignores malformed stored carts", () => {
    expect(parseStoredCart("not json")).toEqual([]);
    expect(parseStoredCart('[{"variantId":1}]')).toEqual([]);
    expect(parseStoredCart(JSON.stringify([line(1)]))).toHaveLength(1);
  });
});

describe("checkout logic", () => {
  it("shows the cash sentence the contract requires", () => {
    expect(payLine(165000, "delivery")).toBe("Pay Rs. 1,650 in cash on delivery");
    expect(payLine(149900, "pickup")).toBe("Pay Rs. 1,499 in cash on pickup");
  });
  it("only offers fulfilments that are switched on", () => {
    expect(availableFulfilments({ paymentMethods: ["cod", "pickup"], deliveryAreas: ["A"] })).toEqual(["pickup", "delivery"]);
    expect(availableFulfilments({ paymentMethods: ["cod"], deliveryAreas: [] })).toEqual([]);
  });
  it("validates phone, delivery fields and the minimum order", () => {
    const lines = [line(1, 10000)];
    const bad = validateCheckout(values({ fulfilment: "delivery", phone: "123" }), lines, settings, subtotal(lines));
    expect(Object.keys(bad)).toEqual(expect.arrayContaining(["phone", "address", "landmark", "area", "items"]));
    const ok = validateCheckout(values(), [line(1)], settings, 149900);
    expect(ok).toEqual({});
  });
  it("builds a request with cod for delivery and pickup for pickup, no payment provider", () => {
    const d = buildRequest(values({ fulfilment: "delivery", address: "x", landmark: "y", area: "Baluwatar" }), [line(1)], "tok");
    expect(d.paymentMethod).toBe("cod");
    expect(d.customer.phone).toBe("+9779812345678");
    expect(d.delivery?.area).toBe("Baluwatar");
    expect(buildRequest(values(), [line(1)], "tok").paymentMethod).toBe("pickup");
  });
  it("maps server field errors", () => {
    const m = mapServerFieldErrors({ "customer.phone": ["bad"], "items.1": ["only 2 left"] });
    expect(m.fields.phone).toBe("bad");
    expect(m.lines[1]).toBe("only 2 left");
  });
  it("uses one generic refusal text", () => {
    expect(refusedMessage("9800000000")).toBe("We can't take this order online right now. Please call us on 9800000000.");
  });
});

describe("format helpers", () => {
  it("converts rupees and paisa", () => {
    expect(rupeesToPaisa("250")).toBe(25000);
    expect(rupeesToPaisa("1,250.5")).toBe(125050);
    expect(rupeesToPaisa("abc")).toBeNull();
    expect(rupeesToPaisa("-5")).toBeNull();
    expect(paisaToRupees(25050)).toBe("250.50");
  });
  it("normalises Nepal mobiles", () => {
    expect(normaliseNepalPhone("98-1234 5678")).toBe("+9779812345678");
    expect(normaliseNepalPhone("+977 9712345678")).toBe("+9779712345678");
    expect(normaliseNepalPhone("01-4000000")).toBeNull();
  });
  it("BUG-004: the checkout phone check is the server normaliser, so both accept the same numbers", () => {
    for (const ok of ["009779841234567", "(984)1234567", "00977-9841234567", "+977 (984) 123-4567", "9712345678"]) {
      expect(normaliseNepalPhone(ok), ok).toBe(normalizeNepalPhone(ok));
      expect(normaliseNepalPhone(ok), ok).not.toBeNull();
    }
    for (const bad of ["09841234567", "12345", "+1 9841234567", "984123456"]) {
      expect(normaliseNepalPhone(bad), bad).toBe(normalizeNepalPhone(bad));
      expect(normaliseNepalPhone(bad), bad).toBeNull();
    }
    expect(hasLeadingZeroMobile("09841234567")).toBe(true);
    expect(hasLeadingZeroMobile("9841234567")).toBe(false);
    const lines = [line(1)];
    expect(validateCheckout(values({ phone: "009779841234567" }), lines, settings, 149900).phone).toBeUndefined();
    expect(validateCheckout(values({ phone: "(984)1234567" }), lines, settings, 149900).phone).toBeUndefined();
    expect(validateCheckout(values({ phone: "09841234567" }), lines, settings, 149900).phone).toMatch(/Leave out the 0/);
  });
  it("BUG-006: money parsing is strict about commas", () => {
    expect(rupeesToPaisa("12,50")).toBeNull();
    expect(rupeesToPaisa("1,2,3")).toBeNull();
    expect(rupeesToPaisa("1.234")).toBeNull();
    expect(rupeesToPaisa("Rs. 50")).toBe(5000); // server parser allows the Rs. prefix
    expect(rupeesToPaisa("1,25,0")).toBeNull();
    expect(rupeesToPaisa("12.50")).toBe(1250);
    expect(rupeesToPaisa("1,250")).toBe(125000);
    expect(rupeesToPaisa("1,25,000")).toBe(12500000);
    expect(rupeesToPaisa("12,500.50")).toBe(1250050);
    expect(rupeesToPaisa("0")).toBe(0);
    expect(rupeesToPaisa("99999999")).toBeNull(); // above the API maximum (Rs. 2 crore)
  });
  it("BUG-006: opening hours must close after they open, in order", () => {
    expect(slotsProblem(parseSlots("18:00-09:00")!)).toMatch(/after opening/);
    expect(slotsProblem(parseSlots("09:00-09:00")!)).toMatch(/after opening/);
    expect(slotsProblem(parseSlots("14:00-20:00, 07:00-12:00")!)).toMatch(/in order/);
    expect(slotsProblem(parseSlots("07:00-12:00, 11:00-20:00")!)).toMatch(/in order/);
    expect(slotsProblem(parseSlots("07:00-12:00, 14:00-20:00")!)).toBeNull();
    expect(parseSlots("18:00-24:00")).toEqual([{ open: "18:00", close: "24:00" }]); // midnight close is allowed
    expect(slotsProblem(parseSlots("18:00-24:00")!)).toBeNull();
    expect(parseSlots("24:00-24:00")).toBeNull(); // 24:00 only as a closing time
    expect(parseSlots("18:00-24:30")).toBeNull();
  });
  it("SEC-012: only https map links render; cafe phone fields are digits", () => {
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("data:text/html,x")).toBeNull();
    expect(safeHttpsUrl("http://maps.example")).toBeNull();
    expect(safeHttpsUrl("not a url")).toBeNull();
    expect(safeHttpsUrl("https://maps.app.goo.gl/abc")).toBe("https://maps.app.goo.gl/abc");
    expect(isPlausiblePhone("01-4412345")).toBe(true);
    expect(isPlausiblePhone("+977 984-1234567")).toBe(true);
    expect(isPlausiblePhone("call me")).toBe(false);
    expect(isPlausiblePhone("12")).toBe(false);
  });
  it("parses opening-hour slots", () => {
    expect(parseSlots("7:00-12:00, 14:00-20:00")).toEqual([
      { open: "07:00", close: "12:00" },
      { open: "14:00", close: "20:00" },
    ]);
    expect(parseSlots("25:00-26:00")).toBeNull();
  });
  it("returns null hours rows when no hours are entered", () => {
    expect(hoursRows(settings.hours)).toBeNull();
  });
});

describe("image resize sizing", () => {
  it("scales by width and never upscales", () => {
    expect(targetSize(4000, 3000, 960)).toEqual({ width: 960, height: 720 });
    expect(targetSize(700, 700, 1600)).toEqual({ width: 700, height: 700 });
  });
});

describe("order state machine (UI copy of contract 3.2)", () => {
  it("is fulfilment aware", () => {
    expect(nextForwardStatus("confirmed", "delivery")).toBe("out_for_delivery");
    expect(nextForwardStatus("confirmed", "pickup")).toBe("ready_for_pickup");
    expect(canTransition("placed", "completed", "pickup")).toBe(false);
    expect(canTransition("completed", "cancelled", "pickup")).toBe(false);
    expect(canTransition("ready_for_pickup", "cancelled", "pickup")).toBe(true);
  });
  it("lets only the owner cancel late-stage orders", () => {
    expect(canCancelAs("confirmed", "staff")).toBe(true);
    expect(canCancelAs("out_for_delivery", "staff")).toBe(false);
    expect(canCancelAs("out_for_delivery", "owner")).toBe(true);
  });
});

describe("mock data and engine", () => {
  it("public snapshot hides hidden items and admin-only fields", () => {
    const snap = toMenuSnapshot(seedDb());
    const names = snap.categories.flatMap((c) => c.items.map((i) => i.name));
    expect(names).not.toContain("Hidden sample item");
    expect(snap.categories[0]?.items[0]).not.toHaveProperty("isVisible");
    for (const c of snap.categories) for (const i of c.items) if (i.imageUrl === null) expect(i.imageVariants).toEqual([]);
  });
  it("public products expose stockState, never exact stock", () => {
    const p = toPublicProducts(seedDb());
    expect(p.map((x) => x.slug)).not.toContain("sample-draft");
    expect(p[0]?.variants[0]).not.toHaveProperty("stock");
  });
  it("checks out, decrements stock, and customer cancel restocks", () => {
    const db = seedDb();
    const before = db.products[0]!.variants[0]!.stock;
    const res = mockCheckout(db, buildRequest(values(), [line(1)], "tok"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.willCallToConfirm).toBe(true);
    expect(res.data.payment).toEqual({ type: "none" });
    expect(db.products[0]!.variants[0]!.stock).toBe(before - 1);
    const cancel = mockCustomerCancel(db, res.data.orderToken);
    expect(cancel.ok && cancel.data.status).toBe("cancelled");
    expect(db.products[0]!.variants[0]!.stock).toBe(before);
  });
  it("answers blocked, capped and over-limit orders with the same generic refusal", () => {
    const db = seedDb();
    mockBlock(db, { kind: "phone", value: "9812345678" });
    const blocked = mockCheckout(db, buildRequest(values(), [line(1)], "t"));
    const db2 = seedDb();
    db2.settings.codMaxTotal = 1000;
    const over = mockCheckout(db2, buildRequest(values(), [line(1)], "t"));
    expect(blocked.ok || over.ok).toBe(false);
    if (!blocked.ok && !over.ok) {
      expect(blocked.error.code).toBe("ORDER_REFUSED");
      expect(blocked.error.message).toBe(over.error.message);
    }
  });
  it("BUG-003: a COD maximum of 0 means no limit (null too); a positive value still refuses", () => {
    for (const limit of [0, null]) {
      const db = seedDb();
      db.settings.codMaxTotal = limit;
      const res = mockCheckout(db, buildRequest(values(), [line(1, 149900, 9)], "t"));
      expect(res.ok, String(limit)).toBe(true);
    }
    const db = seedDb();
    db.settings.codMaxTotal = 100;
    const refused = mockCheckout(db, buildRequest(values(), [line(1)], "t"));
    expect(!refused.ok && refused.error.code).toBe("ORDER_REFUSED");
  });
  it("auto-cancel: placed orders older than the setting are cancelled as auto_unconfirmed and restocked; null = off", () => {
    const db = seedDb();
    const stock = db.products[0]!.variants[0]!.stock;
    const later = Date.now() + 3 * 60 * 60 * 1000; // 3 h from now: both seeded placed orders are past 120 min
    const off = seedDb();
    off.settings.autoCancelPlacedAfterMinutes = null;
    sweepAutoCancel(off, later);
    expect(off.orders.filter((o) => o.status === "cancelled")).toHaveLength(0);
    sweepAutoCancel(db, later);
    const auto = db.orders.filter((o) => o.cancelReason === "auto_unconfirmed");
    expect(auto.map((o) => o.number).sort()).toEqual(["NC-1041", "NC-1043"]);
    expect(db.orders.find((o) => o.number === "NC-1042")!.status).toBe("confirmed"); // confirmed orders are left alone
    expect(db.products[0]!.variants[0]!.stock).toBe(stock + 2);
    const view = mockOrderByToken(db, auto[0]!.token);
    expect(view.ok && view.data.cancelReason).toBe("auto_unconfirmed");
  });
  it("orders paused: checkout answers ORDERS_PAUSED before anything else", () => {
    const db = seedDb();
    db.settings.ordersPaused = true;
    const res = mockCheckout(db, buildRequest(values(), [line(1)], "t"));
    expect(!res.ok && (res.error.code as string)).toBe("ORDERS_PAUSED");
    expect(db.orders).toHaveLength(3); // nothing created
  });
  it("reports out of stock per line and rejects customer cancel after confirm", () => {
    const db = seedDb();
    const out = mockCheckout(db, buildRequest(values(), [line(3)], "t")); // XL, stock 0
    expect(!out.ok && out.error.code).toBe("OUT_OF_STOCK");
    const placed = db.orders.find((o) => o.status === "placed")!;
    expect(mockUpdateStatus(db, placed.id, "confirmed").ok).toBe(true);
    const c = mockCustomerCancel(db, placed.token);
    expect(!c.ok && c.error.code).toBe("CONFLICT");
  });
  it("completing an order records cash as paid; staff cannot cancel late-stage orders", () => {
    const db = seedDb();
    const o = db.orders.find((x) => x.status === "confirmed")!; // pickup
    expect(mockUpdateStatus(db, o.id, "ready_for_pickup").ok).toBe(true);
    const staffCancel = mockCancelOrder(db, { orderId: o.id, reason: "no_show", restock: true }, "staff");
    expect(!staffCancel.ok && staffCancel.error.code).toBe("FORBIDDEN");
    const done = mockUpdateStatus(db, o.id, "completed");
    expect(done.ok && done.data.paymentStatus).toBe("paid");
  });
});

import { safeNextPath } from "@/components/admin/safe-next";

describe("safeNextPath", () => {
  it("follows only internal admin paths", () => {
    expect(safeNextPath("/admin/menu")).toBe("/admin/menu");
    expect(safeNextPath("/admin")).toBe("/admin");
    for (const bad of ["https://evil.example", "//evil.example", "/\evil", "/shop", "/administrator", "/admin/login", "javascript:alert(1)", "/admin/\nx", null, ""]) {
      expect(safeNextPath(bad)).toBe("/admin");
    }
  });
});

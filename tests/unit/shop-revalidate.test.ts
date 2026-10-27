import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCheckout, type CheckoutDeps } from "@/lib/orders/checkout";
import { handleOrderCancel } from "@/lib/orders/public";
import {
  revalidateShopAfterCancel,
  revalidateShopAfterCheckout,
  SHOP_REVALIDATE_KEY,
  SHOP_REVALIDATE_WINDOW_SECONDS,
  shopRevalidateGate,
} from "@/lib/orders/shop-revalidate";
import type { OrderWithItems } from "@/lib/orders/view";
import { fakeDb, ok, pgErr, type PgResult } from "./helpers/fake-db";

/** ADR 0001 F1: coalesced, threshold-aware `shop` revalidation after checkout and customer cancel. */

const SALT = "test-salt-0123456789-0123456789-abc";
const V1 = "3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";
const V2 = "4f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3c";
const TOKEN = "5f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3d";

const allowed: PgResult = ok([{ allowed: true, remaining: 0, retry_after_seconds: 0 }]);
const denied: PgResult = ok([{ allowed: false, remaining: 0, retry_after_seconds: 300 }]);

/**
 * A tiny in-memory stand-in for rate_limit_hit_info on the `revalidate:shop` key: one hit allowed per window,
 * with a controllable clock, so the 10-minute coalescing can be exercised end to end.
 */
function windowGate(now: () => number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (a: Record<string, unknown>): PgResult => {
    const key = String(a.p_key);
    const span = Number(a.p_window_seconds) * 1000;
    const start = Math.floor(now() / span) * span;
    const w = windows.get(key);
    const cur = w && w.start === start ? w : { start, count: 0 };
    cur.count += 1;
    windows.set(key, cur);
    return ok([{ allowed: cur.count <= Number(a.p_max), remaining: 0, retry_after_seconds: 0 }]);
  };
}

const variants = (...states: string[]) => ok(states.map((s, i) => ({ id: [V1, V2][i], stock_state: s })));

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("shopRevalidateGate", () => {
  it("uses rate_limits key revalidate:shop, 600 s window, max 1", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => allowed } });
    expect(await shopRevalidateGate(f.db)).toBe(true);
    expect(f.rpcCalls[0]).toEqual({
      name: "rate_limit_hit_info",
      args: { p_key: SHOP_REVALIDATE_KEY, p_window_seconds: 600, p_max: 1 },
    });
    expect(SHOP_REVALIDATE_WINDOW_SECONDS).toBe(600);
  });
  it("fails closed: database error, no row or a throw = do not revalidate", async () => {
    expect(await shopRevalidateGate(fakeDb({ rpc: { rate_limit_hit_info: () => pgErr("57014", "timeout") } }).db)).toBe(false);
    expect(await shopRevalidateGate(fakeDb({ rpc: { rate_limit_hit_info: () => ok([]) } }).db)).toBe(false);
    expect(await shopRevalidateGate(fakeDb({ rpc: { rate_limit_hit_info: () => denied } }).db)).toBe(false);
    const throwing = { rpc: () => Promise.reject(new Error("network")) } as unknown as Parameters<typeof shopRevalidateGate>[0];
    expect(await shopRevalidateGate(throwing)).toBe(false);
  });
});

describe("revalidateShopAfterCheckout", () => {
  it("in_stock everywhere: not needed, and the gate is NOT consumed", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => allowed }, tables: { product_variants: variants("in_stock", "in_stock") } });
    const revalidate = vi.fn();
    expect(await revalidateShopAfterCheckout(f.db, [V1, V2], revalidate)).toBe("not-needed");
    expect(revalidate).not.toHaveBeenCalled();
    expect(f.rpcCalls).toHaveLength(0);
  });
  it.each(["few_left", "sold_out"])("a variant now %s: revalidates once", async (state) => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => allowed }, tables: { product_variants: variants("in_stock", state) } });
    const revalidate = vi.fn();
    expect(await revalidateShopAfterCheckout(f.db, [V1, V2, V1], revalidate)).toBe("revalidated");
    expect(revalidate).toHaveBeenCalledTimes(1);
    // reads only the ordered variants, de-duplicated
    const inCall = f.tableCalls[0]?.calls.find((c) => c.op === "in");
    expect(inCall?.args).toEqual(["id", [V1, V2]]);
  });
  it("coalesced: inside the window the second low-stock order does not revalidate", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => denied }, tables: { product_variants: variants("sold_out") } });
    const revalidate = vi.fn();
    expect(await revalidateShopAfterCheckout(f.db, [V1], revalidate)).toBe("coalesced");
    expect(revalidate).not.toHaveBeenCalled();
  });
  it("stock read fails: skipped (fail closed on cost), gate not consumed", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => allowed }, tables: { product_variants: pgErr("57014", "timeout") } });
    const revalidate = vi.fn();
    expect(await revalidateShopAfterCheckout(f.db, [V1], revalidate)).toBe("skipped-error");
    expect(revalidate).not.toHaveBeenCalled();
    expect(f.rpcCalls).toHaveLength(0);
  });
  it("revalidateTag throwing is swallowed", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => allowed }, tables: { product_variants: variants("sold_out") } });
    const outcome = await revalidateShopAfterCheckout(f.db, [V1], () => {
      throw new Error("static generation store missing");
    });
    expect(outcome).toBe("skipped-error");
  });
  it("at most once per 10 minutes across many orders (simulated clock)", async () => {
    let t = Date.UTC(2026, 9, 22, 6, 0, 0);
    const f = fakeDb({ rpc: { rate_limit_hit_info: windowGate(() => t) }, tables: { product_variants: variants("few_left") } });
    const revalidate = vi.fn();
    // 30 low-stock orders, one a minute, over 30 minutes = 3 windows = 3 revalidations
    for (let i = 0; i < 30; i++) {
      await revalidateShopAfterCheckout(f.db, [V1], revalidate);
      t += 60_000;
    }
    expect(revalidate).toHaveBeenCalledTimes(3);
  });
});

describe("revalidateShopAfterCancel", () => {
  it("restocked: revalidates (gated); not restocked: nothing, gate untouched", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => allowed } });
    const revalidate = vi.fn();
    expect(await revalidateShopAfterCancel(f.db, false, revalidate)).toBe("not-needed");
    expect(f.rpcCalls).toHaveLength(0);
    expect(await revalidateShopAfterCancel(f.db, true, revalidate)).toBe("revalidated");
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});

// ---- wiring in the route handlers: post-response only ----------------------------------------------------

const created = ok([
  { out_order_id: "11111111-1111-4111-8111-111111111111", out_order_token: TOKEN, out_order_number: "NC-1042", out_total_paisa: 55000, out_status: "placed" },
]);
const checkoutReq = () =>
  new Request("https://cafe.test/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({
      items: [{ variantId: V1, qty: 2 }],
      fulfilment: "pickup",
      paymentMethod: "pickup",
      customer: { name: "Sita Rai", phone: "9841234567" },
      turnstileToken: "tok",
    }),
  });

function checkoutSetup(create: PgResult, stock = "sold_out") {
  const f = fakeDb({
    rpc: { rate_limit_hit_info: () => allowed, create_order: () => create },
    tables: { product_variants: variants(stock), public_settings: ok({ phone: null }), rate_limits: ok([]) },
  });
  const scheduled: (() => Promise<unknown>)[] = [];
  const revalidateShop = vi.fn();
  const deps: CheckoutDeps = {
    db: () => f.db,
    salt: () => SALT,
    siteUrl: () => undefined,
    schedule: (w) => void scheduled.push(w),
    turnstile: vi.fn(async () => undefined),
    revalidateShop,
  };
  return { f, deps, scheduled, revalidateShop };
}

describe("checkout wiring", () => {
  it("success: nothing is read or revalidated before the response; the scheduled work revalidates", async () => {
    const s = checkoutSetup(created);
    const res = await handleCheckout(checkoutReq(), s.deps);
    expect(res.status).toBe(201);
    // before the post-response work runs: no stock read, no shop gate hit, no revalidation (SEC-001 order intact)
    expect(s.f.tableCalls.some((t) => t.table === "product_variants")).toBe(false);
    expect(s.f.rpcCalls.map((c) => c.name)).toEqual(["rate_limit_hit_info", "create_order"]);
    expect(s.revalidateShop).not.toHaveBeenCalled();
    for (const w of s.scheduled) await w();
    expect(s.revalidateShop).toHaveBeenCalledTimes(1);
    expect(s.f.rpcCalls.some((c) => c.args.p_key === SHOP_REVALIDATE_KEY)).toBe(true);
  });
  it("success with stock still in_stock: no revalidation", async () => {
    const s = checkoutSetup(created, "in_stock");
    await handleCheckout(checkoutReq(), s.deps);
    for (const w of s.scheduled) await w();
    expect(s.revalidateShop).not.toHaveBeenCalled();
  });
  it("refused or out-of-stock orders schedule no revalidation", async () => {
    for (const err of [pgErr("P0001", "ORDER_REFUSED"), pgErr("P0001", "OUT_OF_STOCK", JSON.stringify({ "items.0": ["sold out"] }))]) {
      const s = checkoutSetup(err);
      await handleCheckout(checkoutReq(), s.deps);
      for (const w of s.scheduled) await w();
      expect(s.revalidateShop).not.toHaveBeenCalled();
      expect(s.f.tableCalls.some((t) => t.table === "product_variants")).toBe(false);
    }
  });
});

const order = (over: Partial<OrderWithItems>): OrderWithItems =>
  ({
    id: "11111111-1111-4111-8111-111111111111", number: "NC-1042", public_token: TOKEN, status: "placed", fulfilment: "pickup",
    payment_method: "pickup", payment_status: "unpaid", subtotal_paisa: 100, delivery_fee_paisa: 0, vat_paisa: 0, total_paisa: 100,
    customer_name: "Sita", customer_phone: "+9779841234567", customer_email: null, address: null, landmark: null, area: null,
    notes: null, cancel_reason: null, stock_restocked_at: null, created_at: new Date().toISOString(), confirmed_at: null,
    completed_at: null, cancelled_at: null, order_items: [], ...over,
  }) as OrderWithItems;

function cancelSetup(before: OrderWithItems, after: OrderWithItems) {
  let reads = 0;
  const f = fakeDb({
    rpc: { rate_limit_hit_info: () => allowed, customer_cancel_order: () => ok(null) },
    tables: { orders: () => ok(++reads === 1 ? before : after), rate_limits: ok([]) },
  });
  const scheduled: (() => Promise<unknown>)[] = [];
  const revalidateShop = vi.fn();
  const deps = { db: () => f.db, salt: () => SALT, schedule: (w: () => Promise<unknown>) => void scheduled.push(w), revalidateShop };
  return { f, deps, scheduled, revalidateShop };
}
const cancelReq = () => new Request("https://cafe.test/x", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.7" } });

describe("customer cancel wiring", () => {
  it("a cancel that restocked revalidates shop in post-response work only", async () => {
    const s = cancelSetup(
      order({}),
      order({ status: "cancelled", cancel_reason: "customer_request", stock_restocked_at: new Date().toISOString() }),
    );
    const res = await handleOrderCancel(cancelReq(), TOKEN, s.deps);
    expect(res.status).toBe(200);
    expect(s.revalidateShop).not.toHaveBeenCalled();
    for (const w of s.scheduled) await w();
    expect(s.revalidateShop).toHaveBeenCalledTimes(1);
  });
  it("an idempotent repeat (already cancelled and restocked) does not revalidate", async () => {
    const done = order({ status: "cancelled", cancel_reason: "customer_request", stock_restocked_at: new Date().toISOString() });
    const s = cancelSetup(done, done);
    await handleOrderCancel(cancelReq(), TOKEN, s.deps);
    for (const w of s.scheduled) await w();
    expect(s.revalidateShop).not.toHaveBeenCalled();
  });
  it("a cancel that restocked nothing does not revalidate", async () => {
    const s = cancelSetup(order({}), order({ status: "cancelled", cancel_reason: "customer_request" }));
    await handleOrderCancel(cancelReq(), TOKEN, s.deps);
    for (const w of s.scheduled) await w();
    expect(s.revalidateShop).not.toHaveBeenCalled();
  });
});

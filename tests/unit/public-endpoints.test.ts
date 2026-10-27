import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleHealth } from "@/lib/health";
import { cachedMenu, clearMenuCache, getPublicMenu, imageVariantsFor } from "@/lib/data/menu";
import { handleMenu } from "@/lib/menu-route";
import { handleOrderCancel, handleOrderGet } from "@/lib/orders/public";
import { toAdminOrderRow, toOrderView, type OrderWithItems } from "@/lib/orders/view";
import { formatNewOrderAlert, sendTelegram } from "@/lib/notify/telegram";
import { fakeDb, ok, pgErr, type PgResult } from "./helpers/fake-db";

const SALT = "test-salt-0123456789-0123456789-abc";
const TOKEN = "3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";
const allowed: PgResult = ok([{ allowed: true, remaining: 29, retry_after_seconds: 0 }]);
const get = (headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7" }) => new Request("https://cafe.test/x", { headers });
const post = () => new Request("https://cafe.test/x", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.7" } });
const json = async (r: Response) => (await r.json()) as { ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> };

const orderRow = (over: Partial<OrderWithItems> = {}): OrderWithItems =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    number: "NC-1042",
    public_token: TOKEN,
    status: "placed",
    fulfilment: "delivery",
    payment_method: "cod",
    payment_status: "unpaid",
    prices_include_vat: true,
    subtotal_paisa: 50000,
    service_charge_paisa: 0,
    delivery_fee_paisa: 5000,
    vat_paisa: 6500,
    total_paisa: 55000,
    customer_name: "Sita Kumari Rai",
    customer_phone: "+9779841234567",
    customer_email: "sita@example.com",
    address: "Ward 4",
    landmark: "Blue gate",
    area: "Baneshwor",
    notes: null,
    ip_hash: "a".repeat(64),
    personal_data_purged_at: null,
    cancel_reason: null,
    stock_restocked_at: null,
    created_at: new Date().toISOString(),
    confirmed_at: null,
    completed_at: null,
    cancelled_at: null,
    updated_at: new Date().toISOString(),
    order_items: [{ name: "Nailed Tee", variant_label: "M / Black", unit_price_paisa: 25000, qty: 2 }],
    ...over,
  }) as OrderWithItems;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearMenuCache();
});

describe("order view mapping", () => {
  it("public view never contains phone, address, email or full name", () => {
    const v = toOrderView(orderRow());
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/9841234567|Ward 4|Blue gate|sita@example|Kumari|Baneshwor|ip_hash/);
    expect(v.customerName).toBe("Sita");
    expect(v.canCancel).toBe(true);
    expect(v.items).toEqual([{ name: "Nailed Tee (M / Black)", qty: 2, unitPrice: 25000 }]);
    expect(v.total).toBe(55000);
  });
  it("canCancel is only true while placed", () => {
    for (const s of ["confirmed", "out_for_delivery", "ready_for_pickup", "completed", "cancelled"] as const) {
      expect(toOrderView(orderRow({ status: s })).canCancel).toBe(false);
    }
  });
  it("admin row adds contact data, stale flag (placed > 30 min) and blocked flag", () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    const row = toAdminOrderRow(orderRow({ created_at: old }), new Set(["+9779841234567"]));
    expect(row.isStale).toBe(true);
    expect(row.phoneIsBlocked).toBe(true);
    expect(row.customerPhone).toBe("+9779841234567");
    expect(toAdminOrderRow(orderRow(), new Set()).isStale).toBe(false);
    expect(toAdminOrderRow(orderRow({ created_at: old, status: "confirmed" }), new Set()).isStale).toBe(false);
  });
  it("purged orders do not crash", () => {
    const v = toOrderView(orderRow({ customer_name: null }));
    expect(v.customerName).toBe("Customer");
  });
});

describe("GET /api/orders/[token]", () => {
  const deps = (f: ReturnType<typeof fakeDb>) => ({ db: () => f.db, salt: () => SALT, schedule: vi.fn() });

  it("returns the OrderView for a known token", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => allowed }, tables: { orders: ok(orderRow()) } });
    const res = await handleOrderGet(get(), TOKEN, deps(f));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await json(res)).data).toMatchObject({ number: "NC-1042", status: "placed", canCancel: true });
    expect(f.rpcCalls[0]?.args).toMatchObject({ p_window_seconds: 60, p_max: 30 });
  });
  it("malformed and unknown tokens give the identical NOT_FOUND", async () => {
    const f1 = fakeDb({ rpc: { rate_limit_hit_info: () => allowed }, tables: { orders: ok(null) } });
    const unknown = await handleOrderGet(get(), TOKEN, deps(f1));
    const malformed = await handleOrderGet(get(), "not-a-uuid", deps(f1));
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    const a = await json(unknown);
    const b = await json(malformed);
    expect(a.error?.code).toBe("NOT_FOUND");
    expect(a.error?.message).toBe(b.error?.message);
  });
  it("rate limited -> 429 with Retry-After", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => ok([{ allowed: false, remaining: 0, retry_after_seconds: 12 }]) } });
    const res = await handleOrderGet(get(), TOKEN, deps(f));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
  });
});

describe("POST /api/orders/[token]/cancel", () => {
  const mk = (before: OrderWithItems, after: OrderWithItems, cancel: PgResult) => {
    let reads = 0;
    const f = fakeDb({
      rpc: { rate_limit_hit_info: () => allowed, customer_cancel_order: () => cancel },
      tables: { orders: () => ok(++reads === 1 ? before : after) },
    });
    const schedule = vi.fn();
    return { f, schedule, deps: { db: () => f.db, salt: () => SALT, schedule } };
  };

  it("cancels a placed order and alerts staff once", async () => {
    const m = mk(orderRow(), orderRow({ status: "cancelled", cancel_reason: "customer_request" }), ok(orderRow()));
    const res = await handleOrderCancel(post(), TOKEN, m.deps);
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ status: "cancelled", canCancel: false });
    expect(m.f.rpcCalls.map((c) => c.name)).toEqual(["rate_limit_hit_info", "customer_cancel_order"]);
    expect(m.f.rpcCalls[0]?.args).toMatchObject({ p_window_seconds: 3600, p_max: 10 });
    expect(m.schedule).toHaveBeenCalledTimes(1);
  });
  it("is idempotent: cancelling again returns success and does not alert again", async () => {
    const done = orderRow({ status: "cancelled", cancel_reason: "customer_request" });
    const m = mk(done, done, ok(done));
    const res = await handleOrderCancel(post(), TOKEN, m.deps);
    expect(res.status).toBe(200);
    expect(m.schedule).not.toHaveBeenCalled();
  });
  it("after confirmation -> CONFLICT 409 with the call-us message", async () => {
    const m = mk(orderRow({ status: "confirmed" }), orderRow({ status: "confirmed" }), pgErr("P0001", "CONFLICT", "", "Please call us to change this order"));
    const res = await handleOrderCancel(post(), TOKEN, m.deps);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({ code: "CONFLICT", message: "Please call us to change this order" });
  });
  it("unknown token -> NOT_FOUND and no cancel RPC", async () => {
    const m = mk(orderRow(), orderRow(), ok(null));
    const res = await handleOrderCancel(post(), "garbage", m.deps);
    expect(res.status).toBe(404);
    expect(m.f.rpcCalls.some((c) => c.name === "customer_cancel_order")).toBe(false);
  });
});

describe("GET /api/health", () => {
  it("db up, 200, no-store, only db + time", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => allowed, health_ping: () => ok("2026-10-19T00:00:00Z") } });
    const res = await handleHealth(get(), { db: () => f.db, salt: () => SALT, now: () => new Date("2026-10-19T08:30:00Z") });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await json(res)).toEqual({ ok: true, data: { db: "up", time: "2026-10-19T08:30:00.000Z" } });
    expect(f.rpcCalls.map((c) => c.name)).toEqual(["rate_limit_hit_info", "health_ping"]);
    expect(f.rpcCalls[0]?.args).toMatchObject({ p_window_seconds: 60, p_max: 30 });
  });
  it("database down is still HTTP 200 with db: down (and leaks no error text)", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => pgErr("08006", "connection refused to 10.0.0.1"), health_ping: () => pgErr("08006", "connection refused to 10.0.0.1") } });
    const res = await handleHealth(get(), { db: () => f.db, salt: () => SALT });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data?.db).toBe("down");
    expect(JSON.stringify(body)).not.toMatch(/10\.0\.0\.1|refused/);
  });
  it("missing configuration reports down instead of throwing", async () => {
    const res = await handleHealth(get(), { db: () => { throw new Error("no key"); }, salt: () => SALT });
    expect((await json(res)).data?.db).toBe("down");
  });
  it("over 30/min/IP -> 429 with Retry-After", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => ok([{ allowed: false, remaining: 0, retry_after_seconds: 7 }]) } });
    const res = await handleHealth(get(), { db: () => f.db, salt: () => SALT });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(f.rpcCalls.some((c) => c.name === "health_ping")).toBe(false);
  });
});

describe("GET /api/menu", () => {
  const settings = { hours: { weekly: {}, closures: [] }, announcement: null, prices_include_vat: true, service_charge_pct: "0", vat_pct: 13 };
  const tables = (fail = false) => ({
    menu_categories: fail ? pgErr("08006", "down") : ok([{ id: "c1", slug: "coffee", name: "Coffee", sort_order: 1, is_visible: true }]),
    menu_items: ok([
      { id: "i1", category_id: "c1", name: "Latte", description: null, price_paisa: 35000, diet: "veg", tags: ["new"], is_sold_out: false, is_visible: true, image_path: "menu/abc", sort_order: 1, deleted_at: null },
    ]),
    menu_variants: ok([{ id: "v1", item_id: "i1", kind: "size", label: "Large", price_delta_paisa: 5000, is_sold_out: false, sort_order: 1 }]),
    menu_specials: ok([]),
    public_settings: ok(settings),
  });
  // limiterDb = the same fake: it has no rate_limit_hit_info handler, so the limiter fails OPEN (as designed).
  const deps = (f: ReturnType<typeof fakeDb>, limiter: ReturnType<typeof fakeDb> = f) => ({
    db: () => f.db,
    supabaseUrl: () => "https://proj.supabase.co",
    limiterDb: () => limiter.db,
    salt: () => SALT,
  });

  it("SEC-021: per-IP limit 180 / min (ESTIMATE); over it -> 429 with Retry-After and NO menu query", async () => {
    const f = fakeDb({ tables: tables() });
    const limiter = fakeDb({ rpc: { rate_limit_hit_info: () => ok([{ allowed: false, remaining: 0, retry_after_seconds: 12 }]) } });
    const res = await handleMenu(get(), deps(f, limiter));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await json(res)).error?.code).toBe("RATE_LIMITED");
    expect(f.tableCalls).toHaveLength(0);
    expect(limiter.rpcCalls[0]?.args).toMatchObject({ p_window_seconds: 60, p_max: 180 });
    expect(String(limiter.rpcCalls[0]?.args.p_key)).toMatch(/^menu:ip:[0-9a-f]{64}$/);
  });
  it("SEC-021: within the limit the menu is served as before", async () => {
    const limiter = fakeDb({ rpc: { rate_limit_hit_info: () => ok([{ allowed: true, remaining: 100, retry_after_seconds: 0 }]) } });
    const res = await handleMenu(get(), deps(fakeDb({ tables: tables() }), limiter));
    expect(res.status).toBe(200);
    expect(limiter.rpcCalls).toHaveLength(1);
  });
  it("SEC-021: the limiter fails open when its database (or the salt) is unavailable", async () => {
    const down = fakeDb({ rpc: { rate_limit_hit_info: () => pgErr("08006", "down") } });
    expect((await handleMenu(get(), deps(fakeDb({ tables: tables() }), down))).status).toBe(200);
    const noSalt = { ...deps(fakeDb({ tables: tables() })), salt: () => { throw new Error("IP_HASH_SALT missing"); } };
    expect((await handleMenu(get(), noSalt)).status).toBe(200);
  });

  it("maps rows to the contract shape with image variants", async () => {
    const res = await handleMenu(get(), deps(fakeDb({ tables: tables() })));
    const body = await json(res);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=15, stale-while-revalidate=60");
    const cat = (body.data?.categories as { items: Record<string, unknown>[] }[])[0]!;
    expect(cat.items[0]).toMatchObject({
      price: 35000,
      isSoldOut: false,
      imageUrl: "https://proj.supabase.co/storage/v1/object/public/public-media/menu/abc/960.webp",
      variants: [{ id: "v1", priceDelta: 5000, label: "Large", kind: "size", isSoldOut: false }],
    });
    expect((cat.items[0]!.imageVariants as unknown[]).length).toBe(3);
    expect(body.data?.degraded).toBeUndefined();
    expect((body.data?.settings as Record<string, unknown>).vatPct).toBe(13);
  });
  it("database down with a cached copy -> same payload with degraded: true and the old updatedAt", async () => {
    const first = await json(await handleMenu(get(), deps(fakeDb({ tables: tables() }))));
    const res = await handleMenu(get(), deps(fakeDb({ tables: tables(true) })));
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data?.degraded).toBe(true);
    expect(body.data?.updatedAt).toBe(first.data?.updatedAt);
    expect(body.data?.categories).toEqual(first.data?.categories);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("database down and no cached copy -> INTERNAL 500 (page falls back to the static menu)", async () => {
    expect(cachedMenu()).toBeNull();
    const res = await handleMenu(get(), deps(fakeDb({ tables: tables(true) })));
    expect(res.status).toBe(500);
    expect((await json(res)).error?.code).toBe("INTERNAL");
  });
  it("excludes nothing itself but only asks for visible, non-deleted rows and unexpired specials", async () => {
    const f = fakeDb({ tables: tables() });
    await getPublicMenu(f.db, "https://x.co", new Date("2026-10-19T00:00:00Z"));
    const calls = (t: string) => f.tableCalls.find((c) => c.table === t)!.calls;
    expect(calls("menu_items").some((c) => c.op === "eq" && c.args[0] === "is_visible" && c.args[1] === true)).toBe(true);
    expect(calls("menu_items").some((c) => c.op === "is" && c.args[0] === "deleted_at")).toBe(true);
    expect(calls("menu_categories").some((c) => c.op === "eq" && c.args[0] === "is_visible")).toBe(true);
    expect(String(calls("menu_specials").find((c) => c.op === "or")?.args[0])).toContain("ends_at.gt.2026-10-19T00:00:00.000Z");
  });
  it("imageVariantsFor is empty without an image", () => {
    expect(imageVariantsFor(null, "https://x.co")).toEqual([]);
  });
});

describe("Telegram notifier", () => {
  it("no-ops without env", async () => {
    const f = vi.fn();
    expect(await sendTelegram("hi", f as unknown as typeof fetch)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it("swallows network failures", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "t");
    vi.stubEnv("TELEGRAM_CHAT_ID", "c");
    const f = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await sendTelegram("hi", f as unknown as typeof fetch)).toBe(false);
  });
  it("formats a singular item and omits the link without a site url", () => {
    const t = formatNewOrderAlert({ orderId: "x", orderNumber: "NC-1", itemCount: 1, fulfilment: "pickup", total: 12000 }, undefined);
    expect(t).toBe("New order NC-1: 1 item, pickup, Rs. 120. Call to confirm.");
  });
});

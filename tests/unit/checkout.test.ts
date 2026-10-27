import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCheckout, type CheckoutDeps } from "@/lib/orders/checkout";
import { AppError } from "@/lib/errors";
import { fakeDb, ok, pgErr, type PgResult } from "./helpers/fake-db";

const SALT = "test-salt-0123456789-0123456789-abc";
const UUID = "3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";

const allowed: PgResult = ok([{ allowed: true, remaining: 4, retry_after_seconds: 0 }]);
const created = ok([
  { out_order_id: "11111111-1111-4111-8111-111111111111", out_order_token: UUID, out_order_number: "NC-1042", out_total_paisa: 55000, out_status: "placed" },
]);

const pickupBody = {
  items: [{ variantId: UUID, qty: 2 }],
  fulfilment: "pickup",
  paymentMethod: "pickup",
  customer: { name: "Sita Rai", phone: "98 4123-4567" },
  turnstileToken: "tok",
};
const deliveryBody = {
  ...pickupBody,
  fulfilment: "delivery",
  paymentMethod: "cod",
  delivery: { address: "Ward 4, Lane 2", landmark: "Blue gate", area: "Baneshwor" },
  customer: { name: "Sita Rai", phone: "9841234567", email: "sita@example.com" },
  notes: "No onion",
};

function req(body: unknown, headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.9" }) {
  return new Request("https://cafe.test/api/checkout", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function setup(rpc: Record<string, (a: Record<string, unknown>) => PgResult> = {}, tables = {}) {
  const f = fakeDb({
    rpc: { rate_limit_hit_info: () => allowed, create_order: () => created, ...rpc },
    tables: { public_settings: ok({ phone: "01-4000000" }), ...tables },
  });
  const scheduled: (() => Promise<unknown>)[] = [];
  const fetchImpl = vi.fn(async (...args: unknown[]) => (void args, new Response("{}", { status: 200 })));
  const deps: CheckoutDeps = {
    db: () => f.db,
    salt: () => SALT,
    siteUrl: () => "https://cafe.test",
    schedule: (w) => void scheduled.push(w),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    turnstile: vi.fn(async () => undefined),
  };
  return { ...f, deps, scheduled, fetchImpl };
}

const json = async (r: Response) => (await r.json()) as { ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> };

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "bot-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "chat-1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://cafe.test");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/checkout: validation (before anything else runs)", () => {
  it("rejects bad JSON with VALIDATION and touches nothing", async () => {
    const s = setup();
    const res = await handleCheckout(req("{not json"), s.deps);
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("VALIDATION");
    expect(s.rpcCalls).toHaveLength(0);
    expect(s.deps.turnstile).not.toHaveBeenCalled();
  });

  it("returns fieldErrors keyed by path", async () => {
    const s = setup();
    const res = await handleCheckout(
      req({ ...pickupBody, items: [{ variantId: "nope", qty: 11 }], customer: { name: "A", phone: "123" } }),
      s.deps,
    );
    const body = await json(res);
    expect(res.status).toBe(400);
    const fe = body.error?.fieldErrors as Record<string, string[]>;
    expect(Object.keys(fe)).toEqual(expect.arrayContaining(["items.0.variantId", "items.0.qty", "customer.name", "customer.phone"]));
    expect(s.rpcCalls).toHaveLength(0);
  });

  it("requires delivery details for delivery and a payment method that matches the fulfilment", async () => {
    const s = setup();
    const noAddress = await json(await handleCheckout(req({ ...deliveryBody, delivery: undefined }), s.deps));
    expect(noAddress.error?.fieldErrors).toHaveProperty("delivery");
    const wrongMethod = await json(await handleCheckout(req({ ...pickupBody, paymentMethod: "cod" }), s.deps));
    expect(wrongMethod.error?.fieldErrors).toHaveProperty("paymentMethod");
  });

  it("rejects an online payment method (v1 is cash only)", async () => {
    const s = setup();
    const res = await handleCheckout(req({ ...deliveryBody, paymentMethod: "esewa" }), s.deps);
    expect((await json(res)).error?.code).toBe("VALIDATION");
  });

  it("limits: 20 lines max, qty 1..10", async () => {
    const s = setup();
    const many = Array.from({ length: 21 }, () => ({ variantId: UUID, qty: 1 }));
    expect((await json(await handleCheckout(req({ ...pickupBody, items: many }), s.deps))).error?.code).toBe("VALIDATION");
    expect((await json(await handleCheckout(req({ ...pickupBody, items: [{ variantId: UUID, qty: 0 }] }), s.deps))).error?.code).toBe("VALIDATION");
  });
});

describe("POST /api/checkout: abuse controls", () => {
  it("Turnstile failure -> BOT_CHECK_FAILED 400, no rate limit, no order", async () => {
    const s = setup();
    s.deps.turnstile = vi.fn(async () => {
      throw new AppError("BOT_CHECK_FAILED");
    });
    const res = await handleCheckout(req(pickupBody), s.deps);
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("BOT_CHECK_FAILED");
    expect(s.rpcCalls).toHaveLength(0);
  });

  it("runs Turnstile, then the IP limit (5/10min), then create_order; no per-phone attempt limiter (SEC-002)", async () => {
    const s = setup();
    await handleCheckout(req(pickupBody), s.deps);
    const names = s.rpcCalls.map((c) => c.name);
    expect(names).toEqual(["rate_limit_hit_info", "create_order"]);
    expect(s.rpcCalls[0]?.args).toMatchObject({ p_window_seconds: 600, p_max: 5 });
    expect(String(s.rpcCalls[0]?.args.p_key)).toMatch(/^checkout:ip:[0-9a-f]{64}$/);
    expect(s.rpcCalls.some((c) => String(c.args.p_key ?? "").includes(":phone:"))).toBe(false);
  });

  it("SEC-002: rejected checkouts naming phone P from one IP do not stop a genuine order for P from another IP", async () => {
    // An in-memory stand-in for rate_limit_hit_info: every key gets its own counter, limit as asked.
    const counters = new Map<string, number>();
    const hit = (a: Record<string, unknown>) => {
      const n = (counters.get(String(a.p_key)) ?? 0) + 1;
      counters.set(String(a.p_key), n);
      return ok([{ allowed: n <= Number(a.p_max), remaining: 0, retry_after_seconds: n <= Number(a.p_max) ? 0 : 60 }]);
    };
    const attacker = { "cf-connecting-ip": "198.51.100.66" };
    for (let i = 0; i < 5; i++) {
      const s = setup({ rate_limit_hit_info: hit, create_order: () => pgErr("P0001", "OUT_OF_STOCK", JSON.stringify({ "items.0": ["sold out"] })) });
      expect((await handleCheckout(req(pickupBody, attacker), s.deps)).status).toBe(409);
    }
    const victim = setup({ rate_limit_hit_info: hit });
    const res = await handleCheckout(req(pickupBody, { "cf-connecting-ip": "203.0.113.200" }), victim.deps);
    expect(res.status).toBe(201);
  });

  it("the per-phone order cap now comes from the database (real orders only): RATE_LIMITED -> 429 with Retry-After", async () => {
    const s = setup({ create_order: () => pgErr("P0001", "RATE_LIMITED", JSON.stringify({ retryAfterSeconds: 3600 })) });
    const res = await handleCheckout(req(pickupBody), s.deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
  });

  it("SEC-009: in production a spoofed x-forwarded-for is ignored; no IP means the shared 'unknown' bucket, never a null ip_hash", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    const a = setup();
    await handleCheckout(req(pickupBody, { "x-forwarded-for": "6.6.6.6" }), a.deps);
    const b = setup();
    await handleCheckout(req(pickupBody, { "x-forwarded-for": "7.7.7.7" }), b.deps);
    const hashA = a.rpcCalls.find((c) => c.name === "create_order")?.args.p_ip_hash;
    const hashB = b.rpcCalls.find((c) => c.name === "create_order")?.args.p_ip_hash;
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashA).toBe(hashB); // both in one bucket, so rotating the header buys nothing
    expect(a.rpcCalls[0]?.args.p_key).toBe(b.rpcCalls[0]?.args.p_key);
  });

  it("over the IP limit -> 429 with Retry-After and create_order is never called", async () => {
    const s = setup({ rate_limit_hit_info: () => ok([{ allowed: false, remaining: 0, retry_after_seconds: 321 }]) });
    const res = await handleCheckout(req(pickupBody), s.deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("321");
    expect((await json(res)).error?.code).toBe("RATE_LIMITED");
    expect(s.rpcCalls.some((c) => c.name === "create_order")).toBe(false);
  });

  it("ORDERS_PAUSED (owner kill switch) -> 503 with a clear message naming the cafe phone (SEC-003)", async () => {
    const s = setup({ create_order: () => pgErr("P0001", "ORDERS_PAUSED") });
    const res = await handleCheckout(req(pickupBody), s.deps);
    const body = await json(res);
    expect(res.status).toBe(503);
    expect(body.error?.code).toBe("ORDERS_PAUSED");
    expect(body.error?.message).toBe("We are not taking online orders right now. Please call us on 01-4000000 to order.");
    expect(s.scheduled).toHaveLength(0); // no staff alert, no error alert
  });

  it("a non-JSON content type is refused before Turnstile (SEC-015)", async () => {
    const s = setup();
    const r = new Request("https://cafe.test/api/checkout", { method: "POST", body: JSON.stringify(pickupBody), headers: { "content-type": "text/plain" } });
    const res = await handleCheckout(r, s.deps);
    expect(res.status).toBe(400);
    expect(s.deps.turnstile).not.toHaveBeenCalled();
    expect(s.rpcCalls).toHaveLength(0);
  });

  it("an oversized declared body is refused before anything else runs (SEC-015)", async () => {
    const s = setup();
    const res = await handleCheckout(req(pickupBody, { "cf-connecting-ip": "203.0.113.9", "content-length": "1000000" }), s.deps);
    expect(res.status).toBe(400);
    expect(s.deps.turnstile).not.toHaveBeenCalled();
  });

  it("ORDER_REFUSED is a generic 403 and never says which rule fired", async () => {
    const s = setup({ create_order: () => pgErr("P0001", "ORDER_REFUSED", "blocklist: phone", "open order cap") });
    const res = await handleCheckout(req(pickupBody), s.deps);
    const body = await json(res);
    expect(res.status).toBe(403);
    expect(body.error?.code).toBe("ORDER_REFUSED");
    expect(body.error?.message).toBe("We can't take this order online right now. Please call us.");
    expect(body.error?.fieldErrors).toBeUndefined();
    expect(s.tableCalls).toHaveLength(0); // SEC-001: no extra database read on the refusal path
    expect(String(body.error?.message)).not.toMatch(/block|cap|maximum|COD|open order/i);
  });

  it("ORDER_REFUSED text is identical for every cause", async () => {
    const texts = new Set<string>();
    for (const [details, hint] of [["blocklist", ""], ["cap", "x"], ["cod_max", "y"]]) {
      const s = setup({ create_order: () => pgErr("P0001", "ORDER_REFUSED", details, hint) });
      const { requestId: _r, ...rest } = (await json(await handleCheckout(req(pickupBody), s.deps))).error ?? {};
      void _r;
      texts.add(JSON.stringify(rest));
    }
    expect(texts.size).toBe(1);
  });
});

describe("POST /api/checkout: success path", () => {
  it("201 with the contract shape; server sends no prices and the normalised phone and a hashed IP", async () => {
    const s = setup();
    const res = await handleCheckout(req(deliveryBody), s.deps);
    const body = await json(res);
    expect(res.status).toBe(201);
    expect(body).toEqual({
      ok: true,
      data: { orderToken: UUID, orderNumber: "NC-1042", total: 55000, willCallToConfirm: true, payment: { type: "none" } },
    });
    const args = s.rpcCalls.find((c) => c.name === "create_order")?.args as Record<string, unknown>;
    expect(args.p_customer_phone).toBe("+9779841234567");
    expect(args.p_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain("203.0.113.9");
    expect(args).toMatchObject({ p_fulfilment: "delivery", p_payment_method: "cod", p_area: "Baneshwor", p_notes: "No onion" });
    expect(Object.keys(args).some((k) => /price|total/i.test(k))).toBe(false);
    expect(args.p_items).toEqual([{ variantId: UUID, qty: 2 }]);
  });

  it("pickup orders send no address", async () => {
    const s = setup();
    await handleCheckout(req({ ...pickupBody, delivery: { address: "x y z", landmark: "lm", area: "Area" } }), s.deps);
    const args = s.rpcCalls.find((c) => c.name === "create_order")?.args as Record<string, unknown>;
    expect(args.p_address).toBeNull();
    expect(args.p_area).toBeNull();
  });

  it("Telegram alert has order number, count, fulfilment, total and link but no phone, name or address", async () => {
    const s = setup();
    await handleCheckout(req(deliveryBody), s.deps);
    expect(s.scheduled).toHaveLength(1);
    await s.scheduled[0]!();
    const tg = s.fetchImpl.mock.calls.find((c) => String(c[0]).includes("api.telegram.org"));
    expect(tg).toBeTruthy();
    const text = JSON.parse(String((tg![1] as RequestInit).body)).text as string;
    expect(text).toContain("NC-1042");
    expect(text).toContain("2 items");
    expect(text).toContain("delivery");
    expect(text).toContain("Rs. 550");
    expect(text).toContain("/admin/orders/11111111-1111-4111-8111-111111111111");
    expect(text).not.toMatch(/9841234567|Sita|Baneshwor|Ward 4|sita@example/);
  });

  it("SEC-017: never emails the customer at placement, even with an address and Resend configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_key");
    vi.stubEnv("RESEND_FROM_EMAIL", "Cafe <orders@example.com>");
    const s = setup();
    await handleCheckout(req(deliveryBody), s.deps);
    for (const w of s.scheduled) await w();
    expect(s.fetchImpl.mock.calls.some((c) => String(c[0]).includes("api.resend.com"))).toBe(false);
    // the email is still stored with the order, for the confirmation email later
    expect(s.rpcCalls.find((c) => c.name === "create_order")?.args.p_customer_email).toBe("sita@example.com");
  });

  it("SEC-019: a burst sends one alert per order up to 5 a minute, holds the rest back; the next one reports them", async () => {
    const counters = new Map<string, number>();
    let lastWindow: { window_start: string; count: number }[] = [];
    const hit = (a: Record<string, unknown>) => {
      const n = (counters.get(String(a.p_key)) ?? 0) + 1;
      counters.set(String(a.p_key), n);
      if (a.p_key === "alert:new-order") lastWindow = [{ window_start: "2026-10-21T10:00:00Z", count: n }];
      return ok([{ allowed: n <= Number(a.p_max), remaining: Math.max(Number(a.p_max) - n, 0), retry_after_seconds: 0 }]);
    };
    let sentTexts: string[] = [];
    for (let i = 0; i < 8; i++) {
      const s = setup({ rate_limit_hit_info: hit }, { rate_limits: () => ok(lastWindow) });
      await handleCheckout(req(pickupBody, { "cf-connecting-ip": `203.0.113.${i + 1}` }), s.deps);
      await s.scheduled[0]!();
      sentTexts = sentTexts.concat(
        s.fetchImpl.mock.calls.filter((c) => String(c[0]).includes("api.telegram.org")).map((c) => JSON.parse(String((c[1] as RequestInit).body)).text as string),
      );
    }
    expect(sentTexts).toHaveLength(5);
    expect(sentTexts.join("\n")).not.toContain("more");

    // a minute later: the window counter starts again; the previous window held 8 alerts (5 sent, 3 held back)
    counters.delete("alert:new-order");
    const s = setup({ rate_limit_hit_info: hit }, { rate_limits: () => ok(lastWindow) });
    await handleCheckout(req(pickupBody, { "cf-connecting-ip": "203.0.113.50" }), s.deps);
    await s.scheduled[0]!();
    const text = JSON.parse(String((s.fetchImpl.mock.calls.find((c) => String(c[0]).includes("api.telegram.org"))![1] as RequestInit).body)).text as string;
    expect(text).toContain("+3 more new orders since the previous alert");
  });

  it("notifiers no-op when their env is unset and never break the order", async () => {
    vi.unstubAllEnvs();
    const s = setup();
    const res = await handleCheckout(req(deliveryBody), s.deps);
    expect(res.status).toBe(201);
    await s.scheduled[0]!();
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("POST /api/checkout: database errors", () => {
  it("minimum order -> VALIDATION 400 with the message", async () => {
    const s = setup({
      create_order: () => pgErr("P0001", "VALIDATION", JSON.stringify({ items: ["Minimum order for delivery is Rs. 500"] })),
    });
    const res = await handleCheckout(req(deliveryBody), s.deps);
    expect(res.status).toBe(400);
    expect((await json(res)).error?.fieldErrors).toEqual({ items: ["Minimum order for delivery is Rs. 500"] });
  });

  it("OUT_OF_STOCK -> 409 with per-line detail", async () => {
    const s = setup({ create_order: () => pgErr("P0001", "OUT_OF_STOCK", JSON.stringify({ "items.0": ["only 1 left"] })) });
    const res = await handleCheckout(req(pickupBody), s.deps);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({ code: "OUT_OF_STOCK", fieldErrors: { "items.0": ["only 1 left"] } });
  });

  it("unknown DB failure -> generic INTERNAL 500 with a requestId and no SQL", async () => {
    const s = setup({ create_order: () => pgErr("XX000", 'relation "orders" broke at line 3') });
    const res = await handleCheckout(req(pickupBody), s.deps);
    const body = await json(res);
    expect(res.status).toBe(500);
    expect(body.error?.code).toBe("INTERNAL");
    expect(body.error?.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/relation|line 3/);
    expect(s.scheduled).toHaveLength(1); // error alert to staff (request id only)
  });

  it("a failing rate-limit RPC fails closed (no order is created)", async () => {
    const s = setup({ rate_limit_hit_info: () => pgErr("XX000", "down") });
    const res = await handleCheckout(req(pickupBody), s.deps);
    expect(res.status).toBe(500);
    expect(s.rpcCalls.some((c) => c.name === "create_order")).toBe(false);
  });
});

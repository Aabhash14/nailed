import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CACHE_TAG, READ_TAGS, taggedFetch } from "@/lib/cache-tags";
import { createPublicClient } from "@/lib/data/public-client";
import { loadSettings } from "@/lib/data/settings";
import { handleOrderGet } from "@/lib/orders/public";
import { publicCancelReason, toAdminOrderRow, toOrderView, type OrderWithItems } from "@/lib/orders/view";
import { updateSettingsSchema } from "@/lib/validation/admin";
import { fakeDb, ok, type PgResult } from "./helpers/fake-db";

/**
 * 2026-10-21 follow-up fixes (backend-engineer):
 *  1. src/middleware.ts: mock pass-through, live redirect/pass (the old root middleware.ts was never loaded).
 *  2. OrderView.cancelReason (public; "fake" masked).
 *  3. Cache tags on public reads.
 *  4. Rule field names ipOpenOrdersMax / ipOrdersMaxPerDay / autoCancelPlacedAfterMinutes end to end.
 */

// ---- @supabase/ssr is mocked so the "signed in" branch can be tested without a network --------------------------
const auth = vi.hoisted(() => ({
  result: { data: { user: null as null | { id: string } }, error: null as null | { message: string } },
  calls: 0,
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        auth.calls += 1;
        return auth.result;
      },
    },
  }),
}));

const { middleware, config } = await import("@/middleware");

const req = (path: string) => new NextRequest(new URL(path, "https://cafe.test"));
const isPassThrough = (r: Response) => r.headers.get("x-middleware-next") === "1" && !r.headers.get("location");

beforeEach(() => {
  auth.result = { data: { user: null }, error: null };
  auth.calls = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("src/middleware.ts (/admin session gate)", () => {
  it("matches every path except Next's static assets (SEC-011 mock refusal needs the whole site; /admin is gated inside)", () => {
    expect(config).toEqual({ matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] });
  });

  it("LIVE mode: public paths pass straight through without touching Supabase or caching headers", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    for (const p of ["/", "/menu", "/shop/tee", "/checkout", "/order/abc", "/api/menu", "/administrator", "/adminx"]) {
      const res = await middleware(req(p));
      expect(isPassThrough(res), p).toBe(true);
      expect(res.headers.get("cache-control"), p).toBeNull();
    }
    expect(auth.calls).toBe(0);
  });

  it("LIVE mode: every spelling of an /admin path is gated (rsc, segments, _next/data, encoded, upper case)", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    for (const p of ["/admin.rsc", "/admin/orders.rsc", "/admin/orders.segments/x.segment.rsc", "/_next/data/build1/admin/menu.json", "/%61dmin/staff", "/ADMIN/settings"]) {
      expect((await middleware(req(p))).status, p).toBe(307);
    }
  });

  it("MOCK build with APP_ENV staging or production: 503 for every path, nothing else runs (SEC-011 residual)", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock");
    for (const env of ["staging", "production", " Production "]) {
      vi.stubEnv("APP_ENV", env);
      for (const p of ["/", "/menu", "/checkout", "/api/menu", "/admin", "/admin/login"]) {
        const res = await middleware(req(p));
        expect(res.status, `${env} ${p}`).toBe(503);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(isPassThrough(res)).toBe(false);
      }
    }
    expect(auth.calls).toBe(0);
  });

  it("MOCK build without APP_ENV (dev, e2e) still serves; public paths pass without the admin no-store header", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock");
    vi.stubEnv("APP_ENV", "");
    const pub = await middleware(req("/menu"));
    expect(isPassThrough(pub)).toBe(true);
    expect(pub.headers.get("cache-control")).toBeNull();
    vi.stubEnv("APP_ENV", "development");
    expect((await middleware(req("/menu"))).status).toBe(200);
  });

  it("MOCK mode: passes every /admin request through without a session (e2e admin tests)", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock");
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    for (const p of ["/admin", "/admin/orders", "/admin/settings", "/admin/login"]) {
      const res = await middleware(req(p));
      expect(isPassThrough(res), p).toBe(true);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(auth.calls).toBe(0); // no Supabase call in mock mode
  });

  it("LIVE mode, no session: redirects to /admin/login with ?next=<path>", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const res = await middleware(req("/admin/orders?status=placed"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.pathname).toBe("/admin/login");
    expect(loc.searchParams.get("next")).toBe("/admin/orders");
    expect(loc.searchParams.get("status")).toBeNull(); // query is dropped
    expect(auth.calls).toBe(1);
  });

  it("LIVE mode, /admin itself redirects without a next param", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const loc = new URL((await middleware(req("/admin"))).headers.get("location") ?? "");
    expect(loc.pathname).toBe("/admin/login");
    expect(loc.search).toBe("");
  });

  it("LIVE mode fails closed: missing Supabase env redirects (and an unset mode is live, not mock)", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const res = await middleware(req("/admin/menu"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/admin/login");
  });

  it("LIVE mode: a getUser error is treated as signed out", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    auth.result = { data: { user: { id: "u1" } }, error: { message: "jwt expired" } };
    expect((await middleware(req("/admin/orders"))).status).toBe(307);
  });

  it("LIVE mode: the login page itself is reachable signed out, with no-store", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const res = await middleware(req("/admin/login"));
    expect(isPassThrough(res)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("LIVE mode with a valid session: passes through with Cache-Control private, no-store", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    auth.result = { data: { user: { id: "u1" } }, error: null };
    const res = await middleware(req("/admin/orders"));
    expect(isPassThrough(res)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("any other mode value is NOT mock (only the exact string 'mock' skips the check)", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "MOCK");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect((await middleware(req("/admin/orders"))).status).toBe(307);
  });
});

// ---- 2. OrderView.cancelReason ----------------------------------------------------------------------------------
const TOKEN = "3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";
const orderRow = (over: Partial<OrderWithItems> = {}): OrderWithItems =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    number: "NC-1042",
    public_token: TOKEN,
    status: "cancelled",
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
    notes: "ring twice",
    ip_hash: "a".repeat(64),
    personal_data_purged_at: null,
    cancel_reason: "auto_unconfirmed",
    stock_restocked_at: null,
    created_at: new Date().toISOString(),
    confirmed_at: null,
    completed_at: null,
    cancelled_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    order_items: [{ name: "Nailed Tee", variant_label: "M / Black", unit_price_paisa: 25000, qty: 2 }],
    ...over,
  }) as OrderWithItems;

describe("public OrderView.cancelReason", () => {
  it("carries auto_unconfirmed so the customer page can explain the auto-cancel", () => {
    expect(toOrderView(orderRow()).cancelReason).toBe("auto_unconfirmed");
  });
  it("is null for any status other than cancelled", () => {
    for (const s of ["placed", "confirmed", "out_for_delivery", "ready_for_pickup", "completed"] as const) {
      expect(toOrderView(orderRow({ status: s, cancel_reason: null })).cancelReason).toBeNull();
    }
  });
  it("passes reasons through, but shows staff's 'fake' judgement as 'other'", () => {
    for (const r of ["customer_request", "unreachable", "no_show", "refused", "out_of_stock", "other", "auto_unconfirmed"] as const) {
      expect(publicCancelReason(r)).toBe(r);
    }
    expect(publicCancelReason("fake")).toBe("other");
    expect(publicCancelReason(null)).toBeNull();
    expect(toOrderView(orderRow({ cancel_reason: "fake" })).cancelReason).toBe("other");
  });
  it("still never contains phone, address, landmark, area, email, notes, IP hash or the full name", () => {
    const text = JSON.stringify(toOrderView(orderRow()));
    expect(text).not.toMatch(/9841234567|Ward 4|Blue gate|Baneshwor|sita@example|ring twice|Kumari|aaaaaaaa/);
    const keys = Object.keys(toOrderView(orderRow()));
    for (const k of ["customerPhone", "phone", "address", "landmark", "area", "customerEmail", "notes", "ipHash", "id"]) {
      expect(keys).not.toContain(k);
    }
  });
  it("staff still see the real reason in AdminOrderRow", () => {
    expect(toAdminOrderRow(orderRow({ cancel_reason: "fake" }), new Set()).cancelReason).toBe("fake");
  });
  it("GET /api/orders/[token] returns it", async () => {
    const { db } = fakeDb({
      rpc: { rate_limit_hit_info: () => ok([{ allowed: true, remaining: 29, retry_after_seconds: 0 }]) },
      tables: { orders: ok(orderRow()) },
    });
    const res = await handleOrderGet(
      new Request("https://cafe.test/x", { headers: { "cf-connecting-ip": "198.51.100.7" } }),
      TOKEN,
      { db: () => db, salt: () => "s".repeat(32), schedule: () => undefined },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.cancelReason).toBe("auto_unconfirmed");
    expect(body.data.status).toBe("cancelled");
  });
});

// ---- 3. cache tags ----------------------------------------------------------------------------------------------
describe("cache tags on public reads", () => {
  it("every tag the admin actions revalidate is carried by at least one public read", () => {
    const carried = new Set(Object.values(READ_TAGS).flat());
    for (const t of Object.values(CACHE_TAG)) expect(carried.has(t), t).toBe(true);
    expect([...READ_TAGS.menu]).toEqual(["menu", "settings"]); // the menu payload embeds settings
    expect([...READ_TAGS.settings]).toEqual(["settings"]);
    expect([...READ_TAGS.shop]).toEqual(["shop"]);
  });

  it("taggedFetch adds next.tags and keeps the caller's init (no cache/revalidate added)", async () => {
    const base = vi.fn(async () => new Response("[]"));
    const f = taggedFetch(["shop"], base as unknown as typeof fetch);
    await f("https://x.test/rest/v1/products", { method: "GET", headers: { apikey: "k" } });
    const init = (base.mock.calls[0] as unknown[])[1] as RequestInit & { next?: { tags?: string[]; revalidate?: number } };
    expect(init.next?.tags).toEqual(["shop"]);
    expect(init.next?.revalidate).toBeUndefined();
    expect(init.cache).toBeUndefined();
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("apikey")).toBe("k");
  });

  async function tagsSentBy(tags: readonly ("menu" | "settings" | "shop")[] | undefined) {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const spy = vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", spy);
    const db = createPublicClient(tags ? { tags } : {});
    await db.from("products").select("*");
    expect(spy).toHaveBeenCalled();
    const init = (spy.mock.calls[0] as unknown[])[1] as { next?: { tags?: string[] } } | undefined;
    return init?.next?.tags;
  }

  it("createPublicClient({ tags }) sends the tags on every Supabase request", async () => {
    expect(await tagsSentBy(READ_TAGS.shop)).toEqual(["shop"]);
  });
  it("createPublicClient() without tags sends none (route handlers)", async () => {
    expect(await tagsSentBy(undefined)).toBeUndefined();
  });

  it("the live public reads (data-access) use menu / settings / shop tags", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const seen: { path: string; tags: string[] | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit & { next?: { tags?: string[] } }) => {
        seen.push({ path: new URL(String(input instanceof Request ? input.url : input)).pathname, tags: init?.next?.tags });
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const live = await import("@/data-access/public-live");
    await live.liveMenuSnapshot().catch(() => undefined); // empty settings row -> throws after the reads
    await live.liveSettings().catch(() => undefined);
    await live.liveProducts().catch(() => undefined);
    const tagsFor = (p: string) => seen.filter((s) => s.path.endsWith(p)).map((s) => s.tags);
    expect(tagsFor("/menu_items")).toEqual([["menu", "settings"]]);
    expect(tagsFor("/public_settings")).toEqual([["menu", "settings"], ["settings"]]);
    expect(tagsFor("/products")).toEqual([["shop"]]);
    expect(tagsFor("/product_variants")).toEqual([["shop"]]);
    expect(seen.every((s) => Array.isArray(s.tags) && s.tags.length > 0)).toBe(true);
  });
});

// ---- 4. rule field names ----------------------------------------------------------------------------------------
describe("order rule field names (ipOpenOrdersMax, ipOrdersMaxPerDay, autoCancelPlacedAfterMinutes)", () => {
  it("updateSettings schema accepts exactly these names with the DB ranges", () => {
    expect(
      updateSettingsSchema.parse({ ipOpenOrdersMax: 3, ipOrdersMaxPerDay: 10, autoCancelPlacedAfterMinutes: null }),
    ).toEqual({ ipOpenOrdersMax: 3, ipOrdersMaxPerDay: 10, autoCancelPlacedAfterMinutes: null });
    expect(updateSettingsSchema.safeParse({ ipOpenOrders: 3 }).success).toBe(false); // strict: a wrong name fails
    expect(updateSettingsSchema.safeParse({ autoCancelPlacedAfterMinutes: 14 }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ ipOpenOrdersMax: 101 }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ ipOrdersMaxPerDay: 1001 }).success).toBe(false);
  });

  it("loadSettings maps the order_rules columns to the same names", async () => {
    const site = {
      cafe_name: "Nailed Cafe",
      hours: { weekly: {}, closures: [] },
      announcement: null, phone: null, whatsapp: null, email: null, address: null, landmark: null, map_url: null,
      prices_include_vat: true, service_charge_pct: 0, delivery_fee_paisa: 0, delivery_areas: [],
      min_order_delivery_paisa: 0, min_order_pickup_paisa: 0, payment_methods_enabled: ["pickup"],
      features: { lodge: false }, orders_paused: false,
    };
    const rules = {
      cod_max_total_paisa: null, max_open_orders_per_phone: 2,
      ip_open_orders_max: 4, ip_orders_max_per_day: 12, auto_cancel_placed_after_minutes: 90,
    };
    const { db } = fakeDb({ tables: { site_settings: ok(site) as PgResult, order_rules: ok(rules) as PgResult } });
    const s = await loadSettings(db);
    expect(s).toMatchObject({ ipOpenOrdersMax: 4, ipOrdersMaxPerDay: 12, autoCancelPlacedAfterMinutes: 90 });
  });
});

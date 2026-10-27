import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapRpcError } from "@/lib/data/db-errors";
import { AppError } from "@/lib/errors";
import { handleMenu } from "@/lib/menu-route";
import { clearMenuCache, cachedMenu } from "@/lib/data/menu";
import { runNotifier, scheduleNotifier, summaryText, type AlertChannelAdapter } from "@/lib/notify/notifier";
import {
  clearTableCookieHeader,
  makeTableCookieKey,
  readCookieValues,
  signTableCookie,
  tableCookieHeader,
  tableCookieKeysFromEnv,
  tableCookieName,
  verifyTableCookie,
  type TableCookieKeys,
} from "@/lib/tables/cookie";
import { countFailedJoin, handleTableJoin, handleTableOrders, handleTableSession, type TableRouteDeps } from "@/lib/tables/handlers";
import { originAllowed, siteHostname } from "@/lib/tables/origin";
import {
  closeTableSchema,
  joinTableRequestSchema,
  markAlertsReadSchema,
  parseSince,
  saveCafeTablesSchema,
  cancelTableRoundSchema,
  tableOrderRequestSchema,
} from "@/lib/tables/validation";
import { verifyTurnstile } from "@/lib/turnstile";
import type { Db } from "@/lib/data/types";
import { memoryDb } from "./helpers/memory-db";
import { fakeDb, ok, pgErr } from "./helpers/fake-db";

/**
 * Table ordering backend (api-contract 2.3.0 section 9; threat model B1 to B8; SEC-023, SEC-025 to SEC-028).
 * No real database: fakes only.
 */

const SID = "3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";
const SID2 = "4f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3c";
const ITEM = "5f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3d";
const OPT = "6f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3e";
const REQ = "7f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3f";
const SITE = "https://cafe.example";
const DEV_ENV = { NODE_ENV: "test" } as Record<string, string | undefined>;
const PROD_ENV = { NODE_ENV: "production", APP_ENV: "production" } as Record<string, string | undefined>;
const NOW_S = 1_800_000_000;
const NOW = new Date(NOW_S * 1000);

const bytes = (n: number) => new Uint8Array(32).fill(n);
async function keys(cur = 1, prev?: number): Promise<TableCookieKeys> {
  return {
    current: await makeTableCookieKey(cur, bytes(cur)),
    previous: prev ? await makeTableCookieKey(prev, bytes(prev)) : null,
  };
}

const view = {
  rev: 3,
  tableNumber: 7,
  tableLabel: null,
  openedAt: "2026-10-26T04:00:00Z",
  ordering: "on",
  rounds: [],
  bill: { subtotal: 0, serviceCharge: 0, vat: 0, total: 0, pricesIncludeVat: true, serviceChargePct: 0 },
  limits: { maxLines: 20, maxQty: 20, maxWaitingRounds: 3, maxLiveRounds: 30, maxNoteLength: 200 },
};

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  for (const m of ["info", "warn", "error", "log"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

// ================================================================================================================
describe("table cookie (9.2, SEC-025)", () => {
  it("round-trips: kid.sid.epoch.iat.sig, base64url signature of 43 characters", async () => {
    const k = await keys();
    const v = await signTableCookie(k, { sessionId: SID, epoch: 2, issuedAt: NOW_S });
    const parts = v.split(".");
    expect(parts).toHaveLength(5);
    expect(parts.slice(0, 4)).toEqual(["1", SID, "2", String(NOW_S)]);
    expect(parts[4]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyTableCookie(k, v, NOW_S)).toEqual({ sessionId: SID, epoch: 2, issuedAt: NOW_S });
  });

  it("refuses any tampered part: sid, epoch, iat, kid, signature", async () => {
    const k = await keys();
    const v = await signTableCookie(k, { sessionId: SID, epoch: 2, issuedAt: NOW_S });
    const [kid, sid, epoch, iat, sig] = v.split(".") as [string, string, string, string, string];
    const tampered = [
      [kid, SID2, epoch, iat, sig],
      [kid, sid, "3", iat, sig], // SEC-023: an old cookie cannot claim the new epoch
      [kid, sid, epoch, String(NOW_S - 1), sig],
      ["2", sid, epoch, iat, sig],
      [kid, sid, epoch, iat, (sig[0] === "A" ? "B" : "A") + sig.slice(1)],
    ];
    for (const t of tampered) expect(await verifyTableCookie(k, t.join("."), NOW_S)).toBeNull();
  });

  it("refuses a cookie signed with another key (wrong key / IP_HASH_SALT reuse)", async () => {
    const other = { current: await makeTableCookieKey(1, bytes(9)), previous: null };
    const v = await signTableCookie(other, { sessionId: SID, epoch: 1, issuedAt: NOW_S });
    expect(await verifyTableCookie(await keys(), v, NOW_S)).toBeNull();
  });

  it("accepts the previous key during a rotation, and not after it is removed", async () => {
    const old = await keys(1);
    const v = await signTableCookie(old, { sessionId: SID, epoch: 1, issuedAt: NOW_S });
    expect(await verifyTableCookie(await keys(2, 1), v, NOW_S)).not.toBeNull();
    expect(await verifyTableCookie(await keys(2), v, NOW_S)).toBeNull();
    // new cookies are signed with the current key id
    expect((await signTableCookie(await keys(2, 1), { sessionId: SID, epoch: 1, issuedAt: NOW_S })).startsWith("2.")).toBe(true);
  });

  it("expiry: older than 12 h or more than 60 s in the future is refused", async () => {
    const k = await keys();
    const at = async (iat: number) => verifyTableCookie(k, await signTableCookie(k, { sessionId: SID, epoch: 1, issuedAt: iat }), NOW_S);
    expect(await at(NOW_S - 43_200)).not.toBeNull();
    expect(await at(NOW_S - 43_201)).toBeNull();
    expect(await at(NOW_S + 60)).not.toBeNull();
    expect(await at(NOW_S + 61)).toBeNull();
  });

  it("strict parse: malformed values never verify (and never reach the database)", async () => {
    const k = await keys();
    const good = await signTableCookie(k, { sessionId: SID, epoch: 1, issuedAt: NOW_S });
    const [, , , , sig] = good.split(".");
    for (const bad of [
      "",
      "garbage",
      good + ".x",
      good.split(".").slice(0, 4).join("."),
      `1.${SID.toUpperCase()}.1.${NOW_S}.${sig}`,
      `1.not-a-uuid.1.${NOW_S}.${sig}`,
      `1.${SID}.0.${NOW_S}.${sig}`,
      `1.${SID}.32768.${NOW_S}.${sig}`,
      `1.${SID}.01.${NOW_S}.${sig}`,
      `1.${SID}.1.${NOW_S}.5.${sig}`,
      `1.${SID}.1.-5.${sig}`,
      `0.${SID}.1.${NOW_S}.${sig}`,
      `1.${SID}.1.${NOW_S}.${sig}=`,
      `1.${SID}.1.1e9.${sig}`,
      "x".repeat(500),
    ]) {
      expect(await verifyTableCookie(k, bad, NOW_S), bad.slice(0, 40)).toBeNull();
    }
    expect(await verifyTableCookie(k, null, NOW_S)).toBeNull();
  });

  it("name and attributes: __Secure- + Secure in production builds, nc_table locally; Path=/api/table, 12 h, no Domain", () => {
    expect(tableCookieName(PROD_ENV)).toBe("__Secure-nc_table");
    expect(tableCookieName(DEV_ENV)).toBe("nc_table");
    const prod = tableCookieHeader("V", PROD_ENV);
    expect(prod).toBe("__Secure-nc_table=V; Path=/api/table; Max-Age=43200; HttpOnly; SameSite=Lax; Secure");
    expect(tableCookieHeader("V", DEV_ENV)).toBe("nc_table=V; Path=/api/table; Max-Age=43200; HttpOnly; SameSite=Lax");
    expect(clearTableCookieHeader(PROD_ENV)).toBe("__Secure-nc_table=; Path=/api/table; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
    expect(prod.toLowerCase()).not.toContain("domain");
  });

  it("reads only the exact cookie name, at most 3 copies", () => {
    expect(readCookieValues("a=1; nc_table=X; nc_table_x=Y; xnc_table=Z", "nc_table")).toEqual(["X"]);
    expect(readCookieValues("nc_table=1; nc_table=2; nc_table=3; nc_table=4", "nc_table")).toHaveLength(3);
    expect(readCookieValues(null, "nc_table")).toEqual([]);
  });

  it("env keys: missing or short key is INTERNAL naming the variable only; previous id must differ", async () => {
    const b64 = (n: number, len = 32) => btoa(String.fromCharCode(...new Uint8Array(len).fill(n)));
    await expect(tableCookieKeysFromEnv({})).rejects.toMatchObject({ code: "INTERNAL", logDetail: "server env invalid: TABLE_COOKIE_KEY" });
    await expect(tableCookieKeysFromEnv({ TABLE_COOKIE_KEY: b64(1, 16) })).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(
      tableCookieKeysFromEnv({ TABLE_COOKIE_KEY: b64(1), TABLE_COOKIE_KEY_PREVIOUS: b64(2), TABLE_COOKIE_KEY_PREVIOUS_ID: "1" }),
    ).rejects.toMatchObject({ logDetail: "server env invalid: TABLE_COOKIE_KEY_PREVIOUS_ID" });
    const k = await tableCookieKeysFromEnv({ TABLE_COOKIE_KEY: b64(1), TABLE_COOKIE_KEY_ID: "3" });
    expect(k.current.kid).toBe(3);
    expect(k.previous).toBeNull();
  });
});

// ================================================================================================================
describe("Origin check (9.2, B1)", () => {
  it("exact parsed-origin equality with NEXT_PUBLIC_SITE_URL", () => {
    expect(originAllowed("https://cafe.example", SITE, PROD_ENV)).toBe(true);
    expect(originAllowed("https://cafe.example", SITE + "/menu", PROD_ENV)).toBe(true);
    for (const o of [
      null,
      "",
      "null",
      "https://cafe.example.evil.test",
      "https://evil.test",
      "http://cafe.example",
      "https://cafe.example:8443",
      "https://cafe.example/",
      "https://user@cafe.example",
      "https://sub.cafe.example",
    ]) {
      expect(originAllowed(o, SITE, PROD_ENV), String(o)).toBe(false);
    }
  });

  it("http://localhost:* only on a developer machine (allowForwardedFallback), never in staging or production", () => {
    expect(originAllowed("http://localhost:3000", SITE, DEV_ENV)).toBe(true);
    expect(originAllowed("http://localhost:3000", SITE, PROD_ENV)).toBe(false);
    expect(originAllowed("http://localhost:3000", SITE, { NODE_ENV: "development", APP_ENV: "staging" })).toBe(false);
    expect(originAllowed("http://127.0.0.1:3000", SITE, DEV_ENV)).toBe(false);
    expect(originAllowed("https://localhost:3000", SITE, DEV_ENV)).toBe(false);
  });

  it("site hostname for Turnstile", () => {
    expect(siteHostname("https://cafe.example/x")).toBe("cafe.example");
    expect(siteHostname(undefined)).toBeNull();
    expect(siteHostname("not a url")).toBeNull();
  });
});

// ================================================================================================================
describe("validation (9.3, 9.5, 9.7, 9.10)", () => {
  it("join: code normalised (spaces, dashes, case); bad shapes are VALIDATION code with fixed text", () => {
    expect(joinTableRequestSchema.parse({ table: 7, code: " k7m-4qx ", turnstileToken: "t" }).code).toBe("K7M4QX");
    for (const code of ["K7M4Q", "K7M4QXX", "K7M4Q0", "I7M4QX", "", "x".repeat(21)]) {
      const r = joinTableRequestSchema.safeParse({ table: 7, code, turnstileToken: "t" });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.map((i) => i.path.join("."))).toEqual(["code"]);
        expect(JSON.stringify(r.error.issues)).not.toContain(code || "§"); // never echoes the typed code
      }
    }
    for (const table of [0, 100, 7.5, "7"]) {
      expect(joinTableRequestSchema.safeParse({ table, code: "K7M4QX", turnstileToken: "t" }).success).toBe(false);
    }
  });

  it("orders: note trimmed, empty = absent, 200 characters, one line, no bidi; variants sorted and unique; extra keys dropped", () => {
    const base = { clientRequestId: REQ, items: [{ menuItemId: ITEM, qty: 1 }] };
    expect(tableOrderRequestSchema.parse({ ...base, note: "  " }).note).toBeUndefined();
    expect(tableOrderRequestSchema.parse({ ...base, note: " less sugar " }).note).toBe("less sugar");
    expect(tableOrderRequestSchema.parse({ ...base, note: "😀".repeat(200) }).note).toHaveLength(400);
    for (const note of ["a".repeat(201), "two\nlines", "tab\there", "x‮y", "x⁦y", "x\u0085y"]) {
      const r = tableOrderRequestSchema.safeParse({ ...base, note });
      expect(r.success, JSON.stringify(note)).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.path).toEqual(["note"]);
    }
    const parsed = tableOrderRequestSchema.parse({
      ...base,
      items: [{ menuItemId: ITEM, variantIds: [OPT, SID], qty: 2 }],
      sessionId: SID2,
      table: 9,
      price: 1,
    });
    expect(parsed.items[0]?.variantIds).toEqual([SID, OPT].sort());
    expect(parsed).not.toHaveProperty("sessionId");
    expect(parsed).not.toHaveProperty("table");
    const dup = tableOrderRequestSchema.safeParse({ ...base, items: [{ menuItemId: ITEM, variantIds: [OPT, OPT], qty: 1 }] });
    expect(dup.success).toBe(false);
    if (!dup.success) expect(dup.error.issues[0]?.path.join(".")).toBe("items.0.variantIds");
    expect(tableOrderRequestSchema.safeParse({ ...base, items: [] }).success).toBe(false);
    expect(tableOrderRequestSchema.safeParse({ ...base, items: Array(21).fill({ menuItemId: ITEM, qty: 1 }) }).success).toBe(false);
    expect(tableOrderRequestSchema.safeParse({ ...base, items: [{ menuItemId: ITEM, qty: 21 }] }).success).toBe(false);
  });

  it("since: integer 0..2147483647, anything else ignored", () => {
    expect(parseSince("0")).toBe(0);
    expect(parseSince("2147483647")).toBe(2147483647);
    for (const v of [null, "", "-1", "1.5", "2147483648", "abc", "1e3", "12345678901"]) expect(parseSince(v)).toBeUndefined();
  });

  it("saveCafeTables: duplicate numbers on tables.N.number; labels trimmed, blank = null, plain text, 40 characters", () => {
    const r = saveCafeTablesSchema.safeParse({
      tables: [
        { number: 1, isActive: true },
        { number: 2, label: "  ", isActive: true },
        { number: 1, isActive: true },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join("."))).toEqual(["tables.0.number", "tables.2.number"]);
      expect(r.error.issues[0]?.message).toBe("That table number is used twice.");
    }
    expect(saveCafeTablesSchema.parse({ tables: [{ number: 2, label: " Window ", isActive: true }] }).tables[0]?.label).toBe("Window");
    expect(saveCafeTablesSchema.parse({ tables: [{ number: 2, label: "  ", isActive: true }] }).tables[0]?.label).toBeNull();
    for (const label of ["a".repeat(41), "a\nb"]) {
      const bad = saveCafeTablesSchema.safeParse({ tables: [{ number: 2, label, isActive: true }] });
      expect(bad.success).toBe(false);
      if (!bad.success) expect(bad.error.issues[0]?.path.join(".")).toBe("tables.0.label");
    }
  });

  it("closeTable: paidVia required for paid, refused for void; cancel reason session_closed refused; markAlertsRead one form", () => {
    const base = { sessionId: SID, expectedTotal: 100 };
    expect(closeTableSchema.safeParse({ ...base, outcome: "paid" }).error?.issues[0]?.path).toEqual(["paidVia"]);
    expect(closeTableSchema.safeParse({ ...base, outcome: "void", paidVia: "cash" }).error?.issues[0]?.path).toEqual(["paidVia"]);
    expect(closeTableSchema.safeParse({ ...base, outcome: "paid", paidVia: "fonepay" }).success).toBe(true);
    expect(cancelTableRoundSchema.safeParse({ roundId: SID, reason: "session_closed" }).error?.issues[0]?.path).toEqual(["reason"]);
    expect(markAlertsReadSchema.safeParse({ all: true }).success).toBe(true);
    expect(markAlertsReadSchema.safeParse({ ids: [SID] }).success).toBe(true);
    expect(markAlertsReadSchema.safeParse({}).success).toBe(false);
    expect(markAlertsReadSchema.safeParse({ ids: [SID], all: true }).success).toBe(false);
    expect(markAlertsReadSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});

// ================================================================================================================
describe("Turnstile action / hostname (SEC-028, B5)", () => {
  const answer = (json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status: 200 }));
  const opts = { secret: "s", expectedAction: "table-join", expectedHostname: "cafe.example" };

  it("passes only with the right action and hostname", async () => {
    await expect(verifyTurnstile("t", null, { ...opts, fetchImpl: answer({ success: true, action: "table-join", hostname: "Cafe.Example" }) })).resolves.toBeUndefined();
    for (const json of [
      { success: true, action: "checkout", hostname: "cafe.example" },
      { success: true, hostname: "cafe.example" },
      { success: true, action: "table-join", hostname: "localhost" },
      { success: true, action: "table-join" },
      { success: false, action: "table-join", hostname: "cafe.example" },
    ]) {
      await expect(verifyTurnstile("t", null, { ...opts, fetchImpl: answer(json) }), JSON.stringify(json)).rejects.toMatchObject({ code: "BOT_CHECK_FAILED" });
    }
  });

  it("Cloudflare testing keys (result_with_testing_key) skip the action / hostname comparison", async () => {
    const f = answer({ success: true, hostname: "example.com", metadata: { result_with_testing_key: true } });
    await expect(verifyTurnstile("t", null, { ...opts, fetchImpl: f })).resolves.toBeUndefined();
  });

  it("checkout and login (no expectations) behave as before", async () => {
    await expect(verifyTurnstile("t", null, { secret: "s", fetchImpl: answer({ success: true, action: "x", hostname: "y" }) })).resolves.toBeUndefined();
    await expect(verifyTurnstile("t", null, { secret: "s", fetchImpl: answer({ success: false }) })).rejects.toMatchObject({ code: "BOT_CHECK_FAILED" });
  });
});

// ================================================================================================================
describe("database error mapping (9.9)", () => {
  it("TABLE_SESSION_INVALID and TABLE_ORDERS_PAUSED keep the fixed contract texts", () => {
    const inv = mapRpcError({ code: "P0001", message: "TABLE_SESSION_INVALID", hint: "anything" });
    expect([inv.code, inv.message]).toEqual(["TABLE_SESSION_INVALID", "Your table is not open for ordering. Enter the code from our staff to order."]);
    const stopped = mapRpcError({ code: "P0001", message: "TABLE_ORDERS_PAUSED", hint: "Ordering from the app is stopped for this table. Please order with our staff." });
    expect(stopped.message).toBe("Ordering from the app is stopped for this table. Please order with our staff.");
    const paused = mapRpcError({ code: "P0001", message: "TABLE_ORDERS_PAUSED", hint: "something else" });
    expect(paused.message).toBe("The kitchen is not taking orders from the app right now. Please order with our staff.");
  });
});

// ================================================================================================================
type Mem = ReturnType<typeof memoryDb>;

function routeDeps(db: Mem | ReturnType<typeof fakeDb>, k: TableCookieKeys, over: Partial<TableRouteDeps> = {}) {
  const scheduled: (() => Promise<unknown>)[] = [];
  const turnstileCalls: unknown[][] = [];
  const deps: TableRouteDeps = {
    db: () => db.db as Db,
    salt: () => "s".repeat(32),
    siteUrl: () => SITE,
    cookieKeys: async () => k,
    schedule: (w) => void scheduled.push(w),
    turnstile: async (...a) => void turnstileCalls.push(a),
    env: DEV_ENV,
    now: () => NOW,
    ...over,
  };
  return { deps, scheduled, turnstileCalls };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE, "x-forwarded-for": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const joinBody = { table: 7, code: "k7m 4qx", turnstileToken: "tok" };

describe("POST /api/table/join (9.3)", () => {
  it("Origin is checked BEFORE the body is read: 403 Request refused., no-store, nothing else runs", async () => {
    const k = await keys();
    const m = memoryDb({ now: () => NOW.getTime() });
    const { deps, turnstileCalls } = routeDeps(m, k);
    let bodyRead = false;
    const req = post("/api/table/join", joinBody, { origin: "https://evil.test" });
    const spy = new Proxy(req, {
      get(t, p) {
        if (p === "body" || p === "json" || p === "text") bodyRead = true;
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const res = await handleTableJoin(spy as Request, deps);
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error).toMatchObject({ code: "FORBIDDEN", message: "Request refused." });
    expect(bodyRead).toBe(false);
    expect(turnstileCalls).toHaveLength(0);
    expect(m.rpcCalls).toHaveLength(0);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("success: Turnstile with action table-join + site hostname, limits per (IP, table) then per IP, cookie set with the epoch", async () => {
    const k = await keys();
    const m = memoryDb({
      now: () => NOW.getTime(),
      rpc: { join_table_session: () => ({ data: { sessionId: SID, epoch: 3, view }, error: null }) },
    });
    const { deps, turnstileCalls } = routeDeps(m, k);
    const res = await handleTableJoin(post("/api/table/join", joinBody), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, data: view });
    expect(turnstileCalls[0]?.[2]).toEqual({ expectedAction: "table-join", expectedHostname: "cafe.example" });
    const keysUsed = m.rpcCalls.filter((c) => c.name === "rate_limit_hit_info").map((c) => [String(c.args.p_key).replace(/[0-9a-f]{64}/, "<h>"), c.args.p_max, c.args.p_window_seconds]);
    expect(keysUsed).toEqual([
      ["table-join:iptable:<h>:7", 10, 600],
      ["table-join:ip:<h>", 150, 600],
    ]);
    expect(m.rpcCalls.find((c) => c.name === "join_table_session")?.args).toEqual({ p_table_number: 7, p_code: "K7M4QX" });
    const setCookie = res.headers.get("set-cookie") ?? "";
    const value = /^nc_table=([^;]+);/.exec(setCookie)?.[1];
    expect(await verifyTableCookie(k, value, NOW_S)).toEqual({ sessionId: SID, epoch: 3, issuedAt: NOW_S });
    expect(setCookie).toContain("Path=/api/table; Max-Age=43200; HttpOnly; SameSite=Lax");
  });

  it("11th try for the same table from one IP is RATE_LIMITED with Retry-After; another table still works (SEC-026)", async () => {
    const k = await keys();
    const m = memoryDb({
      now: () => NOW.getTime(),
      rpc: { join_table_session: () => ({ data: { sessionId: SID, epoch: 1, view }, error: null }) },
    });
    const { deps } = routeDeps(m, k);
    for (let i = 0; i < 10; i++) expect((await handleTableJoin(post("/api/table/join", joinBody), deps)).status).toBe(200);
    const limited = await handleTableJoin(post("/api/table/join", joinBody), deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect((await handleTableJoin(post("/api/table/join", { ...joinBody, table: 8 }), deps)).status).toBe(200);
  });

  it("wrong code: one VALIDATION answer; log has table + IP prefix and never the code, cookie or body; failure counted after the response", async () => {
    const k = await keys();
    const m = memoryDb({
      now: () => NOW.getTime(),
      rpc: {
        join_table_session: () => ({
          data: null,
          error: { code: "P0001", message: "VALIDATION", details: JSON.stringify({ code: ["That code doesn't match this table. Check it, or ask our staff."] }), hint: null },
        }),
        record_admin_alert: () => ({ data: SID2, error: null }),
      },
    });
    const { deps, scheduled } = routeDeps(m, k);
    const res = await handleTableJoin(post("/api/table/join", { ...joinBody, code: "ZZZ ZZZ" }, { cookie: "nc_table=SECRETCOOKIE" }), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.fieldErrors).toEqual({ code: ["That code doesn't match this table. Check it, or ask our staff."] });
    expect(res.headers.get("set-cookie")).toBeNull();
    const all = logs.join("\n");
    expect(all).toContain('"event":"table_join_failed"');
    expect(all).toContain('"tableNumber":7');
    expect(all).not.toMatch(/ZZZ|SECRETCOOKIE|turnstileToken|tok"/);
    expect(scheduled.length).toBeGreaterThanOrEqual(1);
    for (const w of scheduled) await w();
    expect(m.rpcCalls.map((c) => String(c.args.p_key ?? c.name))).toEqual(
      expect.arrayContaining(["table-join-fail:table:7", "table-join-fail:global"]),
    );
  });

  it("failed-join counter: the 21st failure on a table in an hour records exactly one owner alert (SEC-028)", async () => {
    const m = memoryDb({ now: () => NOW.getTime(), rpc: { record_admin_alert: () => ({ data: SID2, error: null }) } });
    const outcomes: (string | null)[] = [];
    for (let i = 0; i < 25; i++) outcomes.push((await countFailedJoin(m.db as Db, 7)).alerted);
    expect(outcomes.filter((o) => o !== null)).toEqual(["table"]);
    expect(outcomes.indexOf("table")).toBe(20);
    const alerts = m.rpcCalls.filter((c) => c.name === "record_admin_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.args).toEqual({ p_kind: "table_join_fail", p_data: { tableNumber: 7, failures: 21 } });
  });

  it("failed-join counter: the global threshold (51st across tables) alerts once with tableNumber null", async () => {
    const m = memoryDb({ now: () => NOW.getTime(), rpc: { record_admin_alert: () => ({ data: SID2, error: null }) } });
    for (let i = 0; i < 60; i++) await countFailedJoin(m.db as Db, (i % 10) + 1);
    const alerts = m.rpcCalls.filter((c) => c.name === "record_admin_alert");
    expect(alerts.map((a) => a.args.p_data)).toEqual([{ tableNumber: null, failures: 51 }]);
  });

  it("mode off: NOT_FOUND 404; Turnstile failure: BOT_CHECK_FAILED before any limit or RPC", async () => {
    const k = await keys();
    const m = memoryDb({ now: () => NOW.getTime(), rpc: { join_table_session: () => ({ data: null, error: { code: "P0001", message: "NOT_FOUND" } }) } });
    const { deps } = routeDeps(m, k);
    expect((await handleTableJoin(post("/api/table/join", joinBody), deps)).status).toBe(404);
    const m2 = memoryDb({ now: () => NOW.getTime() });
    const r2 = routeDeps(m2, k, { turnstile: async () => Promise.reject(new AppError("BOT_CHECK_FAILED")) });
    const res = await handleTableJoin(post("/api/table/join", joinBody), r2.deps);
    expect(res.status).toBe(400);
    expect(m2.rpcCalls).toHaveLength(0);
  });

  it("body rules: non-JSON content type and bad JSON are VALIDATION 400 with no-store", async () => {
    const k = await keys();
    const m = memoryDb({ now: () => NOW.getTime() });
    const { deps } = routeDeps(m, k);
    const r1 = await handleTableJoin(post("/api/table/join", joinBody, { "content-type": "text/plain" }), deps);
    expect(r1.status).toBe(400);
    const r2 = await handleTableJoin(post("/api/table/join", "{bad"), deps);
    expect(r2.status).toBe(400);
    expect(r2.headers.get("cache-control")).toBe("no-store");
  });
});

// ================================================================================================================
describe("GET /api/table/session (9.4)", () => {
  const get = (q = "", cookie?: string) =>
    new Request(`${SITE}/api/table/session${q}`, { headers: { "x-forwarded-for": "203.0.113.9", ...(cookie ? { cookie } : {}) } });

  it("no cookie: { state: none }, no database call, no Set-Cookie; a bad cookie also clears it", async () => {
    const k = await keys();
    const m = memoryDb({ now: () => NOW.getTime() });
    const { deps } = routeDeps(m, k, { cookieKeys: async () => Promise.reject(new Error("must not be needed")) });
    const res = await handleTableSession(get(), deps);
    expect(await res.json()).toEqual({ ok: true, data: { state: "none" } });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");

    const r2 = routeDeps(m, k);
    const bad = await handleTableSession(get("", "nc_table=1.forged"), r2.deps);
    expect(await bad.json()).toEqual({ ok: true, data: { state: "none" } });
    expect(bad.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(m.rpcCalls).toHaveLength(0);
  });

  it("valid cookie: session and epoch come from the cookie only; since passed; ?session / ?table ignored (B3)", async () => {
    const k = await keys();
    const m = memoryDb({ now: () => NOW.getTime(), rpc: { table_session_guest_view: () => ({ data: { state: "unchanged", rev: 3 }, error: null }) } });
    const { deps } = routeDeps(m, k);
    const v = await signTableCookie(k, { sessionId: SID, epoch: 2, issuedAt: NOW_S });
    const res = await handleTableSession(get(`?since=3&session=${SID2}&sessionId=${SID2}&table=9`, `nc_table=${v}`), deps);
    expect(await res.json()).toEqual({ ok: true, data: { state: "unchanged", rev: 3 } });
    expect(m.rpcCalls.find((c) => c.name === "table_session_guest_view")?.args).toEqual({ p_session_id: SID, p_epoch: 2, p_since: 3 });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("closed / none from the database clears the cookie; a bad since is ignored", async () => {
    const k = await keys();
    const m = memoryDb({ now: () => NOW.getTime(), rpc: { table_session_guest_view: () => ({ data: { state: "closed", tableNumber: 7 }, error: null }) } });
    const { deps } = routeDeps(m, k);
    const v = await signTableCookie(k, { sessionId: SID, epoch: 1, issuedAt: NOW_S });
    const res = await handleTableSession(get("?since=-4", `nc_table=${v}`), deps);
    expect(await res.json()).toEqual({ ok: true, data: { state: "closed", tableNumber: 7 } });
    expect(res.headers.get("set-cookie")).toContain("nc_table=; Path=/api/table; Max-Age=0");
    expect(m.rpcCalls.find((c) => c.name === "table_session_guest_view")?.args.p_since).toBeNull();
  });

  it("the IP limiter fails open, but a real RATE_LIMITED is 429", async () => {
    const k = await keys();
    const v = await signTableCookie(k, { sessionId: SID, epoch: 1, issuedAt: NOW_S });
    const f = fakeDb({
      rpc: {
        rate_limit_hit_info: () => pgErr("08006", "down"),
        table_session_guest_view: () => ok({ state: "open", session: view }),
      },
    });
    const { deps } = routeDeps(f, k);
    expect((await handleTableSession(get("", `nc_table=${v}`), deps)).status).toBe(200);
    const m = memoryDb({ now: () => NOW.getTime(), rpc: { table_session_guest_view: () => ({ data: { state: "open", session: view }, error: null }) } });
    const r = routeDeps(m, k);
    for (let i = 0; i < 180; i++) await handleTableSession(get("", `nc_table=${v}`), r.deps);
    expect((await handleTableSession(get("", `nc_table=${v}`), r.deps)).status).toBe(429);
  });
});

// ================================================================================================================
describe("POST /api/table/orders (9.5)", () => {
  const body = { clientRequestId: REQ, items: [{ menuItemId: ITEM, variantIds: [OPT], qty: 2 }], note: " less ice ", sessionId: SID2 };
  const created = { round: 2, replayed: false, session: view };

  async function setup(rpc: Record<string, (a: Record<string, unknown>) => { data: unknown; error: unknown }> = {}) {
    const k = await keys();
    const m = memoryDb({ now: () => NOW.getTime(), rpc: { create_table_order: () => ({ data: created, error: null }), ...rpc } });
    const r = routeDeps(m, k);
    const v = await signTableCookie(k, { sessionId: SID, epoch: 4, issuedAt: NOW_S });
    return { k, m, ...r, cookie: `nc_table=${v}` };
  }

  it("no / bad cookie: TABLE_SESSION_INVALID 401 with a clearing cookie, no database call", async () => {
    const { m, deps } = await setup();
    for (const cookie of [undefined, "nc_table=nope"]) {
      const res = await handleTableOrders(post("/api/table/orders", body, cookie ? { cookie } : {}), deps);
      expect(res.status).toBe(401);
      expect((await res.json()).error.message).toBe("Your table is not open for ordering. Enter the code from our staff to order.");
      expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(m.rpcCalls).toHaveLength(0);
  });

  it("201 for a new round; the session comes from the cookie (body sessionId ignored); limits per session then per IP", async () => {
    const { m, deps, cookie } = await setup();
    const res = await handleTableOrders(post("/api/table/orders", body, { cookie }), deps);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, data: created });
    const limitKeys = m.rpcCalls.filter((c) => c.name === "rate_limit_hit_info").map((c) => [String(c.args.p_key).replace(/[0-9a-f]{64}/, "<h>"), c.args.p_max]);
    expect(limitKeys).toEqual([
      [`table-order:session:${SID}`, 20],
      ["table-order:ip:<h>", 300],
    ]);
    expect(m.rpcCalls.find((c) => c.name === "create_table_order")?.args).toEqual({
      p_session_id: SID,
      p_epoch: 4,
      p_client_request_id: REQ,
      p_items: [{ menuItemId: ITEM, variantIds: [OPT], qty: 2 }],
      p_note: "less ice",
    });
  });

  it("a replay answers 200 replayed: true", async () => {
    const { deps, cookie } = await setup({ create_table_order: () => ({ data: { ...created, replayed: true }, error: null }) });
    const res = await handleTableOrders(post("/api/table/orders", body, { cookie }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).data.replayed).toBe(true);
  });

  it("SEC-026: 20 rounds from session A use up A only; session B on the same IP still sends", async () => {
    const { k, deps, cookie } = await setup();
    for (let i = 0; i < 20; i++) expect((await handleTableOrders(post("/api/table/orders", body, { cookie }), deps)).status).toBe(201);
    const limited = await handleTableOrders(post("/api/table/orders", body, { cookie }), deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(logs.join("\n")).toContain(`"sessionPrefix":"${SID.slice(0, 8)}"`);
    const b = await signTableCookie(k, { sessionId: SID2, epoch: 1, issuedAt: NOW_S });
    expect((await handleTableOrders(post("/api/table/orders", body, { cookie: `nc_table=${b}` }), deps)).status).toBe(201);
  });

  it("database answers: stopped table = 503 with the table text; ended session = 401 + clearing cookie; CONFLICT hint passes", async () => {
    const stopped = await setup({
      create_table_order: () => ({ data: null, error: { code: "P0001", message: "TABLE_ORDERS_PAUSED", hint: "Ordering from the app is stopped for this table. Please order with our staff." } }),
    });
    const r1 = await handleTableOrders(post("/api/table/orders", body, { cookie: stopped.cookie }), stopped.deps);
    expect(r1.status).toBe(503);
    expect((await r1.json()).error).toMatchObject({ code: "TABLE_ORDERS_PAUSED", message: "Ordering from the app is stopped for this table. Please order with our staff." });
    expect(r1.headers.get("retry-after")).toBeNull();

    const ended = await setup({ create_table_order: () => ({ data: null, error: { code: "P0001", message: "TABLE_SESSION_INVALID" } }) });
    const r2 = await handleTableOrders(post("/api/table/orders", body, { cookie: ended.cookie }), ended.deps);
    expect(r2.status).toBe(401);
    expect(r2.headers.get("set-cookie")).toContain("Max-Age=0");

    const waiting = await setup({
      create_table_order: () => ({ data: null, error: { code: "P0001", message: "CONFLICT", hint: "Your earlier orders are still waiting for the kitchen. Please wait a moment or ask our staff." } }),
    });
    const r3 = await handleTableOrders(post("/api/table/orders", body, { cookie: waiting.cookie }), waiting.deps);
    expect(r3.status).toBe(409);
    expect((await r3.json()).error.message).toBe("Your earlier orders are still waiting for the kitchen. Please wait a moment or ask our staff.");
  });

  it("never logs the note, the cookie or the body, even on INTERNAL", async () => {
    const { deps, cookie } = await setup({ create_table_order: () => ({ data: null, error: { code: "XX000", message: "boom" } }) });
    const res = await handleTableOrders(post("/api/table/orders", { ...body, note: "SECRET-NOTE" }, { cookie }), deps);
    expect(res.status).toBe(500);
    const all = logs.join("\n");
    expect(all).not.toContain("SECRET-NOTE");
    expect(all).not.toContain(cookie.slice(9, 40));
  });

  it("Origin refused before anything, like join", async () => {
    const { m, deps, cookie } = await setup();
    const res = await handleTableOrders(post("/api/table/orders", body, { cookie, origin: "https://cafe.example.evil.test" }), deps);
    expect(res.status).toBe(403);
    expect(m.rpcCalls).toHaveLength(0);
  });
});

// ================================================================================================================
describe("notifier (9.10, 2.3.0)", () => {
  type Sent = { kind: "alert" | "summary"; text: string };
  function channel(sent: Sent[], opts: { fail?: boolean; enabled?: boolean } = {}): AlertChannelAdapter {
    return {
      channel: "webpush",
      enabled: () => opts.enabled !== false,
      send: async (a) => {
        sent.push({ kind: "alert", text: a.text });
        return opts.fail ? { ok: false, error: "http 500" } : { ok: true };
      },
      sendSummary: async (t) => {
        sent.push({ kind: "summary", text: t });
        return { ok: true };
      },
    };
  }
  const claimed = (n: number, at = NOW) =>
    Array.from({ length: n }, (_, i) => ({ alertId: `a${i}`, kind: "table_void", text: `Alert ${i}`, createdAt: new Date(at.getTime() + i).toISOString() }));

  function notifyDb(batches: unknown[][]) {
    const finished: { id: unknown; ok: unknown; error: unknown }[] = [];
    const m = memoryDb({
      now: () => NOW.getTime(),
      rpc: {
        claim_alert_deliveries: () => ({ data: batches.shift() ?? [], error: null }),
        finish_alert_delivery: (a) => {
          finished.push({ id: a.p_alert_id, ok: a.p_ok, error: a.p_error });
          return { data: null, error: null };
        },
      },
    });
    return { m, finished };
  }

  it("v1: no channel enabled = no database call at all (and nothing scheduled)", async () => {
    const f = fakeDb({});
    expect(await runNotifier(f.db)).toEqual({ ran: false, reason: "no_channel" });
    expect(await runNotifier(f.db, { channels: [channel([], { enabled: false })] })).toEqual({ ran: false, reason: "no_channel" });
    expect(f.rpcCalls).toHaveLength(0);
    const scheduled: unknown[] = [];
    scheduleNotifier((w) => void scheduled.push(w), () => f.db);
    expect(scheduled).toHaveLength(0);
  });

  it("claim -> send -> finish; at most 5 sends per 10 minutes, then ONE summary covering the rest", async () => {
    const sent: Sent[] = [];
    const { m, finished } = notifyDb([claimed(8)]);
    const out = await runNotifier(m.db as Db, { channels: [channel(sent)], now: () => NOW.getTime() });
    expect(out).toMatchObject({ ran: true, channels: [{ channel: "webpush", claimed: 8, sent: 5, summarised: 3, held: 0 }] });
    expect(sent.filter((s) => s.kind === "alert")).toHaveLength(5);
    expect(sent.filter((s) => s.kind === "summary").map((s) => s.text)).toEqual([summaryText(3)]);
    expect(summaryText(3)).toBe("3 more alerts. Open Admin > Alerts.");
    expect(finished).toHaveLength(8);
    expect(finished.every((f) => f.ok === true)).toBe(true);
    expect(m.rpcCalls.find((c) => c.name === "claim_alert_deliveries")?.args).toEqual({ p_channel: "webpush", p_limit: 20 });
  });

  it("once the window's summary is used, further alerts are held (finished as failed 'held', retried later)", async () => {
    const sent: Sent[] = [];
    const { m, finished } = notifyDb([claimed(7), claimed(2)]);
    await runNotifier(m.db as Db, { channels: [channel(sent)], now: () => NOW.getTime() });
    finished.length = 0;
    const out = await runNotifier(m.db as Db, { channels: [channel(sent)], now: () => NOW.getTime() });
    expect(out).toMatchObject({ ran: true, channels: [{ sent: 0, summarised: 0, held: 2 }] });
    expect(finished.map((f) => [f.ok, f.error])).toEqual([
      [false, "held"],
      [false, "held"],
    ]);
    expect(sent.filter((s) => s.kind === "summary")).toHaveLength(1);
  });

  it("a failed send is finished as failed with the short error; alerts older than 24 h are never sent", async () => {
    const sent: Sent[] = [];
    const old = claimed(1, new Date(NOW.getTime() - 25 * 3600 * 1000));
    const { m, finished } = notifyDb([[...old, ...claimed(1)]]);
    await runNotifier(m.db as Db, { channels: [channel(sent, { fail: true })], now: () => NOW.getTime() });
    expect(finished).toEqual([
      { id: "a0", ok: false, error: "expired" },
      { id: "a0", ok: false, error: "http 500" },
    ]);
    expect(sent).toHaveLength(1);
  });

  it("never throws: a claim error is reported, not raised", async () => {
    const f = fakeDb({ rpc: { claim_alert_deliveries: () => pgErr("42501", "nope") } });
    await expect(runNotifier(f.db, { channels: [channel([])] })).resolves.toMatchObject({ ran: true, channels: [{ error: "claim_failed" }] });
  });
});

// ================================================================================================================
describe("GET /api/menu: settings.tableOrdering and occupancy (B6)", () => {
  const settingsRow = (mode: string) => ({
    hours: { weekly: {}, closures: [] },
    announcement: null,
    prices_include_vat: true,
    service_charge_pct: 0,
    vat_pct: 13,
    table_ordering: mode,
  });
  function menuDbs(mode: string, occupancy: { data: unknown; error: unknown } = { data: [{ number: 1, label: "Window", occupied: true }, { number: 2, label: null, occupied: false }], error: null }) {
    const pub = fakeDb({
      tables: {
        menu_categories: ok([]),
        menu_items: ok([]),
        menu_variants: ok([]),
        menu_specials: ok([]),
        public_settings: ok(settingsRow(mode)),
      },
    });
    const svc = fakeDb({ rpc: { rate_limit_hit_info: () => ok([{ allowed: true, remaining: 1, retry_after_seconds: 0 }]) }, tables: { table_occupancy: occupancy as never } });
    return { pub, svc };
  }
  const req = () => new Request(`${SITE}/api/menu`, { headers: { "x-forwarded-for": "203.0.113.9" } });
  beforeEach(() => clearMenuCache());

  it("mode on: tables from the service-role view with three columns; never in the remembered copy", async () => {
    const { pub, svc } = menuDbs("on");
    const res = await handleMenu(req(), { db: () => pub.db, supabaseUrl: () => "https://x.supabase.co", limiterDb: () => svc.db, salt: () => "s".repeat(32) });
    const body = await res.json();
    expect(body.data.settings.tableOrdering).toBe("on");
    expect(body.data.tables).toEqual({
      total: 2,
      free: 1,
      tables: [
        { number: 1, label: "Window", occupied: true },
        { number: 2, label: null, occupied: false },
      ],
    });
    const occ = svc.tableCalls.find((c) => c.table === "table_occupancy");
    expect(occ?.calls[0]).toEqual({ op: "select", args: ["number, label, occupied"] });
    expect(pub.tableCalls.some((c) => c.table === "table_occupancy" || c.table === "table_sessions")).toBe(false);
    expect(cachedMenu()).not.toHaveProperty("tables");
  });

  it("mode off: tables null; a failed occupancy read gives null and the menu still answers; degraded copy has tables null", async () => {
    let d = menuDbs("off");
    let body = await (await handleMenu(req(), { db: () => d.pub.db, supabaseUrl: () => "", limiterDb: () => d.svc.db, salt: () => "s".repeat(32) })).json();
    expect([body.data.settings.tableOrdering, body.data.tables]).toEqual(["off", null]);

    d = menuDbs("paused", { data: null, error: { code: "42501", message: "denied" } });
    const res = await handleMenu(req(), { db: () => d.pub.db, supabaseUrl: () => "", limiterDb: () => d.svc.db, salt: () => "s".repeat(32) });
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.data.tables).toBeNull();
    expect(logs.join("\n")).toContain("table_occupancy_failed");

    const broken = fakeDb({ tables: { menu_categories: { data: null, error: { code: "08006" } } } });
    const deg = await (await handleMenu(req(), { db: () => broken.db, supabaseUrl: () => "", limiterDb: () => d.svc.db, salt: () => "s".repeat(32) })).json();
    expect(deg.data.degraded).toBe(true);
    expect(deg.data.tables).toBeNull();
  });
});

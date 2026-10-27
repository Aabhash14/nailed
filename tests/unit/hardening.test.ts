import { afterEach, describe, expect, it, vi } from "vitest";
import { hardenCookieOptions } from "@/lib/auth/cookies";
import { authCaptchaEnabled, serverEnv, serverEnvProblems } from "@/lib/env";
import { AppError, logAppError } from "@/lib/errors";
import { readJson } from "@/lib/http";
import { securityEvent } from "@/lib/log";
import { parseRupeesToPaisa } from "@/lib/money";
import { alertGate, formatNewOrderAlert } from "@/lib/notify/telegram";
import { resetLimit } from "@/lib/ratelimit";
import { isHttpsUrl, updateSettingsSchema } from "@/lib/validation/admin";
import { mapDbError } from "@/lib/data/db-errors";
import type { Db } from "@/lib/data/types";
import { assertImageGroupsValid, checkImageGroup, isWebp } from "@/lib/images/verify";
import { fakeDb, ok, pgErr } from "./helpers/fake-db";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---- SEC-015 ----------------------------------------------------------------------------------------
describe("readJson: body size is checked before / while reading (SEC-015)", () => {
  /** A body stream that serves `total` bytes in 1 KB chunks and records how many it handed out. */
  function countingStream(total: number) {
    const state = { served: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (state.served >= total) return ctrl.close();
        const n = Math.min(1024, total - state.served);
        state.served += n;
        ctrl.enqueue(new Uint8Array(n).fill(0x20));
      },
      cancel() {
        state.cancelled = true;
      },
    }, { highWaterMark: 0 }); // no pre-fetch: every byte served is a byte the reader asked for
    return { stream, state };
  }
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) => {
    // undici needs `duplex: "half"` for stream bodies
    const init = { method: "POST", body, headers: { "content-type": "application/json", ...headers }, duplex: "half" };
    return new Request("https://cafe.test/api/checkout", init as RequestInit);
  };

  it("a declared Content-Length over 32 KB is rejected without reading a single byte", async () => {
    const { stream, state } = countingStream(100 * 1024);
    const err = await readJson(post(stream, { "content-length": String(100 * 1024) })).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION");
    expect((err as AppError).message).toMatch(/too large/);
    expect(state.served).toBe(0);
  });

  it("a 100 KB body with no Content-Length is cut off at the limit (never buffered in full)", async () => {
    const { stream, state } = countingStream(100 * 1024);
    const err = (await readJson(post(stream)).catch((e) => e)) as AppError;
    expect(err.code).toBe("VALIDATION");
    expect(state.served).toBeLessThan(40 * 1024);
    expect(state.cancelled).toBe(true);
  });

  it("counts bytes, not UTF-16 units (multi-byte text over the byte limit is rejected)", async () => {
    const text = JSON.stringify({ a: "न".repeat(12_000) }); // ~12k chars, ~36 KB of UTF-8
    expect(text.length).toBeLessThan(32_768);
    expect(((await readJson(post(text)).catch((e) => e)) as AppError).code).toBe("VALIDATION");
  });

  it("requires application/json when asked (stops text/plain cross-site simple POSTs)", async () => {
    const r = new Request("https://cafe.test/x", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } });
    expect(((await readJson(r, { requireJsonContentType: true }).catch((e) => e)) as AppError).code).toBe("VALIDATION");
    const good = new Request("https://cafe.test/x", { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json; charset=utf-8" } });
    await expect(readJson(good, { requireJsonContentType: true })).resolves.toEqual({ a: 1 });
  });

  it("bad JSON, garbage Content-Length and invalid UTF-8 are VALIDATION, never 500", async () => {
    expect(((await readJson(post("{nope")).catch((e) => e)) as AppError).code).toBe("VALIDATION");
    expect(((await readJson(post("{}", { "content-length": "abc" })).catch((e) => e)) as AppError).code).toBe("VALIDATION");
    expect(((await readJson(post(new Uint8Array([0x7b, 0xff, 0x7d]))).catch((e) => e)) as AppError).code).toBe("VALIDATION");
  });
});

// ---- SEC-006 ----------------------------------------------------------------------------------------
describe("session cookies (SEC-006)", () => {
  it("are HttpOnly and SameSite=Lax always, Secure in production", () => {
    const lib = { path: "/", sameSite: "lax" as const, httpOnly: false, maxAge: 400 * 24 * 3600 };
    expect(hardenCookieOptions(lib, "production")).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(hardenCookieOptions(lib, "development")).toMatchObject({ httpOnly: true, secure: false, sameSite: "lax" });
  });
  it("keep the library maxAge so sign-out (maxAge 0) still deletes the cookie", () => {
    expect(hardenCookieOptions({ maxAge: 0 }, "production").maxAge).toBe(0);
    expect(hardenCookieOptions(undefined, "production")).toMatchObject({ httpOnly: true, path: "/" });
  });
});

// ---- SEC-010 ----------------------------------------------------------------------------------------
describe("server env validation (SEC-010)", () => {
  const base = { SUPABASE_SERVICE_ROLE_KEY: "k", TURNSTILE_SECRET_KEY: "t", IP_HASH_SALT: "x".repeat(32) };
  it("requires a 32+ character salt and reports only variable NAMES", () => {
    expect(serverEnvProblems(base)).toEqual([]);
    const short = { ...base, IP_HASH_SALT: "a-sixteen-chars!" };
    expect(serverEnvProblems(short)).toEqual(["IP_HASH_SALT"]);
    expect(JSON.stringify(serverEnvProblems(short))).not.toContain("a-sixteen");
    expect(() => serverEnv(short)).toThrow();
  });
  it("treats blank optional variables (copied from .dev.vars.example) as unset", () => {
    expect(serverEnvProblems({ ...base, TELEGRAM_BOT_TOKEN: "", RESEND_API_KEY: " ", APP_ENV: "" })).toEqual([]);
  });
  it("AUTH_CAPTCHA_ENABLED is off unless exactly 'true'", () => {
    expect(authCaptchaEnabled({})).toBe(false);
    expect(authCaptchaEnabled({ AUTH_CAPTCHA_ENABLED: "yes" })).toBe(false);
    expect(authCaptchaEnabled({ AUTH_CAPTCHA_ENABLED: "true" })).toBe(true);
  });
});

// ---- SEC-013 ----------------------------------------------------------------------------------------
describe("security log (SEC-013)", () => {
  it("writes one JSON line with a closed field set; ip hash cut to 8 chars", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    securityEvent("login_failed", { ipHashPrefix: "a".repeat(64), code: "invalid_credentials" });
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line).toMatchObject({ type: "security", event: "login_failed", ipHashPrefix: "aaaaaaaa", level: "warn" });
  });
  it("INTERNAL errors are logged with their server-side detail; other codes are not", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logAppError(new AppError("INTERNAL", undefined, { logDetail: "rate_limit_hit_info: 08006" }), "req-1");
    logAppError(new AppError("VALIDATION"), "req-2");
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toMatchObject({ requestId: "req-1", detail: "rate_limit_hit_info: 08006" });
  });
});

// ---- SEC-020 helper ---------------------------------------------------------------------------------
describe("resetLimit: clears one key (used after a successful sign-in)", () => {
  it("deletes every window of exactly that key and fails closed on a database error", async () => {
    const f = fakeDb({ tables: { rate_limits: ok(null) } });
    await resetLimit(f.db, "login:email-ip:abc:def");
    const calls = f.tableCalls[0]!.calls;
    expect(calls.map((c) => c.op)).toEqual(["delete", "eq"]);
    expect(calls[1]!.args).toEqual(["key", "login:email-ip:abc:def"]);
    expect(f.rpcCalls).toHaveLength(0);
    await expect(resetLimit(fakeDb({ tables: { rate_limits: pgErr("XX000", "down") } }).db, "k")).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

// ---- SEC-003 alert coalescing, loosened by SEC-019 ----------------------------------------------------
describe("Telegram alert coalescing (SEC-019): up to 5 a minute, then coalesced", () => {
  it("the FIRST alert of a window is sent and reports how many were held back in the previous busy window", async () => {
    const f = fakeDb({
      rpc: { rate_limit_hit_info: () => ok([{ allowed: true, remaining: 4, retry_after_seconds: 0 }]) },
      tables: { rate_limits: ok([{ window_start: "2026-10-21T10:00:00Z", count: 7 }]) },
    });
    expect(await alertGate(f.db, "new-order")).toEqual({ send: true, heldBack: 2 });
    expect(f.rpcCalls[0]?.args).toEqual({ p_key: "alert:new-order", p_window_seconds: 60, p_max: 5 });
  });
  it("alerts 2..5 of a window are sent without a summary line (the row they read is their own window)", async () => {
    const f = fakeDb({
      rpc: { rate_limit_hit_info: () => ok([{ allowed: true, remaining: 2, retry_after_seconds: 0 }]) },
      tables: { rate_limits: ok([{ window_start: "2026-10-21T10:01:00Z", count: 9 }]) },
    });
    expect(await alertGate(f.db, "new-order")).toEqual({ send: true, heldBack: 0 });
  });
  it("alerts above 5 in the same window are held back", async () => {
    const f = fakeDb({ rpc: { rate_limit_hit_info: () => ok([{ allowed: false, remaining: 0, retry_after_seconds: 40 }]) } });
    expect(await alertGate(f.db, "new-order")).toEqual({ send: false, heldBack: 0 });
  });
  it("fails open (sends) when the database cannot answer or there is no db", async () => {
    expect(await alertGate(fakeDb({ rpc: { rate_limit_hit_info: () => pgErr("08006", "down") } }).db, "internal-error")).toEqual({ send: true, heldBack: 0 });
    expect(await alertGate(null, "internal-error")).toEqual({ send: true, heldBack: 0 });
  });
  it("the summary line names a count and nothing personal", () => {
    const t = formatNewOrderAlert({ orderId: "x", orderNumber: "NC-9", itemCount: 2, fulfilment: "delivery", total: 50000 }, undefined, 6);
    expect(t).toContain("+6 more new orders since the previous alert");
    expect(formatNewOrderAlert({ orderId: "x", orderNumber: "NC-9", itemCount: 1, fulfilment: "pickup", total: 100 }, undefined, 0)).not.toContain("more");
  });
});

// ---- DB check constraints -> field errors (migration 20261021000002) -----------------------------------
describe("mapDbError: settings check violations by constraint name", () => {
  const v = (name: string) =>
    mapDbError({ code: "23514", message: `new row for relation "site_settings" violates check constraint "${name}"`, details: "Failing row contains (secret stuff)" });
  it.each([
    ["site_settings_delivery_needs_area", "deliveryAreas"],
    ["site_settings_hours_ranges_valid", "hours"],
    ["order_rules_cod_max_total_valid", "codMaxTotal"],
    ["order_rules_ip_open_orders_max_range", "ipOpenOrdersMax"],
    ["order_rules_ip_orders_max_per_day_range", "ipOrdersMaxPerDay"],
    ["order_rules_auto_cancel_range", "autoCancelPlacedAfterMinutes"],
  ])("%s -> VALIDATION on %s, no PostgREST text", (name, field) => {
    const e = v(name);
    expect(e.code).toBe("VALIDATION");
    expect(Object.keys(e.fieldErrors ?? {})).toEqual([field]);
    expect(JSON.stringify({ m: e.message, f: e.fieldErrors })).not.toMatch(/Failing row|violates|relation/);
  });
  it("an unknown constraint is a generic VALIDATION", () => {
    const e = v("something_else");
    expect(e.code).toBe("VALIDATION");
    expect(e.fieldErrors).toBeUndefined();
  });
});

// ---- SEC-018 post-upload image check --------------------------------------------------------------------
describe("image groups are checked after upload (SEC-018)", () => {
  const webp = (size: number) => {
    const b = new Uint8Array(size);
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("WEBP"), 8);
    return new Blob([b]);
  };
  const storage = (files: Record<string, Blob | null>) => {
    const removed: string[][] = [];
    const db = {
      storage: {
        from: () => ({
          download: async (p: string) => (files[p] ? { data: files[p], error: null } : { data: null, error: { message: "not found" } }),
          remove: async (paths: string[]) => (removed.push(paths), { data: [], error: null }),
        }),
      },
    } as unknown as Db;
    return { db, removed };
  };
  const g = "menu/3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";
  const good = { [`${g}/480.webp`]: webp(1000), [`${g}/960.webp`]: webp(5000), [`${g}/1600.webp`]: webp(20000) };

  it("accepts three real WebP files within their caps", async () => {
    expect(await checkImageGroup(storage(good).db, g)).toEqual({ ok: true });
  });
  it("a 250 KB file declared as 480 px is refused and the whole group is deleted", async () => {
    const s = storage({ ...good, [`${g}/480.webp`]: webp(250 * 1024) });
    const err = (await assertImageGroupsValid(s.db, [g], "imagePath").catch((e) => e)) as AppError;
    expect(err.code).toBe("VALIDATION");
    expect(err.fieldErrors).toHaveProperty("imagePath");
    expect(s.removed[0]).toEqual([`${g}/480.webp`, `${g}/960.webp`, `${g}/1600.webp`]);
  });
  it("non-WebP bytes under a .webp name, or a missing width, are refused", async () => {
    expect((await checkImageGroup(storage({ ...good, [`${g}/960.webp`]: new Blob(["<html>not an image</html>"]) }).db, g)).ok).toBe(false);
    expect((await checkImageGroup(storage({ ...good, [`${g}/1600.webp`]: null }).db, g)).ok).toBe(false);
    expect(isWebp(new Uint8Array(4))).toBe(false);
  });
});

// ---- BUG-006 money ----------------------------------------------------------------------------------
describe("parseRupeesToPaisa: strict (BUG-006)", () => {
  it.each([
    ["1250", 125000],
    ["1,250", 125000],
    ["12,500", 1250000],
    ["1,25,000", 12500000],
    ["123,456", 12345600],
    ["12.5", 1250],
    ["12.50", 1250],
    ["Rs. 350", 35000],
    ["0", 0],
  ])("%s -> %i paisa", (input, paisa) => expect(parseRupeesToPaisa(input)).toBe(paisa));

  it.each(["12,50", "1,25,0", "", "  ", "-5", "1e3", "1.234", "12.", ".5", "abc", "1,2", "99999999999"])("rejects %j", (input) =>
    expect(parseRupeesToPaisa(input)).toBeNull(),
  );
});

// ---- SEC-012 / BUG-003 / BUG-006 settings schema ------------------------------------------------------
describe("updateSettings validation", () => {
  const parse = (v: object) => updateSettingsSchema.safeParse(v);
  it("mapUrl must be https (javascript:, data:, http: are refused) (SEC-012)", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "http://maps.google.com/x", "https://user:pw@maps.google.com", "ftp://x.y"]) {
      expect(parse({ mapUrl: bad }).success).toBe(false);
    }
    expect(parse({ mapUrl: "https://maps.app.goo.gl/abc" }).success).toBe(true);
    expect(parse({ mapUrl: null }).success).toBe(true);
    expect(isHttpsUrl("JAVASCRIPT:alert(1)")).toBe(false);
  });
  it("phone and WhatsApp accept real numbers only (SEC-012)", () => {
    for (const good of ["01-4000000", "+977 9841234567", "(01) 4 000 000", "9841234567", ""]) expect(parse({ phone: good }).success).toBe(true);
    for (const bad of ["javascript:alert(1)", "call me", "12345", "+977 98412345678901234", "98<script>"]) expect(parse({ whatsapp: bad }).success).toBe(false);
  });
  it("codMaxTotal 0 means NO limit and is stored as null (BUG-003)", () => {
    const r = parse({ codMaxTotal: 0 });
    expect(r.success && r.data.codMaxTotal).toBeNull();
    const r2 = parse({ codMaxTotal: 500000 });
    expect(r2.success && r2.data.codMaxTotal).toBe(500000);
    expect(parse({ codMaxTotal: -1 }).success).toBe(false);
  });
  it("hours: closing must be after opening; invalid clock times refused (BUG-006)", () => {
    const hours = (slot: { open: string; close: string }) => ({
      hours: { weekly: { "0": null, "1": [slot], "2": null, "3": null, "4": null, "5": null, "6": null }, closures: [] },
    });
    expect(parse(hours({ open: "09:00", close: "18:00" })).success).toBe(true);
    expect(parse(hours({ open: "18:00", close: "24:00" })).success).toBe(true); // midnight close, same as the DB check
    expect(parse(hours({ open: "24:00", close: "24:00" })).success).toBe(false);
    const reversed = parse(hours({ open: "18:00", close: "09:00" }));
    expect(reversed.success).toBe(false);
    expect(reversed.error?.issues[0]?.path.join(".")).toBe("hours.weekly.1.0.close");
    expect(parse(hours({ open: "09:00", close: "09:00" })).success).toBe(false);
    expect(parse(hours({ open: "25:00", close: "26:00" })).success).toBe(false);
    expect(parse(hours({ open: "9:00", close: "18:00" })).success).toBe(false);
  });
  it("delivery (cod) with an empty area list in the same request is refused (BUG-006)", () => {
    const r = parse({ paymentMethods: ["cod", "pickup"], deliveryAreas: [] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["deliveryAreas"]);
    expect(parse({ paymentMethods: ["pickup"], deliveryAreas: [] }).success).toBe(true);
  });
});

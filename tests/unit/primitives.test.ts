import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mapDbError, mapRpcError } from "@/lib/data/db-errors";
import { normalizeNepalPhone } from "@/lib/phone";
import { ipKey, UNKNOWN_IP } from "@/lib/ratelimit";
import { allowForwardedFallback, clientIp, hmacHex, ipBucket, ipHash } from "@/lib/ratelimit/ip-hash";
import { slugify } from "@/lib/slug";
import { roleAllows } from "@/lib/auth/roles";
import { HTTP_STATUS } from "@/lib/errors";

describe("normalizeNepalPhone", () => {
  it.each([
    ["9841234567", "+9779841234567"],
    ["98 4123-4567", "+9779841234567"],
    ["+977 9841234567", "+9779841234567"],
    ["9779741234567", "+9779741234567"],
    ["00977-9841234567", "+9779841234567"],
  ])("accepts %s", (input, expected) => expect(normalizeNepalPhone(input)).toBe(expected));

  it.each(["", "123", "9641234567", "+919841234567", "98412345678", "abcdefghij"])("rejects %s", (input) =>
    expect(normalizeNepalPhone(input)).toBeNull(),
  );
});

describe("ipHash (SEC-010: HMAC-SHA-256 keyed with the salt)", () => {
  const salt = "0123456789abcdef0123456789abcdef-salt";
  it("is HMAC-SHA-256(salt, 'ip:' + ip), lowercase hex, 64 chars (fits the DB check)", async () => {
    const h = await ipHash("203.0.113.9", salt);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHmac("sha256", salt).update("ip:203.0.113.9").digest("hex"));
    // no longer the old unkeyed construction
    expect(h).not.toBe(createHash("sha256").update(`${salt}:203.0.113.9`).digest("hex"));
  });
  it("differs per salt (so per environment) and per ip, and never contains the ip", async () => {
    const a = await ipHash("203.0.113.9", salt);
    expect(a).not.toBe(await ipHash("203.0.113.9", `${salt}-other`));
    expect(a).not.toBe(await ipHash("203.0.113.10", salt));
    expect(a).not.toContain("203.0.113.9");
  });
  it("refuses a salt shorter than 32 characters (the old 16-char minimum is no longer enough)", async () => {
    await expect(ipHash("1.1.1.1", "short")).rejects.toThrow();
    await expect(ipHash("1.1.1.1", "x".repeat(16))).rejects.toThrow(/32/);
    await expect(ipHash("1.1.1.1", "x".repeat(31))).rejects.toThrow();
    await expect(ipHash("1.1.1.1", "x".repeat(32))).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
  it("separates purposes: the same text hashed as ip, phone and email gives three different digests", async () => {
    const v = "9841234567";
    const all = new Set([await hmacHex(salt, "ip", v), await hmacHex(salt, "phone", v), await hmacHex(salt, "email", v)]);
    expect(all.size).toBe(3);
  });
});

describe("ipBucket (SEC-009: IPv6 is limited per /64)", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    ["2001:db8:abcd:12:1:2:3:4", "2001:db8:abcd:12::/64"],
    ["2001:db8:abcd:12::99", "2001:db8:abcd:12::/64"],
    ["2001:DB8:ABCD:0012:ffff:ffff:ffff:ffff", "2001:db8:abcd:12::/64"],
    ["::ffff:198.51.100.7", "198.51.100.7"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["unknown", "unknown"],
  ])("%s -> %s", (ip, bucket) => expect(ipBucket(ip)).toBe(bucket));

  it("two addresses in the same /64 share a hash; a different /64 does not", async () => {
    const salt = "s".repeat(32);
    const a = await ipHash("2001:db8:1:2::a", salt);
    expect(await ipHash("2001:db8:1:2:ffff::b", salt)).toBe(a);
    expect(await ipHash("2001:db8:1:3::a", salt)).not.toBe(a);
  });
});

describe("clientIp (SEC-009)", () => {
  const dev = { NODE_ENV: "development" };
  const prod = { NODE_ENV: "production", APP_ENV: "production" };
  it("prefers cf-connecting-ip over spoofable forwarded headers", () => {
    const h = new Headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "6.6.6.6, 7.7.7.7" });
    expect(clientIp(h, dev)).toBe("1.1.1.1");
    expect(clientIp(h, prod)).toBe("1.1.1.1");
  });
  it("falls back to forwarded headers only on a developer machine, and returns null when absent", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 7.7.7.7" }), dev)).toBe("6.6.6.6");
    expect(clientIp(new Headers({ "x-real-ip": "5.5.5.5" }), dev)).toBe("5.5.5.5");
    expect(clientIp(new Headers(), dev)).toBeNull();
  });
  it("in production / staging ignores x-forwarded-for and x-real-ip entirely", () => {
    const spoofed = new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "5.5.5.5" });
    expect(clientIp(spoofed, prod)).toBeNull();
    expect(clientIp(spoofed, { NODE_ENV: "production" })).toBeNull();
    expect(clientIp(spoofed, { NODE_ENV: "development", APP_ENV: "staging" })).toBeNull();
    expect(allowForwardedFallback(prod)).toBe(false);
  });
});

describe("ipKey: a missing IP is one strict shared bucket, never 'no limit' (SEC-009)", () => {
  it("returns a key and a 64-hex hash even without any IP header", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    const salt = "k".repeat(32);
    const a = await ipKey("checkout", new Headers({ "x-forwarded-for": "6.6.6.6" }), salt);
    const b = await ipKey("checkout", new Headers(), salt);
    expect(a.key).toMatch(/^checkout:ip:[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash); // the spoofed header is ignored: both land in the "unknown" bucket
    expect(a.known).toBe(false);
    expect(a.hash).toBe(await ipHash(UNKNOWN_IP, salt));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
});

describe("mapRpcError (supabase/README error protocol)", () => {
  const e = (message: string, details = "", hint = "") => mapRpcError({ code: "P0001", message, details, hint });

  it("maps VALIDATION details to fieldErrors", () => {
    const r = e("VALIDATION", JSON.stringify({ items: ["Minimum order for delivery is Rs. 500"] }));
    expect(r.code).toBe("VALIDATION");
    expect(r.fieldErrors).toEqual({ items: ["Minimum order for delivery is Rs. 500"] });
  });
  it("maps OUT_OF_STOCK details", () => {
    const r = e("OUT_OF_STOCK", JSON.stringify({ "items.1": ["only 2 left"] }));
    expect(r.code).toBe("OUT_OF_STOCK");
    expect(r.fieldErrors).toEqual({ "items.1": ["only 2 left"] });
  });
  it("RATE_LIMITED carries retryAfterSeconds", () => {
    expect(e("RATE_LIMITED", JSON.stringify({ retryAfterSeconds: 120 })).retryAfterSeconds).toBe(120);
  });
  it("ORDER_REFUSED never carries detail or hint", () => {
    const r = e("ORDER_REFUSED", "blocked phone", "cap reached");
    expect(r.code).toBe("ORDER_REFUSED");
    expect(JSON.stringify(r.fieldErrors ?? {})).toBe("{}");
    expect(r.message).not.toMatch(/blocked|cap/);
  });
  it("passes a safe CONFLICT hint through", () => {
    expect(e("CONFLICT", "", "Please call us to change this order").message).toBe("Please call us to change this order");
  });
  it("hides the raw illegal-transition hint behind a friendly message", () => {
    expect(e("CONFLICT", "", "illegal status transition").message).toBe("That status change is not allowed.");
  });
  it("anything else is INTERNAL with no SQL in the message", () => {
    const r = mapRpcError({ code: "42P01", message: 'relation "orders" does not exist' });
    expect(r.code).toBe("INTERNAL");
    expect(r.message).not.toMatch(/relation|orders/);
  });
  it("an unknown P0001 message is INTERNAL", () => {
    expect(e("SOMETHING_ELSE").code).toBe("INTERNAL");
  });
  it("ORDERS_PAUSED (kill switch) maps to its own code, HTTP 503", () => {
    const r = e("ORDERS_PAUSED");
    expect(r.code).toBe("ORDERS_PAUSED");
    expect(HTTP_STATUS[r.code]).toBe(503);
  });
});

describe("mapDbError", () => {
  it("unique violation -> CONFLICT, check violation -> VALIDATION, rls -> FORBIDDEN", () => {
    expect(mapDbError({ code: "23505" }, { conflictMessage: "slug taken" }).message).toBe("slug taken");
    expect(mapDbError({ code: "23514" }).code).toBe("VALIDATION");
    expect(mapDbError({ code: "42501" }).code).toBe("FORBIDDEN");
    expect(mapDbError({ code: "XX000", message: "boom" }).code).toBe("INTERNAL");
  });
});

describe("misc", () => {
  it("slugify", () => {
    expect(slugify("Hot Coffee & Tea!")).toBe("hot-coffee-tea");
    expect(slugify("चिया", "category")).toBe("category");
  });
  it("roleAllows: staff cannot do owner things, owner can do both", () => {
    expect(roleAllows("staff", "owner")).toBe(false);
    expect(roleAllows("staff", "staff")).toBe(true);
    expect(roleAllows("owner", "owner")).toBe(true);
    expect(roleAllows(null, "staff")).toBe(false);
  });
});

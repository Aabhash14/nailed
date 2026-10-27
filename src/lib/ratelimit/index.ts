import { AppError } from "@/lib/errors";
import type { Db } from "@/lib/data/types";
import { securityEvent } from "@/lib/log";
import type { RateLimitInfoRow } from "@/types/db";
import { clientIp, hmacHex, ipHash } from "./ip-hash";

export { allowForwardedFallback, clientIp, hmacHex, ipBucket, ipHash, MIN_SALT_LENGTH, sha256Hex } from "./ip-hash";

/**
 * Rate-limit presets (api-contract.md). Windows are in seconds.
 * There is deliberately NO per-phone attempt limiter for checkout (SEC-002): counting attempts let anyone
 * lock a named customer out. Real orders per phone are capped inside create_order
 * (order_rules.phone_orders_max_per_day), which counts placed orders only.
 */
export const LIMITS = {
  checkoutIp: { window: 10 * 60, max: 5 },
  orderLookupIp: { window: 60, max: 30 },
  orderCancelIp: { window: 60 * 60, max: 10 },
  healthIp: { window: 60, max: 30 },
  /**
   * GET /api/menu (SEC-021). ESTIMATE, sized for one shared IP (cafe Wi-Fi, or a mobile carrier's CGNAT) with many
   * open menus: each visible menu polls every 30 s = 2 a minute, so 180 a minute = 90 open menus behind one IP,
   * about 2x a 20-table cafe with two phones per table, plus refetch-on-return bursts. One abusive IP is held to
   * 3 requests a second; the Cloudflare rate rule (devops) is the volumetric control.
   */
  menuIp: { window: 60, max: 180 },
  loginIp: { window: 15 * 60, max: 10 },
  /**
   * SEC-020: sign-in ATTEMPTS, counted atomically before the password check. Strict lock per (email + IP bucket),
   * cleared by a successful sign-in, so one IP can only lock itself out. Looser ceiling per email whatever the IP
   * (not cleared on success), so a distributed guesser is still capped. Both ESTIMATE.
   */
  loginEmailIp: { window: 15 * 60, max: 5 },
  loginEmail: { window: 60 * 60, max: 30 },
  /**
   * Table ordering (api-contract 9.3 to 9.5, SEC-026; all ESTIMATE). Per session or per (IP, table) first, because the
   * cafe Wi-Fi gives every guest the same IP; the per-IP numbers are ceilings only.
   */
  tableJoinIpTable: { window: 10 * 60, max: 10 },
  tableJoinIp: { window: 10 * 60, max: 150 },
  tableOrderSession: { window: 10 * 60, max: 20 },
  tableOrderIp: { window: 10 * 60, max: 300 },
  tableViewIp: { window: 60, max: 180 },
  /** SEC-028: failed joins are COUNTED (never refused); going over raises one owner alert per window. */
  tableJoinFailGlobal: { window: 60 * 60, max: 50 },
  tableJoinFailTable: { window: 60 * 60, max: 20 },
} as const;

export type Limit = { window: number; max: number };

/** Used as the "IP" when no client IP is available, so such requests share one strict bucket (SEC-009). */
export const UNKNOWN_IP = "unknown";

function first<T>(data: unknown): T | undefined {
  return (Array.isArray(data) ? data[0] : data) as T | undefined;
}

function logLimited(key: string) {
  const [scope, kind, hash] = key.split(":");
  securityEvent("rate_limited", {
    scope,
    kind,
    // "iptable" = table-join per (IP bucket, table); "session" = table-order per table session (SEC-026)
    ipHashPrefix: kind === "ip" || kind === "iptable" ? hash : undefined,
    sessionPrefix: kind === "session" ? hash : undefined,
  });
}

/** Record one hit (rpc rate_limit_hit_info) and return the row. Database errors are INTERNAL. */
export async function recordHit(db: Db, key: string, limit: Limit): Promise<RateLimitInfoRow> {
  const { data, error } = await db.rpc("rate_limit_hit_info", {
    p_key: key,
    p_window_seconds: limit.window,
    p_max: limit.max,
  });
  if (error) throw new AppError("INTERNAL", undefined, { logDetail: `rate_limit_hit_info: ${error.code}` });
  const row = first<RateLimitInfoRow>(data);
  if (!row) throw new AppError("INTERNAL", undefined, { logDetail: "rate_limit_hit_info returned no row" });
  return row;
}

/**
 * Count one hit in Postgres (rpc rate_limit_hit_info). Throws RATE_LIMITED with retryAfterSeconds
 * when over the limit. A database error is rethrown as INTERNAL: callers decide whether to fail
 * closed (checkout, login) or open (health).
 */
export async function enforceLimit(db: Db, key: string, limit: Limit): Promise<void> {
  const row = await recordHit(db, key, limit);
  if (!row.allowed) {
    logLimited(key);
    throw new AppError("RATE_LIMITED", undefined, { retryAfterSeconds: row.retry_after_seconds });
  }
}

/**
 * Forget every window of one key (service client, direct delete on public.rate_limits). Used to clear a
 * sign-in counter after a successful login (SEC-020). Throws INTERNAL on a database error; callers decide.
 * There is deliberately no read-only "peek": check-then-record was raceable (SEC-020). Count first, then act.
 */
export async function resetLimit(db: Db, key: string): Promise<void> {
  const { error } = await db.from("rate_limits").delete().eq("key", key);
  if (error) throw new AppError("INTERNAL", undefined, { logDetail: `rate_limits reset: ${error.code}` });
}

/**
 * Key builders. Raw IPs, phones and emails never appear in a key: they are HMAC'd first.
 * A missing client IP maps to one shared "unknown" bucket (strict, not "unlimited"), and is logged.
 */
export async function ipKey(scope: string, headers: Headers, salt: string): Promise<{ key: string; hash: string; known: boolean }> {
  const ip = clientIp(headers);
  if (!ip) securityEvent("client_ip_missing", { scope });
  const hash = await ipHash(ip ?? UNKNOWN_IP, salt);
  return { key: `${scope}:ip:${hash}`, hash, known: ip !== null };
}

export async function emailKey(scope: string, email: string, salt: string): Promise<string> {
  return `${scope}:email:${await hmacHex(salt, "email", email.trim().toLowerCase())}`;
}

export async function phoneKey(scope: string, phone: string, salt: string): Promise<string> {
  return `${scope}:phone:${await hmacHex(salt, "phone", phone)}`;
}

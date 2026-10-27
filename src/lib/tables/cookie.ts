import { decodeBase64Key, optionalEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";

/**
 * Guest table cookie (api-contract 9.2; SEC-023, SEC-025). Stateless: it says "this browser joined table session
 * <sid> at cookie epoch <epoch>". The database is the authority on every request (session open, under 12 h,
 * cookie_epoch = epoch), so closing the table or pressing "New code" ends every earlier cookie.
 *
 * Value: `<kid>.<sid>.<epoch>.<iat>.<sig>`
 *   kid   key id, one digit 1..9 (TABLE_COOKIE_KEY_ID signs; TABLE_COOKIE_KEY_PREVIOUS_ID verifies during a rotation)
 *   sid   table session id (UUID)
 *   epoch table_sessions.cookie_epoch at join time, 1..32767
 *   iat   issued-at, Unix seconds
 *   sig   base64url (no padding) of HMAC-SHA-256(key, "table-session|<kid>|<sid>|<epoch>|<iat>")
 *
 * Signed with a DEDICATED key (TABLE_COOKIE_KEY), never IP_HASH_SALT. Verified with crypto.subtle.verify (constant
 * time) after a strict parse; anything malformed, unknown, expired or forged counts as "no cookie": no database call.
 * Never log the cookie value.
 */

export const TABLE_COOKIE_MAX_AGE_SECONDS = 43_200; // 12 h
export const TABLE_COOKIE_FUTURE_SKEW_SECONDS = 60;
export const TABLE_COOKIE_PATH = "/api/table";
export const TABLE_COOKIE_NAME_DEV = "nc_table";
export const TABLE_COOKIE_NAME_PROD = "__Secure-nc_table";

type EnvLike = Record<string, string | undefined>;

export type TableCookieKey = { kid: number; key: CryptoKey };
export type TableCookieKeys = { current: TableCookieKey; previous: TableCookieKey | null };
export type TableCookiePayload = { sessionId: string; epoch: number; issuedAt: number };

const enc = new TextEncoder();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding
const MAX_VALUE_LENGTH = 120;

/** Production builds (staging and production Workers) use Secure and the `__Secure-` name; a dev server does not. */
export function tableCookieSecure(env: EnvLike = process.env): boolean {
  return env.NODE_ENV === "production";
}

export function tableCookieName(env: EnvLike = process.env): string {
  return tableCookieSecure(env) ? TABLE_COOKIE_NAME_PROD : TABLE_COOKIE_NAME_DEV;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Import raw key bytes (tests, and the env loader below). At least 32 bytes. */
export async function makeTableCookieKey(kid: number, raw: Uint8Array): Promise<TableCookieKey> {
  if (!Number.isInteger(kid) || kid < 1 || kid > 9) throw new Error("table cookie key id must be 1..9");
  if (raw.length < 32) throw new Error("table cookie key must be at least 32 bytes");
  return { kid, key: await importKey(raw) };
}

let keyCache: { fingerprint: string; keys: Promise<TableCookieKeys> } | null = null;

/**
 * Keys from the environment (TABLE_COOKIE_KEY, TABLE_COOKIE_KEY_ID, TABLE_COOKIE_KEY_PREVIOUS,
 * TABLE_COOKIE_KEY_PREVIOUS_ID). A missing or invalid key is INTERNAL with the variable NAME in the log, never a value.
 * Imported once per isolate (cached by the env values).
 */
export function tableCookieKeysFromEnv(env: EnvLike = process.env): Promise<TableCookieKeys> {
  const cur = optionalEnv("TABLE_COOKIE_KEY", env);
  const curId = optionalEnv("TABLE_COOKIE_KEY_ID", env) ?? "1";
  const prev = optionalEnv("TABLE_COOKIE_KEY_PREVIOUS", env);
  const prevId = optionalEnv("TABLE_COOKIE_KEY_PREVIOUS_ID", env);
  const fingerprint = [cur, curId, prev, prevId].join("\u0000");
  if (keyCache?.fingerprint === fingerprint) return keyCache.keys;

  const fail = (name: string) => new AppError("INTERNAL", undefined, { logDetail: `server env invalid: ${name}` });
  const curBytes = cur ? decodeBase64Key(cur) : null;
  if (!curBytes || curBytes.length < 32) return Promise.reject(fail("TABLE_COOKIE_KEY"));
  if (!/^[1-9]$/.test(curId)) return Promise.reject(fail("TABLE_COOKIE_KEY_ID"));
  let prevBytes: Uint8Array | null = null;
  if (prev) {
    prevBytes = decodeBase64Key(prev);
    if (!prevBytes || prevBytes.length < 32) return Promise.reject(fail("TABLE_COOKIE_KEY_PREVIOUS"));
    if (!prevId || !/^[1-9]$/.test(prevId) || prevId === curId) return Promise.reject(fail("TABLE_COOKIE_KEY_PREVIOUS_ID"));
  }
  const keys = (async (): Promise<TableCookieKeys> => ({
    current: await makeTableCookieKey(Number(curId), curBytes),
    previous: prevBytes ? await makeTableCookieKey(Number(prevId), prevBytes) : null,
  }))();
  keyCache = { fingerprint, keys };
  keys.catch(() => {
    if (keyCache?.keys === keys) keyCache = null;
  });
  return keys;
}

function message(kid: number, p: TableCookiePayload): Uint8Array<ArrayBuffer> {
  return enc.encode(`table-session|${kid}|${p.sessionId}|${p.epoch}|${p.issuedAt}`);
}

function toBase64Url(buf: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Sign a cookie value with the CURRENT key. The session id is written lower-case. */
export async function signTableCookie(keys: TableCookieKeys, p: TableCookiePayload): Promise<string> {
  const payload = { ...p, sessionId: p.sessionId.toLowerCase() };
  if (!UUID_RE.test(payload.sessionId)) throw new Error("table cookie: session id is not a UUID");
  if (!Number.isInteger(payload.epoch) || payload.epoch < 1 || payload.epoch > 32767) throw new Error("table cookie: bad epoch");
  if (!Number.isInteger(payload.issuedAt) || payload.issuedAt < 1) throw new Error("table cookie: bad issuedAt");
  const { kid, key } = keys.current;
  const sig = await crypto.subtle.sign("HMAC", key, message(kid, payload));
  return `${kid}.${payload.sessionId}.${payload.epoch}.${payload.issuedAt}.${toBase64Url(sig)}`;
}

/**
 * Strict parse + constant-time verify. Returns the payload, or null for anything that is not a valid, unexpired
 * cookie signed by a known key: wrong part count, unknown kid, non-UUID sid, non-decimal or out-of-range epoch / iat,
 * iat more than 60 s in the future or more than 12 h old, bad signature.
 */
export async function verifyTableCookie(
  keys: TableCookieKeys,
  value: string | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<TableCookiePayload | null> {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 5) return null;
  const [kidS, sid, epochS, iatS, sig] = parts as [string, string, string, string, string];
  if (!/^[1-9]$/.test(kidS)) return null;
  const kid = Number(kidS);
  const key = keys.current.kid === kid ? keys.current : keys.previous?.kid === kid ? keys.previous : null;
  if (!key) return null;
  if (!UUID_RE.test(sid) || sid !== sid.toLowerCase()) return null;
  if (!/^[1-9][0-9]{0,4}$/.test(epochS)) return null;
  const epoch = Number(epochS);
  if (epoch > 32767) return null;
  if (!/^[1-9][0-9]{0,10}$/.test(iatS)) return null;
  const issuedAt = Number(iatS);
  if (issuedAt > nowSeconds + TABLE_COOKIE_FUTURE_SKEW_SECONDS) return null;
  if (nowSeconds - issuedAt > TABLE_COOKIE_MAX_AGE_SECONDS) return null;
  if (!SIG_RE.test(sig)) return null;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = fromBase64Url(sig);
  } catch {
    return null;
  }
  const payload = { sessionId: sid, epoch, issuedAt };
  const valid = await crypto.subtle.verify("HMAC", key.key, sigBytes, message(kid, payload));
  return valid ? payload : null;
}

/**
 * Every value of the named cookie in a Cookie header (normally one). Cookie names are compared exactly. At most 3
 * are returned, so a header stuffed with copies costs nothing.
 */
export function readCookieValues(cookieHeader: string | null, name: string): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    out.push(part.slice(eq + 1).trim());
    if (out.length >= 3) break;
  }
  return out;
}

export type TableCookieRead = { present: boolean; payload: TableCookiePayload | null };

/** Read and verify the table cookie of a request. `present` = a cookie of that name was sent (valid or not). */
export async function readTableCookie(
  headers: Headers,
  keys: TableCookieKeys,
  opts: { env?: EnvLike; nowSeconds?: number } = {},
): Promise<TableCookieRead> {
  const values = readCookieValues(headers.get("cookie"), tableCookieName(opts.env));
  for (const v of values) {
    const payload = await verifyTableCookie(keys, v, opts.nowSeconds);
    if (payload) return { present: true, payload };
  }
  return { present: values.length > 0, payload: null };
}

function attributes(env: EnvLike | undefined, maxAge: number): string {
  // No Domain attribute, ever (cookie tossing from a sibling subdomain; threat model 5.4).
  const secure = tableCookieSecure(env) ? "; Secure" : "";
  return `Path=${TABLE_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/** Set-Cookie header value for a freshly signed cookie (12 h). */
export function tableCookieHeader(value: string, env?: EnvLike): string {
  return `${tableCookieName(env)}=${value}; ${attributes(env, TABLE_COOKIE_MAX_AGE_SECONDS)}`;
}

/** Set-Cookie header value that deletes the cookie (same name and path, Max-Age=0). */
export function clearTableCookieHeader(env?: EnvLike): string {
  return `${tableCookieName(env)}=; ${attributes(env, 0)}`;
}

/**
 * Keyed hashing for personal identifiers (SEC-010). HMAC-SHA-256 keyed with IP_HASH_SALT, one purpose
 * label per data type ("ip:", "phone:", "email:") so one digest can never be confused with another.
 * Output stays lowercase hex, 64 chars, so the database checks (`^[0-9a-f]{64}$`) still hold.
 * This is the only form in which an IP, phone or email reaches the database (orders.ip_hash,
 * blocked_contacts, rate_limits keys). Changing IP_HASH_SALT (or this construction) resets IP-based
 * blocklist entries and counters (ops/env.md).
 */

export const MIN_SALT_LENGTH = 32;
/**
 * Purpose labels. "table-session" is deliberately NOT one of them: api-contract 2.1.0 (SEC-025) moved the guest table
 * cookie off IP_HASH_SALT to its own key (TABLE_COOKIE_KEY, src/lib/tables/cookie.ts), so rotating one secret never
 * resets the other's data. Do not add a cookie-signing purpose here.
 */
export type HashPurpose = "ip" | "phone" | "email";

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Plain SHA-256 hex. Not for personal data (use hmacHex); kept for non-secret fingerprints. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

let keyCache: { salt: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(salt: string): Promise<CryptoKey> {
  if (keyCache?.salt !== salt) {
    keyCache = {
      salt,
      key: crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    };
  }
  return keyCache.key;
}

/** HMAC-SHA-256(salt, `${purpose}:${value}`) as lowercase hex. Refuses a salt shorter than 32 characters. */
export async function hmacHex(salt: string, purpose: HashPurpose, value: string): Promise<string> {
  if (typeof salt !== "string" || salt.length < MIN_SALT_LENGTH) {
    throw new Error(`IP_HASH_SALT must be at least ${MIN_SALT_LENGTH} characters`);
  }
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(salt), enc.encode(`${purpose}:${value}`));
  return toHex(sig);
}

// ---- IP normalisation ----------------------------------------------------------------------------

function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Expand an IPv6 address to 8 numeric groups, or null when it is not one. Handles "::" and an IPv4 tail. */
function parseIpv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const rest = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The unit we rate-limit and block (SEC-009): an IPv4 address as is, an IPv6 address by its /64 prefix
 * (one household or phone usually owns a whole /64), an IPv4-mapped IPv6 address as its IPv4.
 * Anything unparseable is used lowercased as-is (it still gets hashed).
 */
export function ipBucket(ip: string): string {
  const s = ip.trim();
  const v4 = parseIpv4(s);
  if (v4) return v4.join(".");
  const v6 = parseIpv6(s);
  if (!v6) return s.toLowerCase().slice(0, 100);
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
    return [v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff].join(".");
  }
  return `${v6
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** Salted, keyed hash of the client's IP bucket. */
export async function ipHash(ip: string, salt: string): Promise<string> {
  return hmacHex(salt, "ip", ipBucket(ip));
}

type EnvLike = Record<string, string | undefined>;

/**
 * Forwarded-header fallbacks are trusted ONLY on a developer machine: NODE_ENV is not "production" and
 * APP_ENV is unset or "development". Staging and production (any other APP_ENV value, or any production build) use
 * cf-connecting-ip alone, which Cloudflare sets at the edge and a client cannot forge (SEC-009).
 */
export function allowForwardedFallback(env: EnvLike = process.env): boolean {
  const appEnv = (env.APP_ENV ?? "").trim().toLowerCase();
  return env.NODE_ENV !== "production" && (appEnv === "" || appEnv === "development");
}

/** Client IP, or null when none is present (callers then use one shared "unknown" bucket, never "no limit"). */
export function clientIp(headers: Headers, env: EnvLike = process.env): string | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 100);
  if (!allowForwardedFallback(env)) return null;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 100);
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff ? xff.slice(0, 100) : null;
}

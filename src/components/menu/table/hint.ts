/**
 * Small, EAGER helpers for /menu table ordering (they ship with the menu, so keep this file tiny and import-free):
 * the `?t=` / `?code=` query values and the local join hint (api-contract 2.0.0 section 9.2).
 *
 * The hint is NOT a credential (the HttpOnly `nc_table` cookie is). It only decides whether the menu asks
 * GET /api/table/session on mount, so guests who never joined cost no request. Stored in localStorage under
 * `nc_table_hint` as { tableNumber, joinedAt }; deleted on a "none" or "closed" answer.
 */

export const TABLE_HINT_KEY = "nc_table_hint";
/** Same lifetime as the session and the cookie (12 h). */
export const TABLE_HINT_MAX_AGE_MS = 12 * 3_600_000;
/** Clock skew allowed for a hint "from the future" (same 60 s as the cookie's issuedAt rule). */
const FUTURE_SKEW_MS = 60_000;

export type TableHint = { tableNumber: number; joinedAt: string };

/** `?t=7` -> 7. Display range 1..99 (architecture.md section 2); anything else -> null. */
export function parseTableParam(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 99 ? n : null;
}

/** `?code=K7M4QX` as scanned. Only a plausible value is kept (1..20 characters of letters, digits, spaces, dashes). */
export function parseCodeParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  return t.length >= 1 && t.length <= 20 && /^[A-Za-z0-9 -]+$/.test(t) ? t : null;
}

/** Strict parse of a stored hint. Null when missing, malformed, older than 12 h or from the future. */
export function parseHint(raw: string | null | undefined, now: number): TableHint | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const { tableNumber, joinedAt } = v as Record<string, unknown>;
  if (typeof tableNumber !== "number" || !Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 99) return null;
  if (typeof joinedAt !== "string") return null;
  const t = Date.parse(joinedAt);
  if (!Number.isFinite(t)) return null;
  if (t - now > FUTURE_SKEW_MS || now - t >= TABLE_HINT_MAX_AGE_MS) return null;
  return { tableNumber, joinedAt };
}

export function readHint(now: number = Date.now()): TableHint | null {
  try {
    return parseHint(window.localStorage.getItem(TABLE_HINT_KEY), now);
  } catch {
    return null; // storage blocked
  }
}

export function writeHint(tableNumber: number, now: number = Date.now()): void {
  try {
    const hint: TableHint = { tableNumber, joinedAt: new Date(now).toISOString() };
    window.localStorage.setItem(TABLE_HINT_KEY, JSON.stringify(hint));
    window.dispatchEvent(new Event(HINT_EVENT));
  } catch {
    /* storage blocked: the guest re-enters the code after a reload */
  }
}

export function clearHint(): void {
  try {
    window.localStorage.removeItem(TABLE_HINT_KEY);
    window.dispatchEvent(new Event(HINT_EVENT));
  } catch {
    /* ignore */
  }
}

/** Same-tab change signal (the storage event only fires in OTHER tabs). */
export const HINT_EVENT = "nc-table-hint";

/**
 * SEC-024 (security review 2026-10-25): the QR link carries the code in the FRAGMENT, "/menu?t=7#c=K7M4QX", so it is
 * never sent to the server, never in a log and never in a Referer. A legacy "?code=" (contract 2.0.0 text) is read
 * too. The menu calls this on FIRST MOUNT, keeps the code in memory only (never in storage, F4) and replaces the
 * address at once with `cleanUrl`, before the join sheet, Turnstile or any fetch.
 */
export function takeScannedCode(href: string): { code: string | null; cleanUrl: string | null } {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { code: null, cleanUrl: null };
  }
  const hash = new URLSearchParams(u.hash.startsWith("#") ? u.hash.slice(1) : u.hash);
  const fromHash = hash.get("c");
  const fromQuery = u.searchParams.get("code");
  if (fromHash === null && fromQuery === null) return { code: null, cleanUrl: null };
  u.searchParams.delete("code");
  hash.delete("c");
  const q = u.searchParams.toString();
  const h = hash.toString();
  return {
    code: parseCodeParam(fromHash ?? fromQuery),
    cleanUrl: `${u.pathname}${q ? `?${q}` : ""}${h ? `#${h}` : ""}`,
  };
}

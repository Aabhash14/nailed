import { AppError } from "@/lib/errors";
import { allowForwardedFallback } from "@/lib/ratelimit/ip-hash";

type EnvLike = Record<string, string | undefined>;

export const ORIGIN_REFUSED = "Request refused.";

/** The origin (scheme://host[:port]) of a URL, or null when it does not parse or is not http(s). */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * True when the request's `Origin` header may post to /api/table/* (api-contract 9.2, threat model checklist B1).
 * - The header must be present and be a bare origin: it is parsed, and the parsed origin must equal the raw header,
 *   so `null`, a path, credentials or anything odd is refused.
 * - It must equal the origin of NEXT_PUBLIC_SITE_URL exactly (string equality of parsed origins; never a prefix or
 *   substring test, so `https://site.example.evil.test` fails).
 * - `http://localhost:<any port>` is also allowed, but only on a developer machine, decided by the same runtime test
 *   as allowForwardedFallback() (NODE_ENV not production, APP_ENV unset or development). Never by a build flag.
 */
export function originAllowed(origin: string | null, siteUrl: string | undefined, env: EnvLike = process.env): boolean {
  if (!origin) return false;
  const parsed = originOf(origin);
  if (!parsed || parsed !== origin) return false;
  const site = originOf(siteUrl);
  if (site && parsed === site) return true;
  if (!allowForwardedFallback(env)) return false;
  const u = new URL(parsed);
  return u.protocol === "http:" && u.hostname === "localhost";
}

/** Throws FORBIDDEN 403 "Request refused." unless the Origin is allowed. Call BEFORE reading the body. */
export function assertTableOrigin(req: Request, siteUrl: string | undefined, env: EnvLike = process.env): void {
  if (!originAllowed(req.headers.get("origin"), siteUrl, env)) throw new AppError("FORBIDDEN", ORIGIN_REFUSED);
}

/** Host of NEXT_PUBLIC_SITE_URL for the Turnstile hostname check (SEC-028), or null when the URL is unusable. */
export function siteHostname(siteUrl: string | undefined): string | null {
  const o = originOf(siteUrl);
  return o ? new URL(o).hostname : null;
}

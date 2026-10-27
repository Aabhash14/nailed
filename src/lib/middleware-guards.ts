/** Pure helpers for src/middleware.ts (kept out of the middleware file so it only exports what Next expects). */

const MOCK_REFUSED_ENVS = new Set(["staging", "production"]);

/**
 * SEC-011 residual: true when a MOCK build must not serve, because the runtime APP_ENV (a Worker var in
 * wrangler.jsonc) says this is a deployed environment. Unset or "development" (dev, e2e) = serve.
 */
export function refuseMockBuild(appEnv: string | undefined): boolean {
  return MOCK_REFUSED_ENVS.has((appEnv ?? "").trim().toLowerCase());
}

/**
 * `/admin` and everything below it, in every form the old `/admin/:path*` matcher compiled to: the page path, its
 * `.json` / `.rsc` / `.segments/...` variants and the `/_next/data/<build>/...` prefix. Decoded and lowercased
 * first, so an encoded or upper-case spelling is covered too (over-matching only means a redirect to the login).
 */
export function isAdminPath(pathname: string): boolean {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // malformed escape: compare the raw path
  }
  p = p.toLowerCase().replace(/^\/_next\/data\/[^/]+(?=\/)/, "");
  return p === "/admin" || p.startsWith("/admin/") || p.startsWith("/admin.");
}

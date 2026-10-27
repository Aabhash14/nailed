import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/**
 * SEC-011 build guard. Mock mode (sample data, fake admin login, no orders reach the cafe) must never ship by accident.
 * - NEXT_PUBLIC_DATA_MODE unset or "live" -> live (the default).
 * - NEXT_PUBLIC_DATA_MODE=mock             -> mock; a production build also needs ALLOW_MOCK_BUILD=1 (the e2e build sets it).
 * - anything else                          -> build fails (a typo must not silently pick a mode).
 * A live build also needs the public Supabase values: they are inlined at build time and the ISR pages read the
 * database while building, so without them the build would fail later with a less helpful prerender error.
 */
function assertDataModeForBuild(): void {
  const mode = process.env.NEXT_PUBLIC_DATA_MODE;
  if (mode !== undefined && mode !== "" && mode !== "live" && mode !== "mock") {
    throw new Error(`NEXT_PUBLIC_DATA_MODE must be "live" or "mock" (got "${mode}").`);
  }
  if (mode === "mock") {
    if (process.env.ALLOW_MOCK_BUILD !== "1") {
      throw new Error(
        "Refusing to build in MOCK data mode: the site would show sample data and no order would reach the cafe. " +
          "Unset NEXT_PUBLIC_DATA_MODE for a live build, or set ALLOW_MOCK_BUILD=1 for a test-only build (e2e).",
      );
    }
    return;
  }
  const missing = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `LIVE build (the default) needs ${missing.join(" and ")} (public values, see .env.example / ops/env.md). ` +
        "For a test-only build with sample data set NEXT_PUBLIC_DATA_MODE=mock and ALLOW_MOCK_BUILD=1.",
    );
  }
}

/** Origin of the Supabase project (https + wss), from the public env. Empty in mock mode. */
function supabaseOrigins(): { https: string; wss: string } | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { https: u.origin, wss: `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}` };
  } catch {
    return null;
  }
}

const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * SEC-005 Content-Security-Policy. 'unsafe-inline' for scripts is needed by Next's inline bootstrap scripts until a
 * nonce-based CSP (middleware) replaces it; everything else is locked to self, Turnstile and the Supabase project.
 */
function contentSecurityPolicy(isDev: boolean): string {
  const sb = supabaseOrigins();
  const sbHttps = sb ? ` ${sb.https}` : "";
  const sbWss = sb ? ` ${sb.wss}` : "";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} ${TURNSTILE}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${sbHttps}`,
    "font-src 'self' data:",
    `connect-src 'self'${sbHttps}${sbWss} ${TURNSTILE}${isDev ? " ws: http://localhost:*" : ""}`,
    `frame-src ${TURNSTILE}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join("; ");
}

function securityHeaders(isDev: boolean, isProdBuild: boolean) {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(isDev) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
  ];
  // HSTS only from production builds (browsers ignore it over plain http anyway). No includeSubDomains/preload until
  // the client's custom domain is final (devops decides; SEC-005).
  if (isProdBuild) headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
  return headers;
}

export default function config(phase: string): NextConfig {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  if (phase === PHASE_PRODUCTION_BUILD) assertDataModeForBuild();
  const isProdBuild = !isDev;

  return {
    // Dev server only: NEXT_DEV_DIST_DIR=.next-dev lets a local `next dev` run alongside a build/e2e that owns `.next`.
    // Never applies to `next build` / `next start`.
    ...(isDev && process.env.NEXT_DEV_DIST_DIR ? { distDir: process.env.NEXT_DEV_DIST_DIR } : {}),
    reactStrictMode: true,
    poweredByHeader: false,
    outputFileTracingRoot: import.meta.dirname,
    // Images are pre-sized WebP variants chosen by a custom loader (src/lib/images).
    // No runtime image optimisation service on Workers Free.
    images: { unoptimized: true },
    async headers() {
      return [
        // Later entries override earlier ones for the same header key (Next.js rule), so the global set comes first.
        { source: "/:path*", headers: securityHeaders(isDev, isProdBuild) },
        { source: "/api/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
        {
          // The order token in the URL is the credential: never send it in a Referer, never index it.
          source: "/order/:path*",
          headers: [
            { key: "Referrer-Policy", value: "no-referrer" },
            { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          ],
        },
        {
          source: "/api/orders/:path*",
          headers: [
            { key: "Referrer-Policy", value: "no-referrer" },
            { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          ],
        },
        {
          // also matches /admin itself
          source: "/admin/:path*",
          headers: [
            { key: "Referrer-Policy", value: "no-referrer" },
            { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          ],
        },
      ];
    },
  };
}

// Gives `next dev` the Cloudflare bindings (KV etc.) locally, no account needed.
if (process.env.NODE_ENV === "development") initOpenNextCloudflareForDev();

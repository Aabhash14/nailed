import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * QA regression for the "middleware never ran" defect (fixed 2026-10-21: it moved from ./middleware.ts to
 * src/middleware.ts; a root middleware.ts is silently ignored when the app uses src/).
 *
 * Unlike middleware-cache-orderview.test.ts, @supabase/ssr is NOT mocked here: the real client runs, with
 * NEXT_PUBLIC_DATA_MODE=live explicitly (not just unset). No database or network is used: with no auth cookie the
 * library answers "no session" without a request, and a forged cookie only reaches a stubbed fetch.
 * The last block checks the BUILD output (.next/server/middleware-manifest.json): it proves Next actually registered
 * src/middleware.ts for /admin. It is skipped when there is no build in .next.
 */

const APP = fileURLToPath(new URL("../../", import.meta.url));
const { middleware, config } = await import("@/middleware");
const req = (path: string, cookie?: string) =>
  new NextRequest(new URL(path, "https://cafe.test"), cookie ? { headers: { cookie } } : undefined);

function live() {
  vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "live");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("src/middleware.ts with NEXT_PUBLIC_DATA_MODE=live and the real Supabase client", () => {
  it("unauthenticated GET /admin redirects to /admin/login (no next param), without a network call", async () => {
    live();
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await middleware(req("/admin"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin).toBe("https://cafe.test"); // same-origin redirect
    expect(loc.pathname).toBe("/admin/login");
    expect(loc.search).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("every admin page and a deep order link redirect when signed out, keeping only the path in ?next=", async () => {
    live();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    for (const p of [
      "/admin/orders",
      "/admin/orders/00000000-0000-4000-8007-000000000001",
      "/admin/menu",
      "/admin/products",
      "/admin/settings",
      "/admin/staff",
      "/admin/account",
      "/admin/blocklist",
    ]) {
      const res = await middleware(req(`${p}?x=1`));
      expect(res.status, p).toBe(307);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.pathname, p).toBe("/admin/login");
      expect(loc.searchParams.get("next"), p).toBe(p);
      expect(loc.searchParams.get("x"), p).toBeNull();
    }
  });

  it("a forged auth cookie is checked with Supabase (getUser), and a 401 answer still redirects", async () => {
    live();
    const session = {
      access_token: "forged.jwt.token",
      refresh_token: "forged-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated" },
    };
    const cookie = `sb-proj-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const res = await middleware(req("/admin/settings", cookie));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/admin/login");
    expect(seen.some((u) => u.startsWith("https://proj.supabase.co/auth/v1/user"))).toBe(true);
  });

  it("network failure while checking the session fails closed", async () => {
    live();
    const session = { access_token: "a.b.c", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "u" } };
    const cookie = `sb-proj-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const res = await middleware(req("/admin/orders", cookie));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/admin/login");
  });

  it("the login page itself is not redirected (no loop)", async () => {
    live();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const res = await middleware(req("/admin/login?next=%2Fadmin%2Fmenu"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("live mode with Supabase env missing still fails closed", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "live");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const res = await middleware(req("/admin"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/admin/login");
  });
});

describe("middleware file placement (the original defect)", () => {
  it("lives in src/ and there is no root middleware file that Next would silently ignore", () => {
    expect(existsSync(`${APP}src/middleware.ts`)).toBe(true);
    for (const f of ["middleware.ts", "middleware.js", "middleware.mjs"]) expect(existsSync(`${APP}${f}`), f).toBe(false);
    // Since SEC-011 (residual, 2026-10-23) the matcher covers every path except Next's static assets; /admin is
    // gated inside the function (isAdminPath), which the live tests above exercise.
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image|favicon.ico).*)"]);
  });
});

// ---- build output --------------------------------------------------------------------------------------------
const MANIFEST = `${APP}.next/server/middleware-manifest.json`;
type Manifest = {
  middleware: Record<string, { name: string; files: string[]; matchers: { regexp: string; originalSource: string }[] }>;
  sortedMiddleware: string[];
};
// A build older than src/middleware.ts cannot prove anything about the current source: skipped (rebuild to check).
const buildIsCurrent =
  existsSync(MANIFEST) && statSync(MANIFEST).mtimeMs >= statSync(`${APP}src/middleware.ts`).mtimeMs;

describe.skipIf(!buildIsCurrent)("build output: .next/server/middleware-manifest.json (current build only)", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const entry = manifest.middleware["/"];

  it("registers src/middleware with the matcher from the source", () => {
    expect(entry, "no middleware in the build: Next did not pick up src/middleware.ts").toBeDefined();
    expect(entry!.name).toBe("src/middleware");
    expect(entry!.matchers.map((m) => m.originalSource)).toEqual(config.matcher);
    expect(manifest.sortedMiddleware).toEqual(["/"]);
  });

  it("the compiled middleware file exists", () => {
    for (const f of entry!.files) expect(existsSync(`${APP}.next/${f}`), f).toBe(true);
  });

  it("the compiled matcher reaches /admin and the public pages (mock refusal), but not Next's static assets", () => {
    const re = new RegExp(entry!.matchers[0]!.regexp);
    for (const p of ["/admin", "/admin/", "/admin/login", "/admin/orders/abc", "/", "/menu", "/shop", "/checkout", "/order/abc", "/api/menu"]) {
      expect(re.test(p), p).toBe(true);
    }
    for (const p of ["/_next/static/chunks/main.js", "/_next/image", "/favicon.ico"]) {
      expect(re.test(p), p).toBe(false);
    }
  });
});

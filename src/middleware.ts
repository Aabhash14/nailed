import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hardenCookieOptions } from "@/lib/auth/cookies";
import { isAdminPath, refuseMockBuild } from "@/lib/middleware-guards";

/**
 * Two jobs:
 *
 * 1. SEC-011 residual: a MOCK build (NEXT_PUBLIC_DATA_MODE=mock, sample data, fake admin login, orders that never
 *    reach the cafe) refuses to serve anything with a 503 when the runtime APP_ENV (a Worker var in wrangler.jsonc)
 *    is "staging" or "production". The build guard in next.config.ts stops a mock build by mistake; this stops a
 *    mock bundle (CI verify job, local e2e) that is deployed by hand. That is why the matcher covers every path
 *    except Next's static files. The e2e and dev runs have no APP_ENV, so they are unaffected.
 *
 * 2. Layer 1 of 3 for /admin (middleware, requireRole, RLS). Checks there is a valid Supabase session
 *    (getUser verifies the token with Supabase, it does not just decode it) and refreshes the cookies.
 *    It does NOT check the role: that is requireRole() in every action and the layout (it needs the database).
 *    Fails closed: missing env or any error redirects to /admin/login. Every other path passes straight through.
 *
 * Standard (edge-style) middleware only: OpenNext on Cloudflare does not support Node middleware.
 * Lives in src/ because the app uses the src/ layout: Next.js only loads src/middleware.ts then
 * (a root middleware.ts is silently ignored, which is how the /admin check went missing before 2026-10-21).
 * NEXT_PUBLIC_DATA_MODE is inlined at build time, and next.config.ts refuses a mock production build without
 * ALLOW_MOCK_BUILD=1, so a live build cannot be switched to the mock branch at runtime. APP_ENV is read at runtime.
 */

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (process.env.NEXT_PUBLIC_DATA_MODE === "mock") {
    if (refuseMockBuild(process.env.APP_ENV)) {
      return new NextResponse("Service unavailable.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
      });
    }
    if (!isAdminPath(pathname)) return NextResponse.next();
    const pass = NextResponse.next({ request: req });
    pass.headers.set("Cache-Control", "private, no-store");
    return pass;
  }

  if (!isAdminPath(pathname)) return NextResponse.next();

  const isLogin = pathname === "/admin/login" || pathname.startsWith("/admin/login/");

  let response = NextResponse.next({ request: req });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let signedIn = false;
  if (url && key) {
    try {
      const supabase = createServerClient(url, key, {
        cookies: {
          getAll: () => req.cookies.getAll(),
          setAll: (list, headers) => {
            for (const c of list) req.cookies.set(c.name, c.value);
            response = NextResponse.next({ request: req });
            // SEC-006: HttpOnly, SameSite=Lax, Secure in production
            for (const c of list) response.cookies.set(c.name, c.value, hardenCookieOptions(c.options));
            // no-cache headers the library sends with refreshed auth cookies
            for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
          },
        },
      });
      const { data, error } = await supabase.auth.getUser();
      signedIn = !error && !!data.user;
    } catch {
      signedIn = false;
    }
  }

  if (!signedIn && !isLogin) {
    const login = req.nextUrl.clone();
    login.pathname = "/admin/login";
    login.search = "";
    if (pathname !== "/admin") login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/**
 * Every path except Next's build assets and the image optimiser (job 1 needs the whole site). The /admin gate is
 * decided inside the function (isAdminPath). Kept as a literal: Next reads it statically at build time.
 */
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

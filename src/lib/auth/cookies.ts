import type { CookieOptions } from "@supabase/ssr";

/**
 * SEC-006: Supabase session cookies are written HttpOnly, SameSite=Lax and (in production builds) Secure.
 * The library default is httpOnly:false because its BROWSER client reads the cookie; this app has no
 * browser auth client (all admin work goes through server actions), so no script needs the tokens.
 * maxAge is NOT overridden: the library uses maxAge 0 to delete cookies on sign-out.
 * Edge-safe (used by src/middleware.ts): no Node or server-only imports.
 */
export function hardenCookieOptions(
  options: CookieOptions | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): CookieOptions {
  return {
    ...options,
    path: options?.path ?? "/",
    httpOnly: true,
    sameSite: "lax",
    secure: nodeEnv === "production",
  };
}

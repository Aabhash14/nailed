import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hardenCookieOptions } from "./cookies";

/**
 * Cookie-bound Supabase client acting AS THE LOGGED-IN USER (anon key + the user's session cookies).
 * Used only to sign in/out and to verify who is calling. Data access goes through the service client
 * AFTER requireRole(), never through this one for privileged work.
 */
export async function createSessionClient(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase public env is not set");
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const c of list) store.set(c.name, c.value, hardenCookieOptions(c.options)); // SEC-006
        } catch {
          // Called from a Server Component: cookies are read-only there. Middleware refreshes the session.
        }
      },
    },
  });
}

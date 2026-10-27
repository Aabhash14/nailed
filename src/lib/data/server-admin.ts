import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Db } from "./types";

/**
 * The ONLY module allowed to hold the Supabase service role key (architecture.md section 6).
 * ESLint blocks importing this file from pages and components; `server-only` blocks it from
 * client bundles at build time.
 *
 * The client is typed loosely (default schema) and results are cast to the row types in
 * src/types/db.ts: the hand-written Database type has no Insert/Update shapes. Replace with the
 * generated types once the Supabase CLI is available.
 */
export type { Db };

export function getServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return key;
}

function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return url;
}

/** Service-role client. Create per request; never cache across requests, never expose to the browser. */
export function createAdminClient(): Db {
  return createClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "cafe-app-server" } },
  });
}

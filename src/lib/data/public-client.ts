import { createClient } from "@supabase/supabase-js";
import { taggedFetch, type CacheTag } from "@/lib/cache-tags";
import type { Db } from "./types";

/**
 * Anon-key client for public reads (menu, settings, shop). RLS limits it to visible/published rows.
 * No service role here, so this file is safe for pages (frontend) to import in Server Components.
 * Type-only import above is erased at build time.
 *
 * `tags`: cache tags for ISR pages (see src/lib/cache-tags.ts). Pass READ_TAGS.menu / .settings / .shop from
 * Server Component reads so the admin actions' revalidateTag reaches the page. Route handlers do not need them.
 */
export function createPublicClient(opts: { tags?: readonly CacheTag[] } = {}): Db {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase public env is not set");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(opts.tags && opts.tags.length > 0 ? { global: { fetch: taggedFetch(opts.tags) } } : {}),
  });
}

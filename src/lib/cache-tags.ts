/**
 * On-demand revalidation tags (api-contract section 4: "mutating menu/settings/product actions call revalidateTag
 * for the affected tag"). Public reads tag their fetches with these, so the ISR pages that used them carry the tag,
 * and the admin actions' revalidateTag(...) marks those pages stale.
 *
 * In production this only works when OpenNext has a tag cache (open-next.config.ts: KV tag cache, binding
 * NEXT_TAG_CACHE_KV in wrangler.jsonc). Without the binding revalidateTag is a no-op and pages refresh only on the
 * time-based `revalidate` (3600 s) safety net.
 */
export const CACHE_TAG = {
  menu: "menu",
  settings: "settings",
  shop: "shop",
} as const;

export type CacheTag = (typeof CACHE_TAG)[keyof typeof CACHE_TAG];

/** Which tags each public read carries. The menu payload embeds settings (hours, announcement, VAT), so it has both. */
export const READ_TAGS = {
  menu: [CACHE_TAG.menu, CACHE_TAG.settings],
  settings: [CACHE_TAG.settings],
  shop: [CACHE_TAG.shop],
} as const satisfies Record<string, readonly CacheTag[]>;

/**
 * A fetch that adds Next's `next.tags` to every request (used as supabase-js `global.fetch`).
 * Only tags, no `cache`/`revalidate`: the data fetch itself stays uncached (no extra KV writes for a data cache);
 * Next still attaches the tags to the ISR page being rendered. Outside Next (unit tests, scripts) the extra
 * `next` field is ignored by fetch.
 */
export function taggedFetch(tags: readonly CacheTag[], base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  const list = [...tags];
  return (input, init) => base(input, { ...init, next: { ...(init?.next ?? {}), tags: list } });
}

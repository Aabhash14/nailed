import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
import memoryQueue from "@opennextjs/cloudflare/overrides/queue/memory-queue";
import kvNextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/kv-next-tag-cache";
import { softTagFilter, withFilter } from "@opennextjs/cloudflare/overrides/tag-cache/tag-cache-filter";

// ISR cache in Workers KV (free tier). Not R2 (ADR 0001).
// Tag cache (2026-10-21, backend-engineer): makes revalidateTag("menu" | "settings" | "shop") in the admin actions
// actually mark ISR pages stale. Workers KV, free tier, no new paid service. Needs a second KV binding
// NEXT_TAG_CACHE_KV in wrangler.jsonc (devops); without it OpenNext logs "No KV binding" and revalidateTag stays a
// no-op (pages still refresh on the 3600 s safety net). KV is eventually consistent: an edit can take up to about
// 60 s to reach the cached HTML; open menus already get it within a second through Realtime.
// softTagFilter drops Next's internal "_N_T_" path tags: the app never calls revalidatePath, and it saves KV reads.
//
// Queue (2026-10-22, ADR 0001 F2): the memory queue makes time-based ISR (revalidate = 3600) regenerate on the
// Worker. Without a queue OpenNext's default throws and a page that is never tag-revalidated never refreshes.
// It needs a service binding WORKER_SELF_REFERENCE pointing at this same Worker (cafe-app-staging / cafe-app) in
// wrangler.jsonc (devops). Without the binding the queue throws an IgnorableError: pages keep being served stale,
// nothing breaks. De-duplication is per isolate only (OpenNext docs: not meant for heavy production load); each
// regeneration costs one extra Worker invocation and KV writes (R13). Verify on staging (T-031) before production.
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  tagCache: withFilter({ tagCache: kvNextTagCache, filterFn: softTagFilter }),
  queue: memoryQueue,
});

import "server-only";
import { revalidateTag } from "next/cache";
import { after } from "next/server";
import { CACHE_TAG } from "@/lib/cache-tags";
import { createAdminClient } from "@/lib/data/server-admin";
import { createPublicClient } from "@/lib/data/public-client";
import { serverEnvProblems } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { tableCookieKeysFromEnv } from "@/lib/tables/cookie";

/** Real dependencies for the route handlers. Tests call the handlers in src/lib/** with fakes instead. */

let validatedSalt: string | null = null;

/**
 * IP_HASH_SALT after the full server environment has been validated once (SEC-010: `serverEnv()` used
 * to be dead code). Misconfiguration is INTERNAL with the variable NAMES in the log, never values.
 */
export function ipSalt(): string {
  const salt = process.env.IP_HASH_SALT;
  if (salt && salt === validatedSalt) return salt;
  const problems = serverEnvProblems();
  if (problems.length > 0 || !salt) {
    throw new AppError("INTERNAL", undefined, { logDetail: `server env invalid: ${problems.join(", ") || "IP_HASH_SALT"}` });
  }
  validatedSalt = salt;
  return salt;
}

/** Run work after the response is sent (Cloudflare waitUntil via Next `after`). Never throws to the caller. */
export function scheduleAfter(work: () => Promise<unknown>): void {
  try {
    after(async () => {
      try {
        await work();
      } catch {
        // notifications are best effort
      }
    });
  } catch {
    void work().catch(() => undefined);
  }
}

/**
 * ADR 0001 F1: revalidateTag("shop"), called only from inside scheduleAfter work (Next `after`).
 * Verified in the installed code (2026-10-22): Next 15.5.28 runs after() callbacks inside
 * withExecuteRevalidates (server/after/after-context.js), which flushes tags revalidated during the callbacks
 * to the incremental cache, and that promise is handed to waitUntil. OpenNext (@opennextjs/aws utils/promise.js)
 * provides the Worker's waitUntil through Symbol.for("@next/request-context"), and its revalidateTag ->
 * writeTags uses the request's ALS store, which async continuations keep. Not yet observed on a deployed Worker:
 * staging check in T-031 (look for the KV tag write after an order that leaves a size few_left).
 */
export function revalidateShopTag(): void {
  revalidateTag(CACHE_TAG.shop);
}

export const realDeps = {
  adminDb: () => createAdminClient(),
  publicDb: () => createPublicClient(),
  salt: ipSalt,
  siteUrl: () => process.env.NEXT_PUBLIC_SITE_URL,
  supabaseUrl: () => process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  schedule: scheduleAfter,
  revalidateShop: revalidateShopTag,
  /** TABLE_COOKIE_KEY (+ id, + previous key during a rotation). INTERNAL with the variable name when missing. */
  tableCookieKeys: () => tableCookieKeysFromEnv(),
};

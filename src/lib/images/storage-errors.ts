/**
 * Storage refusals from the SEC-018 guard (`private.storage_public_media_guard()`, migration 20261023000001).
 * The trigger raises 42501 with a "public-media: ..." message; storage-api answers HTTP 400 with
 * `{ statusCode: "403", code: "AccessDenied", message: "public-media: ..." }`. supabase-js turns that into a
 * StorageApiError with the same `code` / `statusCode` / `message`.
 *
 * Those messages are safe and useful for the owner ("480 px image is 41000 bytes, the limit is 40960 bytes"), so the
 * upload flow maps them to VALIDATION with that text instead of INTERNAL. Anything else (an RLS refusal, a 5xx)
 * returns null and stays INTERNAL.
 * Works on a StorageApiError and on the parsed JSON body of a direct upload response alike.
 */
const GUARD_PREFIX = "public-media:";

export function storageGuardMessage(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { message?: unknown; code?: unknown; statusCode?: unknown; error?: unknown };
  const message = typeof e.message === "string" ? e.message.trim() : "";
  if (!message.startsWith(GUARD_PREFIX)) return null;
  const denied = e.code === "AccessDenied" || e.error === "AccessDenied" || String(e.statusCode ?? "") === "403";
  if (!denied) return null;
  return message.slice(0, 200);
}

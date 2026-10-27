import { storageGuardMessage } from "@/lib/images/storage-errors";

export const GENERIC_UPLOAD_ERROR = "The upload did not go through. Please try again.";

/**
 * Text for a refused direct upload. The storage guard (SEC-018) answers with a safe, specific reason
 * ("public-media: 480 px image is 41000 bytes, the limit is 40960 bytes"); show that to the owner, without the
 * technical bucket prefix. Anything else (bad JSON, an RLS refusal, a 5xx) gets the generic message.
 */
export function uploadRefusalMessage(body: unknown): string {
  const guard = storageGuardMessage(body);
  if (!guard) return GENERIC_UPLOAD_ERROR;
  const reason = guard.replace(/^public-media:\s*/i, "").trim();
  if (!reason) return GENERIC_UPLOAD_ERROR;
  return `This photo was refused: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? "" : "."}`;
}

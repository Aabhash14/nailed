import { logAppError, newRequestId, toApiError, toAppError } from "@/lib/errors";
import { ok, type ActionResult } from "@/lib/validation/api";

/**
 * Wraps the body of an admin server action: success -> ActionResult ok, any throw -> contract error.
 * Each action starts with `await requireRole(...)` INSIDE the callback (reviewer checklist).
 * INTERNAL errors are logged here with their server-side detail (SEC-013).
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  const requestId = newRequestId();
  try {
    return ok(await fn());
  } catch (e) {
    const app = toAppError(e, requestId);
    logAppError(app, requestId);
    return { ok: false, error: toApiError(app, requestId) };
  }
}

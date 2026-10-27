import type { ApiErr, ApiError, ErrorCode } from "@/lib/validation/api";

/**
 * Error model for the whole server side (api-contract.md section 0).
 * Throw `AppError` anywhere; route handlers and admin actions turn it into the contract envelope.
 * Anything that is not an AppError becomes INTERNAL with a generic message (no stack, no SQL).
 */

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  ORDER_REFUSED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  OUT_OF_STOCK: 409,
  RATE_LIMITED: 429,
  BOT_CHECK_FAILED: 400,
  ORDERS_PAUSED: 503,
  TABLE_SESSION_INVALID: 401,
  TABLE_ORDERS_PAUSED: 503,
  INTERNAL: 500,
};

export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION: "Please check the highlighted fields.",
  UNAUTHENTICATED: "Please sign in to continue.",
  FORBIDDEN: "You do not have permission to do that.",
  ORDER_REFUSED: "We can't take this order online right now. Please call us.",
  NOT_FOUND: "We could not find that.",
  CONFLICT: "That change conflicts with the current state. Please refresh and try again.",
  OUT_OF_STOCK: "Some items are no longer available in the quantity requested.",
  RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
  BOT_CHECK_FAILED: "The bot check failed. Please try again.",
  ORDERS_PAUSED: "We are not taking online orders right now. Please call the cafe to order.",
  // api-contract 9.9 (fixed texts; the frontend shows them as they are)
  TABLE_SESSION_INVALID: "Your table is not open for ordering. Enter the code from our staff to order.",
  TABLE_ORDERS_PAUSED: "The kitchen is not taking orders from the app right now. Please order with our staff.",
  INTERNAL: "Something went wrong on our side. Please try again.",
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly fieldErrors?: Record<string, string[]>;
  readonly retryAfterSeconds?: number;
  /** Server-side only detail for logs. Never sent to the client. */
  readonly logDetail?: string;

  constructor(
    code: ErrorCode,
    message?: string,
    opts: {
      fieldErrors?: Record<string, string[]>;
      retryAfterSeconds?: number;
      logDetail?: string;
    } = {},
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "AppError";
    this.code = code;
    this.fieldErrors = opts.fieldErrors;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.logDetail = opts.logDetail;
  }
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Normalise anything thrown into an AppError. Unknown errors become INTERNAL with the error text kept in
 * `logDetail` (server side only). Logging happens once, at the response boundary (`logAppError`).
 */
export function toAppError(e: unknown, _requestId?: string): AppError {
  void _requestId;
  if (e instanceof AppError) return e;
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : "non-error thrown";
  return new AppError("INTERNAL", undefined, { logDetail: detail.slice(0, 500) });
}

/**
 * Log an INTERNAL error with its server-side detail (SEC-013: logDetail used to be discarded).
 * Called once per request by `jsonError` (route handlers) and `runAction` (admin actions).
 * logDetail holds codes and short messages only, never request bodies or secrets.
 */
export function logAppError(e: AppError, requestId?: string): void {
  if (e.code !== "INTERNAL") return;
  console.error(
    JSON.stringify({ level: "error", type: "internal", requestId, detail: (e.logDetail ?? "no detail").slice(0, 500) }),
  );
}

export function toApiError(e: AppError, requestId?: string): ApiError {
  const out: ApiError = { code: e.code, message: e.message };
  if (e.fieldErrors && Object.keys(e.fieldErrors).length > 0) out.fieldErrors = e.fieldErrors;
  if (requestId) out.requestId = requestId;
  return out;
}

export function toApiErr(e: unknown, requestId?: string): ApiErr {
  const app = toAppError(e, requestId);
  return { ok: false, error: toApiError(app, requestId) };
}

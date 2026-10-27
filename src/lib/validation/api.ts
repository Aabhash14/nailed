import { z } from "zod";

/** Shared envelope and error codes from api-contract.md section 0 (2.0.0 adds the two TABLE_* codes, section 9.9). Feature schemas are added by backend-engineer. */
export const errorCodeSchema = z.enum([
  "VALIDATION",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "ORDER_REFUSED",
  "NOT_FOUND",
  "CONFLICT",
  "OUT_OF_STOCK",
  "RATE_LIMITED",
  "BOT_CHECK_FAILED",
  "ORDERS_PAUSED", // 503, checkout only: owner kill switch is on (SEC-003). Disclosable, unlike ORDER_REFUSED.
  "TABLE_SESSION_INVALID", // 401, table routes only (api-contract 9.9): no, bad or ended table cookie, or the table closed
  "TABLE_ORDERS_PAUSED", // 503, POST /api/table/orders only (9.9): mode "paused", or staff stopped this table
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  requestId: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: ApiError };
export type ActionResult<T> = ApiOk<T> | ApiErr;

export const healthDataSchema = z.object({
  db: z.enum(["up", "down"]),
  time: z.string().datetime(),
});
export type HealthData = z.infer<typeof healthDataSchema>;

export const ok = <T>(data: T): ApiOk<T> => ({ ok: true, data });
export const err = (code: ErrorCode, message: string): ApiErr => ({
  ok: false,
  error: { code, message },
});

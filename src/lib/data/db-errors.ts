import { AppError } from "@/lib/errors";
import type { ErrorCode } from "@/lib/validation/api";

/** Shape of a PostgREST / supabase-js error. */
export type PgError = { code?: string; message?: string; details?: string | null; hint?: string | null };

const RPC_CODES = new Set<string>([
  "VALIDATION",
  "ORDER_REFUSED",
  "OUT_OF_STOCK",
  "RATE_LIMITED",
  "NOT_FOUND",
  "CONFLICT",
  "FORBIDDEN",
  "ORDERS_PAUSED", // create_order: site_settings.orders_paused is on (SEC-003 kill switch)
  // Table ordering (api-contract 9.9, migration 20261026000002)
  "TABLE_SESSION_INVALID", // guest RPCs: closed, unknown, older than 12 h, or an old cookie epoch
  "TABLE_ORDERS_PAUSED", // create_table_order: mode "paused", or the table's app orders are stopped (hint says which)
]);

/**
 * The two TABLE_ORDERS_PAUSED texts (api-contract 9.9). The database's hint says which applies; only these exact texts
 * are passed through, anything else becomes the mode text.
 */
export const TABLE_PAUSED_MESSAGE = "The kitchen is not taking orders from the app right now. Please order with our staff.";
export const TABLE_STOPPED_MESSAGE = "Ordering from the app is stopped for this table. Please order with our staff.";

function parseDetails(details: string | null | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  try {
    const v: unknown = JSON.parse(details);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map an error from create_order / set_order_status / customer_cancel_order (supabase/README.md,
 * "Error protocol") to an AppError. SQLSTATE P0001 + message = contract code. Anything else is INTERNAL.
 * ORDER_REFUSED deliberately carries no detail: the cause is never revealed.
 */
export function mapRpcError(error: PgError): AppError {
  if (error.code === "P0001" && error.message && RPC_CODES.has(error.message)) {
    const code = error.message as ErrorCode;
    const details = parseDetails(error.details);
    if (code === "ORDER_REFUSED") return new AppError("ORDER_REFUSED");
    if (code === "ORDERS_PAUSED") return new AppError("ORDERS_PAUSED");
    // Fixed contract text, whatever the hint says (9.9).
    if (code === "TABLE_SESSION_INVALID") return new AppError("TABLE_SESSION_INVALID");
    if (code === "TABLE_ORDERS_PAUSED") {
      return new AppError("TABLE_ORDERS_PAUSED", error.hint === TABLE_STOPPED_MESSAGE ? TABLE_STOPPED_MESSAGE : TABLE_PAUSED_MESSAGE);
    }
    if (code === "VALIDATION" || code === "OUT_OF_STOCK") {
      const fieldErrors: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(details ?? {})) {
        if (Array.isArray(v)) fieldErrors[k] = v.filter((x): x is string => typeof x === "string");
      }
      return new AppError(code, undefined, { fieldErrors });
    }
    if (code === "RATE_LIMITED") {
      const n = details?.retryAfterSeconds;
      return new AppError(code, undefined, { retryAfterSeconds: typeof n === "number" ? n : 60 });
    }
    // NOT_FOUND / CONFLICT / FORBIDDEN: hint may carry safe text (e.g. "Please call us to change this order")
    const hint = error.hint && error.hint.length <= 200 ? error.hint : undefined;
    const safeHint = code === "CONFLICT" && hint === "illegal status transition" ? "That status change is not allowed." : hint;
    return new AppError(code, safeHint);
  }
  return new AppError("INTERNAL", undefined, { logDetail: `rpc error ${error.code ?? "?"}: ${error.message ?? ""}`.slice(0, 300) });
}

export const TRANSLATIONS_INVALID =
  "A translation is not valid. Use ne, zh, ja, ko or pt; every language needs a name (or label); keep within the length limits; pronunciation is for Nepali only.";

/**
 * Check constraints (settings: 20261021000002; menu translations: 20261024000001; table settings: 20261026000001) -> contract field + safe message. Only the constraint NAME
 * is read from the PostgREST message; message, details and hint are never passed to the client.
 */
export const CHECK_CONSTRAINT_FIELDS: Record<string, { field: string; message: string }> = {
  site_settings_delivery_needs_area: { field: "deliveryAreas", message: "Add at least one delivery area, or turn off delivery." },
  site_settings_hours_ranges_valid: { field: "hours", message: "Each opening time must be HH:mm and close after it opens." },
  order_rules_cod_max_total_valid: { field: "codMaxTotal", message: "Enter 0 or more (0 or empty means no limit)." },
  order_rules_ip_open_orders_max_range: { field: "ipOpenOrdersMax", message: "Enter a number from 1 to 100." },
  order_rules_ip_orders_max_per_day_range: { field: "ipOrdersMaxPerDay", message: "Enter a number from 1 to 1000." },
  order_rules_auto_cancel_range: { field: "autoCancelPlacedAfterMinutes", message: "Enter 15 to 10080 minutes, or leave empty to turn it off." },
  // Menu translations (20261024000001, api-contract 1.4.0). The Zod schemas apply the same rules first, so these are
  // a backstop. upsertMenuItem re-keys the variant one to `variants.N.translations` (it knows the index).
  menu_items_translations_valid: { field: "translations", message: TRANSLATIONS_INVALID },
  menu_categories_translations_valid: { field: "translations", message: TRANSLATIONS_INVALID },
  menu_variants_translations_valid: { field: "translations", message: TRANSLATIONS_INVALID },
  // Table ordering owner settings (20261026000001, api-contract 2.2.0). Zod checks the same ranges first.
  order_rules_staff_cancel_window_range: { field: "staffCancelWindowMinutes", message: "Enter 0 to 60 minutes (0 = staff can never cancel an accepted order)." },
  order_rules_owner_alert_whatsapp_valid: { field: "ownerAlertWhatsApp", message: "Enter up to 3 Nepal mobile numbers." },
};

function checkViolation(error: PgError): AppError {
  const name = /constraint "([a-z0-9_]{1,63})"/.exec(error.message ?? "")?.[1];
  const known = name ? CHECK_CONSTRAINT_FIELDS[name] : undefined;
  if (known) return new AppError("VALIDATION", undefined, { fieldErrors: { [known.field]: [known.message] } });
  return new AppError("VALIDATION", "One of the values is not allowed.");
}

/** Map an error from a plain table query/mutation. Constraint violations become contract errors. */
export function mapDbError(error: PgError, ctx: { conflictMessage?: string } = {}): AppError {
  switch (error.code) {
    case "23505":
      return new AppError("CONFLICT", ctx.conflictMessage ?? "That value is already in use.");
    case "23503":
      return new AppError("CONFLICT", "That record is still in use or does not exist.");
    case "23514":
      return checkViolation(error);
    case "22P02":
    case "22023":
    case "23502":
      return new AppError("VALIDATION", "One of the values is not allowed.");
    case "42501":
      return new AppError("FORBIDDEN");
    case "P0001":
      return mapRpcError(error);
    default:
      return new AppError("INTERNAL", undefined, {
        logDetail: `db error ${error.code ?? "?"}: ${error.message ?? ""}`.slice(0, 300),
      });
  }
}

/** Throw if a supabase result carries an error; otherwise return data. */
export function unwrap<T>(res: { data: T | null; error: PgError | null }, ctx?: { conflictMessage?: string }): T | null {
  if (res.error) throw mapDbError(res.error, ctx);
  return res.data;
}

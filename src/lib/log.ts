/**
 * Security event log (SEC-013). One JSON line per event on the Worker console (Workers observability
 * collects it). The field list is closed on purpose: there is NO slot for a phone, email, name, address,
 * order token, password or full hash. Identify people only by profile id (staff) or the first 8 hex
 * characters of a salted IP hash (customers).
 */

export type SecurityEventName =
  | "login_succeeded"
  | "login_failed"
  | "login_locked"
  | "login_bot_check_failed"
  | "password_changed"
  | "password_change_failed"
  | "staff_invited"
  | "staff_deactivated"
  | "forbidden"
  | "rate_limited"
  | "client_ip_missing"
  | "order_refused"
  | "order_refused_paused"
  | "order_status_changed"
  | "blocklist_added"
  | "blocklist_removed"
  | "orders_paused"
  | "orders_resumed"
  | "settings_changed"
  // Table ordering (api-contract 9.3, 9.7). Never the typed code, the cookie, a note or a request body.
  | "table_join_failed"
  | "table_audit"
  | "table_ordering_changed";

export type SecurityEventFields = {
  requestId?: string;
  /** Acting staff/owner profile id. */
  userId?: string;
  /** Profile id the action was applied to (deactivate). */
  targetUserId?: string;
  role?: string;
  /** Role that was required (forbidden). */
  need?: string;
  /** Rate-limit scope, e.g. "checkout", "login". */
  scope?: string;
  /** Key kind, e.g. "ip", "email". */
  kind?: string;
  /** First 8 hex chars of the salted IP hash. Longer input is cut. */
  ipHashPrefix?: string;
  code?: string;
  /** Names of changed settings fields (never their values). */
  fields?: string[];
  to?: string;
  reason?: string;
  orderId?: string;
  /** Table number 1..99 (table ordering). */
  tableNumber?: number;
  /** Table session id (staff audit events only; guests are never identified by it in logs, see sessionPrefix). */
  sessionId?: string;
  /** Profile id behind a table audit event (api-contract 9.7 `table_audit`). */
  profileId?: string;
  /** First 8 characters of a table session id (rate_limited on table-order:session keys). */
  sessionPrefix?: string;
};

const WARN_EVENTS = new Set<SecurityEventName>([
  "login_failed",
  "login_locked",
  "login_bot_check_failed",
  "password_change_failed",
  "forbidden",
  "rate_limited",
  "client_ip_missing",
  "order_refused",
  "order_refused_paused",
  "table_join_failed",
  "table_audit",
]);

const short = (v: string, n = 64) => v.slice(0, n);

function clean(f: SecurityEventFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null) continue;
    if ((k === "ipHashPrefix" || k === "sessionPrefix") && typeof v === "string") out[k] = v.slice(0, 8);
    else if (Array.isArray(v)) out[k] = v.slice(0, 40).map((x) => short(String(x), 40));
    else if (typeof v === "string") out[k] = short(v);
    else out[k] = v;
  }
  return out;
}

export function securityEvent(event: SecurityEventName, fields: SecurityEventFields = {}): void {
  const warn = WARN_EVENTS.has(event);
  const line = JSON.stringify({
    level: warn ? "warn" : "info",
    type: "security",
    event,
    at: new Date().toISOString(),
    ...clean(fields),
  });
  if (warn) console.warn(line);
  else console.info(line);
}

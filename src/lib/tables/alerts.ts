import type { AdminAlertKind, AdminAlertRow, AlertDeliveryRow } from "@/types/db";
import type { AdminAlert, AlertChannel, AlertDeliveryStatus } from "./types";

/** Owner alerts (api-contract 2.3.0 section 9.10): pure mapping from database rows to the AdminAlert shape. */

export const ALERT_COLUMNS = "id, kind, text, data, created_at, read_at, read_by";
const KINDS = new Set<AdminAlertKind>([
  "table_void",
  "table_round_cancelled_after_accept",
  "table_expired_with_bill",
  "table_join_fail",
]);
const REASONS = new Set(["guest_request", "unavailable", "mistake", "other", "session_closed"]);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);

/**
 * Copy `data` through an allow-list (known keys, right types). The database builds it from fixed keys already; this
 * keeps anything unexpected from reaching the browser. `tableNumber: null` (all tables) is omitted.
 */
export function alertData(raw: unknown): AdminAlert["data"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: AdminAlert["data"] = {};
  const tableNumber = int(r.tableNumber);
  if (tableNumber !== undefined) out.tableNumber = tableNumber;
  const round = int(r.round);
  if (round !== undefined) out.round = round;
  const amount = int(r.amount);
  if (amount !== undefined) out.amount = amount;
  if (typeof r.actorName === "string" || r.actorName === null) out.actorName = r.actorName as string | null;
  if (typeof r.reason === "string" && REASONS.has(r.reason)) out.reason = r.reason as AdminAlert["data"]["reason"];
  const acceptedRounds = int(r.acceptedRounds);
  if (acceptedRounds !== undefined) out.acceptedRounds = acceptedRounds;
  const failures = int(r.failures);
  if (failures !== undefined) out.failures = failures;
  const minutes = int(r.minutesAfterAccept);
  if (minutes !== undefined) out.minutesAfterAccept = minutes;
  return out;
}

/**
 * Status of one alert on one channel (9.10, data-model decision 22 review item 9): `sent` = sent; a `failed` row with
 * no retry left (3 attempts, or the alert is over 24 h old) = `failed`; no row and over 24 h old = `failed` (it will
 * never be claimed); everything else (no row yet, `sending`, a retryable failure) = `pending`.
 */
export function deliveryStatus(
  row: Pick<AlertDeliveryRow, "status" | "attempts"> | undefined,
  createdAt: string,
  nowMs: number,
): AlertDeliveryStatus {
  const old = nowMs - Date.parse(createdAt) > MAX_AGE_MS;
  if (!row) return old ? "failed" : "pending";
  if (row.status === "sent") return "sent";
  if (row.status === "failed" && (row.attempts >= 3 || old)) return "failed";
  return old ? "failed" : "pending";
}

export function toAdminAlert(
  row: Pick<AdminAlertRow, "id" | "kind" | "text" | "data" | "created_at" | "read_at" | "read_by">,
  names: ReadonlyMap<string, string>,
  delivery: AdminAlert["delivery"],
): AdminAlert | null {
  if (!KINDS.has(row.kind)) return null;
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    text: row.text,
    data: alertData(row.data),
    readAt: row.read_at,
    readByName: row.read_by ? (names.get(row.read_by) ?? null) : null,
    delivery,
  };
}

export type DeliveryRowLite = { alert_id: string; channel: string; status: AlertDeliveryRow["status"]; attempts: number };

/** Delivery list for one alert over the enabled channels (`[]` in v1: no channel). */
export function deliveryFor(
  alertId: string,
  createdAt: string,
  channels: readonly AlertChannel[],
  rows: readonly DeliveryRowLite[],
  nowMs: number,
): AdminAlert["delivery"] {
  return channels.map((channel) => ({
    channel,
    status: deliveryStatus(
      rows.find((r) => r.alert_id === alertId && r.channel === channel),
      createdAt,
      nowMs,
    ),
  }));
}

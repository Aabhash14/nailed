import { formatClock } from "@/components/format";
import {
  TABLE_LIMITS,
  type AdminTableRound,
  type AdminTableSession,
  type AdminAlert,
  type AdminAlertKind,
  type CafeTable,
  type Role,
  type SaveCafeTablesInput,
  type TableBoard,
  type TableBoardResult,
  type TableCancelReason,
  type TableCloseOutcome,
  type TablePaidVia,
} from "@/types/contract";

/**
 * Pure logic for the staff Tables board, table setup and owner alerts (no React, no browser APIs), unit-tested in
 * tests/unit/table-board-logic.test.ts. The database is the authority on every rule; these only decide what the UI
 * offers, so staff are not shown buttons the server would refuse.
 */

// ---- change-only feed -------------------------------------------------------------------------------------------

/**
 * Applies one getTableBoard answer. `changed: false` keeps the board on screen (only the clock moves). If there is no
 * board to keep (should not happen: `since` is only sent once a board exists), `needFull` asks for one call without
 * `since` (the only case the contract allows besides the first call).
 */
export function mergeBoard(
  prev: TableBoard | null,
  res: TableBoardResult,
): { board: TableBoard | null; needFull: boolean; serverTime: string; cursor: string } {
  if (res.changed) return { board: res, needFull: false, serverTime: res.serverTime, cursor: res.cursor };
  if (!prev) return { board: null, needFull: true, serverTime: res.serverTime, cursor: res.cursor };
  return { board: prev, needFull: false, serverTime: res.serverTime, cursor: res.cursor };
}

/** Rounds waiting as `new` on `next` that were not on `prev` (for the new-round sound). Nothing on the first load. */
export function newRoundIds(prev: TableBoard | null, next: TableBoard): string[] {
  if (!prev) return [];
  const known = new Set<string>();
  for (const c of prev.tables) for (const r of c.session?.rounds ?? []) known.add(r.id);
  const out: string[] = [];
  for (const c of next.tables) for (const r of c.session?.rounds ?? []) if (r.status === "new" && !known.has(r.id)) out.push(r.id);
  return out;
}

/** "Now" on the server's clock: serverTime plus the time passed locally since it arrived (no fetch needed). */
export function serverNow(serverTime: string, receivedAtLocal: number, nowLocal: number): number {
  return new Date(serverTime).getTime() + Math.max(0, nowLocal - receivedAtLocal);
}

export const IDLE_AFTER_MS = 2 * 3_600_000;
/** Idle flag (ADR 0002 R3, SEC-023 item 5): nothing happened at this table for more than 2 h. */
export function isIdle(s: Pick<AdminTableSession, "lastActivityAt">, now: number): boolean {
  return now - new Date(s.lastActivityAt).getTime() > IDLE_AFTER_MS;
}

/** Contract 9.12 banner text. */
export function offlineText(sinceIso: string): string {
  return `Offline since ${formatClock(sinceIso)}. Take orders on paper.`;
}

// ---- rounds -----------------------------------------------------------------------------------------------------

export const ROUND_STATUS_LABEL: Record<AdminTableRound["status"], string> = {
  new: "New",
  preparing: "Preparing",
  served: "Served",
  cancelled: "Cancelled",
};

export const TABLE_CANCEL_REASON_LABEL: Record<TableCancelReason, string> = {
  guest_request: "Guest asked",
  unavailable: "Not available",
  mistake: "Mistake",
  other: "Other",
  session_closed: "Table closed",
};
export const STAFF_TABLE_CANCEL_REASONS = ["guest_request", "unavailable", "mistake", "other"] as const;

export type CancelState =
  | { kind: "none" }
  | { kind: "allowed" }
  /** Staff, accepted round, before `staffCanCancelUntil` (2.2.0, 9.10a): allowed, and the owner is notified. */
  | { kind: "window"; minutesLeft: number }
  /** Staff, accepted round, window over or 0 (SEC-022): owner only. */
  | { kind: "owner_only" };

/**
 * Who may cancel this round now. Staff: `new` any time; an accepted round until `staffCanCancelUntil` (the server
 * computes it from the owner's setting). Owner: any round that is not cancelled. The database decides at the moment
 * of the cancel; this only decides what the board offers.
 */
export function cancelState(
  r: Pick<AdminTableRound, "status" | "acceptedAt" | "staffCanCancelUntil">,
  role: Role,
  now: number,
): CancelState {
  if (r.status === "cancelled") return { kind: "none" };
  if (role === "owner" || r.status === "new") return { kind: "allowed" };
  if (!r.staffCanCancelUntil) return { kind: "owner_only" };
  const leftMs = new Date(r.staffCanCancelUntil).getTime() - now;
  return leftMs >= 0 ? { kind: "window", minutesLeft: Math.max(1, Math.ceil(leftMs / 60_000)) } : { kind: "owner_only" };
}

/** The forward moves a round offers (contract 9.6): new -> preparing / served, preparing -> served. */
export function forwardMoves(r: Pick<AdminTableRound, "status">): ("preparing" | "served")[] {
  if (r.status === "new") return ["preparing", "served"];
  if (r.status === "preparing") return ["served"];
  return [];
}

// ---- close ------------------------------------------------------------------------------------------------------

export type CloseChoices = {
  /** Why "paid" is not possible yet (a round is still `new`), or null. */
  paidBlocked: string | null;
  /** Staff may void only a table where no round was ever accepted (SEC-022); the owner always. */
  voidAllowed: boolean;
  voidNote: string | null;
};

export function closeChoices(s: Pick<AdminTableSession, "rounds" | "everAccepted" | "bill">, role: Role): CloseChoices {
  const hasNew = s.rounds.some((r) => r.status === "new");
  const owner = role === "owner";
  // SEC-022 (2.1.0): void, and a paid close at Rs. 0, are owner only once any round was ever accepted
  const voidAllowed = owner || !s.everAccepted;
  const zeroPaidBlocked = !owner && s.everAccepted && s.bill.total === 0;
  return {
    paidBlocked: hasNew
      ? "Accept or cancel the new order first."
      : zeroPaidBlocked
        ? "The total is Rs. 0 after accepted orders were cancelled. Only the owner can close this table."
        : null,
    voidAllowed,
    voidNote: voidAllowed ? null : "Only the owner can void a table after an order was accepted. Close it as paid.",
  };
}

export const PAID_VIA_LABEL: Record<TablePaidVia, string> = { cash: "Cash", fonepay: "Fonepay QR", other: "Other" };
export const OUTCOME_LABEL: Record<TableCloseOutcome, string> = { paid: "Paid", void: "Voided", expired: "Expired" };

// ---- links ------------------------------------------------------------------------------------------------------

/**
 * The join link in the QR: the code in the FRAGMENT (SEC-024), so it never reaches the server, logs or a Referer.
 * `origin` = the site origin the board runs on (window.location.origin).
 */
export function joinUrl(origin: string, tableNumber: number, code: string): string {
  return `${origin.replace(/\/+$/, "")}/menu?t=${tableNumber}#c=${encodeURIComponent(code)}`;
}

// ---- setup ------------------------------------------------------------------------------------------------------

export type SetupRow = { id?: string; number: number; label: string; isActive: boolean; isOpen: boolean; hasHistory: boolean };

export function rowsFromTables(rows: CafeTable[]): SetupRow[] {
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    label: r.label ?? "",
    isActive: r.isActive,
    isOpen: r.isOpen,
    hasHistory: r.hasHistory,
  }));
}

/**
 * "Number of tables: N" (contract 9.7): rows 1..N, keeping the existing id, label and active flag of each number and
 * leaving out rows above N. A number that belongs to a table with history the owner removed from the list earlier
 * (`retired`) brings THAT table back, switched on (2.3.0: never a new row on its number). `openAbove` lists open
 * tables the change would drop (the server refuses those).
 */
export function rowsForCount(
  rows: SetupRow[],
  n: number,
  retired: SetupRow[] = [],
): { rows: SetupRow[]; openAbove: number[] } {
  const count = Math.max(0, Math.min(TABLE_LIMITS.maxTable, Math.floor(n)));
  const byNumber = new Map(rows.map((r) => [r.number, r]));
  const old = new Map(retired.map((r) => [r.number, r]));
  const next: SetupRow[] = [];
  for (let i = 1; i <= count; i++) {
    const r = byNumber.get(i);
    const back = old.get(i);
    next.push(r ? { ...r } : back ? { ...back, isActive: true } : { number: i, label: "", isActive: true, isOpen: false, hasHistory: false });
  }
  const openAbove = rows.filter((r) => r.isOpen && (r.number > count || !Number.isInteger(r.number))).map((r) => r.number);
  return { rows: next, openAbove };
}

/** 2.3.0 (9.7) message for a new row on the number of a deactivated table with history. */
export function retiredNumberText(n: number): string {
  return `Table ${n} is still on file as inactive. Turn it back on instead.`;
}

/**
 * Client-side checks with the server's keys (`tables.N.number`, `tables.N.label`). `retired` = tables with history
 * the owner removed from the list in this edit (the server keeps them, inactive, under their number).
 */
export function setupProblems(rows: SetupRow[], retired: SetupRow[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<number>();
  if (rows.length > TABLE_LIMITS.maxTable) out.tables = "Up to 99 tables.";
  const onFile = (n: number) =>
    retired.some((r) => r.hasHistory && r.number === n) || rows.some((r) => r.id && r.hasHistory && !r.isActive && r.number === n);
  rows.forEach((r, i) => {
    if (!Number.isInteger(r.number) || r.number < 1 || r.number > 99) out[`tables.${i}.number`] = "Use a number from 1 to 99.";
    else if (!r.id && onFile(r.number)) out[`tables.${i}.number`] = retiredNumberText(r.number);
    else if (seen.has(r.number)) out[`tables.${i}.number`] = "That table number is used twice.";
    seen.add(r.number);
    if (r.label.trim().length > TABLE_LIMITS.maxLabelLength) out[`tables.${i}.label`] = "Keep the name under 40 characters.";
  });
  return out;
}

export function toSaveInput(rows: SetupRow[]): SaveCafeTablesInput {
  return {
    tables: rows.map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      number: r.number,
      label: r.label.trim() ? r.label.trim() : null,
      isActive: r.isActive,
    })),
  };
}

// ---- owner alerts (9.10) ----------------------------------------------------------------------------------------

export const ALERT_TITLE: Record<AdminAlertKind, string> = {
  table_void: "Table voided",
  table_round_cancelled_after_accept: "Accepted order cancelled",
  table_expired_with_bill: "Table never closed",
  table_join_fail: "Many wrong table codes",
};

/** 2.3.0: delivery is channel-neutral and empty in v1 (no channel). */
export const NO_CHANNEL_TEXT = "Phone alerts: not set up yet. Alerts appear here.";
const CHANNEL_LABEL: Record<AdminAlert["delivery"][number]["channel"], string> = { webpush: "Browser", email: "Email" };
const DELIVERY_STATUS_LABEL: Record<AdminAlert["delivery"][number]["status"], string> = {
  pending: "sending",
  sent: "sent",
  failed: "not sent",
};
/** One badge text per channel, e.g. "Email: sent"; [] when no channel is enabled. */
export function deliveryLabels(delivery: AdminAlert["delivery"]): string[] {
  return delivery.map((d) => `${CHANNEL_LABEL[d.channel] ?? d.channel}: ${DELIVERY_STATUS_LABEL[d.status] ?? d.status}`);
}

/** Owner alerts list polls every 60 s while visible (9.10). */
export const ALERTS_POLL_MS = 60_000;

/** "Still open from HH:mm" (SEC-023 item 4): shown on a table idle for more than 2 h. */
export function stillOpenText(openedAt: string): string {
  return `Still open from ${formatClock(openedAt)}. Is this the previous party? Close it, or press New code for the new guests.`;
}

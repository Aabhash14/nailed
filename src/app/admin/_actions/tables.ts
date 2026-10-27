"use server";

import { runAction } from "@/lib/actions";
import { requireRole, type AuthContext } from "@/lib/auth/require-role";
import { unwrap } from "@/lib/data/db-errors";
import { createAdminClient } from "@/lib/data/server-admin";
import type { Db } from "@/lib/data/types";
import { scheduleAfter } from "@/lib/deps";
import { AppError } from "@/lib/errors";
import { securityEvent } from "@/lib/log";
import { scheduleNotifier } from "@/lib/notify/notifier";
import type {
  AdminTableRound,
  AdminTableSession,
  CafeTable,
  ClosedTableSummary,
  TableBoardResult,
  TableOrderingMode,
} from "@/lib/tables/types";
import {
  cancelTableRoundSchema,
  closeTableSchema,
  getTableBoardSchema,
  openTableSchema,
  rotateTableCodeSchema,
  saveCafeTablesSchema,
  setTableOrderingSchema,
  setTableOrdersLockedSchema,
  setTableRoundStatusSchema,
} from "@/lib/tables/validation";
import { rewordSaveTablesError } from "@/lib/tables/save-errors";
import { parseInput } from "@/lib/validation/common";

/**
 * Table ordering admin actions (api-contract 2.3.0 section 9.7). Same conventions as section 4: runAction,
 * requireRole first, Zod, then ONE service-role RPC with the verified actor (`p_actor`); the database re-checks the
 * role and the rules and is the authority (owner-only void after acceptance, the staff cancel window, close rules).
 *
 * No ISR tag or path revalidation anywhere in this file (ADR 0002 rule 2): occupancy and the mode reach open menus
 * through the GET /api/menu poll, and the board is a change-only feed.
 */

/** Run one table RPC; a database FORBIDDEN is logged as `forbidden` with scope "tables" (9.7), then rethrown. */
async function tableRpc<T>(me: AuthContext, db: Db, name: string, args: Record<string, unknown>): Promise<T> {
  try {
    const data: unknown = unwrap(await db.rpc(name, { ...args, p_actor: me.userId }));
    if (data === null || data === undefined) {
      throw new AppError("INTERNAL", undefined, { logDetail: `${name}: no result` });
    }
    return data as T;
  } catch (e) {
    if (e instanceof AppError && e.code === "FORBIDDEN") {
      securityEvent("forbidden", { userId: me.userId, role: me.role, scope: "tables", code: "db", reason: name });
    }
    throw e;
  }
}

/** S. All tables by number, plus the current mode. */
export async function listCafeTables() {
  return runAction(async (): Promise<{ rows: CafeTable[]; mode: TableOrderingMode }> => {
    const me = await requireRole("staff");
    return tableRpc(me, createAdminClient(), "list_cafe_tables", {});
  });
}

/**
 * O. The FULL set of tables: left-out tables are deleted (no history) or deactivated (history). A table with an open
 * session cannot be renumbered, deactivated or left out (CONFLICT "Close table <n> first.").
 */
export async function saveCafeTables(input: unknown) {
  return runAction(async (): Promise<{ rows: CafeTable[] }> => {
    const me = await requireRole("owner");
    const { tables } = parseInput(saveCafeTablesSchema, input);
    try {
      return await tableRpc<{ rows: CafeTable[] }>(me, createAdminClient(), "save_cafe_tables", {
        p_tables: tables.map((t) => ({
          ...(t.id ? { id: t.id } : {}),
          number: t.number,
          label: t.label,
          isActive: t.isActive,
        })),
      });
    } catch (e) {
      throw rewordSaveTablesError(
        e,
        tables.map((t) => t.number),
      );
    }
  });
}

/** O; staff may only switch "on" <-> "paused" (the database answers FORBIDDEN otherwise). No revalidation. */
export async function setTableOrdering(input: unknown) {
  return runAction(async (): Promise<{ mode: TableOrderingMode }> => {
    const me = await requireRole("staff");
    const { mode } = parseInput(setTableOrderingSchema, input);
    const saved = await tableRpc<TableOrderingMode>(me, createAdminClient(), "set_table_ordering", { p_mode: mode });
    const out: TableOrderingMode = saved === "on" || saved === "paused" || saved === "off" ? saved : mode;
    securityEvent("table_ordering_changed", { userId: me.userId, role: me.role, to: out });
    return { mode: out };
  });
}

/** S. Change-only feed (ADR 0002 rule 3): `{ changed: false }` when `since` equals the current cursor. */
export async function getTableBoard(input?: unknown) {
  return runAction(async (): Promise<TableBoardResult> => {
    const me = await requireRole("staff");
    const { since } = parseInput(getTableBoardSchema, input ?? {});
    return tableRpc(me, createAdminClient(), "table_board", { p_since: since ?? null });
  });
}

/** S. Opens a free table: new code, QR link `/menu?t=N#c=CODE` (fragment, SEC-024). */
export async function openTable(input: unknown) {
  return runAction(async (): Promise<AdminTableSession> => {
    const me = await requireRole("staff");
    const { tableId } = parseInput(openTableSchema, input);
    return tableRpc(me, createAdminClient(), "open_table_session", { p_table_id: tableId });
  });
}

/** S (SEC-023). New code for the same open session; every earlier guest cookie ends (cookie_epoch + 1). */
export async function rotateTableCode(input: unknown) {
  return runAction(async (): Promise<AdminTableSession> => {
    const me = await requireRole("staff");
    const { sessionId } = parseInput(rotateTableCodeSchema, input);
    return tableRpc(me, createAdminClient(), "rotate_table_code", { p_session_id: sessionId });
  });
}

/** S (SEC-023). "Stop app orders" for one open table. Idempotent. */
export async function setTableOrdersLocked(input: unknown) {
  return runAction(async (): Promise<AdminTableSession> => {
    const me = await requireRole("staff");
    const { sessionId, locked } = parseInput(setTableOrdersLockedSchema, input);
    return tableRpc(me, createAdminClient(), "set_table_orders_locked", { p_session_id: sessionId, p_locked: locked });
  });
}

/**
 * S; O to void (or close as paid at Rs. 0) once any round was ever accepted (SEC-022; the database decides from
 * history). `expectedTotal` must equal the live total. Every void writes the owner alert `table_void` in the same
 * transaction; the notifier runs after the response.
 */
export async function closeTable(input: unknown) {
  return runAction(async (): Promise<ClosedTableSummary> => {
    const me = await requireRole("staff");
    const d = parseInput(closeTableSchema, input);
    const summary = await tableRpc<ClosedTableSummary>(me, createAdminClient(), "close_table_session", {
      p_session_id: d.sessionId,
      p_outcome: d.outcome,
      p_paid_via: d.outcome === "paid" ? (d.paidVia ?? null) : null,
      p_expected_total: d.expectedTotal,
    });
    if (d.outcome === "void") {
      securityEvent("table_audit", { kind: "void", sessionId: d.sessionId, profileId: me.userId });
    }
    scheduleNotifier(scheduleAfter, createAdminClient);
    return summary;
  });
}

/** S. new -> preparing, new / preparing -> served (sets acceptedAt / servedAt). */
export async function setTableRoundStatus(input: unknown) {
  return runAction(async (): Promise<AdminTableRound> => {
    const me = await requireRole("staff");
    const { roundId, status } = parseInput(setTableRoundStatusSchema, input);
    return tableRpc(me, createAdminClient(), "transition_table_order", {
      p_order_id: roundId,
      p_to: status,
      p_reason: null,
    });
  });
}

/**
 * S for `new` rounds, and for `preparing` / `served` within the staff cancel window (2.2.0, 9.10a); O after it.
 * Every cancel of an accepted round writes the owner alert in the same transaction; the notifier runs after.
 */
export async function cancelTableRound(input: unknown) {
  return runAction(async (): Promise<AdminTableRound> => {
    const me = await requireRole("staff");
    const { roundId, reason } = parseInput(cancelTableRoundSchema, input);
    const db = createAdminClient();
    const round = await tableRpc<AdminTableRound>(me, db, "transition_table_order", {
      p_order_id: roundId,
      p_to: "cancelled",
      p_reason: reason,
    });
    if (round.acceptedAt) {
      // table_audit carries the session id (9.7); the round row has it (service-role read, best effort).
      let sessionId: string | undefined;
      try {
        const r = await db.from("table_orders").select("session_id").eq("id", roundId).maybeSingle();
        sessionId = (r.data as { session_id?: string } | null)?.session_id;
      } catch {
        sessionId = undefined;
      }
      securityEvent("table_audit", { kind: "cancel_after_accept", sessionId, profileId: me.userId });
    }
    scheduleNotifier(scheduleAfter, createAdminClient);
    return round;
  });
}

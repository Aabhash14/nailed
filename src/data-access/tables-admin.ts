"use client";

import { getAlertCount, listAlerts, markAlertsRead } from "@/app/admin/_actions/alerts";
import {
  cancelTableRound,
  closeTable,
  getTableBoard,
  listCafeTables,
  openTable,
  rotateTableCode,
  saveCafeTables,
  setTableOrdering,
  setTableOrdersLocked,
  setTableRoundStatus,
} from "@/app/admin/_actions/tables";
import { mutateTablesDb } from "@/mocks/db";
import {
  mockCancelTableRound,
  mockCloseTable,
  mockGetTableBoard,
  mockListCafeTables,
  mockOpenTable,
  mockSaveCafeTables,
  mockSetTableOrdering,
  mockGetAlertCount,
  mockListAlerts,
  mockMarkAlertsRead,
  mockRotateTableCode,
  mockSetTableOrdersLocked,
  mockSetTableRoundStatus,
} from "@/mocks/tables";
import type {
  AdminTableRound,
  AdminTableSession,
  CafeTable,
  ClosedTableSummary,
  CloseTableInput,
  AdminAlert,
  ListAlertsInput,
  MarkAlertsReadInput,
  Role,
  SaveCafeTablesInput,
  TableBoardResult,
  TableCancelReason,
  TableOrderingMode,
  ActionResult,
  Uuid,
} from "@/types/contract";

/**
 * Table ordering admin actions (api-contract 2.0.0 section 9.7), one-to-one with backend-engineer's
 * src/app/admin/_actions/tables.ts and alerts.ts (contract 2.2.0). Part of AdminApi (./admin.ts): pages call `adminApi.getTableBoard(...)` etc.
 * None of these may cause a revalidateTag / revalidatePath (ADR 0002 rule 2); the UI never asks for one.
 */
export interface TablesAdminApi {
  /** S. All tables by number, plus the current mode. */
  listCafeTables(): Promise<ActionResult<{ rows: CafeTable[]; mode: TableOrderingMode }>>;
  /** O. The FULL set of tables. */
  saveCafeTables(i: SaveCafeTablesInput): Promise<ActionResult<{ rows: CafeTable[] }>>;
  /** O; staff may only switch "on" <-> "paused". */
  setTableOrdering(i: { mode: TableOrderingMode }): Promise<ActionResult<{ mode: TableOrderingMode }>>;
  /** S. Change-only feed: `{ changed: false }` when `since` equals the current cursor. */
  getTableBoard(i: { since?: string }): Promise<ActionResult<TableBoardResult>>;
  /** S. Opens a free table and returns its code. */
  openTable(i: { tableId: Uuid }): Promise<ActionResult<AdminTableSession>>;
  /** S; O to void (or close as paid at Rs. 0) once any round was ever accepted (2.1.0). */
  closeTable(i: CloseTableInput): Promise<ActionResult<ClosedTableSummary>>;
  /** S. new -> preparing, new / preparing -> served. */
  setTableRoundStatus(i: { roundId: Uuid; status: "preparing" | "served" }): Promise<ActionResult<AdminTableRound>>;
  /** S for `new`, and for `preparing` / `served` until staffCanCancelUntil (2.2.0, 9.10a); O after it. */
  cancelTableRound(i: {
    roundId: Uuid;
    reason: Exclude<TableCancelReason, "session_closed">;
  }): Promise<ActionResult<AdminTableRound>>;
  /** 2.1.0 (SEC-023): S. A new code for the same open session (rounds and bill kept); phones that joined must re-join. */
  rotateTableCode(i: { sessionId: Uuid }): Promise<ActionResult<AdminTableSession>>;
  /** 2.1.0 (SEC-023): S. "Stop app orders" for one open table. Idempotent; closing the table clears it. */
  setTableOrdersLocked(i: { sessionId: Uuid; locked: boolean }): Promise<ActionResult<AdminTableSession>>;
  // 2.2.0 (9.10) owner alerts: src/app/admin/_actions/alerts.ts, all O
  listAlerts(i: ListAlertsInput): Promise<ActionResult<{ rows: AdminAlert[]; total: number; unread: number }>>;
  markAlertsRead(i: MarkAlertsReadInput): Promise<ActionResult<{ unread: number }>>;
  getAlertCount(): Promise<ActionResult<{ unread: number }>>;
}

type Session = { role: Role; displayName: string } | null;
const needLogin = { ok: false as const, error: { code: "UNAUTHENTICATED" as const, message: "Please sign in again." } };

/** MOCK (NEXT_PUBLIC_DATA_MODE=mock): the browser mock db, with the owner/staff split. No security value. */
export function createMockTablesAdminApi(readSession: () => Session): TablesAdminApi {
  const as = <T>(fn: (s: NonNullable<Session>) => ActionResult<T>): Promise<ActionResult<T>> => {
    const s = readSession();
    return Promise.resolve(s ? fn(s) : needLogin);
  };
  return {
    listCafeTables: () => as(() => mutateTablesDb((db) => mockListCafeTables(db))),
    saveCafeTables: (i) => as((s) => mutateTablesDb((db) => mockSaveCafeTables(db, s.role, i))),
    setTableOrdering: (i) => as((s) => mutateTablesDb((db) => mockSetTableOrdering(db, s.role, i.mode))),
    getTableBoard: (i) => as(() => mutateTablesDb((db) => mockGetTableBoard(db, i.since))),
    openTable: (i) => as((s) => mutateTablesDb((db) => mockOpenTable(db, s.displayName, i.tableId))),
    closeTable: (i) => as((s) => mutateTablesDb((db) => mockCloseTable(db, s.role, s.displayName, i))),
    setTableRoundStatus: (i) => as(() => mutateTablesDb((db) => mockSetTableRoundStatus(db, i.roundId, i.status))),
    cancelTableRound: (i) =>
      as((s) => mutateTablesDb((db) => mockCancelTableRound(db, s.role, s.displayName, i.roundId, i.reason))),
    rotateTableCode: (i) => as(() => mutateTablesDb((db) => mockRotateTableCode(db, i.sessionId))),
    setTableOrdersLocked: (i) => as(() => mutateTablesDb((db) => mockSetTableOrdersLocked(db, i.sessionId, i.locked))),
    listAlerts: (i) => as((s) => mutateTablesDb((db) => mockListAlerts(db, s.role, i))),
    markAlertsRead: (i) => as((s) => mutateTablesDb((db) => mockMarkAlertsRead(db, s.role, s.displayName, i))),
    getAlertCount: () => as((s) => mutateTablesDb((db) => mockGetAlertCount(db, s.role))),
  };
}

/**
 * LIVE: backend-engineer's server actions (src/app/admin/_actions/tables.ts and alerts.ts, contract 2.3.0). Swapped in
 * by backend-engineer on 2026-10-26, replacing the "not connected" placeholder. The actions return ActionResult<T>;
 * the cast only widens the error code to TableErrorCode (validation/api.ts now carries both TABLE_* codes).
 */
const c = <T>(p: Promise<unknown>) => p as Promise<ActionResult<T>>;

export const liveTablesAdminApi: TablesAdminApi = {
  listCafeTables: () => c(listCafeTables()),
  saveCafeTables: (i) => c(saveCafeTables(i)),
  setTableOrdering: (i) => c(setTableOrdering(i)),
  getTableBoard: (i) => c(getTableBoard(i)),
  openTable: (i) => c(openTable(i)),
  closeTable: (i) => c(closeTable(i)),
  setTableRoundStatus: (i) => c(setTableRoundStatus(i)),
  cancelTableRound: (i) => c(cancelTableRound(i)),
  rotateTableCode: (i) => c(rotateTableCode(i)),
  setTableOrdersLocked: (i) => c(setTableOrdersLocked(i)),
  listAlerts: (i) => c(listAlerts(i)),
  markAlertsRead: (i) => c(markAlertsRead(i)),
  getAlertCount: () => c(getAlertCount()),
};

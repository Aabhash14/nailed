/**
 * Table ordering shapes for the server side (api-contract 2.3.0 section 9). TYPE-ONLY. The database shapes come from
 * `@/types/db` (hand-written, pinned by tests/database/table_ordering.test.sql) and are passed through unchanged; the
 * types below are the ones the contract defines on top of them. The frontend keeps its own copy in
 * src/types/contract.ts; the two must stay the same shape.
 */
import type {
  AdminAlertKind,
  AdminTableCard,
  AdminTableRound,
  AdminTableSession,
  CafeTable,
  ClaimedAlert,
  ClosedTableSummary,
  CreateTableOrderResult,
  GuestTableRound,
  IsoDateTime,
  JoinTableResult,
  Paisa,
  StaffTableCancelReason,
  StatsTableOrders,
  TableBill,
  TableBoardResult,
  TableCancelReason,
  TableCloseOutcome,
  TableGuestState,
  TableOrderingMode,
  TableOrderLine,
  TablePaidVia,
  TableRoundStatus,
  TableSessionView,
  Uuid,
} from "@/types/db";

export type {
  AdminAlertKind,
  AdminTableCard,
  AdminTableRound,
  AdminTableSession,
  CafeTable,
  ClaimedAlert,
  ClosedTableSummary,
  CreateTableOrderResult,
  GuestTableRound,
  JoinTableResult,
  StaffTableCancelReason,
  StatsTableOrders,
  TableBill,
  TableBoardResult,
  TableCancelReason,
  TableCloseOutcome,
  TableGuestState,
  TableOrderingMode,
  TableOrderLine,
  TablePaidVia,
  TableRoundStatus,
  TableSessionView,
};

/** GET /api/menu `tables` (9.1). Active tables only, by number. No codes, times or orders. */
export type TableOccupancy = {
  total: number;
  free: number;
  tables: { number: number; label: string | null; occupied: boolean }[];
};

/** POST /api/table/orders answer (9.5). */
export type TableOrderResponse = CreateTableOrderResult;

/**
 * 2.3.0 (9.10): reserved names for the pending free delivery channel. None is enabled in v1. The database CHECK on
 * alert_deliveries.channel still says 'whatsapp' only and is widened by migration when a channel is chosen.
 */
export type AlertChannel = "webpush" | "email";
export type AlertDeliveryStatus = "pending" | "sent" | "failed";

/** 9.10 (2.3.0). `delivery` is `[]` while no channel is enabled (v1). */
export type AdminAlert = {
  id: Uuid;
  kind: AdminAlertKind;
  createdAt: IsoDateTime;
  text: string;
  data: {
    tableNumber?: number;
    round?: number;
    amount?: Paisa;
    actorName?: string | null;
    reason?: TableCancelReason;
    acceptedRounds?: number;
    failures?: number;
    minutesAfterAccept?: number;
  };
  readAt: IsoDateTime | null;
  readByName: string | null;
  delivery: { channel: AlertChannel; status: AlertDeliveryStatus }[];
};

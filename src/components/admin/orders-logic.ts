import type { AdminOrderRow, OrderStatus } from "@/types/contract";
import { isActive } from "@/types/order-flow";
import { kathmanduDateKey } from "@/components/format";

/** Pure helpers for Today's orders (no React), unit-tested in tests/unit/orders-logic.test.ts. */

type Row = Pick<AdminOrderRow, "status" | "createdAt" | "completedAt" | "cancelledAt">;

/** When an order stopped needing action: completed or cancelled time; null while it is still open. */
export function finishedAt(o: Row): string | null {
  if (o.status === "completed") return o.completedAt ?? o.createdAt;
  if (o.status === "cancelled") return o.cancelledAt ?? o.createdAt;
  return null;
}

/**
 * BUG-013: "Finished today" means finished on the current Kathmandu date, whenever the order was placed. An order
 * placed at 23:52 and completed at 00:12 belongs to the new day (it used to vanish from both tabs).
 */
export function finishedOnDay(o: Row, dayKey: string): boolean {
  const t = finishedAt(o);
  return t !== null && kathmanduDateKey(t) === dayKey;
}

/** Design review T-048 fix 5: what needs doing first. Placed (call them), then confirmed, then on the way / ready. */
const GROUP: Record<OrderStatus, number> = {
  placed: 0,
  confirmed: 1,
  ready_for_pickup: 2,
  out_for_delivery: 2,
  completed: 3,
  cancelled: 3,
};

/** "Needs action": status group first, then OLDEST first inside each group, so stale orders come to the top. */
export function sortNeedsAction<T extends Row>(rows: T[]): T[] {
  return [...rows].sort((a, b) => GROUP[a.status] - GROUP[b.status] || a.createdAt.localeCompare(b.createdAt));
}

/** "Finished today": most recently finished first. */
export function sortFinished<T extends Row>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (finishedAt(b) ?? "").localeCompare(finishedAt(a) ?? ""));
}

/** Both tabs from one list of rows. `now` decides "today" (Kathmandu date). */
export function splitBoard<T extends Row>(rows: T[], now: Date): { open: T[]; done: T[] } {
  const today = kathmanduDateKey(now);
  return {
    open: sortNeedsAction(rows.filter((r) => isActive(r.status))),
    done: sortFinished(rows.filter((r) => !isActive(r.status) && finishedOnDay(r, today))),
  };
}

import type { DailySales, DailySalesLine, LogDailySalesLineInput } from "@/lib/stats/types";
import type { AdminMenuCategory } from "@/types/contract";
import { formatClock } from "@/components/format";
import { kathmanduDate } from "@/lib/stats/dates";
import { shortDate } from "../stats/stats-logic";

/** Pure helpers for the "Log sales" screen. No React, no browser APIs (unit-tested). */

export const QTY_MAX = 9999;

export type SalesRow = {
  key: string;
  menuItemId: string;
  variantId: string | null;
  name: string; // item name
  label: string; // what the row shows: the item name, or the option label for a sub-row
  pricePaisa: number; // current menu price (item + option delta, floored at 0)
  hidden: boolean;
};
export type SalesItem = { item: SalesRow; options: SalesRow[] };
export type SalesGroup = { id: string; name: string; items: SalesItem[] };

export const lineKey = (menuItemId: string, variantId: string | null | undefined) => `${menuItemId}|${variantId ?? ""}`;

/** Menu -> categories of items, each with its options as sub-rows (every option is its own line in the log). */
export function buildGroups(menu: AdminMenuCategory[]): SalesGroup[] {
  return [...menu]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({
      id: c.id,
      name: c.name,
      items: [...c.items]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((it) => ({
          item: {
            key: lineKey(it.id, null),
            menuItemId: it.id,
            variantId: null,
            name: it.name,
            label: it.name,
            pricePaisa: Math.max(0, it.price),
            hidden: !it.isVisible,
          },
          options: it.variants.map((v) => ({
            key: lineKey(it.id, v.id),
            menuItemId: it.id,
            variantId: v.id,
            name: it.name,
            label: v.label,
            pricePaisa: Math.max(0, it.price + v.priceDelta),
            hidden: !it.isVisible,
          })),
        })),
    }))
    .filter((g) => g.items.length > 0);
}

export function allRows(groups: SalesGroup[]): SalesRow[] {
  return groups.flatMap((g) => g.items.flatMap((i) => [i.item, ...i.options]));
}

/** Quantities of a saved log, keyed by line (missing = 0). */
export function qtyFromLog(log: DailySales | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of log?.lines ?? []) out[lineKey(l.menuItemId, l.variantId)] = l.qty;
  return out;
}

/** Lines of the log that the current menu no longer has (deleted item or option). Shown read-only. */
export function orphanLines(log: DailySales | null, groups: SalesGroup[]): DailySalesLine[] {
  const keys = new Set(allRows(groups).map((r) => r.key));
  return (log?.lines ?? []).filter((l) => !keys.has(lineKey(l.menuItemId, l.variantId)) && l.qty > 0);
}

/** Text typed in a qty box -> whole number 0..9999, or null when it is not one. Empty = 0. */
export function parseQty(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n <= QTY_MAX ? n : null;
}

/** Keep only digits, at most 4 (what the box accepts while typing). */
export function cleanQtyInput(text: string): string {
  return text.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 4);
}

export function step(current: number, by: 1 | -1): number {
  return Math.min(QTY_MAX, Math.max(0, current + by));
}

/**
 * Live total. A line already in the log keeps the price it was first logged at (the database does the same);
 * a new line uses today's menu price. Orphan lines (no longer on the menu) count as logged.
 */
export function liveTotal(
  qty: Record<string, number>,
  rows: SalesRow[],
  log: DailySales | null,
  orphans: DailySalesLine[],
): { items: number; paisa: number } {
  const snap = new Map((log?.lines ?? []).map((l) => [lineKey(l.menuItemId, l.variantId), l.unitPricePaisa]));
  let items = 0;
  let paisa = 0;
  for (const r of rows) {
    const q = qty[r.key] ?? 0;
    if (q <= 0) continue;
    items += q;
    paisa += q * (snap.get(r.key) ?? r.pricePaisa);
  }
  for (const o of orphans) {
    items += o.qty;
    paisa += o.lineTotalPaisa;
  }
  return { items, paisa };
}

/**
 * Lines to send. The server MERGES lines (unsent ones stay), so send every row whose qty differs from what is
 * saved, including 0 for a row that was cleared.
 */
export function changedLines(saved: Record<string, number>, current: Record<string, number>, rows: SalesRow[]): LogDailySalesLineInput[] {
  const out: LogDailySalesLineInput[] = [];
  for (const r of rows) {
    const now = current[r.key] ?? 0;
    const before = saved[r.key] ?? 0;
    if (now !== before) out.push({ menuItemId: r.menuItemId, variantId: r.variantId, qty: now }); // base item: variantId null
  }
  return out;
}

export type SaveErrors = { lines: string[]; tillTotal?: string; note?: string; date?: string; other: string[] };

/** Server VALIDATION fieldErrors -> messages next to the right fields ("lines.3" is the 4th line SENT). */
export function mapSaveErrors(fieldErrors: Record<string, string[]> | undefined, sent: LogDailySalesLineInput[], rows: SalesRow[]): SaveErrors {
  const out: SaveErrors = { lines: [], other: [] };
  for (const [k, msgs] of Object.entries(fieldErrors ?? {})) {
    const msg = msgs.join(" ");
    const m = /^lines\.(\d+)/.exec(k);
    if (m) {
      const l = sent[Number(m[1])];
      const r = l ? rows.find((x) => x.key === lineKey(l.menuItemId, l.variantId)) : undefined;
      out.lines.push(r ? `${r.variantId ? `${r.name}, ${r.label}` : r.name}: ${msg}` : msg);
    } else if (k === "tillTotal" || k === "tillTotalPaisa") out.tillTotal = msg;
    else if (k === "note") out.note = msg;
    else if (k === "date") out.date = msg;
    else out.other.push(msg);
  }
  return out;
}

/** Case-insensitive match on item or option name (the quick filter). */
export function matchesFilter(item: SalesItem, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return item.item.name.toLowerCase().includes(f) || item.options.some((o) => o.label.toLowerCase().includes(f));
}

/**
 * Status line for a loaded log. With the saver's name (`updatedByName` from getDailySales/logDailySales):
 * "Saved at 18:30 by Asha" on its own line (the save banner's wording). Without it, as before: ": last saved at 18:30."
 * A log saved on a later day than the one it is for names that day: "Saved Mon 26 Oct at 09:10 by Asha".
 */
export function loadedLogStatus(log: Pick<DailySales, "businessDate" | "updatedAt"> & { updatedByName?: string | null }): {
  ownLine: boolean;
  text: string;
} {
  const savedOn = kathmanduDate(new Date(log.updatedAt));
  const when = `${savedOn === log.businessDate ? "" : `${shortDate(savedOn)} `}at ${formatClock(log.updatedAt)}`;
  const by = log.updatedByName?.trim();
  return by ? { ownLine: true, text: `Saved ${when} by ${by}` } : { ownLine: false, text: `: last saved ${when}.` };
}

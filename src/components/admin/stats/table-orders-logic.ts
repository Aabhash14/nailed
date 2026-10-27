import type { StatsBundle } from "@/lib/stats/types";
import type { StatsTableOrders } from "@/types/contract";

/** Pure helpers for the "Ordered from the table" stats card (contract 2.2.0 section 9.11). */

/** `StatsBundle.tableOrders`, read defensively: optional until src/lib/stats/types.ts carries it. */
export function tableOrdersOf(data: StatsBundle): StatsTableOrders | null {
  const t = (data as StatsBundle & { tableOrders?: StatsTableOrders }).tableOrders;
  return t && typeof t === "object" && Array.isArray(t.byHour) ? t : null;
}

/** The busiest hours from the 24 entries: the top `n` with any rounds, ties to the earlier hour ("13:00"). */
export function busiestHours(byHour: StatsTableOrders["byHour"], n = 3): string[] {
  return [...byHour]
    .filter((h) => h.rounds > 0)
    .sort((a, b) => b.rounds - a.rounds || a.hour - b.hour)
    .slice(0, n)
    .map((h) => `${String(h.hour).padStart(2, "0")}:00`);
}

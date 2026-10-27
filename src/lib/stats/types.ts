/**
 * Types for the statistics dashboard and the daily food sales log (api-contract 1.5.0 + 1.5.1, section 4 "Statistics").
 * TYPE-ONLY and client-safe: the frontend imports these. The DB shapes come from `@/types/db` (hand-written copy of
 * supabase/types/db.ts, documented in supabase/README.md "Statistics"); they are passed through unchanged.
 */

import type {
  DailySalesLog,
  DailySalesLogLine,
  IsoDate,
  Paisa,
  StatsBestFoodDay,
  StatsBestFoodPerDay,
  StatsBusyHeatmap,
  StatsCancellations,
  StatsFoodWeekday,
  StatsGrain,
  StatsHeatmapCell,
  StatsMetric,
  StatsOverview,
  StatsStockAlert,
  StatsStockAlerts,
  StatsTableOrders,
  StatsTimeseries,
  StatsTimeseriesBucket,
  StatsTopFood,
  StatsTopFoodItem,
  StatsTopMerch,
  StatsTopMerchProduct,
  StatsTopMerchVariant,
  Uuid,
  Weekday,
} from "@/types/db";

export type {
  DailySalesLog,
  DailySalesLogLine,
  StatsBestFoodDay,
  StatsBestFoodPerDay,
  StatsBusyHeatmap,
  StatsCancellations,
  StatsFoodWeekday,
  StatsGrain,
  StatsHeatmapCell,
  StatsMetric,
  StatsOverview,
  StatsStockAlert,
  StatsStockAlerts,
  StatsTableOrders,
  StatsTimeseries,
  StatsTimeseriesBucket,
  StatsTopFood,
  StatsTopFoodItem,
  StatsTopMerch,
  StatsTopMerchProduct,
  StatsTopMerchVariant,
  Weekday,
};
export type { DateRange, StatsFixedPreset, StatsPreset } from "./dates";

/**
 * One day's food sales log, as returned by `getDailySales` / `logDailySales`: the DB's DailySalesLog plus
 * `updatedByName` (1.5.1), the `profiles.display_name` of `updatedBy`, looked up by the server with the service
 * client. `null` when `updatedBy` is null or the profile no longer exists (a deactivated staff member's profile is
 * deleted, which sets `updatedBy` to null). Never an email.
 */
export type DailySales = DailySalesLog & { updatedByName: string | null };
export type DailySalesLine = DailySalesLogLine;

// ---- inputs ----------------------------------------------------------------------------------------------------

export type GetDailySalesInput = { date: IsoDate };

export type LogDailySalesLineInput = {
  menuItemId: Uuid;
  variantId?: Uuid | null; // omitted / null = the base item
  qty: number; // whole number 0..9999; 0 zeroes an existing line
};

export type LogDailySalesInput = {
  date: IsoDate; // Kathmandu business date. Staff: today or yesterday only. Never in the future
  lines: LogDailySalesLineInput[]; // 0..500, MERGED: unsent lines stay as they are
  tillTotalPaisa?: Paisa | null; // 0..1,000,000,000. Omitted = keep the stored value; null = clear
  note?: string | null; // max 500 characters, trimmed. Omitted = keep the stored value; null or "" = clear
};

export type StatsCompare = "previous" | "none" | { from: IsoDate; to: IsoDate };

export type GetStatsInput = {
  from: IsoDate;
  to: IsoDate; // from <= to, at most 1,096 days, both included
  compare?: StatsCompare; // default "previous"
  grain?: StatsGrain; // default: day up to 62 days, week up to 366, month above
};

// ---- output ----------------------------------------------------------------------------------------------------

export type StatsRange = {
  from: IsoDate;
  to: IsoDate;
  compareFrom: IsoDate | null; // null when compare = "none"
  compareTo: IsoDate | null;
  grain: StatsGrain; // the grain actually used for `timeseries`
  timezone: "Asia/Kathmandu";
  /** 1.5.1: logged days in from..to whose note is "DEMO DATA" (case-insensitive). 0 = no demo days in range. */
  demoDataDays: number;
};

/** What `resolveStatsRange` works out from the input alone (everything in StatsRange except the database count). */
export type ResolvedStatsRange = Omit<StatsRange, "demoDataDays">;

/** `getStats` result: one RPC per key, called in parallel; each value is that RPC's jsonb, unchanged. */
export type StatsBundle = {
  range: StatsRange;
  overview: StatsOverview; // stats_overview (with the compare range)
  timeseries: StatsTimeseries; // stats_timeseries (range.grain)
  topFood: StatsTopFood; // stats_top_food (limit 10)
  bestFoodPerDay: StatsBestFoodPerDay; // stats_best_food_per_day
  topMerch: StatsTopMerch; // stats_top_merch (limit 10)
  heatmap: StatsBusyHeatmap; // stats_busy_heatmap
  cancellations: StatsCancellations; // stats_cancellations
  stockAlerts: StatsStockAlerts; // stats_stock_alerts (current stock, not range-bound)
  /**
   * 2.0.0 (api-contract 9.11): stats_table_orders over range.from..range.to (no compare range). A SEPARATE block:
   * never added to food revenue, topFood or the timeseries (dine-in rounds are also in the daily log).
   */
  tableOrders: StatsTableOrders;
};

"use server";

import { runAction } from "@/lib/actions";
import { requireRole, type AuthContext } from "@/lib/auth/require-role";
import { unwrap } from "@/lib/data/db-errors";
import { createAdminClient } from "@/lib/data/server-admin";
import type { Db } from "@/lib/data/types";
import { AppError } from "@/lib/errors";
import { securityEvent } from "@/lib/log";
import { DAILY_SALES_MIN_DATE, kathmanduToday, staffMayUseDate } from "@/lib/stats/dates";
import type { DailySales, StatsBundle } from "@/lib/stats/types";
import {
  getDailySalesSchema,
  DEMO_DATA_NOTE,
  getStatsSchema,
  logDailySalesSchema,
  MSG,
  resolveStatsRange,
  STATS_TOP_LIMIT,
} from "@/lib/stats/validation";
import { parseInput } from "@/lib/validation/common";
import type {
  DailySalesLog,
  IsoDate,
  StatsBestFoodPerDay,
  StatsBusyHeatmap,
  StatsCancellations,
  StatsOverview,
  StatsStockAlerts,
  StatsTableOrders,
  StatsTimeseries,
  StatsTopFood,
  StatsTopMerch,
} from "@/types/db";

/**
 * Daily food sales log (staff + owner) and the owner statistics dashboard (api-contract 1.5.1, section 4
 * "Statistics"). Every RPC here is service-role only with a trailing `p_actor` (the verified profile id); the
 * database re-checks the role and the date window and is the authority. The app checks first so the user gets a
 * clear VALIDATION message instead of a FORBIDDEN from the database.
 */

type Scope = "daily_sales" | "stats";

/** Log a database FORBIDDEN as a security event (no PII: profile id and role only), then rethrow. */
async function withForbiddenLog<T>(
  me: AuthContext,
  scope: Scope,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError && e.code === "FORBIDDEN") {
      securityEvent("forbidden", {
        userId: me.userId,
        role: me.role,
        need: scope === "stats" ? "owner" : "staff",
        scope,
        code: "db",
      });
    }
    throw e;
  }
}

/** The database calls the till field `tillTotal`; the action input calls it `tillTotalPaisa`. */
function renameDbFieldErrors(e: unknown): unknown {
  if (!(e instanceof AppError) || e.code !== "VALIDATION" || !e.fieldErrors?.tillTotal) return e;
  const { tillTotal, ...rest } = e.fieldErrors;
  return new AppError("VALIDATION", e.message, {
    fieldErrors: { ...rest, tillTotalPaisa: tillTotal },
  });
}

function vErr(field: string, message: string): AppError {
  return new AppError("VALIDATION", undefined, { fieldErrors: { [field]: [message] } });
}

/** App-side date window (same rules as the RPCs): never the future; staff today/yesterday only; logs from 2020. */
function checkLogDate(
  me: AuthContext,
  date: IsoDate,
  mode: "read" | "write",
  now = new Date(),
): void {
  const today = kathmanduToday(now);
  if (date > today) throw vErr("date", MSG.future);
  if (mode === "write" && date < DAILY_SALES_MIN_DATE) throw vErr("date", MSG.tooOld);
  if (me.role !== "owner" && !staffMayUseDate(date, now)) {
    throw vErr("date", mode === "write" ? MSG.staffLog : MSG.staffRead);
  }
}

function asLogOrNull(data: unknown, rpcName: string): DailySalesLog | null {
  if (data === null || data === undefined) return null;
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new AppError("INTERNAL", undefined, { logDetail: `${rpcName}: unexpected result type` });
  }
  return data as DailySalesLog;
}

/**
 * 1.5.1: add `updatedByName` = profiles.display_name of `updatedBy` (service client). Only the display name is read,
 * never an email. When the saver is the caller, `me.displayName` is that same column, read from profiles by
 * requireRole in this request, so no second query. null when `updatedBy` is null or the profile is gone. The name is
 * cosmetic: a failed lookup is logged (no PII) and gives null instead of failing a read or an already-saved log.
 */
async function withUpdatedByName(db: Db, me: AuthContext, log: DailySalesLog): Promise<DailySales> {
  const by = log.updatedBy;
  if (!by) return { ...log, updatedByName: null };
  if (by === me.userId) return { ...log, updatedByName: me.displayName };
  const res = await db.from("profiles").select("display_name").eq("id", by).maybeSingle();
  if (res.error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "daily_sales_name_lookup_failed",
        code: String(res.error.code ?? "?").slice(0, 16),
      }),
    );
    return { ...log, updatedByName: null };
  }
  const name: unknown = (res.data as { display_name?: unknown } | null)?.display_name;
  return { ...log, updatedByName: typeof name === "string" && name !== "" ? name : null };
}

/** 1.5.1: logged days in from..to marked as seed demo data (note "DEMO DATA", any case). One indexed count query. */
async function countDemoDataDays(db: Db, from: IsoDate, to: IsoDate): Promise<number> {
  const res = await db
    .from("daily_sales")
    .select("id", { count: "exact", head: true })
    .gte("business_date", from)
    .lte("business_date", to)
    .ilike("note", DEMO_DATA_NOTE); // no % or _ in the pattern: a case-insensitive equality
  unwrap(res);
  if (typeof res.count !== "number") {
    throw new AppError("INTERNAL", undefined, { logDetail: "daily_sales demo count: no count returned" });
  }
  return res.count;
}

async function rpcObject<T>(db: Db, name: string, args: Record<string, unknown>): Promise<T> {
  const data: unknown = unwrap(await db.rpc(name, args));
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new AppError("INTERNAL", undefined, { logDetail: `${name}: no object returned` });
  }
  return data as T;
}

/**
 * Staff + owner. One day's food sales log, or null when nothing is logged for that date yet.
 * Input `{ date }` (Kathmandu `YYYY-MM-DD`). Staff: today or yesterday only.
 */
export async function getDailySales(input: unknown) {
  return runAction(async (): Promise<DailySales | null> => {
    const me = await requireRole("staff");
    const { date } = parseInput(getDailySalesSchema, input);
    checkLogDate(me, date, "read");
    const db = createAdminClient();
    return withForbiddenLog(me, "daily_sales", async () => {
      const log = asLogOrNull(
        unwrap(await db.rpc("get_daily_sales", { p_date: date, p_actor: me.userId })),
        "get_daily_sales",
      );
      return log ? withUpdatedByName(db, me, log) : null;
    });
  });
}

/**
 * Staff + owner. Save a day's food counts. Lines are MERGED (unsent lines stay; qty 0 zeroes one). Prices are
 * snapshotted by the database; any price the client sends is dropped by the schema. `tillTotalPaisa` / `note`:
 * omitted = keep the stored value (read first), null = clear. Staff: today or yesterday only. Owner: any past date.
 */
export async function logDailySales(input: unknown) {
  return runAction(async (): Promise<DailySales> => {
    const me = await requireRole("staff");
    const d = parseInput(logDailySalesSchema, input);
    checkLogDate(me, d.date, "write");
    const db = createAdminClient();
    return withForbiddenLog(me, "daily_sales", async () => {
      let till = d.tillTotalPaisa;
      let note = d.note;
      if (till === undefined || note === undefined) {
        // The RPC REPLACES the header; "omitted = unchanged" (contract rule since 1.3.1) needs the current values.
        const current = asLogOrNull(
          unwrap(await db.rpc("get_daily_sales", { p_date: d.date, p_actor: me.userId })),
          "get_daily_sales",
        );
        if (till === undefined) till = current?.tillTotalPaisa ?? null;
        if (note === undefined) note = current?.note ?? null;
      }
      let saved: DailySalesLog | null;
      try {
        saved = asLogOrNull(
          unwrap(
            await db.rpc("upsert_daily_sales", {
              p_date: d.date,
              p_lines: d.lines.map((l) => ({
                menuItemId: l.menuItemId,
                variantId: l.variantId ?? null,
                qty: l.qty,
              })),
              p_till_total: till,
              p_note: note,
              p_actor: me.userId,
            }),
          ),
          "upsert_daily_sales",
        );
      } catch (e) {
        throw renameDbFieldErrors(e);
      }
      if (!saved)
        throw new AppError("INTERNAL", undefined, {
          logDetail: "upsert_daily_sales returned null",
        });
      return withUpdatedByName(db, me, saved);
    });
  });
}

/**
 * Owner only. The whole dashboard in one call: the nine stats RPCs (2.0.0: + stats_table_orders) run in parallel, each value passed through as
 * the RPC returned it, plus (1.5.1) `range.demoDataDays`, a count query on daily_sales run in the same batch. The
 * owner role was checked by requireRole above; the count reads with the service client like the RPCs do. Input `{ from, to, compare?, grain? }`; see `GetStatsInput` in src/lib/stats/types.ts.
 */
export async function getStats(input: unknown) {
  return runAction(async (): Promise<StatsBundle> => {
    const me = await requireRole("owner");
    const range = resolveStatsRange(parseInput(getStatsSchema, input));
    const db = createAdminClient();
    const r = { p_from: range.from, p_to: range.to };
    const actor = { p_actor: me.userId };

    return withForbiddenLog(me, "stats", async () => {
      const [
        overview,
        timeseries,
        topFood,
        bestFoodPerDay,
        topMerch,
        heatmap,
        cancellations,
        stockAlerts,
        tableOrders,
        demoDataDays,
      ] = await Promise.all([
        rpcObject<StatsOverview>(db, "stats_overview", {
          ...r,
          p_cmp_from: range.compareFrom,
          p_cmp_to: range.compareTo,
          ...actor,
        }),
        rpcObject<StatsTimeseries>(db, "stats_timeseries", {
          ...r,
          p_grain: range.grain,
          ...actor,
        }),
        rpcObject<StatsTopFood>(db, "stats_top_food", { ...r, p_limit: STATS_TOP_LIMIT, ...actor }),
        rpcObject<StatsBestFoodPerDay>(db, "stats_best_food_per_day", { ...r, ...actor }),
        rpcObject<StatsTopMerch>(db, "stats_top_merch", {
          ...r,
          p_limit: STATS_TOP_LIMIT,
          ...actor,
        }),
        rpcObject<StatsBusyHeatmap>(db, "stats_busy_heatmap", { ...r, ...actor }),
        rpcObject<StatsCancellations>(db, "stats_cancellations", { ...r, ...actor }),
        rpcObject<StatsStockAlerts>(db, "stats_stock_alerts", { ...actor }),
        // 2.0.0 (9.11): table orders, same range, a separate block
        rpcObject<StatsTableOrders>(db, "stats_table_orders", { ...r, ...actor }),
        countDemoDataDays(db, range.from, range.to),
      ]);
      return {
        range: { ...range, demoDataDays },
        overview,
        timeseries,
        topFood,
        bestFoodPerDay,
        topMerch,
        heatmap,
        cancellations,
        stockAlerts,
        tableOrders,
      };
    });
  });
}

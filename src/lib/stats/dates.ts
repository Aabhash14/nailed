/**
 * Kathmandu calendar-date helpers for the statistics dashboard and the daily food sales log (api-contract 1.5.0).
 * PURE functions, no server imports: the frontend imports this file too, so both sides compute "today", the preset
 * ranges, the previous (compare) range and the default grain the same way.
 *
 * Dates are `YYYY-MM-DD` strings meaning a calendar day in Asia/Kathmandu (UTC+05:45, no daylight saving).
 * Kathmandu day D runs from 18:15 UTC on D-1 to 18:14:59.999 UTC on D (supabase/README.md "Statistics").
 * Arithmetic is done on UTC midnights, which has no DST either, so day counts are exact.
 */

import type { IsoDate, StatsGrain } from "@/types/db";

export const KATHMANDU_TZ = "Asia/Kathmandu" as const;
/** Fixed offset. Nepal has had no daylight saving since 1986. */
export const KATHMANDU_OFFSET_MINUTES = 5 * 60 + 45;
/** Inclusive range limit in days, same as the database (`p_to - p_from >= 1096` is refused). */
export const STATS_MAX_RANGE_DAYS = 1096;
/** Default grain: `day` up to this many days (inclusive) ... */
export const GRAIN_DAY_MAX_DAYS = 62;
/** ... `week` up to this many days (one year, leap year included), `month` above. */
export const GRAIN_WEEK_MAX_DAYS = 366;
/** The database refuses food logs before this date. */
export const DAILY_SALES_MIN_DATE: IsoDate = "2020-01-01";

export const STATS_PRESETS = [
  "today",
  "yesterday",
  "last7Days",
  "last30Days",
  "thisMonth",
  "lastMonth",
  "custom",
] as const;
export type StatsPreset = (typeof STATS_PRESETS)[number];
/** Every preset except `custom` maps to a fixed range. */
export type StatsFixedPreset = Exclude<StatsPreset, "custom">;

export type DateRange = { from: IsoDate; to: IsoDate };

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in `YYYY-MM-DD` form (rejects 2026-02-30, 2026-1-5, "2026-10-25T00:00"). */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toUtcMs(date: IsoDate): number {
  if (!isIsoDate(date)) throw new RangeError(`not an ISO date: ${String(date).slice(0, 20)}`);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Kathmandu calendar date of an instant (default: now). */
export function kathmanduDate(at: Date = new Date()): IsoDate {
  return fromUtcMs(at.getTime() + KATHMANDU_OFFSET_MINUTES * 60_000);
}

/** Today's date in Kathmandu, whatever the browser's or server's time zone. */
export function kathmanduToday(now: Date = new Date()): IsoDate {
  return kathmanduDate(now);
}

/** `date` plus `days` (negative to go back). */
export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Number of days from `from` to `to`, both included (from = to gives 1; to before from gives 0 or less). */
export function daysInclusive(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS) + 1;
}

/** Compare two ISO dates: negative, 0 or positive (string order is date order for YYYY-MM-DD). */
export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function firstOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

/**
 * The range of a dashboard preset, in Kathmandu dates, both ends inclusive. "Last 7 days" and "Last 30 days"
 * include today. "This month" runs from the 1st to today. `custom` has no fixed range: the UI keeps the user's dates.
 */
export function presetRange(name: StatsFixedPreset, now: Date = new Date()): DateRange {
  const today = kathmanduToday(now);
  switch (name) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "last7Days":
      return { from: addDays(today, -6), to: today };
    case "last30Days":
      return { from: addDays(today, -29), to: today };
    case "thisMonth":
      return { from: firstOfMonth(today), to: today };
    case "lastMonth": {
      const lastDayPrev = addDays(firstOfMonth(today), -1);
      return { from: firstOfMonth(lastDayPrev), to: lastDayPrev };
    }
  }
}

/** The range of the same length immediately before `from..to` (compare = "previous"). */
export function previousRange(from: IsoDate, to: IsoDate): DateRange {
  const n = daysInclusive(from, to);
  if (n < 1) throw new RangeError("from must be on or before to");
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(n - 1)), to: prevTo };
}

/** Default chart grain: `day` up to 62 days, `week` up to 366 days (one year), `month` above. */
export function defaultGrain(from: IsoDate, to: IsoDate): StatsGrain {
  const n = daysInclusive(from, to);
  if (n <= GRAIN_DAY_MAX_DAYS) return "day";
  if (n <= GRAIN_WEEK_MAX_DAYS) return "week";
  return "month";
}

/** Staff may read and log today and yesterday (Kathmandu) only. The database is the authority; this is the UI/app pre-check. */
export function staffMayUseDate(date: IsoDate, now: Date = new Date()): boolean {
  const today = kathmanduToday(now);
  return date === today || date === addDays(today, -1);
}

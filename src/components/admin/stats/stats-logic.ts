import { daysInclusive, defaultGrain, isIsoDate, presetRange, previousRange, STATS_MAX_RANGE_DAYS, type DateRange, type StatsPreset } from "@/lib/stats/dates";
import type { StatsGrain, StatsMetric } from "@/lib/stats/types";
import type { CancelReason } from "@/types/contract";
import { CANCEL_REASON_LABEL } from "@/types/order-flow";

/** Pure helpers for the owner Stats dashboard. No React, no browser APIs (unit-tested). */

export const PRESET_LABEL: Record<StatsPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7Days: "Last 7 days",
  last30Days: "Last 30 days",
  thisMonth: "This month",
  lastMonth: "Last month",
  custom: "Custom",
};
export const PRESET_ORDER: StatsPreset[] = ["today", "yesterday", "last7Days", "last30Days", "thisMonth", "lastMonth", "custom"];

export type GrainChoice = "auto" | StatsGrain;
export const GRAIN_LABEL: Record<GrainChoice, string> = { auto: "Auto", day: "Day", week: "Week", month: "Month" };

/** Dashboard controls, kept in the address bar so a view can be reloaded or shared. */
export type StatsQuery = {
  preset: StatsPreset;
  from: string; // only used for custom
  to: string;
  compare: boolean;
  grain: GrainChoice;
};

export const DEFAULT_QUERY: Omit<StatsQuery, "from" | "to"> = { preset: "last30Days", compare: true, grain: "auto" };

export function parseQuery(search: string, today: string): StatsQuery {
  const p = new URLSearchParams(search);
  const preset = (PRESET_ORDER as string[]).includes(p.get("range") ?? "") ? (p.get("range") as StatsPreset) : DEFAULT_QUERY.preset;
  const grainRaw = p.get("grain") ?? "auto";
  const grain: GrainChoice = grainRaw === "day" || grainRaw === "week" || grainRaw === "month" ? grainRaw : "auto";
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  const okCustom = isIsoDate(from) && isIsoDate(to) && from <= to && to <= today;
  return {
    preset: preset === "custom" && !okCustom ? DEFAULT_QUERY.preset : preset,
    from: okCustom ? from : "",
    to: okCustom ? to : "",
    compare: p.get("compare") !== "0",
    grain,
  };
}

export function serializeQuery(q: StatsQuery): string {
  const p = new URLSearchParams();
  p.set("range", q.preset);
  if (q.preset === "custom") {
    p.set("from", q.from);
    p.set("to", q.to);
  }
  if (!q.compare) p.set("compare", "0");
  if (q.grain !== "auto") p.set("grain", q.grain);
  return p.toString();
}

/** Problem with a custom range typed by the owner, or null when it can be fetched. */
export function customRangeProblem(from: string, to: string, today: string): string | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return "Pick both a start and an end date.";
  if (from > to) return "The start date must be on or before the end date.";
  if (to > today) return "The end date cannot be after today.";
  if (daysInclusive(from, to) > STATS_MAX_RANGE_DAYS) return "Pick a range of at most 1,096 days (about 3 years).";
  return null;
}

/** The concrete range for the controls (custom falls back to the last 30 days until both dates are valid). */
export function rangeFor(q: StatsQuery, now: Date): DateRange {
  if (q.preset === "custom") return { from: q.from, to: q.to };
  return presetRange(q.preset, now);
}

export function grainFor(q: StatsQuery, r: DateRange): StatsGrain {
  return q.grain === "auto" ? defaultGrain(r.from, r.to) : q.grain;
}

export function compareRangeFor(q: StatsQuery, r: DateRange): DateRange | null {
  return q.compare ? previousRange(r.from, r.to) : null;
}

/* ---- dates ---------------------------------------------------------------------------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parts(date: string): { y: number; m: number; d: number; wd: number } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** "Sun 25 Oct" */
export function shortDate(date: string): string {
  const { m, d, wd } = parts(date);
  return `${WEEKDAY_SHORT[wd]} ${d} ${MONTHS[m - 1]}`;
}
/** "Sunday 25 October 2026" */
export function longDate(date: string): string {
  const { y, m, d, wd } = parts(date);
  return `${WEEKDAY_LONG[wd]} ${d} ${MONTHS_LONG[m - 1]} ${y}`;
}
/** "25 Oct" */
export function dayMonth(date: string): string {
  const { m, d } = parts(date);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "1 Oct to 25 Oct 2026", "25 Oct 2026", "28 Dec 2025 to 3 Jan 2026" */
export function rangeLabel(from: string, to: string): string {
  const a = parts(from);
  const b = parts(to);
  if (from === to) return `${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  const left = a.y === b.y ? `${a.d} ${MONTHS[a.m - 1]}` : `${a.d} ${MONTHS[a.m - 1]} ${a.y}`;
  return `${left} to ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
}

/** Axis / table label for a timeseries bucket. */
export function bucketLabel(b: { bucket: string; start: string; end: string }, grain: StatsGrain): string {
  if (grain === "day") return shortDate(b.start);
  if (grain === "month") {
    const { y, m } = parts(b.bucket);
    return `${MONTHS[m - 1]} ${y}`;
  }
  return b.start === b.end ? dayMonth(b.start) : `${dayMonth(b.start)} to ${dayMonth(b.end)}`;
}
/** Short tick under a bar: "25" (day), "19 Oct" (week), "Oct" (month). */
export function bucketTick(b: { bucket: string; start: string }, grain: StatsGrain): string {
  const { m, d } = parts(b.start);
  if (grain === "day") return String(d);
  if (grain === "week") return dayMonth(b.start);
  return MONTHS[parts(b.bucket).m - 1] ?? String(m);
}

/** "13:00 to 14:00" */
export function hourLabel(h: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:00 to ${pad((h + 1) % 24)}:00`;
}

/* ---- numbers ---------------------------------------------------------------------------------------------- */

const countFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });
export function formatCount(n: number): string {
  return countFmt.format(n);
}

/** "12.4%" (one decimal, as the database rounds). */
export function formatPct(n: number): string {
  return `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1, minimumFractionDigits: n % 1 === 0 ? 0 : 1 }).format(n)}%`;
}

export type Change = { dir: "up" | "down" | "same" | "none"; text: string };

/**
 * Change vs the compare period, as words (never colour alone): "Up 12.4% on previous period", "Down 3%",
 * "Same as previous period", or why there is no figure.
 */
export function changeOf(m: StatsMetric, hasCompare: boolean): Change {
  if (!hasCompare) return { dir: "none", text: "No comparison" };
  if (m.changePct === null) {
    if (m.compare === 0 && (m.value ?? 0) > 0) return { dir: "none", text: "New: none in previous period" };
    if (m.compare === 0 || m.compare === null) return { dir: "none", text: "None in previous period either" };
    return { dir: "none", text: "No comparison" };
  }
  if (m.changePct === 0) return { dir: "same", text: "Same as previous period" };
  const dir = m.changePct > 0 ? "up" : "down";
  return { dir, text: `${dir === "up" ? "Up" : "Down"} ${formatPct(Math.abs(m.changePct))} on previous period` };
}

/** Axis maximum: a round number at or above `max` (1, 2, 2.5, 5 x 10^n), and its tick step for 4 gridlines. */
export function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (!(max > 0)) return { top: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = nice * mag;
  return { top: step * ticks, step };
}

/** Short money for chart axes, from paisa: "Rs. 0", "Rs. 500", "Rs. 25k", "Rs. 1.2 lakh". Tables use formatNpr. */
export function axisMoney(paisa: number): string {
  const r = paisa / 100;
  if (r === 0) return "Rs. 0";
  if (r >= 100_000) return `Rs. ${countFmt.format(Math.round(r / 10_000) / 10)} lakh`;
  if (r >= 1_000) return `Rs. ${countFmt.format(Math.round(r / 100) / 10)}k`;
  return `Rs. ${countFmt.format(Math.round(r))}`;
}

/** Show every n-th tick so labels never collide (about `fit` labels across the chart). */
export function tickEvery(count: number, fit: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, fit)));
}

/** 0 = none, 1 = some, 2 = more, 3 = busiest band. Lightness steps of one colour, plus the number in the cell. */
export function heatLevel(n: number, max: number): 0 | 1 | 2 | 3 {
  if (n <= 0 || max <= 0) return 0;
  const f = n / max;
  return f > 0.66 ? 3 : f > 0.33 ? 2 : 1;
}

/** Hours to draw in the heatmap: at least 8:00 to 21:00, wider when orders came in earlier or later. */
export function hourSpan(cells: { hour: number; orders: number }[]): number[] {
  let lo = 8;
  let hi = 21;
  for (const c of cells) {
    if (c.orders > 0) {
      lo = Math.min(lo, c.hour);
      hi = Math.max(hi, c.hour);
    }
  }
  const out: number[] = [];
  for (let h = lo; h <= hi; h++) out.push(h);
  return out;
}

/** Owner-facing reason names: the orders board's wording (one vocabulary across admin). */
export const REASON_LABEL: Record<CancelReason, string> = CANCEL_REASON_LABEL as Record<CancelReason, string>;
export const REASON_ORDER: CancelReason[] = ["customer_request", "auto_unconfirmed", "no_show", "refused", "unreachable", "out_of_stock", "fake", "other"];

/** "Rs. 1,240 more than logged" / "Rs. 300 less than logged" / "Matches the logged food" */
export function tillDiffText(diffPaisa: number, fmt: (p: number) => string): string {
  if (diffPaisa === 0) return "Matches the logged food";
  return `${fmt(Math.abs(diffPaisa))} ${diffPaisa > 0 ? "more" : "less"} than logged`;
}

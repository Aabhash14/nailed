"use client";

import { Fragment, useId, useState, type ReactNode } from "react";
import { formatNpr } from "@/lib/money";
import type { StatsGrain, StatsHeatmapCell, StatsTimeseriesBucket } from "@/lib/stats/types";
import { axisMoney, bucketLabel, bucketTick, formatCount, heatLevel, hourLabel, niceScale, tickEvery, WEEKDAY_LONG, WEEKDAY_SHORT } from "./stats-logic";

/**
 * Hand-rolled charts for the owner Stats page. No chart library (Worker bundle limit): plain HTML/CSS bars, theme
 * tokens only. Every chart is decorative for assistive tech (aria-hidden) and comes with a title, a one-line text
 * summary and a data table: visually hidden by default, shown with "Show as table".
 */

/* Series fills. Food = solid brick (dark). Merch = marigold with diagonal stripes (light). They differ in lightness
   and in pattern, so they read apart without hue, in greyscale and for colour-blind owners. */
export const FOOD_FILL = "bg-primary";
export const MERCH_FILL =
  "bg-accent bg-[repeating-linear-gradient(135deg,transparent_0_3px,color-mix(in_srgb,var(--color-surface-raised)_45%,transparent)_3px_6px)]";

export function Swatch({ fill, label }: { fill: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span aria-hidden="true" className={`border-ink/40 inline-block h-3.5 w-5 border ${fill}`} />
      {label}
    </span>
  );
}

/** Card with a title, a summary line, the chart, and the same data as a table (hidden until asked for). */
export function ChartFrame({
  title,
  summary,
  legend,
  table,
  children,
  headingLevel = 2,
}: {
  title: string;
  summary: ReactNode;
  legend?: ReactNode;
  table?: ReactNode;
  children: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={`${id}-t`} className="border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <H id={`${id}-t`} className={headingLevel === 2 ? "font-display text-xl" : "text-lg font-semibold"}>
          {title}
        </H>
        {table ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${id}-tbl`}
            onClick={() => setOpen((o) => !o)}
            className="min-h-tap text-primary -my-2 font-semibold underline-offset-4 hover:underline"
          >
            {open ? "Show as chart" : "Show as table"}
          </button>
        ) : null}
      </div>
      <p className="text-ink-muted text-sm">{summary}</p>
      {legend ? <div className="flex flex-wrap gap-x-5 gap-y-1">{legend}</div> : null}
      {open ? null : children}
      {table ? (
        // BUG-020: an open, horizontally scrollable table must be reachable and named for keyboard users.
        <div
          id={`${id}-tbl`}
          className={open ? "focus-visible:outline-primary overflow-x-auto rounded-control focus-visible:outline-2 focus-visible:outline-offset-2" : "sr-only"}
          {...(open ? { tabIndex: 0, role: "region", "aria-label": `${title} as a table` } : {})}
        >
          {table}
        </div>
      ) : null}
    </section>
  );
}

/** Plain data table with tabular figures (used inside ChartFrame). */
export function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <table className="w-full min-w-[20rem] border-collapse text-sm tabular-nums">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-line-strong border-b text-left">
          {head.map((h, i) => (
            <th key={h} scope="col" className={`py-2 pr-3 font-semibold ${i > 0 ? "text-right" : ""}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-line border-b last:border-b-0">
            {r.map((c, j) =>
              j === 0 ? (
                <th key={j} scope="row" className="py-2 pr-3 text-left font-normal">
                  {c}
                </th>
              ) : (
                <td key={j} className="py-2 pr-3 text-right">
                  {c}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Stacked bars: food (bottom) + merch (top) earnings per bucket, with a money axis. */
export function EarningsBars({ buckets, grain }: { buckets: StatsTimeseriesBucket[]; grain: StatsGrain }) {
  const max = Math.max(0, ...buckets.map((b) => b.totalRevenuePaisa));
  const { top, step } = niceScale(max);
  const gridlines = [0, 1, 2, 3, 4].map((i) => i * step);
  const every = tickEvery(buckets.length, grain === "week" ? 6 : 10);
  // Many buckets (a long custom range by day): keep bars at least 6 px wide and let the plot scroll sideways.
  const minPlot = buckets.length > 40 ? `${buckets.length * 8}px` : undefined;
  return (
    <div aria-hidden="true" className="grid grid-cols-[auto_1fr] gap-x-2">
      {/* y axis */}
      <div className="relative h-48 w-14 text-right text-xs tabular-nums md:h-56">
        {gridlines.map((g) => (
          <span key={g} className="text-ink-muted absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${100 - (g / top) * 100}%` }}>
            {axisMoney(g)}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto pb-1">
        <div style={{ minWidth: minPlot }}>
          <div className="relative h-48 md:h-56">
            {gridlines.map((g) => (
              <div key={g} className={`absolute inset-x-0 border-t ${g === 0 ? "border-ink" : "border-line border-dashed"}`} style={{ top: `${100 - (g / top) * 100}%` }} />
            ))}
            <div className="absolute inset-0 flex items-end gap-[2px] md:gap-1">
              {buckets.map((b) => {
                const food = (b.foodRevenuePaisa / top) * 100;
                const merch = (b.merchRevenuePaisa / top) * 100;
                return (
                  <div
                    key={b.bucket}
                    title={`${bucketLabel(b, grain)}: food ${formatNpr(b.foodRevenuePaisa)}, merch ${formatNpr(b.merchRevenuePaisa)}`}
                    className="flex h-full min-w-[4px] flex-1 flex-col justify-end"
                  >
                    {merch > 0 ? <div className={`${MERCH_FILL} border-ink/30 border-x border-t`} style={{ height: `${merch}%` }} /> : null}
                    {food > 0 ? <div className={`${FOOD_FILL} ${merch > 0 ? "border-surface-raised border-t" : ""}`} style={{ height: `${food}%` }} /> : null}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-1 flex gap-[2px] md:gap-1">
            {buckets.map((b, i) => (
              <span key={b.bucket} className="text-ink-muted min-w-[4px] flex-1 overflow-visible text-center text-xs whitespace-nowrap tabular-nums">
                {i % every === 0 ? bucketTick(b, grain) : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export type BarRow = { key: string; label: ReactNode; detail?: ReactNode; value: number; valueText: string };

/**
 * Horizontal bars as an ordered list. The label and the value are text, so the list itself is the accessible data;
 * the bar is decoration (aria-hidden).
 */
export function BarList({ rows, fill = FOOD_FILL, ordered = true, label }: { rows: BarRow[]; fill?: string; ordered?: boolean; label?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const List = ordered ? "ol" : "ul";
  return (
    <List aria-label={label} className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 font-semibold break-words">{r.label}</span>
            <span className="shrink-0 text-right tabular-nums">{r.valueText}</span>
          </div>
          <div aria-hidden="true" className="bg-surface-alt h-2.5 w-full">
            <div className={`h-full ${fill}`} style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, (r.value / max) * 100)}%` }} />
          </div>
          {r.detail ? <p className="text-ink-muted text-sm tabular-nums">{r.detail}</p> : null}
        </li>
      ))}
    </List>
  );
}

const HEAT_FILL = ["bg-surface", "bg-primary/25 text-ink", "bg-primary/50 text-ink", "bg-primary text-on-primary"] as const;

/**
 * Weekday x hour grid of merch orders placed. Shade (one colour, lighter to darker) AND the count in each cell.
 * Wide screens: days down, hours across. Phones: transposed (7 day columns, hours down), so every cell keeps room
 * for its number without sideways scrolling.
 */
export function Heatmap({ cells, hours }: { cells: StatsHeatmapCell[]; hours: number[] }) {
  const max = Math.max(0, ...cells.map((c) => c.orders));
  const at = (wd: number, h: number) => cells.find((c) => c.weekday === wd && c.hour === h)?.orders ?? 0;
  const labelEvery = hours.length > 12 ? 2 : 1;
  const days = [0, 1, 2, 3, 4, 5, 6];
  return (
    <div aria-hidden="true" className="space-y-3">
      {/* phones: hours down, days across */}
      <div className="grid gap-[2px] md:hidden" style={{ gridTemplateColumns: "3rem repeat(7, minmax(0, 1fr))" }}>
        <span />
        {days.map((wd) => (
          <span key={wd} className="text-center text-xs font-semibold">
            {WEEKDAY_SHORT[wd]}
          </span>
        ))}
        {hours.map((h) => (
          <Fragment key={h}>
            <span className="text-ink-muted self-center text-xs tabular-nums">{`${String(h).padStart(2, "0")}:00`}</span>
            {days.map((wd) => (
              <Cell key={wd} wd={wd} h={h} n={at(wd, h)} max={max} className="h-7" />
            ))}
          </Fragment>
        ))}
      </div>
      {/* tablet and up: days down, hours across */}
      <div className="hidden gap-[2px] md:grid" style={{ gridTemplateColumns: `2.5rem repeat(${hours.length}, minmax(0, 1fr))` }}>
        <span />
        {hours.map((h, i) => (
          <span key={h} className="text-ink-muted text-center text-xs tabular-nums">
            {i % labelEvery === 0 ? h : ""}
          </span>
        ))}
        {days.map((wd) => (
          <Fragment key={wd}>
            <span className="self-center text-xs font-semibold">{WEEKDAY_SHORT[wd]}</span>
            {hours.map((h) => (
              <Cell key={h} wd={wd} h={h} n={at(wd, h)} max={max} className="aspect-square min-h-6" />
            ))}
          </Fragment>
        ))}
      </div>
      <p className="text-ink-muted text-xs md:hidden">Hours are Kathmandu time; each row is one hour from the time shown.</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-ink-muted">Orders in the hour:</span>
        {(["None", "Some", "More", "Busiest"] as const).map((t, i) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span className={`border-line-strong inline-block h-4 w-4 border ${HEAT_FILL[i]}`} />
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function Cell({ wd, h, n, max, className }: { wd: number; h: number; n: number; max: number; className: string }) {
  return (
    <span
      title={`${WEEKDAY_LONG[wd]} ${hourLabel(h)}: ${n} ${n === 1 ? "order" : "orders"}`}
      className={`border-line grid place-items-center border text-xs font-semibold tabular-nums ${HEAT_FILL[heatLevel(n, max)]} ${className}`}
    >
      {n > 0 ? formatCount(n) : ""}
    </span>
  );
}

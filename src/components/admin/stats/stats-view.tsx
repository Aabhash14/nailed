"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button, LinkButton } from "@/components/ui/button";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { CheckField } from "@/components/ui/field";
import { adminApi } from "@/data-access/admin";
import { formatNpr } from "@/lib/money";
import { addDays, daysInclusive, kathmanduToday, type DateRange } from "@/lib/stats/dates";
import type { StatsBundle, StatsMetric } from "@/lib/stats/types";
import { useAdminSession } from "../admin-shell";
import { BarList, ChartFrame, DataTable, EarningsBars, FOOD_FILL, Heatmap, MERCH_FILL, Swatch } from "./charts";
import { TableOrdersCard } from "./table-orders-card";
import {
  bucketLabel,
  changeOf,
  compareRangeFor,
  customRangeProblem,
  formatCount,
  formatPct,
  GRAIN_LABEL,
  grainFor,
  hourLabel,
  hourSpan,
  parseQuery,
  PRESET_LABEL,
  PRESET_ORDER,
  rangeFor,
  rangeLabel,
  REASON_LABEL,
  REASON_ORDER,
  serializeQuery,
  shortDate,
  tillDiffText,
  WEEKDAY_LONG,
  type GrainChoice,
  type StatsQuery,
} from "./stats-logic";

type Load = { state: "idle" | "loading" } | { state: "error"; message: string } | { state: "ok"; data: StatsBundle };

/** Owner dashboard: earnings, best sellers, busy times, cancellations and stock alerts (Kathmandu dates, NPR). */
export function StatsView() {
  const { role } = useAdminSession();
  if (role !== "owner") {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Stats</h1>
        <Banner tone="info" title="Owner only">
          Earnings and sales stats are for the owner. You can still log today&apos;s food sales.
        </Banner>
        <LinkButton href="/admin/sales" variant="secondary">
          Log today&apos;s sales
        </LinkButton>
      </div>
    );
  }
  return <OwnerStats />;
}

function OwnerStats() {
  const [query, setQuery] = useState<StatsQuery | null>(null);
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const reqId = useRef(0);

  // Controls come from the address bar (reload / share keeps the view); read after mount, the page is client-only.
  useEffect(() => {
    setQuery(parseQuery(window.location.search, kathmanduToday()));
  }, []);

  const fetchStats = useCallback(async (q: StatsQuery) => {
    const r = rangeFor(q, new Date());
    const id = ++reqId.current;
    setLoad({ state: "loading" });
    try {
      const res = await adminApi.getStats({
        from: r.from,
        to: r.to,
        compare: q.compare ? "previous" : "none",
        ...(q.grain === "auto" ? {} : { grain: q.grain }),
      });
      if (id !== reqId.current) return; // a newer request has started
      if (!res.ok) {
        setLoad({ state: "error", message: res.error.message });
        return;
      }
      setLoad({ state: "ok", data: res.data });
    } catch {
      if (id === reqId.current) setLoad({ state: "error", message: "Could not load the stats. Check the connection and try again." });
    }
  }, []);

  useEffect(() => {
    if (!query) return;
    window.history.replaceState(null, "", `${window.location.pathname}?${serializeQuery(query)}`);
    void fetchStats(query);
  }, [query, fetchStats]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Stats</h1>
        <p className="text-ink-muted">Earnings, best sellers and busy times. Dates and hours are Kathmandu time; amounts in rupees.</p>
      </div>

      {query ? <Controls query={query} onChange={setQuery} /> : <Skeleton className="h-40 w-full" />}

      <div aria-live="polite" className="sr-only">
        {load.state === "loading" ? "Loading stats" : load.state === "ok" ? `Showing ${rangeLabel(load.data.range.from, load.data.range.to)}` : ""}
      </div>

      {load.state === "error" ? (
        <Banner tone="danger" live="alert" title="Could not load the stats">
          {load.message}{" "}
          <Button variant="ghost" onClick={() => query && void fetchStats(query)}>
            Try again
          </Button>
        </Banner>
      ) : null}

      {load.state === "loading" || load.state === "idle" ? <LoadingStats /> : null}

      {load.state === "ok" ? <Dashboard data={load.data} /> : null}
    </div>
  );
}

/* ---- controls -------------------------------------------------------------------------------------------- */

function Controls({ query, onChange }: { query: StatsQuery; onChange: (q: StatsQuery) => void }) {
  const today = kathmanduToday();
  const r = query.preset === "custom" ? { from: query.from, to: query.to } : rangeFor(query, new Date());
  const [custom, setCustom] = useState<DateRange>(() => (query.preset === "custom" ? r : { from: addDays(today, -13), to: today }));
  const [showCustom, setShowCustom] = useState(query.preset === "custom");
  const [customError, setCustomError] = useState<string | null>(null);
  const id = useId();

  const cmp = r.from && r.to ? compareRangeFor({ ...query, compare: true }, r) : null;
  const grainUsed = grainFor(query, r);

  function pick(preset: StatsQuery["preset"]) {
    if (preset === "custom") {
      setShowCustom(true);
      return;
    }
    setShowCustom(false);
    setCustomError(null);
    onChange({ ...query, preset, from: "", to: "" });
  }

  function applyCustom(e: FormEvent) {
    e.preventDefault();
    const problem = customRangeProblem(custom.from, custom.to, today);
    setCustomError(problem);
    if (!problem) onChange({ ...query, preset: "custom", from: custom.from, to: custom.to });
  }

  const selected = showCustom ? "custom" : query.preset;

  return (
    <section aria-label="Choose the dates" className="border-line bg-surface-raised rounded-card shadow-card space-y-4 border p-4 md:p-5">
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Date range</legend>
        <div className="flex flex-wrap gap-2">
          {PRESET_ORDER.map((p) => (
            <Chip key={p} name={`${id}-range`} checked={selected === p} onChange={() => pick(p)} label={PRESET_LABEL[p]} />
          ))}
        </div>
      </fieldset>

      {showCustom ? (
        <form onSubmit={applyCustom} noValidate className="flex flex-wrap items-end gap-3">
          <DateInput label="From" value={custom.from} max={today} onChange={(v) => setCustom((c) => ({ ...c, from: v }))} invalid={!!customError} errId={`${id}-cerr`} />
          <DateInput label="To" value={custom.to} max={today} onChange={(v) => setCustom((c) => ({ ...c, to: v }))} invalid={!!customError} errId={`${id}-cerr`} />
          <Button type="submit">Show these dates</Button>
          {customError ? (
            <p id={`${id}-cerr`} role="alert" className="text-danger w-full text-sm font-semibold">
              {customError}
            </p>
          ) : null}
        </form>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <CheckField
          label="Compare to previous period"
          hint={cmp ? `${rangeLabel(cmp.from, cmp.to)} (same number of days, just before)` : "Shows the change in each figure"}
          checked={query.compare}
          onChange={(e) => onChange({ ...query, compare: e.currentTarget.checked })}
        />
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Chart by</legend>
          <div className="flex flex-wrap gap-2">
            {(["auto", "day", "week", "month"] as GrainChoice[]).map((g) => (
              <Chip
                key={g}
                name={`${id}-grain`}
                checked={query.grain === g}
                onChange={() => onChange({ ...query, grain: g })}
                label={g === "auto" ? `Auto (${GRAIN_LABEL[grainFor({ ...query, grain: "auto" }, r)].toLowerCase()})` : GRAIN_LABEL[g]}
              />
            ))}
          </div>
        </fieldset>
      </div>

      {r.from && r.to ? (
        <p className="border-line border-t pt-3 text-sm">
          <span className="font-semibold">Showing {rangeLabel(r.from, r.to)}</span>
          <span className="text-ink-muted">
            {" "}
            ({formatCount(daysInclusive(r.from, r.to))} {daysInclusive(r.from, r.to) === 1 ? "day" : "days"}, chart by {grainUsed}
            {grainUsed === "week" ? ", weeks start on Sunday" : ""})
          </span>
        </p>
      ) : null}
    </section>
  );
}

/** Radio styled as a chip: native radio keyboard behaviour (arrow keys), 44 px tall, checked = filled + bold. */
function Chip({ name, checked, onChange, label }: { name: string; checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="relative cursor-pointer">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="peer sr-only" />
      <span className="min-h-tap rounded-control border-line-strong text-ink peer-checked:bg-primary peer-checked:text-on-primary peer-checked:border-primary peer-focus-visible:outline-primary inline-flex items-center gap-1.5 border px-3 font-semibold transition-colors duration-(--motion-base) peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 hover:border-ink">
        {checked ? (
          <span aria-hidden="true" className="text-xs">
            ◆
          </span>
        ) : null}
        {label}
      </span>
    </label>
  );
}

function DateInput({ label, value, max, onChange, invalid, errId }: { label: string; value: string; max: string; onChange: (v: string) => void; invalid: boolean; errId: string }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        type="date"
        value={value}
        max={max}
        min="2020-01-01"
        onChange={(e) => onChange(e.currentTarget.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errId : undefined}
        className="min-h-tap rounded-control border-line-strong bg-surface text-ink hover:border-ink focus-visible:border-primary border px-3 py-2 text-base tabular-nums aria-[invalid=true]:border-danger"
      />
    </div>
  );
}

/* ---- loading ------------------------------------------------------------------------------------------- */

function LoadingStats() {
  return (
    <div aria-busy="true" aria-label="Loading stats" className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

/* ---- dashboard ---------------------------------------------------------------------------------------------- */

function Dashboard({ data }: { data: StatsBundle }) {
  const o = data.overview;
  // 1.5.1: the bundle counts the days in range logged with the note "DEMO DATA" (no extra getDailySales call).
  const demo = data.range.demoDataDays > 0;
  const hasCmp = data.range.compareFrom !== null;
  const nothing =
    (o.totalRevenuePaisa.value ?? 0) === 0 &&
    (o.foodDaysLogged.value ?? 0) === 0 &&
    data.cancellations.ordersPlaced === 0 &&
    (o.merchOrders.value ?? 0) === 0;

  return (
    <div className="space-y-5">
      {demo ? (
        <Banner tone="warning" title="Demo data">
          The food numbers in this range come from made-up sample logs marked &ldquo;DEMO DATA&rdquo;, not real sales. Remove them before
          trusting these figures.
        </Banner>
      ) : null}

      {nothing ? (
        <EmptyState title="Nothing recorded for these dates" action={<LinkButton href="/admin/sales">Log food sales</LinkButton>}>
          No food sales were logged and no shop orders came in between {rangeLabel(data.range.from, data.range.to)}. Pick other dates,
          or log a day&apos;s food sales at closing.
        </EmptyState>
      ) : (
        <>
          <Kpis data={data} hasCmp={hasCmp} />
          <EarningsSection data={data} />
          <div className="grid gap-5 lg:grid-cols-2">
            <TopFood data={data} />
            <TopMerch data={data} />
          </div>
          <BestFoodPerDay data={data} />
          {/* 2.0.0: dine-in rounds, a separate block next to (never inside) the daily-log figures */}
          <TableOrdersCard data={data} />
          <Busiest data={data} />
          <div className="grid gap-5 lg:grid-cols-2">
            <Cancellations data={data} />
            <StockAlerts data={data} />
          </div>
        </>
      )}
      {nothing ? <StockAlerts data={data} /> : null}
    </div>
  );
}

function Kpis({ data, hasCmp }: { data: StatsBundle; hasCmp: boolean }) {
  const o = data.overview;
  const days = daysInclusive(data.range.from, data.range.to);
  const logged = o.foodDaysLogged.value ?? 0;
  const tillDays = o.foodTillDays.value ?? 0;
  const till = o.foodTillTotalPaisa.value ?? 0;
  const food = o.foodRevenuePaisa.value ?? 0;
  const cmpLabel = hasCmp && data.range.compareFrom && data.range.compareTo ? rangeLabel(data.range.compareFrom, data.range.compareTo) : null;
  return (
    <section aria-labelledby="kpi-h" className="space-y-3">
      <h2 id="kpi-h" className="sr-only">
        Totals
      </h2>
      {cmpLabel ? <p className="text-ink-muted text-sm">Changes are against {cmpLabel}.</p> : null}
      <ul className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:grid-cols-3">
        <Kpi label="Total earnings" metric={o.totalRevenuePaisa} money hasCmp={hasCmp} note="Food logged + shop orders completed" />
        <Kpi
          label="Food earnings"
          metric={o.foodRevenuePaisa}
          money
          hasCmp={hasCmp}
          note={
            <>
              Logged on {formatCount(logged)} of {formatCount(days)} {days === 1 ? "day" : "days"}
              {tillDays > 0 ? (
                <>
                  <br />
                  Till total {formatNpr(till)} on {formatCount(tillDays)} {tillDays === 1 ? "day" : "days"}
                  {tillDays === logged ? <>: {tillDiffText(till - food, formatNpr)}</> : " (not every logged day has one)"}
                </>
              ) : null}
            </>
          }
        />
        <Kpi label="Merch earnings" metric={o.merchRevenuePaisa} money hasCmp={hasCmp} note="Completed shop orders, delivery included" />
        <Kpi label="Merch orders" metric={o.merchOrders} hasCmp={hasCmp} note="Completed in these dates" />
        <Kpi label="Average merch order" metric={o.avgMerchOrderPaisa} money hasCmp={hasCmp} empty="No orders" />
        <Kpi label="Food items sold" metric={o.foodItemsSold} hasCmp={hasCmp} note={logged > 0 ? `About ${formatCount(Math.round(((o.foodItemsSold.value ?? 0) / logged) * 10) / 10)} a logged day` : undefined} />
      </ul>
    </section>
  );
}

function Kpi({
  label,
  metric,
  money = false,
  hasCmp,
  note,
  empty = "None",
}: {
  label: string;
  metric: StatsMetric;
  money?: boolean;
  hasCmp: boolean;
  note?: ReactNode;
  empty?: string;
}) {
  const fmt = (n: number) => (money ? formatNpr(Math.round(n)) : formatCount(n));
  const ch = changeOf(metric, hasCmp);
  const arrow = ch.dir === "up" ? "▲" : ch.dir === "down" ? "▼" : ch.dir === "same" ? "=" : "";
  const tone = ch.dir === "up" ? "text-success" : ch.dir === "down" ? "text-danger" : "text-ink-muted";
  return (
    <li className="border-line bg-surface-raised rounded-card shadow-card flex min-w-0 flex-col gap-1 border p-3 sm:p-4">
      <p className="text-ink-muted text-sm font-semibold">{label}</p>
      <p className="text-xl leading-tight font-semibold tabular-nums sm:text-2xl md:text-3xl">{metric.value === null ? empty : fmt(metric.value)}</p>
      <p className={`text-sm font-semibold ${tone}`}>
        {arrow ? (
          <span aria-hidden="true" className="mr-1">
            {arrow}
          </span>
        ) : null}
        {ch.text}
      </p>
      {hasCmp && metric.compare !== null ? <p className="text-ink-muted text-sm tabular-nums">Previous: {fmt(metric.compare)}</p> : null}
      {note ? <p className="text-ink-muted text-sm tabular-nums">{note}</p> : null}
    </li>
  );
}

function EarningsSection({ data }: { data: StatsBundle }) {
  const ts = data.timeseries;
  const buckets = ts.buckets;
  const best = buckets.reduce<(typeof buckets)[number] | null>((a, b) => (!a || b.totalRevenuePaisa > a.totalRevenuePaisa ? b : a), null);
  const food = buckets.reduce((s, b) => s + b.foodRevenuePaisa, 0);
  const merch = buckets.reduce((s, b) => s + b.merchRevenuePaisa, 0);
  const total = food + merch;
  const unit = ts.grain === "day" ? "day" : ts.grain === "week" ? "week" : "month";
  const summary =
    total === 0
      ? "No earnings in these dates."
      : `${formatNpr(total)} in total: food ${formatPct(Math.round((food / total) * 1000) / 10)}, merch ${formatPct(Math.round((merch / total) * 1000) / 10)}. ` +
        (best && best.totalRevenuePaisa > 0 ? `Best ${unit}: ${bucketLabel(best, ts.grain)}, ${formatNpr(best.totalRevenuePaisa)}.` : "");
  return (
    <ChartFrame
      title="Earnings over time"
      summary={summary}
      legend={
        <>
          <Swatch fill={FOOD_FILL} label="Food (solid)" />
          <Swatch fill={MERCH_FILL} label="Merch (striped, on top)" />
        </>
      }
      table={
        <DataTable
          caption={`Earnings by ${unit}`}
          head={[unit[0]!.toUpperCase() + unit.slice(1), "Food", "Merch", "Total", "Merch orders"]}
          rows={buckets.map((b) => [
            `${bucketLabel(b, ts.grain)}${b.partial ? " (part)" : ""}`,
            formatNpr(b.foodRevenuePaisa),
            formatNpr(b.merchRevenuePaisa),
            formatNpr(b.totalRevenuePaisa),
            formatCount(b.merchOrders),
          ])}
        />
      }
    >
      <EarningsBars buckets={buckets} grain={ts.grain} />
      {buckets.some((b) => b.partial) ? <p className="text-ink-muted text-sm">The first or last {unit} is only partly inside these dates.</p> : null}
    </ChartFrame>
  );
}

/** Two-tab switch (quantity / earnings): real tabs with arrow-key movement. */
function Tabs<K extends string>({ label, tabs, value, onChange, idBase }: { label: string; tabs: [K, string][]; value: K; onChange: (k: K) => void; idBase: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(e: KeyboardEvent, i: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const n = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    onChange(tabs[n]![0]);
    refs.current[n]?.focus();
  }
  return (
    <div role="tablist" aria-label={label} className="border-line flex gap-1 border-b">
      {tabs.map(([k, t], i) => (
        <button
          key={k}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${k}`}
          aria-selected={value === k}
          aria-controls={`${idBase}-panel`}
          tabIndex={value === k ? 0 : -1}
          onClick={() => onChange(k)}
          onKeyDown={(e) => onKey(e, i)}
          className={`min-h-tap -mb-px border-b-[3px] px-3 font-semibold ${value === k ? "border-primary text-ink" : "text-ink-muted hover:text-ink border-transparent"}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function TopFood({ data }: { data: StatsBundle }) {
  const [by, setBy] = useState<"qty" | "revenue">("qty");
  const id = useId();
  const list = by === "qty" ? data.topFood.byQty : data.topFood.byRevenue;
  const lead = list[0];
  return (
    <section aria-labelledby={`${id}-h`} className="border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4 md:p-5">
      <h2 id={`${id}-h`} className="font-display text-xl">
        Top food
      </h2>
      <p className="text-ink-muted text-sm">
        {lead
          ? `${lead.name} leads ${by === "qty" ? `with ${formatCount(lead.qty)} sold` : `with ${formatNpr(lead.revenuePaisa)}`}. Options are counted with their item.`
          : "No food logged in these dates."}
      </p>
      <Tabs
        label="Rank top food by"
        idBase={id}
        value={by}
        onChange={setBy}
        tabs={[
          ["qty", "By quantity"],
          ["revenue", "By earnings"],
        ]}
      />
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${by}`}>
        {list.length === 0 ? (
          <p className="text-ink-muted py-4">Nothing to rank yet. Food appears here once sales are logged for these dates.</p>
        ) : (
          <BarList
            label={by === "qty" ? "Top food by quantity" : "Top food by earnings"}
            rows={list.map((r) => ({
              key: r.menuItemId,
              label: (
                <>
                  <span className="text-ink-muted mr-1.5 tabular-nums">{r.rank}.</span>
                  {r.name}
                  {r.isDeleted ? <span className="text-ink-muted font-normal"> (no longer on the menu)</span> : null}
                </>
              ),
              value: by === "qty" ? r.qty : r.revenuePaisa,
              valueText: by === "qty" ? `${formatCount(r.qty)} sold` : formatNpr(r.revenuePaisa),
              detail: by === "qty" ? formatNpr(r.revenuePaisa) : `${formatCount(r.qty)} sold`,
            }))}
          />
        )}
      </div>
    </section>
  );
}

function TopMerch({ data }: { data: StatsBundle }) {
  const [by, setBy] = useState<"product" | "variant">("product");
  const id = useId();
  const tm = data.topMerch;
  const lead = tm.byProduct[0];
  return (
    <section aria-labelledby={`${id}-h`} className="border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4 md:p-5">
      <h2 id={`${id}-h`} className="font-display text-xl">
        Top merch
      </h2>
      <p className="text-ink-muted text-sm">
        {lead ? `${lead.name} sold the most: ${formatCount(lead.qty)} ${lead.qty === 1 ? "piece" : "pieces"} in completed orders.` : "No completed shop orders in these dates."}
      </p>
      <Tabs
        label="Show top merch by"
        idBase={id}
        value={by}
        onChange={setBy}
        tabs={[
          ["product", "By product"],
          ["variant", "By size and colour"],
        ]}
      />
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${by}`}>
        {(by === "product" ? tm.byProduct.length : tm.byVariant.length) === 0 ? (
          <p className="text-ink-muted py-4">Nothing sold yet in these dates.</p>
        ) : (
          <BarList
            fill={MERCH_FILL}
            label={by === "product" ? "Top merch by product" : "Top merch by size and colour"}
            rows={
              by === "product"
                ? tm.byProduct.map((r) => ({
                    key: r.productId,
                    label: (
                      <>
                        <span className="text-ink-muted mr-1.5 tabular-nums">{r.rank}.</span>
                        {r.name}
                      </>
                    ),
                    value: r.qty,
                    valueText: `${formatCount(r.qty)} sold`,
                    detail: formatNpr(r.revenuePaisa),
                  }))
                : tm.byVariant.map((r) => ({
                    key: r.variantId,
                    label: (
                      <>
                        <span className="text-ink-muted mr-1.5 tabular-nums">{r.rank}.</span>
                        {r.productName}, {r.size} / {r.colour}
                      </>
                    ),
                    value: r.qty,
                    valueText: `${formatCount(r.qty)} sold`,
                    detail: formatNpr(r.revenuePaisa),
                  }))
            }
          />
        )}
      </div>
    </section>
  );
}

const BEST_DAYS_SHOWN = 14;

/** Averages to whole rupees: "Rs. 46,577 a day" reads better than "Rs. 46,576.67". */
const roundRupees = (paisa: number) => Math.round(paisa / 100) * 100;

function BestFoodPerDay({ data }: { data: StatsBundle }) {
  const [all, setAll] = useState(false);
  const id = useId();
  const days = [...data.bestFoodPerDay.days].reverse(); // newest first
  const shown = all ? days : days.slice(0, BEST_DAYS_SHOWN);
  const notLogged = days.filter((d) => !d.logged).length;
  return (
    <section aria-labelledby={`${id}-h`} className="border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4 md:p-5">
      <h2 id={`${id}-h`} className="font-display text-xl">
        Best food each day
      </h2>
      <p className="text-ink-muted text-sm">
        The item sold most each day, newest first.{" "}
        {notLogged > 0 ? `${formatCount(notLogged)} of ${formatCount(days.length)} ${days.length === 1 ? "day was" : "days were"} not logged.` : "Every day was logged."}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm tabular-nums md:text-base">
          <caption className="sr-only">Best-selling food item per day</caption>
          <thead>
            <tr className="border-line-strong border-b text-left">
              <th scope="col" className="py-2 pr-3 font-semibold">
                Date
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                Item
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">
                Qty
              </th>
              <th scope="col" className="py-2 text-right font-semibold">
                Earnings
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.date} className={`border-line border-b last:border-b-0 ${d.logged ? "" : "text-ink-muted"}`}>
                <th scope="row" className="py-2 pr-3 text-left font-normal whitespace-nowrap">
                  {shortDate(d.date)}
                </th>
                {!d.logged ? (
                  <td colSpan={3} className="py-2 italic">
                    Not logged
                  </td>
                ) : d.name === null ? (
                  <td colSpan={3} className="py-2">
                    Logged, nothing sold
                  </td>
                ) : (
                  <>
                    <td className="py-2 pr-3 font-semibold">{d.name}</td>
                    <td className="py-2 pr-3 text-right">{formatCount(d.qty ?? 0)}</td>
                    <td className="py-2 text-right whitespace-nowrap">{formatNpr(d.revenuePaisa ?? 0)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {days.length > BEST_DAYS_SHOWN ? (
        <Button variant="secondary" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? `Show the latest ${BEST_DAYS_SHOWN} days` : `Show all ${formatCount(days.length)} days`}
        </Button>
      ) : null}
    </section>
  );
}

function Busiest({ data }: { data: StatsBundle }) {
  const hm = data.heatmap;
  const hours = hourSpan(hm.merch);
  const totalOrders = hm.merch.reduce((s, c) => s + c.orders, 0);
  const peak = hm.merch.reduce<(typeof hm.merch)[number] | null>((a, c) => (!a || c.orders > a.orders ? c : a), null);
  const byDay = [0, 1, 2, 3, 4, 5, 6].map((wd) => ({ wd, n: hm.merch.filter((c) => c.weekday === wd).reduce((s, c) => s + c.orders, 0) }));
  const busiestDay = byDay.reduce((a, b) => (b.n > a.n ? b : a));
  const food = [...hm.foodByWeekday].sort((a, b) => a.weekday - b.weekday);
  const foodBest = food.reduce<(typeof food)[number] | null>((a, f) => ((f.avgItemsSoldPerDay ?? -1) > (a?.avgItemsSoldPerDay ?? -1) ? f : a), null);
  return (
    <div className="space-y-5">
      <ChartFrame
        title="Busiest days and hours (shop orders)"
        summary={
          totalOrders === 0
            ? "No shop orders were placed in these dates."
            : `${formatCount(totalOrders)} shop ${totalOrders === 1 ? "order" : "orders"} placed (any outcome). Busiest hour: ${WEEKDAY_LONG[peak!.weekday]} ${hourLabel(peak!.hour)} (${formatCount(peak!.orders)}). Busiest day: ${WEEKDAY_LONG[busiestDay.wd]} (${formatCount(busiestDay.n)}).`
        }
        table={
          <DataTable
            caption="Shop orders placed by weekday and hour (hours with no orders on any day are left out)"
            head={["Day", ...hours.filter((h) => hm.merch.some((c) => c.hour === h && c.orders > 0)).map((h) => `${String(h).padStart(2, "0")}:00`), "Total"]}
            rows={[0, 1, 2, 3, 4, 5, 6].map((wd) => [
              WEEKDAY_LONG[wd],
              ...hours
                .filter((h) => hm.merch.some((c) => c.hour === h && c.orders > 0))
                .map((h) => formatCount(hm.merch.find((c) => c.weekday === wd && c.hour === h)?.orders ?? 0)),
              formatCount(byDay[wd]!.n),
            ])}
          />
        }
      >
        {totalOrders === 0 ? null : <Heatmap cells={hm.merch} hours={hours} />}
      </ChartFrame>

      <ChartFrame
        title="Food by day of the week"
        summary={
          foodBest && foodBest.avgItemsSoldPerDay !== null
            ? `${WEEKDAY_LONG[foodBest.weekday]} is the busiest for food: about ${formatCount(foodBest.avgItemsSoldPerDay)} items on an average logged day. Averages count logged days only.`
            : "No food logged in these dates."
        }
        table={
          <DataTable
            caption="Food sales by day of the week"
            head={["Day", "Days logged", "Avg items a day", "Avg earnings a day", "Items in total"]}
            rows={food.map((f) => [
              WEEKDAY_LONG[f.weekday],
              formatCount(f.daysLogged),
              f.avgItemsSoldPerDay === null ? "Not logged" : formatCount(f.avgItemsSoldPerDay),
              f.avgRevenuePaisaPerDay === null ? "Not logged" : formatNpr(roundRupees(f.avgRevenuePaisaPerDay)),
              formatCount(f.itemsSold),
            ])}
          />
        }
      >
        <BarList
          ordered={false}
          rows={food.map((f) => ({
            key: String(f.weekday),
            label: WEEKDAY_LONG[f.weekday],
            value: f.avgItemsSoldPerDay ?? 0,
            valueText: f.avgItemsSoldPerDay === null ? "Not logged" : `${formatCount(f.avgItemsSoldPerDay)} items a day`,
            detail: f.avgRevenuePaisaPerDay === null ? undefined : `${formatNpr(roundRupees(f.avgRevenuePaisaPerDay))} a day, ${formatCount(f.daysLogged)} ${f.daysLogged === 1 ? "day" : "days"} logged`,
          }))}
        />
      </ChartFrame>
    </div>
  );
}

function Cancellations({ data }: { data: StatsBundle }) {
  const c = data.cancellations;
  const id = useId();
  const reasons = REASON_ORDER.map((k) => ({ k, n: c.byReason[k] ?? 0 })).filter((r) => r.n > 0);
  return (
    <section aria-labelledby={`${id}-h`} className="border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4 md:p-5">
      <h2 id={`${id}-h`} className="font-display text-xl">
        Cancellations and no-shows
      </h2>
      {c.ordersPlaced === 0 ? (
        <p className="text-ink-muted">No shop orders were placed in these dates.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 tabular-nums">
            <Fact term="Orders placed" value={formatCount(c.ordersPlaced)} />
            <Fact term="Cancelled" value={`${formatCount(c.cancelled)}${c.cancelRatePct !== null ? ` (${formatPct(c.cancelRatePct)})` : ""}`} />
            <Fact term="Completed" value={`${formatCount(c.completed)}${c.completionRatePct !== null ? ` (${formatPct(c.completionRatePct)})` : ""}`} />
            <Fact term="Still open" value={formatCount(c.open)} />
          </dl>
          <h3 className="pt-1 font-semibold">Why orders were cancelled</h3>
          {reasons.length === 0 ? (
            <p className="text-ink-muted">No cancellations.</p>
          ) : (
            <BarList
              ordered={false}
              label="Cancellation reasons"
              rows={reasons
                .sort((a, b) => b.n - a.n)
                .map((r) => ({
                  key: r.k,
                  label: REASON_LABEL[r.k],
                  value: r.n,
                  valueText: `${formatCount(r.n)}${c.cancelled ? ` (${formatPct(Math.round((r.n / c.cancelled) * 1000) / 10)})` : ""}`,
                }))}
            />
          )}
        </>
      )}
      <p className="border-line text-ink-muted border-t pt-3 text-sm">
        <span className="text-ink font-semibold">Refused attempts: </span>
        {c.refusedAttempts.recorded ? formatCount(c.refusedAttempts.count ?? 0) : "not recorded."} Orders the shop turned away (blocked numbers,
        too many open orders) are not stored, so they are not counted here.
      </p>
    </section>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="bg-surface rounded-control px-3 py-2">
      <dt className="text-ink-muted text-sm">{term}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}

function StockAlerts({ data }: { data: StatsBundle }) {
  const s = data.stockAlerts;
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4 md:p-5">
      <h2 id={`${id}-h`} className="font-display text-xl">
        Stock alerts
      </h2>
      <p className="text-ink-muted text-sm">
        Sizes that are sold out or down to {s.fewLeftThreshold} or fewer, right now. Sales are the last 7 and 30 days.
      </p>
      {s.items.length === 0 ? (
        <p className="py-2">Every size has more than {s.fewLeftThreshold} in stock.</p>
      ) : (
        <ul className="space-y-2">
          {s.items.map((a) => (
            <li key={a.variantId} className={`border-line rounded-control space-y-1.5 border p-3 ${a.stockState === "sold_out" ? "hatch-soldout" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">
                  {a.productName}, {a.size} / {a.colour}
                </span>
                {a.stockState === "sold_out" ? <Badge tone="danger">Sold out</Badge> : <Badge tone="accent">Only {a.stock} left</Badge>}
                {!a.isPublished ? <Badge>Not in the shop</Badge> : null}
              </div>
              <p className="text-ink-muted text-sm tabular-nums">
                Sold {formatCount(a.sold7d)} in 7 days, {formatCount(a.sold30d)} in 30 days.{" "}
                {a.stockState === "sold_out"
                  ? "No stock left."
                  : a.daysOfStockLeft === null
                    ? "No recent sales, so no estimate."
                    : `About ${formatCount(a.daysOfStockLeft)} ${a.daysOfStockLeft === 1 ? "day" : "days"} of stock left.`}
              </p>
              <Link href={`/admin/products#product-${a.productId}`} className="min-h-tap text-primary inline-flex items-center font-semibold underline underline-offset-4">
                Change stock<span className="sr-only">: {a.productName}, {a.size} / {a.colour}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


import {
  addDays,
  daysInclusive,
  kathmanduDate,
  KATHMANDU_OFFSET_MINUTES,
} from "@/lib/stats/dates";
import type {
  DailySales,
  DailySalesLine,
  StatsBestFoodDay,
  StatsBundle,
  StatsFoodWeekday,
  StatsHeatmapCell,
  StatsMetric,
  ResolvedStatsRange,
  StatsRange,
  StatsStockAlert,
  StatsTimeseriesBucket,
  StatsTopFoodItem,
  StatsTopMerchProduct,
  StatsTopMerchVariant,
  Weekday,
} from "@/lib/stats/types";
import type { AdminMenuCategory, AdminProduct, CancelReason } from "@/types/contract";

/**
 * MOCK statistics for NEXT_PUBLIC_DATA_MODE=mock (dev demos and e2e). PURE: no window, no storage.
 *
 * - A deterministic 60-day DEMO food log over the sample menu (same idea as the local DB seed: Saturdays closed,
 *   Friday busiest, every day noted "DEMO DATA"), plus deterministic sample merch orders for the last 120 days.
 * - `computeStatsBundle` re-implements the stats RPC rules from supabase/README.md "Statistics" in TypeScript, so the
 *   dashboard sees exactly the shapes the real `getStats` returns. Every number here is made up.
 */

export const DEMO_NOTE = "DEMO DATA";
const DEMO_FOOD_DAYS = 60;
const DEMO_MERCH_DAYS = 120;
const DAY_MS = 86_400_000;

/* ---- deterministic random -------------------------------------------------------------------------------- */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: small seeded PRNG, so the demo numbers are the same on every reload and in every test run. */
function rng(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- Kathmandu helpers ----------------------------------------------------------------------------------- */

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
}

/** Kathmandu hour (0..23) of an instant. */
export function kathmanduHour(iso: string): number {
  return new Date(new Date(iso).getTime() + KATHMANDU_OFFSET_MINUTES * 60_000).getUTCHours();
}

/** The UTC instant of Kathmandu wall time `date` `hour`:`minute`. */
function kathmanduInstant(date: string, hour: number, minute: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - KATHMANDU_OFFSET_MINUTES * 60_000).toISOString();
}

function datesIn(from: string, to: string): string[] {
  const n = daysInclusive(from, to);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(addDays(from, i));
  return out;
}

const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

/* ---- menu pricing (the DB snapshots the same way) ------------------------------------------------------- */

export type MenuPriceRef = { name: string; variantLabel: string | null; unitPricePaisa: number };

/** item price + variant delta, floored at 0 (supabase/README.md "Food sales log"). null = unknown item / variant. */
export function menuPrice(menu: AdminMenuCategory[], menuItemId: string, variantId: string | null): MenuPriceRef | null {
  for (const c of menu) {
    const it = c.items.find((i) => i.id === menuItemId);
    if (!it) continue;
    if (!variantId) return { name: it.name, variantLabel: null, unitPricePaisa: Math.max(0, it.price) };
    const v = it.variants.find((x) => x.id === variantId);
    if (!v) return null;
    return { name: it.name, variantLabel: v.label, unitPricePaisa: Math.max(0, it.price + v.priceDelta) };
  }
  return null;
}

/** Totals of a log (lines total + items sold), recomputed after every change. */
export function withTotals(log: Omit<DailySales, "linesTotalPaisa" | "itemsSold">): DailySales {
  const lines = [...log.lines].sort(
    (a, b) => a.name.localeCompare(b.name) || (a.variantLabel ?? "").localeCompare(b.variantLabel ?? ""),
  );
  return {
    ...log,
    lines,
    linesTotalPaisa: lines.reduce((s, l) => s + l.lineTotalPaisa, 0),
    itemsSold: lines.reduce((s, l) => s + l.qty, 0),
  };
}

/* ---- demo food log ---------------------------------------------------------------------------------------- */

/** Typical units per day by position in the sample menu (made up). Unlisted items sell a few. */
const BASE_QTY = [46, 18, 34, 14, 12, 28, 8, 3];

/**
 * The generated DEMO log for one date, or null when the demo has no log that day (Saturdays, today and later, more
 * than 60 days back). Deterministic per date, so stats and the sales screen agree.
 */
export function demoFoodLog(menu: AdminMenuCategory[], date: string, today: string): DailySales | null {
  if (date >= today || date < addDays(today, -DEMO_FOOD_DAYS)) return null;
  const wd = weekdayOf(date);
  if (wd === 6) return null; // closed on Saturdays in the demo
  const r = rng(`food:${date}`);
  const dayFactor = wd === 5 ? 1.4 : wd === 0 ? 1.15 : wd === 3 ? 0.9 : 1;
  const lines: DailySalesLine[] = [];
  const items = menu.flatMap((c) => c.items);
  const createdAt = kathmanduInstant(date, 21, 10);
  items.forEach((it, idx) => {
    const base = BASE_QTY[idx] ?? 4;
    const qty = Math.max(0, Math.round(base * dayFactor * (0.7 + r() * 0.6)));
    const push = (variantId: string | null, label: string | null, q: number, unit: number) => {
      if (q <= 0) return;
      lines.push({
        id: `demo-${date}-${it.id}-${variantId ?? "base"}`,
        menuItemId: it.id,
        variantId,
        menuItemExists: true,
        name: it.name,
        variantLabel: label,
        qty: q,
        unitPricePaisa: unit,
        lineTotalPaisa: q * unit,
        updatedBy: null,
        updatedAt: createdAt,
      });
    };
    // Options: about a quarter of an item's sales go to each of its first two options.
    const opts = it.variants.slice(0, 2);
    let rest = qty;
    for (const v of opts) {
      const q = Math.round(qty * (0.15 + r() * 0.15));
      rest -= q;
      push(v.id, v.label, q, Math.max(0, it.price + v.priceDelta));
    }
    push(null, null, Math.max(0, rest), Math.max(0, it.price));
  });
  const base = withTotals({
    id: `demo-${date}`,
    businessDate: date,
    tillTotalPaisa: null,
    note: DEMO_NOTE,
    createdBy: null,
    updatedBy: null,
    updatedByName: null, // 1.5.1: seed demo logs have no saver
    createdAt,
    updatedAt: createdAt,
    lines,
  });
  // About two days in three also carry a till total, a little off the logged lines (cash rounding, missed items).
  const tillRoll = r();
  if (tillRoll < 0.66) {
    const drift = Math.round((r() - 0.4) * 0.06 * base.linesTotalPaisa / 1000) * 1000;
    base.tillTotalPaisa = Math.max(0, base.linesTotalPaisa + drift);
  }
  return base;
}

/* ---- demo merch orders -------------------------------------------------------------------------------- */

export type StatOrderLine = {
  productId: string;
  productName: string;
  variantId: string;
  size: string;
  colour: string;
  qty: number;
  unitPricePaisa: number;
};
export type StatOrder = {
  createdAt: string;
  completedAt: string | null;
  status: "completed" | "cancelled" | "open";
  cancelReason: CancelReason | null;
  totalPaisa: number;
  lines: StatOrderLine[];
};

const REASON_ROLL: [number, CancelReason][] = [
  [0.34, "customer_request"],
  [0.62, "auto_unconfirmed"],
  [0.78, "unreachable"],
  [0.88, "no_show"],
  [0.94, "out_of_stock"],
  [1, "other"],
];
/** Order hours (Kathmandu), weighted to lunch and early evening. */
const HOURS = [9, 10, 11, 12, 12, 13, 13, 13, 14, 15, 16, 17, 17, 18, 18, 19, 20, 21];

/** Sample merch orders for the last 120 days (made up). Uses the current sample products and their prices. */
export function demoMerchOrders(products: AdminProduct[], now: Date): StatOrder[] {
  const today = kathmanduDate(now);
  const sellable = products.filter((p) => p.isPublished).flatMap((p) => p.variants.map((v) => ({ p, v })));
  if (sellable.length === 0) return [];
  const out: StatOrder[] = [];
  for (let back = DEMO_MERCH_DAYS; back >= 0; back--) {
    const date = addDays(today, -back);
    const r = rng(`merch:${date}`);
    const wd = weekdayOf(date);
    const n = Math.floor(r() * (wd === 5 || wd === 6 ? 4.2 : 2.6));
    for (let k = 0; k < n; k++) {
      const hour = HOURS[Math.floor(r() * HOURS.length)] ?? 13;
      const createdAt = kathmanduInstant(date, hour, Math.floor(r() * 60));
      if (new Date(createdAt).getTime() > now.getTime()) continue;
      const lines: StatOrderLine[] = [];
      const lineCount = r() < 0.75 ? 1 : 2;
      for (let j = 0; j < lineCount; j++) {
        const pick = sellable[Math.floor(r() * sellable.length)]!;
        if (lines.some((l) => l.variantId === pick.v.id)) continue;
        lines.push({
          productId: pick.p.id,
          productName: pick.p.name,
          variantId: pick.v.id,
          size: pick.v.size,
          colour: pick.v.colour,
          qty: r() < 0.8 ? 1 : 2,
          unitPricePaisa: pick.v.price,
        });
      }
      const sub = lines.reduce((s, l) => s + l.qty * l.unitPricePaisa, 0);
      const fee = r() < 0.5 ? 15000 : 0;
      const roll = r();
      const ageH = (now.getTime() - new Date(createdAt).getTime()) / 3_600_000;
      let status: StatOrder["status"] = roll < 0.72 ? "completed" : "cancelled";
      if (ageH < 30 && roll < 0.9) status = "open"; // the last day or so is still being handled
      const completedAt =
        status === "completed"
          ? new Date(Math.min(now.getTime() - 60_000, new Date(createdAt).getTime() + (1 + r() * 24) * 3_600_000)).toISOString()
          : null;
      const rr = r();
      const reason = status === "cancelled" ? (REASON_ROLL.find(([p]) => rr < p)?.[1] ?? "other") : null;
      out.push({ createdAt, completedAt, status, cancelReason: reason, totalPaisa: sub + fee, lines });
    }
  }
  return out;
}

/* ---- the RPCs, in TypeScript ------------------------------------------------------------------------------ */

function metric(value: number | null, compare: number | null, hasCompare: boolean): StatsMetric {
  const c = hasCompare ? compare : null;
  const changePct = c === null || c === 0 || value === null ? null : Math.round(((value - c) / c) * 1000) / 10;
  return { value, compare: c, changePct };
}

function foodTotals(logs: DailySales[]) {
  let revenue = 0;
  let items = 0;
  let till = 0;
  let tillDays = 0;
  for (const l of logs) {
    revenue += l.linesTotalPaisa;
    items += l.itemsSold;
    if (l.tillTotalPaisa !== null) {
      till += l.tillTotalPaisa;
      tillDays++;
    }
  }
  return { revenue, items, days: logs.length, till, tillDays };
}

function merchTotals(orders: StatOrder[], from: string, to: string) {
  const done = orders.filter((o) => o.status === "completed" && o.completedAt && inRange(kathmanduDate(new Date(o.completedAt)), from, to));
  const revenue = done.reduce((s, o) => s + o.totalPaisa, 0);
  return { revenue, orders: done.length, avg: done.length ? Math.round(revenue / done.length) : null };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function bucketStart(date: string, grain: StatsRange["grain"]): string {
  if (grain === "day") return date;
  if (grain === "week") return addDays(date, -weekdayOf(date));
  return `${date.slice(0, 7)}-01`;
}
function bucketEnd(start: string, grain: StatsRange["grain"]): string {
  if (grain === "day") return start;
  if (grain === "week") return addDays(start, 6);
  const [y, m] = start.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function rankFood(rows: Omit<StatsTopFoodItem, "rank">[], by: "qty" | "revenue", limit: number): StatsTopFoodItem[] {
  const key = by === "qty" ? "qty" : "revenuePaisa";
  const other = by === "qty" ? "revenuePaisa" : "qty";
  return rows
    .filter((r) => r[key] > 0)
    .sort((a, b) => b[key] - a[key] || b[other] - a[other] || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

export type StatsSources = {
  logs: DailySales[]; // every food log we know (any dates)
  orders: StatOrder[];
  menu: AdminMenuCategory[];
  products: AdminProduct[];
  now: Date;
};

export const REFUSED_NOTE =
  "ORDER_REFUSED attempts are not stored in the database: the order is rolled back and only the security log records it.";

/** All dashboard data for one range, with the same rules and shapes as the stats RPCs. */
export function computeStatsBundle(resolved: ResolvedStatsRange, src: StatsSources, limit = 10): StatsBundle {
  const { from, to, compareFrom, compareTo, grain } = resolved;
  // 1.5.1: logged days in from..to (not the compare range) whose note is DEMO DATA, any case (server: ilike equality)
  const demoDataDays = src.logs.filter(
    (l) => inRange(l.businessDate, from, to) && l.note?.toUpperCase() === DEMO_NOTE,
  ).length;
  const range: StatsRange = { ...resolved, demoDataDays };
  const hasCmp = compareFrom !== null && compareTo !== null;
  const logsIn = (a: string, b: string) => src.logs.filter((l) => inRange(l.businessDate, a, b));
  const cur = logsIn(from, to);
  const f = foodTotals(cur);
  const m = merchTotals(src.orders, from, to);
  const fc = hasCmp ? foodTotals(logsIn(compareFrom, compareTo)) : null;
  const mc = hasCmp ? merchTotals(src.orders, compareFrom, compareTo) : null;

  const overview: StatsBundle["overview"] = {
    from,
    to,
    compareFrom,
    compareTo,
    timezone: "Asia/Kathmandu",
    foodRevenuePaisa: metric(f.revenue, fc?.revenue ?? null, hasCmp),
    merchRevenuePaisa: metric(m.revenue, mc?.revenue ?? null, hasCmp),
    totalRevenuePaisa: metric(f.revenue + m.revenue, fc && mc ? fc.revenue + mc.revenue : null, hasCmp),
    merchOrders: metric(m.orders, mc?.orders ?? null, hasCmp),
    avgMerchOrderPaisa: metric(m.avg, mc?.avg ?? null, hasCmp),
    foodItemsSold: metric(f.items, fc?.items ?? null, hasCmp),
    foodDaysLogged: metric(f.days, fc?.days ?? null, hasCmp),
    foodTillTotalPaisa: metric(f.till, fc?.till ?? null, hasCmp),
    foodTillDays: metric(f.tillDays, fc?.tillDays ?? null, hasCmp),
  };

  // timeseries
  const placedIn = src.orders.filter((o) => inRange(kathmanduDate(new Date(o.createdAt)), from, to));
  const buckets: StatsTimeseriesBucket[] = [];
  let b = bucketStart(from, grain);
  while (b <= to) {
    const natEnd = bucketEnd(b, grain);
    const start = b < from ? from : b;
    const end = natEnd > to ? to : natEnd;
    const ft = foodTotals(logsIn(start, end));
    const mt = merchTotals(src.orders, start, end);
    const placed = placedIn.filter((o) => inRange(kathmanduDate(new Date(o.createdAt)), start, end)).length;
    buckets.push({
      bucket: b,
      start,
      end,
      partial: start !== b || end !== natEnd,
      foodRevenuePaisa: ft.revenue,
      foodItemsSold: ft.items,
      merchRevenuePaisa: mt.revenue,
      merchOrders: mt.orders,
      merchOrdersPlaced: placed,
      totalRevenuePaisa: ft.revenue + mt.revenue,
    });
    b = addDays(natEnd, 1);
  }

  // top food (variants summed into their item)
  const currentName = new Map(src.menu.flatMap((c) => c.items.map((i) => [i.id, i.name] as const)));
  const agg = new Map<string, { name: string; qty: number; revenuePaisa: number; last: string }>();
  for (const log of cur) {
    for (const l of log.lines) {
      const a = agg.get(l.menuItemId) ?? { name: l.name, qty: 0, revenuePaisa: 0, last: "" };
      a.qty += l.qty;
      a.revenuePaisa += l.lineTotalPaisa;
      if (log.businessDate >= a.last) {
        a.last = log.businessDate;
        a.name = l.name;
      }
      agg.set(l.menuItemId, a);
    }
  }
  const foodRows = [...agg.entries()].map(([menuItemId, a]) => ({
    menuItemId,
    name: currentName.get(menuItemId) ?? a.name,
    isDeleted: !currentName.has(menuItemId),
    qty: a.qty,
    revenuePaisa: a.revenuePaisa,
  }));

  // best food per day
  const byDate = new Map(cur.map((l) => [l.businessDate, l]));
  const days: StatsBestFoodDay[] = datesIn(from, to).map((date) => {
    const log = byDate.get(date);
    if (!log) {
      return { date, logged: false, menuItemId: null, name: null, qty: null, revenuePaisa: null, dayItemsSold: null, dayFoodRevenuePaisa: null };
    }
    const per = new Map<string, { name: string; qty: number; rev: number }>();
    for (const l of log.lines) {
      const a = per.get(l.menuItemId) ?? { name: currentName.get(l.menuItemId) ?? l.name, qty: 0, rev: 0 };
      a.qty += l.qty;
      a.rev += l.lineTotalPaisa;
      per.set(l.menuItemId, a);
    }
    const best = [...per.entries()]
      .filter(([, a]) => a.qty > 0)
      .sort(([, a], [, z]) => z.qty - a.qty || z.rev - a.rev || a.name.localeCompare(z.name))[0];
    return {
      date,
      logged: true,
      menuItemId: best ? best[0] : null,
      name: best ? best[1].name : null,
      qty: best ? best[1].qty : 0,
      revenuePaisa: best ? best[1].rev : 0,
      dayItemsSold: log.itemsSold,
      dayFoodRevenuePaisa: log.linesTotalPaisa,
    };
  });

  // top merch (completed, by completed_at)
  const done = src.orders.filter((o) => o.status === "completed" && o.completedAt && inRange(kathmanduDate(new Date(o.completedAt)), from, to));
  const prod = new Map<string, Omit<StatsTopMerchProduct, "rank">>();
  const vari = new Map<string, Omit<StatsTopMerchVariant, "rank">>();
  for (const o of done) {
    for (const l of o.lines) {
      const p = prod.get(l.productId) ?? { productId: l.productId, name: l.productName, qty: 0, revenuePaisa: 0 };
      p.qty += l.qty;
      p.revenuePaisa += l.qty * l.unitPricePaisa;
      prod.set(l.productId, p);
      const v = vari.get(l.variantId) ?? {
        variantId: l.variantId,
        productId: l.productId,
        productName: l.productName,
        size: l.size,
        colour: l.colour,
        label: `${l.size} / ${l.colour}`,
        qty: 0,
        revenuePaisa: 0,
      };
      v.qty += l.qty;
      v.revenuePaisa += l.qty * l.unitPricePaisa;
      vari.set(l.variantId, v);
    }
  }
  const rankMerch = <T extends { qty: number; revenuePaisa: number }>(rows: T[]) =>
    rows
      .sort((a, z) => z.qty - a.qty || z.revenuePaisa - a.revenuePaisa)
      .slice(0, limit)
      .map((r, i) => ({ rank: i + 1, ...r }));

  // heatmap
  const merch: StatsHeatmapCell[] = [];
  for (let wd = 0; wd < 7; wd++) for (let h = 0; h < 24; h++) merch.push({ weekday: wd as Weekday, hour: h, orders: 0, completedOrders: 0 });
  for (const o of placedIn) {
    const wd = weekdayOf(kathmanduDate(new Date(o.createdAt)));
    const cell = merch[wd * 24 + kathmanduHour(o.createdAt)]!;
    cell.orders++;
    if (o.status === "completed") cell.completedOrders++;
  }
  const foodByWeekday: StatsFoodWeekday[] = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).map((wd) => {
    const ls = cur.filter((l) => weekdayOf(l.businessDate) === wd);
    const t = foodTotals(ls);
    return {
      weekday: wd,
      daysLogged: t.days,
      itemsSold: t.items,
      revenuePaisa: t.revenue,
      avgItemsSoldPerDay: t.days ? round1(t.items / t.days) : null,
      avgRevenuePaisaPerDay: t.days ? Math.round(t.revenue / t.days) : null,
    };
  });

  // cancellations (placed in range)
  const byReason: Record<CancelReason, number> = {
    customer_request: 0,
    auto_unconfirmed: 0,
    no_show: 0,
    refused: 0,
    unreachable: 0,
    out_of_stock: 0,
    fake: 0,
    other: 0,
  };
  let completed = 0;
  let cancelled = 0;
  let open = 0;
  for (const o of placedIn) {
    if (o.status === "completed") completed++;
    else if (o.status === "cancelled") {
      cancelled++;
      byReason[o.cancelReason ?? "other"]++;
    } else open++;
  }
  const placed = placedIn.length;

  // stock alerts (current stock; rolling windows from now)
  const nowMs = src.now.getTime();
  const soldSince = (variantId: string, days: number) =>
    src.orders
      .filter((o) => o.status !== "cancelled" && nowMs - new Date(o.createdAt).getTime() <= days * DAY_MS)
      .reduce((s, o) => s + o.lines.filter((l) => l.variantId === variantId).reduce((q, l) => q + l.qty, 0), 0);
  const alerts: StatsStockAlert[] = src.products
    .flatMap((p) =>
      p.variants
        .filter((v) => v.stock <= 3)
        .map((v): StatsStockAlert => {
          const sold30d = soldSince(v.id, 30);
          const rate = sold30d > 0 ? round2(sold30d / 30) : null;
          const soldOut = v.stock <= 0;
          return {
            variantId: v.id,
            productId: p.id,
            productName: p.name,
            isPublished: p.isPublished,
            size: v.size,
            colour: v.colour,
            sku: v.sku,
            stock: Math.max(0, v.stock),
            stockState: soldOut ? "sold_out" : "few_left",
            sold7d: soldSince(v.id, 7),
            sold30d,
            dailyRate30d: rate,
            daysOfStockLeft: soldOut ? 0 : rate ? round1(v.stock / rate) : null,
          };
        }),
    )
    .sort(
      (a, z) =>
        (a.stockState === "sold_out" ? 0 : 1) - (z.stockState === "sold_out" ? 0 : 1) ||
        (a.daysOfStockLeft ?? Infinity) - (z.daysOfStockLeft ?? Infinity) ||
        a.stock - z.stock ||
        a.productName.localeCompare(z.productName) ||
        a.colour.localeCompare(z.colour) ||
        a.size.localeCompare(z.size),
    );

  return {
    range,
    overview,
    timeseries: { from, to, grain, weekStartsOn: "sunday", timezone: "Asia/Kathmandu", buckets },
    topFood: { from, to, limit, byQty: rankFood(foodRows, "qty", limit), byRevenue: rankFood(foodRows, "revenue", limit) },
    bestFoodPerDay: { from, to, days },
    topMerch: { from, to, limit, byProduct: rankMerch([...prod.values()]), byVariant: rankMerch([...vari.values()]) },
    heatmap: { from, to, timezone: "Asia/Kathmandu", weekdays: "0 = Sunday ... 6 = Saturday", merch, foodByWeekday },
    cancellations: {
      from,
      to,
      ordersPlaced: placed,
      completed,
      cancelled,
      open,
      cancelRatePct: placed ? round1((cancelled / placed) * 100) : null,
      completionRatePct: placed ? round1((completed / placed) * 100) : null,
      byReason,
      refusedAttempts: { recorded: false, count: null, note: REFUSED_NOTE },
    },
    stockAlerts: { generatedAt: src.now.toISOString(), fewLeftThreshold: 3, items: alerts },
    // contract 2.0.0 / 9.11: a separate block. Empty here; src/data-access/stats-mock.ts fills it from the mock tables.
    tableOrders: {
      rounds: 0,
      cancelledRounds: 0,
      cancelledAfterAccept: 0,
      paidTables: 0,
      paidTotalPaisa: 0,
      voidedTables: 0,
      expiredTables: 0,
      expiredWithOrdersPaisa: 0,
      topItems: [],
      byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, rounds: 0 })),
    },
  };
}

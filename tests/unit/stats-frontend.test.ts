import { describe, expect, it } from "vitest";
import { formatNpr } from "@/lib/money";
import { resolveStatsRange } from "@/lib/stats/validation";
import {
  axisMoney,
  bucketLabel,
  changeOf,
  customRangeProblem,
  heatLevel,
  hourSpan,
  niceScale,
  parseQuery,
  rangeFor,
  rangeLabel,
  serializeQuery,
  shortDate,
  tickEvery,
  tillDiffText,
} from "@/components/admin/stats/stats-logic";
import {
  allRows,
  buildGroups,
  changedLines,
  cleanQtyInput,
  liveTotal,
  mapSaveErrors,
  orphanLines,
  parseQty,
  qtyFromLog,
  step,
} from "@/components/admin/sales/sales-logic";
import { computeStatsBundle, demoFoodLog, demoMerchOrders, kathmanduHour, weekdayOf } from "@/mocks/stats";
import { seedDb } from "@/mocks/seed";
import type { DailySales } from "@/lib/stats/types";

const NOW = new Date("2026-10-25T06:15:00Z"); // 12:00 Kathmandu, Sunday 25 Oct 2026
const TODAY = "2026-10-25";

describe("stats-logic: controls and URL state", () => {
  it("parses and serialises the address bar, falling back to last 30 days", () => {
    expect(parseQuery("", TODAY)).toEqual({ preset: "last30Days", from: "", to: "", compare: true, grain: "auto" });
    const q = parseQuery("?range=custom&from=2026-09-01&to=2026-09-30&compare=0&grain=week", TODAY);
    expect(q).toEqual({ preset: "custom", from: "2026-09-01", to: "2026-09-30", compare: false, grain: "week" });
    expect(parseQuery(serializeQuery(q), TODAY)).toEqual(q);
    // a broken or future custom range is not trusted
    expect(parseQuery("?range=custom&from=2026-10-01&to=2026-11-30", TODAY).preset).toBe("last30Days");
    expect(parseQuery("?range=bogus&grain=hour", TODAY)).toMatchObject({ preset: "last30Days", grain: "auto" });
  });

  it("checks a custom range before fetching", () => {
    expect(customRangeProblem("", "2026-10-01", TODAY)).toMatch(/both/);
    expect(customRangeProblem("2026-10-05", "2026-10-01", TODAY)).toMatch(/on or before/);
    expect(customRangeProblem("2026-10-01", "2026-10-26", TODAY)).toMatch(/after today/);
    expect(customRangeProblem("2020-01-01", "2026-10-25", TODAY)).toMatch(/1,096/);
    expect(customRangeProblem("2026-10-01", "2026-10-25", TODAY)).toBeNull();
  });

  it("resolves presets in Kathmandu time", () => {
    expect(rangeFor({ preset: "last7Days", from: "", to: "", compare: true, grain: "auto" }, NOW)).toEqual({ from: "2026-10-19", to: TODAY });
    // 20:00 UTC on 24 Oct is already 25 Oct 01:45 in Kathmandu
    expect(rangeFor({ preset: "today", from: "", to: "", compare: true, grain: "auto" }, new Date("2026-10-24T20:00:00Z"))).toEqual({ from: TODAY, to: TODAY });
  });
});

describe("stats-logic: formatting", () => {
  it("formats dates and ranges", () => {
    expect(shortDate("2026-10-25")).toBe("Sun 25 Oct");
    expect(rangeLabel("2026-10-01", "2026-10-25")).toBe("1 Oct to 25 Oct 2026");
    expect(rangeLabel("2025-12-28", "2026-01-03")).toBe("28 Dec 2025 to 3 Jan 2026");
    expect(rangeLabel(TODAY, TODAY)).toBe("25 Oct 2026");
    expect(bucketLabel({ bucket: "2026-10-18", start: "2026-10-19", end: "2026-10-24" }, "week")).toBe("19 Oct to 24 Oct");
    expect(bucketLabel({ bucket: "2026-10-01", start: "2026-10-01", end: "2026-10-25" }, "month")).toBe("Oct 2026");
  });

  it("describes a change in words, never by colour alone", () => {
    expect(changeOf({ value: 112, compare: 100, changePct: 12 }, true)).toEqual({ dir: "up", text: "Up 12% on previous period" });
    expect(changeOf({ value: 90, compare: 100, changePct: -10.5 }, true)).toEqual({ dir: "down", text: "Down 10.5% on previous period" });
    expect(changeOf({ value: 100, compare: 100, changePct: 0 }, true).text).toBe("Same as previous period");
    expect(changeOf({ value: 5, compare: 0, changePct: null }, true).text).toMatch(/^New/);
    expect(changeOf({ value: 5, compare: null, changePct: null }, false).text).toBe("No comparison");
  });

  it("scales chart axes to round numbers and short money labels", () => {
    expect(niceScale(8_475_000)).toEqual({ top: 10_000_000, step: 2_500_000 });
    expect(niceScale(0)).toEqual({ top: 4, step: 1 });
    expect(axisMoney(0)).toBe("Rs. 0");
    expect(axisMoney(2_500_000)).toBe("Rs. 25k");
    expect(axisMoney(10_000_000)).toBe("Rs. 1 lakh");
    expect(tickEvery(30, 10)).toBe(3);
    expect(tillDiffText(-30000, formatNpr)).toBe("Rs. 300 less than logged");
  });

  it("shades the heatmap in 4 steps and keeps 8:00 to 21:00 in view", () => {
    expect([0, 1, 4, 10].map((n) => heatLevel(n, 10))).toEqual([0, 1, 2, 3]);
    const span = hourSpan([{ hour: 6, orders: 2 }, { hour: 23, orders: 0 }]);
    expect(span[0]).toBe(6);
    expect(span.at(-1)).toBe(21);
  });
});

describe("sales-logic", () => {
  const db = seedDb(NOW);
  const groups = buildGroups(db.menu);
  const rows = allRows(groups);
  const coffee = db.menu[0]!.items[1]!; // "Sample black coffee" with Oat milk (+50) and Large (+30)

  it("lists every item with its options as sub-rows, priced item + delta", () => {
    const g = groups[0]!.items.find((i) => i.item.menuItemId === coffee.id)!;
    expect(g.options.map((o) => [o.label, o.pricePaisa])).toEqual([
      ["Oat milk", 15000 + 5000],
      ["Large", 15000 + 3000],
    ]);
    expect(rows.find((r) => r.name === "Hidden sample item")?.hidden).toBe(true);
  });

  it("accepts whole numbers 0..9999 only", () => {
    expect(parseQty("")).toBe(0);
    expect(parseQty("12")).toBe(12);
    expect(parseQty("1.5")).toBeNull();
    expect(parseQty("10000")).toBeNull();
    expect(cleanQtyInput("0a12345")).toBe("1234");
    expect(step(0, -1)).toBe(0);
    expect(step(9999, 1)).toBe(9999);
  });

  it("sends only changed lines (merge semantics), with 0 for a cleared row and null for a base item", () => {
    const base = rows.find((r) => r.menuItemId === coffee.id && r.variantId === null)!;
    const large = rows.find((r) => r.label === "Large")!;
    const tea = rows[0]!;
    const saved = { [base.key]: 5, [tea.key]: 3 };
    const current = { [base.key]: 5, [tea.key]: 0, [large.key]: 2 };
    expect(changedLines(saved, current, rows)).toEqual([
      { menuItemId: tea.menuItemId, variantId: null, qty: 0 },
      { menuItemId: coffee.id, variantId: large.variantId, qty: 2 },
    ]);
  });

  it("totals with the logged price snapshot for existing lines and today's price for new ones", () => {
    const tea = rows[0]!;
    const log: DailySales = {
      id: "x",
      businessDate: TODAY,
      tillTotalPaisa: null,
      note: null,
      createdBy: null,
      updatedBy: null,
      updatedByName: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      linesTotalPaisa: 0,
      itemsSold: 0,
      lines: [
        { id: "l1", menuItemId: tea.menuItemId, variantId: null, menuItemExists: true, name: tea.name, variantLabel: null, qty: 2, unitPricePaisa: 10000, lineTotalPaisa: 20000, updatedBy: null, updatedAt: "" },
        { id: "l2", menuItemId: "gone", variantId: null, menuItemExists: false, name: "Old cake", variantLabel: null, qty: 1, unitPricePaisa: 5000, lineTotalPaisa: 5000, updatedBy: null, updatedAt: "" },
      ],
    };
    const orphans = orphanLines(log, groups);
    expect(orphans.map((o) => o.name)).toEqual(["Old cake"]);
    const qty = { ...qtyFromLog(log), [rows[1]!.key]: 1 };
    // tea 2 x Rs. 100 (snapshot, not today's Rs. 120) + 1 x today's price of row 1 + orphan Rs. 50
    expect(liveTotal(qty, rows, log, orphans)).toEqual({ items: 4, paisa: 20000 + rows[1]!.pricePaisa + 5000 });
  });

  it("maps server field errors back to the item that was sent", () => {
    const sent = [{ menuItemId: rows[0]!.menuItemId, variantId: null, qty: 1 }];
    const e = mapSaveErrors({ "lines.0.qty": ["Enter a whole number from 0 to 9999."], tillTotalPaisa: ["too big"], range: ["x"] }, sent, rows);
    expect(e.lines).toEqual([`${rows[0]!.name}: Enter a whole number from 0 to 9999.`]);
    expect(e.tillTotal).toBe("too big");
    expect(e.other).toEqual(["x"]);
  });
});

describe("mock stats engine (same shapes and rules as the RPCs)", () => {
  const db = seedDb(NOW);
  const logs = Array.from({ length: 62 }, (_, i) => demoFoodLog(db.menu, new Date(Date.UTC(2026, 9, 25 - i)).toISOString().slice(0, 10), TODAY)).filter(
    (l): l is DailySales => l !== null,
  );
  const orders = demoMerchOrders(db.products, NOW);
  const src = { logs, orders, menu: db.menu, products: db.products, now: NOW };

  it("demo food log: Saturdays and today are not logged, every day is noted DEMO DATA, deterministic", () => {
    expect(demoFoodLog(db.menu, "2026-10-24", TODAY)).toBeNull(); // Saturday
    expect(demoFoodLog(db.menu, TODAY, TODAY)).toBeNull();
    const fri = demoFoodLog(db.menu, "2026-10-23", TODAY)!;
    expect(fri.note).toBe("DEMO DATA");
    expect(fri.linesTotalPaisa).toBe(fri.lines.reduce((s, l) => s + l.qty * l.unitPricePaisa, 0));
    expect(demoFoodLog(db.menu, "2026-10-23", TODAY)).toEqual(fri);
    expect(logs.every((l) => weekdayOf(l.businessDate) !== 6)).toBe(true);
  });

  it("buckets, totals and compare match the README rules", () => {
    const range = resolveStatsRange({ from: "2026-10-01", to: TODAY });
    expect(range).toMatchObject({ compareFrom: "2026-09-06", compareTo: "2026-09-30", grain: "day" });
    const b = computeStatsBundle(range, src);
    const o = b.overview;
    // 1.5.1: days in from..to (not the compare range) noted DEMO DATA; every generated demo log carries the note
    expect(b.range.demoDataDays).toBe(logs.filter((l) => l.businessDate >= "2026-10-01" && l.businessDate <= TODAY).length);
    expect(b.range.demoDataDays).toBeGreaterThan(0);
    expect(b.timeseries.buckets).toHaveLength(25);
    expect(b.timeseries.buckets.reduce((s, x) => s + x.foodRevenuePaisa, 0)).toBe(o.foodRevenuePaisa.value);
    expect(o.totalRevenuePaisa.value).toBe((o.foodRevenuePaisa.value ?? 0) + (o.merchRevenuePaisa.value ?? 0));
    const m = o.foodRevenuePaisa;
    expect(m.changePct).toBe(Math.round((((m.value ?? 0) - (m.compare ?? 0)) / (m.compare ?? 1)) * 1000) / 10);
    expect(b.bestFoodPerDay.days).toHaveLength(25);
    expect(b.bestFoodPerDay.days.find((d) => d.date === "2026-10-24")).toMatchObject({ logged: false, name: null });
    expect(b.topFood.byQty.length).toBeLessThanOrEqual(10);
    expect(b.heatmap.merch).toHaveLength(168);
    expect(b.heatmap.foodByWeekday.find((f) => f.weekday === 6)).toMatchObject({ daysLogged: 0, avgItemsSoldPerDay: null });
    expect(Object.keys(b.cancellations.byReason).sort()).toHaveLength(8);
    expect(b.cancellations.refusedAttempts).toMatchObject({ recorded: false, count: null });
    expect(b.cancellations.completed + b.cancellations.cancelled + b.cancellations.open).toBe(b.cancellations.ordersPlaced);
  });

  it("week buckets start on Sunday and are clipped to the range", () => {
    const b = computeStatsBundle(resolveStatsRange({ from: "2026-10-01", to: TODAY, grain: "week" }), src);
    const first = b.timeseries.buckets[0]!;
    expect(first).toMatchObject({ bucket: "2026-09-27", start: "2026-10-01", end: "2026-10-03", partial: true });
    expect(weekdayOf(b.timeseries.buckets[1]!.bucket)).toBe(0);
  });

  it("stock alerts: sold out first, few-left threshold 3", () => {
    const b = computeStatsBundle(resolveStatsRange({ from: TODAY, to: TODAY }), src);
    const items = b.stockAlerts.items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.stockState).toBe("sold_out");
    expect(items.every((i) => i.stock <= 3)).toBe(true);
    expect(items.filter((i) => i.stockState === "sold_out").every((i) => i.daysOfStockLeft === 0)).toBe(true);
  });

  it("an empty range has zeros, not errors", () => {
    const b = computeStatsBundle(resolveStatsRange({ from: "2025-01-01", to: "2025-01-31", compare: "none" }), src);
    expect(b.range.demoDataDays).toBe(0);
    expect(b.overview.totalRevenuePaisa).toEqual({ value: 0, compare: null, changePct: null });
    expect(b.overview.avgMerchOrderPaisa.value).toBeNull();
    expect(b.topFood.byQty).toEqual([]);
    expect(b.cancellations.cancelRatePct).toBeNull();
  });

  it("orders land on their Kathmandu hour", () => {
    expect(kathmanduHour("2026-10-25T06:15:00Z")).toBe(12);
    expect(kathmanduHour("2026-10-24T18:14:00Z")).toBe(23);
  });
});

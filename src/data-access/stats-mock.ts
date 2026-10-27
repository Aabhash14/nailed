"use client";

import { kathmanduToday, staffMayUseDate, isIsoDate, addDays } from "@/lib/stats/dates";
import { getStatsSchema, logDailySalesSchema, MSG, resolveStatsRange } from "@/lib/stats/validation";
import type { DailySales, GetStatsInput, LogDailySalesInput, StatsBundle } from "@/lib/stats/types";
import { loadDb } from "@/mocks/db";
import { computeStatsBundle, demoFoodLog, demoMerchOrders, menuPrice, withTotals, type StatOrder } from "@/mocks/stats";
import type { MockDb } from "@/mocks/seed";
import type { ActionResult, StatsTableOrders } from "@/types/contract";
import { mockTableStats } from "@/mocks/tables";
import type { AdminSession } from "./admin";

/**
 * MOCK statistics + food sales log (NEXT_PUBLIC_DATA_MODE=mock only). Same inputs, outputs and error codes as
 * backend-engineer's actions in src/app/admin/_actions/stats.ts. Logs saved here live in this browser's
 * localStorage, on top of a generated 60-day DEMO log (src/mocks/stats.ts).
 */

/** What the sales screen reads: the contract's log, which carries the saver's name since 1.5.1 (kept as an alias). */
export type DailySalesView = DailySales;

const KEY = "nc-mock-sales-v1";
type Store = Record<string, DailySalesView>;

function readStore(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}
function writeStore(s: Store): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the demo just will not persist */
  }
}
export function resetMockSales(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

const forbidden = (message: string): ActionResult<never> => ({ ok: false, error: { code: "FORBIDDEN", message } });
const validation = (fieldErrors: Record<string, string[]>): ActionResult<never> => ({
  ok: false,
  error: { code: "VALIDATION", message: "Please check the form.", fieldErrors },
});
const needLogin = (): ActionResult<never> => ({ ok: false, error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });

function logFor(db: MockDb, store: Store, date: string, today: string): DailySalesView | null {
  return store[date] ?? demoFoodLog(db.menu, date, today);
}

/** The mock db's own sample orders (Today's orders board) in the stats shape. */
function dbOrders(db: MockDb): StatOrder[] {
  return db.orders.map((o) => ({
    createdAt: o.createdAt,
    completedAt: o.completedAt,
    status: o.status === "completed" ? "completed" : o.status === "cancelled" ? "cancelled" : "open",
    cancelReason: o.cancelReason,
    totalPaisa: o.total,
    lines: o.lines.flatMap((l) => {
      const p = db.products.find((x) => x.variants.some((v) => v.id === l.variantId));
      const v = p?.variants.find((x) => x.id === l.variantId);
      return p && v
        ? [{ productId: p.id, productName: p.name, variantId: v.id, size: v.size, colour: v.colour, qty: l.qty, unitPricePaisa: l.unitPrice }]
        : [];
    }),
  }));
}

function zodFieldErrors(issues: { path: (string | number)[]; message: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of issues) {
    const k = i.path.join(".") || "form";
    (out[k] ??= []).push(i.message);
  }
  return out;
}

export async function mockGetDailySales(session: AdminSession | null, input: { date: string }): Promise<ActionResult<DailySalesView | null>> {
  if (!session) return needLogin();
  if (!isIsoDate(input.date)) return validation({ date: [MSG.date] });
  const now = new Date();
  const today = kathmanduToday(now);
  if (input.date > today) return validation({ date: [MSG.future] });
  if (session.role !== "owner" && !staffMayUseDate(input.date, now)) return forbidden(MSG.staffRead);
  return { ok: true, data: logFor(loadDb(), readStore(), input.date, today) };
}

export async function mockLogDailySales(session: AdminSession | null, input: LogDailySalesInput): Promise<ActionResult<DailySalesView>> {
  if (!session) return needLogin();
  const parsed = logDailySalesSchema.safeParse(input);
  if (!parsed.success) return validation(zodFieldErrors(parsed.error.issues));
  const v = parsed.data;
  const now = new Date();
  const today = kathmanduToday(now);
  if (v.date > today) return validation({ date: [MSG.future] });
  if (session.role !== "owner" && !staffMayUseDate(v.date, now)) return forbidden(MSG.staffLog);

  const db = loadDb();
  const store = readStore();
  const prev = logFor(db, store, v.date, today);
  const stamp = now.toISOString();
  const actor = `mock-${session.role}`;
  const lines = [...(prev?.lines ?? [])];
  const errors: Record<string, string[]> = {};
  v.lines.forEach((l, i) => {
    const variantId = l.variantId ?? null;
    const at = lines.findIndex((x) => x.menuItemId === l.menuItemId && x.variantId === variantId);
    if (at >= 0) {
      const old = lines[at]!;
      // an existing line keeps its price snapshot (the price at first entry); only qty changes
      lines[at] = { ...old, qty: l.qty, lineTotalPaisa: l.qty * old.unitPricePaisa, updatedBy: actor, updatedAt: stamp };
      return;
    }
    const ref = menuPrice(db.menu, l.menuItemId, variantId);
    if (!ref) {
      const known = menuPrice(db.menu, l.menuItemId, null);
      errors[`lines.${i}`] = [known ? "unknown variant for this item" : "unknown menu item"];
      return;
    }
    lines.push({
      id: crypto.randomUUID(),
      menuItemId: l.menuItemId,
      variantId,
      menuItemExists: true,
      name: ref.name,
      variantLabel: ref.variantLabel,
      qty: l.qty,
      unitPricePaisa: ref.unitPricePaisa,
      lineTotalPaisa: l.qty * ref.unitPricePaisa,
      updatedBy: actor,
      updatedAt: stamp,
    });
  });
  if (Object.keys(errors).length > 0) return validation(errors);

  const saved: DailySalesView = {
    ...withTotals({
      id: prev?.id ?? crypto.randomUUID(),
      businessDate: v.date,
      // types.ts: omitted = keep the stored value, null = clear
      tillTotalPaisa: v.tillTotalPaisa === undefined ? (prev?.tillTotalPaisa ?? null) : v.tillTotalPaisa,
      note: v.note === undefined ? (prev?.note ?? null) : v.note,
      createdBy: prev?.createdBy ?? actor,
      updatedBy: actor,
      updatedByName: session.displayName, // 1.5.1: the caller is the saver
      createdAt: prev?.createdAt ?? stamp,
      updatedAt: stamp,
      lines,
    }),
  };
  store[v.date] = saved;
  writeStore(store);
  return { ok: true, data: saved };
}

export async function mockGetStats(session: AdminSession | null, input: GetStatsInput): Promise<ActionResult<StatsBundle>> {
  if (!session) return needLogin();
  if (session.role !== "owner") return forbidden("Only the owner can see the stats.");
  const parsed = getStatsSchema.safeParse(input);
  if (!parsed.success) return validation(zodFieldErrors(parsed.error.issues));
  const range = resolveStatsRange(parsed.data);
  const now = new Date();
  const today = kathmanduToday(now);
  const db = loadDb();
  const store = readStore();
  // every log that could fall in either range: stored ones + the generated demo window
  const logs = new Map<string, DailySales>();
  for (let back = 0; back <= 61; back++) {
    const d = addDays(today, -back);
    const l = demoFoodLog(db.menu, d, today);
    if (l) logs.set(d, l);
  }
  for (const [d, l] of Object.entries(store)) logs.set(d, l);
  const bundle = computeStatsBundle(range, {
    logs: [...logs.values()],
    orders: [...demoMerchOrders(db.products, now), ...dbOrders(db)],
    menu: db.menu,
    products: db.products,
    now,
  });
  // 2.0.0 (section 9.11): a separate block, never added into the food figures above
  const withTables: StatsBundle & { tableOrders: StatsTableOrders } = {
    ...bundle,
    tableOrders: mockTableStats(db, range.from, range.to),
  };
  return { ok: true, data: withTables };
}

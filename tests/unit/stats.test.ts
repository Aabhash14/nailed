import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { AuthContext } from "@/lib/auth/roles";
import { fakeDb, ok, pgErr, type PgResult } from "./helpers/fake-db";

// ---- module mocks: no real Supabase, no Next runtime (same pattern as admin-actions.test.ts) --------------------
const state = vi.hoisted(() => ({
  user: null as null | { userId: string; role: "owner" | "staff"; displayName: string },
  db: null as unknown,
}));

vi.mock("@/lib/data/server-admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/auth/require-role", async () => {
  const { AppError } = await import("@/lib/errors");
  const { roleAllows } = await import("@/lib/auth/roles");
  return {
    getCurrentUser: async () => state.user,
    requireRole: async (need: "owner" | "staff") => {
      if (!state.user) throw new AppError("UNAUTHENTICATED");
      if (!roleAllows(state.user.role, need)) throw new AppError("FORBIDDEN");
      return state.user;
    },
  };
});

import { getDailySales, getStats, logDailySales } from "@/app/admin/_actions/stats";
import {
  addDays,
  daysInclusive,
  defaultGrain,
  isIsoDate,
  kathmanduToday,
  presetRange,
  previousRange,
  staffMayUseDate,
} from "@/lib/stats/dates";
import {
  getStatsSchema,
  logDailySalesSchema,
  MSG,
  resolveStatsRange,
} from "@/lib/stats/validation";

const OWNER = {
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "owner",
  displayName: "Owner",
} as const;
const STAFF = {
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "staff",
  displayName: "Staff",
} as const;
const ITEM = "3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";
const VAR = "4f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3c";

/** 2026-10-25 10:45 in Kathmandu. */
const NOW = new Date("2026-10-25T05:00:00Z");

const log = (over: Record<string, unknown> = {}) => ({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  businessDate: "2026-10-25",
  tillTotalPaisa: 4_500_000,
  note: "busy",
  createdBy: STAFF.userId,
  updatedBy: STAFF.userId,
  createdAt: "2026-10-25T10:00:00Z",
  updatedAt: "2026-10-25T10:00:00Z",
  linesTotalPaisa: 18_000,
  itemsSold: 2,
  lines: [],
  ...over,
});

const STATS_RPCS = [
  "stats_overview",
  "stats_timeseries",
  "stats_top_food",
  "stats_best_food_per_day",
  "stats_top_merch",
  "stats_busy_heatmap",
  "stats_cancellations",
  "stats_stock_alerts",
  "stats_table_orders", // 2.0.0 (api-contract 9.11)
] as const;

function statsHandlers(
  over: Partial<Record<(typeof STATS_RPCS)[number], (a: Record<string, unknown>) => PgResult>> = {},
) {
  const h: Record<string, (a: Record<string, unknown>) => PgResult> = {};
  for (const n of STATS_RPCS) h[n] = over[n] ?? (() => ok({ rpc: n }));
  return h;
}

type FakeOpts = Parameters<typeof fakeDb>[0];
/** A head-only count result, as supabase-js returns for `select(..., { count: "exact", head: true })`. */
const countRes = (count: number | null): PgResult => ({ data: null, error: null, count }) as PgResult;

/**
 * fakeDb with this file's defaults: no demo days in range (daily_sales count 0) and no profile found (profiles
 * maybeSingle -> null). Tests override either through `tables`.
 */
function fdb(opts: FakeOpts = {}) {
  return fakeDb({
    ...opts,
    tables: { daily_sales: countRes(0), profiles: ok(null), ...opts.tables },
  });
}

/** What getDailySales / logDailySales return for `log(over)` with the given saver name (1.5.1). */
const named = (updatedByName: string | null, over: Record<string, unknown> = {}) => ({
  ...log(over),
  updatedByName,
});

function use(user: AuthContext | null, f: ReturnType<typeof fakeDb>) {
  state.user = user;
  state.db = f.db;
  return f;
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  state.user = null;
  state.db = fdb({}).db;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ================================================================================================================
describe("Kathmandu dates (src/lib/stats/dates.ts)", () => {
  it("today flips at 18:15 UTC (00:00 +05:45)", () => {
    expect(kathmanduToday(new Date("2026-10-24T18:14:59.999Z"))).toBe("2026-10-24");
    expect(kathmanduToday(new Date("2026-10-24T18:15:00.000Z"))).toBe("2026-10-25");
    expect(kathmanduToday(new Date("2026-12-31T18:15:00Z"))).toBe("2027-01-01");
  });

  it("isIsoDate accepts real dates only", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    for (const bad of [
      "2026-02-29",
      "2026-13-01",
      "2026-1-05",
      "2026-10-25T00:00",
      "",
      20261025,
      null,
    ]) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });

  it("presets in Kathmandu time", () => {
    expect(presetRange("today", NOW)).toEqual({ from: "2026-10-25", to: "2026-10-25" });
    expect(presetRange("yesterday", NOW)).toEqual({ from: "2026-10-24", to: "2026-10-24" });
    expect(presetRange("last7Days", NOW)).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(presetRange("last30Days", NOW)).toEqual({ from: "2026-09-26", to: "2026-10-25" });
    expect(presetRange("thisMonth", NOW)).toEqual({ from: "2026-10-01", to: "2026-10-25" });
    expect(presetRange("lastMonth", NOW)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    // 2026-10-31 18:20 UTC is already 1 November in Kathmandu
    const nov1 = new Date("2026-10-31T18:20:00Z");
    expect(presetRange("today", nov1)).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(presetRange("lastMonth", nov1)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("lastMonth", new Date("2027-01-10T06:00:00Z"))).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(presetRange("lastMonth", new Date("2028-03-10T06:00:00Z"))).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("previousRange = same number of days immediately before", () => {
    expect(previousRange("2026-10-25", "2026-10-25")).toEqual({
      from: "2026-10-24",
      to: "2026-10-24",
    });
    expect(previousRange("2026-10-19", "2026-10-25")).toEqual({
      from: "2026-10-12",
      to: "2026-10-18",
    });
    expect(previousRange("2026-10-01", "2026-10-25")).toEqual({
      from: "2026-09-06",
      to: "2026-09-30",
    });
    expect(previousRange("2026-03-01", "2026-03-31")).toEqual({
      from: "2026-01-29",
      to: "2026-02-28",
    });
    expect(previousRange("2026-01-01", "2026-12-31")).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
    const p = previousRange("2026-02-10", "2026-05-03");
    expect(daysInclusive(p.from, p.to)).toBe(daysInclusive("2026-02-10", "2026-05-03"));
    expect(addDays(p.to, 1)).toBe("2026-02-10");
    expect(() => previousRange("2026-10-25", "2026-10-24")).toThrow();
  });

  it("default grain: day <= 62 days, week <= 366, month above", () => {
    expect(defaultGrain("2026-10-25", "2026-10-25")).toBe("day");
    expect(defaultGrain("2026-08-25", "2026-10-25")).toBe("day"); // 62 days
    expect(daysInclusive("2026-08-25", "2026-10-25")).toBe(62);
    expect(defaultGrain("2026-08-24", "2026-10-25")).toBe("week"); // 63
    expect(defaultGrain("2024-01-01", "2024-12-31")).toBe("week"); // 366 (leap year)
    expect(defaultGrain("2024-01-01", "2025-01-01")).toBe("month"); // 367
  });

  it("staff window: today and yesterday in Kathmandu", () => {
    expect(staffMayUseDate("2026-10-25", NOW)).toBe(true);
    expect(staffMayUseDate("2026-10-24", NOW)).toBe(true);
    expect(staffMayUseDate("2026-10-23", NOW)).toBe(false);
    expect(staffMayUseDate("2026-10-26", NOW)).toBe(false);
  });
});

// ================================================================================================================
describe("stats input validation", () => {
  const fe = (input: unknown) => {
    const r = getStatsSchema.safeParse(input);
    return r.success
      ? null
      : Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
  };

  it("ISO dates, from <= to, at most 1,096 days (inclusive), same keys as the database", () => {
    expect(fe({ from: "2026-10-01", to: "2026-10-25" })).toBeNull();
    expect(fe({ from: "2026-10-26", to: "2026-10-25" })).toEqual({ range: MSG.rangeOrder });
    expect(fe({ from: "2024-01-01", to: "2026-12-31" })).toBeNull(); // 366 + 365 + 365 = 1096
    expect(daysInclusive("2024-01-01", "2026-12-31")).toBe(1096);
    expect(fe({ from: "2023-12-31", to: "2026-12-31" })).toEqual({ range: MSG.rangeTooLong });
    expect(fe({ from: "2026-10-1", to: "2026-10-25" })).toEqual({ from: MSG.date });
    expect(
      fe({
        from: "2026-10-01",
        to: "2026-10-25",
        compare: { from: "2026-09-30", to: "2026-09-01" },
      }),
    ).toEqual({
      "compare.range": MSG.rangeOrder,
    });
    expect(fe({ from: "2026-10-01", to: "2026-10-25", compare: "last-year" })).not.toBeNull();
    expect(fe({ from: "2026-10-01", to: "2026-10-25", grain: "year" })).not.toBeNull();
  });

  it("resolveStatsRange: compare previous (default) / none / custom, grain default or given", () => {
    const parse = (i: unknown) => resolveStatsRange(getStatsSchema.parse(i));
    expect(parse({ from: "2026-10-01", to: "2026-10-25" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-25",
      compareFrom: "2026-09-06",
      compareTo: "2026-09-30",
      grain: "day",
      timezone: "Asia/Kathmandu",
    });
    expect(parse({ from: "2026-10-01", to: "2026-10-25", compare: "none" })).toMatchObject({
      compareFrom: null,
      compareTo: null,
    });
    expect(
      parse({
        from: "2026-10-01",
        to: "2026-10-25",
        compare: { from: "2025-10-01", to: "2025-10-25" },
      }),
    ).toMatchObject({
      compareFrom: "2025-10-01",
      compareTo: "2025-10-25",
    });
    expect(parse({ from: "2026-01-01", to: "2026-10-25" }).grain).toBe("week");
    expect(parse({ from: "2024-01-01", to: "2026-10-25" }).grain).toBe("month");
    expect(parse({ from: "2024-01-01", to: "2026-10-25", grain: "day" }).grain).toBe("day");
  });

  it("log lines: qty 0..9999 whole, money ints, note length in characters, duplicates, prices stripped", () => {
    const base = { date: "2026-10-25", lines: [] as unknown[] };
    const keys = (i: unknown) => {
      const r = logDailySalesSchema.safeParse(i);
      return r.success ? [] : r.error.issues.map((x) => x.path.join("."));
    };
    expect(
      keys({
        ...base,
        lines: [
          { menuItemId: ITEM, qty: 0 },
          { menuItemId: ITEM, variantId: VAR, qty: 9999 },
        ],
      }),
    ).toEqual([]);
    expect(keys({ ...base, lines: [{ menuItemId: ITEM, qty: 10000 }] })).toEqual(["lines.0.qty"]);
    expect(keys({ ...base, lines: [{ menuItemId: ITEM, qty: -1 }] })).toEqual(["lines.0.qty"]);
    expect(keys({ ...base, lines: [{ menuItemId: ITEM, qty: 1.5 }] })).toEqual(["lines.0.qty"]);
    expect(keys({ ...base, lines: [{ menuItemId: ITEM, qty: "3" }] })).toEqual(["lines.0.qty"]);
    expect(keys({ ...base, lines: [{ menuItemId: "x", qty: 1 }] })).toEqual(["lines.0.menuItemId"]);
    expect(
      keys({
        ...base,
        lines: [
          { menuItemId: ITEM, qty: 1 },
          { menuItemId: ITEM.toUpperCase(), variantId: null, qty: 2 },
        ],
      }),
    ).toEqual(["lines.1"]);
    expect(
      keys({ ...base, lines: Array.from({ length: 501 }, () => ({ menuItemId: ITEM, qty: 1 })) }),
    ).toContain("lines");
    expect(keys({ ...base, tillTotalPaisa: 1_000_000_000 })).toEqual([]);
    expect(keys({ ...base, tillTotalPaisa: 1_000_000_001 })).toEqual(["tillTotalPaisa"]);
    expect(keys({ ...base, tillTotalPaisa: 100.5 })).toEqual(["tillTotalPaisa"]);
    expect(keys({ ...base, note: "न".repeat(500) })).toEqual([]);
    expect(keys({ ...base, note: "x".repeat(501) })).toEqual(["note"]);
    const parsed = logDailySalesSchema.parse({
      ...base,
      lines: [{ menuItemId: ITEM, qty: 2, unitPricePaisa: 1 }],
      note: "   ",
    });
    expect(parsed.lines[0]).toEqual({ menuItemId: ITEM, qty: 2 });
    expect(parsed.note).toBeNull();
  });
});

// ================================================================================================================
describe("roles", () => {
  it("anon can call nothing (UNAUTHENTICATED, no database call)", async () => {
    const f = use(
      null,
      fdb({
        rpc: {
          get_daily_sales: () => ok(null),
          upsert_daily_sales: () => ok(log()),
          ...statsHandlers(),
        },
      }),
    );
    for (const r of [
      await getDailySales({ date: "2026-10-25" }),
      await logDailySales({ date: "2026-10-25", lines: [] }),
      await getStats({ from: "2026-10-01", to: "2026-10-25" }),
    ]) {
      expect(r).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    }
    expect(f.rpcCalls).toHaveLength(0);
  });

  it("staff cannot call getStats (FORBIDDEN before any database call)", async () => {
    const f = use(STAFF, fdb({ rpc: statsHandlers() }));
    const r = await getStats({ from: "2026-10-01", to: "2026-10-25" });
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(f.rpcCalls).toHaveLength(0);
  });

  it("role is checked before input validation (no input detail leaks to the wrong role)", async () => {
    use(STAFF, fdb({}));
    expect(await getStats({ from: "nope" })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    use(null, fdb({}));
    expect(await logDailySales({})).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });

  it("staff and owner can read and log today; the verified profile id is sent as p_actor", async () => {
    for (const who of [STAFF, OWNER]) {
      const saved = log({ updatedBy: who.userId });
      const f = use(
        who,
        fdb({
          rpc: { get_daily_sales: () => ok(log()), upsert_daily_sales: () => ok(saved) },
          tables: { profiles: ok({ display_name: "Staff" }) },
        }),
      );
      expect(await getDailySales({ date: "2026-10-25" })).toEqual({ ok: true, data: named("Staff") });
      expect(
        await logDailySales({ date: "2026-10-25", lines: [], tillTotalPaisa: null, note: null }),
      ).toEqual({ ok: true, data: { ...saved, updatedByName: who.displayName } });
      expect(f.rpcCalls.map((c) => c.args.p_actor)).toEqual([who.userId, who.userId]);
    }
  });

  it("getDailySales returns null when nothing is logged", async () => {
    use(STAFF, fdb({ rpc: { get_daily_sales: () => ok(null) } }));
    expect(await getDailySales({ date: "2026-10-24" })).toEqual({ ok: true, data: null });
  });
});

// ================================================================================================================
describe("date window (app pre-check; the database is the authority)", () => {
  it("staff: today and yesterday only, clear VALIDATION, no database call", async () => {
    const f = use(
      STAFF,
      fdb({ rpc: { get_daily_sales: () => ok(null), upsert_daily_sales: () => ok(log()) } }),
    );
    expect(
      await logDailySales({ date: "2026-10-24", lines: [], tillTotalPaisa: null, note: null }),
    ).toMatchObject({ ok: true });
    expect(
      await logDailySales({ date: "2026-10-23", lines: [], tillTotalPaisa: null, note: null }),
    ).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { date: [MSG.staffLog] } },
    });
    expect(await getDailySales({ date: "2026-10-23" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { date: [MSG.staffRead] } },
    });
    expect(f.rpcCalls.map((c) => c.args.p_date)).toEqual(["2026-10-24"]);
  });

  it("staff window follows Kathmandu midnight, not UTC", async () => {
    vi.setSystemTime(new Date("2026-10-24T18:20:00Z")); // 00:05 on 25 Oct in Kathmandu, still 24 Oct in UTC
    const f = use(STAFF, fdb({ rpc: { upsert_daily_sales: () => ok(log()) } }));
    const body = { lines: [], tillTotalPaisa: null, note: null };
    expect(await logDailySales({ ...body, date: "2026-10-25" })).toMatchObject({ ok: true });
    expect(await logDailySales({ ...body, date: "2026-10-24" })).toMatchObject({ ok: true });
    expect(await logDailySales({ ...body, date: "2026-10-23" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(f.rpcCalls).toHaveLength(2);
  });

  it("owner: any past date from 2020, never the future", async () => {
    const f = use(
      OWNER,
      fdb({ rpc: { get_daily_sales: () => ok(null), upsert_daily_sales: () => ok(log()) } }),
    );
    const body = { lines: [], tillTotalPaisa: null, note: null };
    expect(await logDailySales({ ...body, date: "2025-03-01" })).toMatchObject({ ok: true });
    expect(await getDailySales({ date: "2021-06-01" })).toMatchObject({ ok: true });
    expect(await logDailySales({ ...body, date: "2026-10-26" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { date: [MSG.future] } },
    });
    expect(await getDailySales({ date: "2026-10-26" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(await logDailySales({ ...body, date: "2019-12-31" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { date: [MSG.tooOld] } },
    });
    expect(await logDailySales({ ...body, date: "2026-02-30" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { date: [MSG.date] } },
    });
    expect(f.rpcCalls).toHaveLength(2);
  });
});

// ================================================================================================================
describe("logDailySales", () => {
  it("sends lines without prices; omitted till/note keep the stored values (read first)", async () => {
    const f = use(
      STAFF,
      fdb({
        rpc: {
          get_daily_sales: () => ok(log({ tillTotalPaisa: 777, note: "kept" })),
          upsert_daily_sales: () => ok(log()),
        },
      }),
    );
    const r = await logDailySales({
      date: "2026-10-25",
      lines: [
        { menuItemId: ITEM, qty: 3, unitPricePaisa: 1, name: "hack" },
        { menuItemId: ITEM, variantId: VAR, qty: 0 },
      ],
    });
    expect(r).toMatchObject({ ok: true });
    expect(f.rpcCalls.map((c) => c.name)).toEqual(["get_daily_sales", "upsert_daily_sales"]);
    expect(f.rpcCalls[1]!.args).toEqual({
      p_date: "2026-10-25",
      p_lines: [
        { menuItemId: ITEM, variantId: null, qty: 3 },
        { menuItemId: ITEM, variantId: VAR, qty: 0 },
      ],
      p_till_total: 777,
      p_note: "kept",
      p_actor: STAFF.userId,
    });
  });

  it("explicit null clears; both header fields given = no extra read", async () => {
    const f = use(OWNER, fdb({ rpc: { upsert_daily_sales: () => ok(log()) } }));
    await logDailySales({ date: "2026-10-20", lines: [], tillTotalPaisa: null, note: "  " });
    expect(f.rpcCalls.map((c) => c.name)).toEqual(["upsert_daily_sales"]);
    expect(f.rpcCalls[0]!.args).toMatchObject({ p_till_total: null, p_note: null });
  });

  it("only one header field omitted: that one is read, the other is as sent", async () => {
    const f = use(
      OWNER,
      fdb({ rpc: { get_daily_sales: () => ok(null), upsert_daily_sales: () => ok(log()) } }),
    );
    await logDailySales({ date: "2026-10-20", lines: [], tillTotalPaisa: 5000 });
    expect(f.rpcCalls[1]!.args).toMatchObject({ p_till_total: 5000, p_note: null });
  });

  it("app-side line errors use the database's keys", async () => {
    use(STAFF, fdb({}));
    const r = await logDailySales({
      date: "2026-10-25",
      lines: [
        { menuItemId: ITEM, qty: 1 },
        { menuItemId: ITEM, qty: 2 },
      ],
    });
    expect(r).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { "lines.1": [MSG.duplicate] } },
    });
  });
});

// ================================================================================================================
describe("getStats", () => {
  it("calls all nine RPCs (2.0.0: + stats_table_orders) with the resolved ranges, grain, limit and p_actor, and bundles them", async () => {
    const f = use(OWNER, fdb({ rpc: statsHandlers() }));
    const r = await getStats({ from: "2026-10-01", to: "2026-10-25" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.range).toEqual({
      from: "2026-10-01",
      to: "2026-10-25",
      compareFrom: "2026-09-06",
      compareTo: "2026-09-30",
      grain: "day",
      timezone: "Asia/Kathmandu",
      demoDataDays: 0,
    });
    expect(Object.keys(r.data).sort()).toEqual(
      [
        "range",
        "overview",
        "timeseries",
        "topFood",
        "bestFoodPerDay",
        "topMerch",
        "heatmap",
        "cancellations",
        "stockAlerts",
        "tableOrders",
      ].sort(),
    );
    expect(r.data.overview).toEqual({ rpc: "stats_overview" });
    expect(r.data.heatmap).toEqual({ rpc: "stats_busy_heatmap" });
    expect(r.data.stockAlerts).toEqual({ rpc: "stats_stock_alerts" });

    const args = Object.fromEntries(f.rpcCalls.map((c) => [c.name, c.args]));
    expect(Object.keys(args).sort()).toEqual([...STATS_RPCS].sort());
    const rng = { p_from: "2026-10-01", p_to: "2026-10-25", p_actor: OWNER.userId };
    expect(args.stats_overview).toEqual({
      ...rng,
      p_cmp_from: "2026-09-06",
      p_cmp_to: "2026-09-30",
    });
    expect(args.stats_timeseries).toEqual({ ...rng, p_grain: "day" });
    expect(args.stats_top_food).toEqual({ ...rng, p_limit: 10 });
    expect(args.stats_top_merch).toEqual({ ...rng, p_limit: 10 });
    expect(args.stats_best_food_per_day).toEqual(rng);
    expect(args.stats_busy_heatmap).toEqual(rng);
    expect(args.stats_cancellations).toEqual(rng);
    expect(args.stats_stock_alerts).toEqual({ p_actor: OWNER.userId });
    // 9.11: the same range, no compare range, a separate block
    expect(args.stats_table_orders).toEqual(rng);
    expect(r.data.tableOrders).toEqual({ rpc: "stats_table_orders" });
  });

  it("compare none sends null compare dates; grain defaults by length and can be overridden", async () => {
    let f = use(OWNER, fdb({ rpc: statsHandlers() }));
    await getStats({ from: "2026-01-01", to: "2026-10-25", compare: "none" });
    let args = Object.fromEntries(f.rpcCalls.map((c) => [c.name, c.args]));
    expect(args.stats_overview).toMatchObject({ p_cmp_from: null, p_cmp_to: null });
    expect(args.stats_timeseries).toMatchObject({ p_grain: "week" });

    f = use(OWNER, fdb({ rpc: statsHandlers() }));
    await getStats({
      from: "2024-01-01",
      to: "2026-10-25",
      compare: { from: "2021-01-01", to: "2023-10-25" },
      grain: "day",
    });
    args = Object.fromEntries(f.rpcCalls.map((c) => [c.name, c.args]));
    expect(args.stats_overview).toMatchObject({ p_cmp_from: "2021-01-01", p_cmp_to: "2023-10-25" });
    expect(args.stats_timeseries).toMatchObject({ p_grain: "day" });
  });

  it("runs the RPCs and the demo count in parallel (all ten start before any finishes)", async () => {
    const started: string[] = [];
    const release: (() => void)[] = [];
    const later = (name: string, res: PgResult) => {
      started.push(name);
      return new Promise<PgResult>((resolve) => release.push(() => resolve(res)));
    };
    const countQuery = {
      select: () => countQuery,
      gte: () => countQuery,
      lte: () => countQuery,
      ilike: () => later("daily_sales", countRes(2)),
    };
    const db = {
      rpc: (name: string) => later(name, ok({ rpc: name })),
      from: () => countQuery,
    };
    state.user = OWNER;
    state.db = db;
    const p = getStats({ from: "2026-10-01", to: "2026-10-25" });
    await vi.waitFor(() => expect(started).toHaveLength(10)); // nine RPCs + the demo-day count
    release.forEach((r) => r());
    const r = await p;
    expect(r.ok && r.data.range.demoDataDays).toBe(2);
  });

  it("invalid ranges: VALIDATION with range / compare.range, no database call", async () => {
    const f = use(OWNER, fdb({ rpc: statsHandlers() }));
    expect(await getStats({ from: "2026-10-25", to: "2026-10-01" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { range: [MSG.rangeOrder] } },
    });
    expect(await getStats({ from: "2020-01-01", to: "2026-10-25" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { range: [MSG.rangeTooLong] } },
    });
    expect(
      await getStats({
        from: "2026-10-01",
        to: "2026-10-25",
        compare: { from: "2020-01-01", to: "2026-01-01" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { "compare.range": [MSG.rangeTooLong] } },
    });
    expect(f.rpcCalls).toHaveLength(0);
  });
});

// ================================================================================================================
describe("1.5.1: updatedByName on the daily log", () => {
  const SITA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const profileCalls = (f: ReturnType<typeof fakeDb>) =>
    f.tableCalls.filter((t) => t.table === "profiles").map((t) => t.calls);

  it("another person saved the day: their display_name is read from profiles by id (display_name only)", async () => {
    const f = use(
      OWNER,
      fdb({
        rpc: { get_daily_sales: () => ok(log({ updatedBy: SITA })) },
        // even if the row carried more columns, only display_name may reach the response
        tables: { profiles: ok({ display_name: "Sita", email: "sita@example.com" }) },
      }),
    );
    const r = await getDailySales({ date: "2026-10-24" });
    expect(r).toEqual({ ok: true, data: named("Sita", { updatedBy: SITA }) });
    expect(JSON.stringify(r)).not.toContain("@");
    expect(profileCalls(f)).toEqual([
      [
        { op: "select", args: ["display_name"] },
        { op: "eq", args: ["id", SITA] },
        { op: "maybeSingle", args: [] },
      ],
    ]);
  });

  it("the caller saved it: their own display name, no extra query", async () => {
    const f = use(STAFF, fdb({ rpc: { get_daily_sales: () => ok(log()) } }));
    expect(await getDailySales({ date: "2026-10-25" })).toEqual({ ok: true, data: named("Staff") });
    expect(profileCalls(f)).toEqual([]);
  });

  it("profile gone (deactivated staff) or updatedBy null: null, never an id or email", async () => {
    let f = use(OWNER, fdb({ rpc: { get_daily_sales: () => ok(log({ updatedBy: SITA })) } }));
    expect(await getDailySales({ date: "2026-10-24" })).toEqual({
      ok: true,
      data: named(null, { updatedBy: SITA }),
    });
    expect(profileCalls(f)).toHaveLength(1);

    f = use(OWNER, fdb({ rpc: { get_daily_sales: () => ok(log({ updatedBy: null })) } }));
    expect(await getDailySales({ date: "2026-10-24" })).toEqual({
      ok: true,
      data: named(null, { updatedBy: null }),
    });
    expect(profileCalls(f)).toHaveLength(0);

    use(
      OWNER,
      fdb({
        rpc: { get_daily_sales: () => ok(log({ updatedBy: SITA })) },
        tables: { profiles: ok({ display_name: 42 }) },
      }),
    );
    expect(await getDailySales({ date: "2026-10-24" })).toMatchObject({
      ok: true,
      data: { updatedByName: null },
    });
  });

  it("a failed name lookup does not fail the read: null, logged without PII", async () => {
    const err = vi.mocked(console.error);
    use(
      OWNER,
      fdb({
        rpc: { get_daily_sales: () => ok(log({ updatedBy: SITA })) },
        tables: { profiles: pgErr("57014", "canceling statement due to statement timeout") },
      }),
    );
    expect(await getDailySales({ date: "2026-10-24" })).toEqual({
      ok: true,
      data: named(null, { updatedBy: SITA }),
    });
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("daily_sales_name_lookup_failed") && l.includes("57014"))).toBe(true);
    expect(lines.join(" ")).not.toContain(SITA);
  });

  it("logDailySales returns the saved day with the saver's name (the caller), no profiles query", async () => {
    const f = use(
      OWNER,
      fdb({ rpc: { upsert_daily_sales: () => ok(log({ updatedBy: OWNER.userId })) } }),
    );
    const r = await logDailySales({ date: "2026-10-20", lines: [], tillTotalPaisa: null, note: null });
    expect(r).toEqual({ ok: true, data: named("Owner", { updatedBy: OWNER.userId }) });
    expect(profileCalls(f)).toEqual([]);
  });

  it("logDailySales: if the database names someone else as the saver, that name is looked up", async () => {
    use(
      STAFF,
      fdb({
        rpc: { upsert_daily_sales: () => ok(log({ updatedBy: SITA })) },
        tables: { profiles: ok({ display_name: "Sita" }) },
      }),
    );
    expect(
      await logDailySales({ date: "2026-10-25", lines: [], tillTotalPaisa: null, note: null }),
    ).toMatchObject({ ok: true, data: { updatedBy: SITA, updatedByName: "Sita" } });
  });

  it("no name lookup when nothing is logged or the save failed", async () => {
    let f = use(STAFF, fdb({ rpc: { get_daily_sales: () => ok(null) } }));
    expect(await getDailySales({ date: "2026-10-25" })).toEqual({ ok: true, data: null });
    expect(profileCalls(f)).toEqual([]);

    f = use(
      STAFF,
      fdb({
        rpc: { upsert_daily_sales: () => pgErr("P0001", "VALIDATION", JSON.stringify({ "lines.0": ["x"] })) },
      }),
    );
    expect(
      await logDailySales({ date: "2026-10-25", lines: [], tillTotalPaisa: null, note: null }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(profileCalls(f)).toEqual([]);
  });
});

// ================================================================================================================
describe("1.5.1: getStats range.demoDataDays", () => {
  it("one head-only exact count on daily_sales in from..to with note DEMO DATA (any case)", async () => {
    const f = use(
      OWNER,
      fdb({ rpc: statsHandlers(), tables: { daily_sales: countRes(17) } }),
    );
    const r = await getStats({ from: "2026-09-01", to: "2026-10-25" });
    expect(r.ok && r.data.range.demoDataDays).toBe(17);
    const q = f.tableCalls.filter((t) => t.table === "daily_sales");
    expect(q).toHaveLength(1);
    expect(q[0]!.calls).toEqual([
      { op: "select", args: ["id", { count: "exact", head: true }] },
      { op: "gte", args: ["business_date", "2026-09-01"] },
      { op: "lte", args: ["business_date", "2026-10-25"] },
      { op: "ilike", args: ["note", "DEMO DATA"] },
    ]);
    // the compare range is not counted: the banner is about the range on screen
    expect(JSON.stringify(q[0]!.calls)).not.toContain("2026-07");
  });

  it("no demo days: 0", async () => {
    use(OWNER, fdb({ rpc: statsHandlers() }));
    const r = await getStats({ from: "2026-10-01", to: "2026-10-25", compare: "none" });
    expect(r.ok && r.data.range.demoDataDays).toBe(0);
  });

  it("count failure or a missing count is INTERNAL (no SQL text leaks), like any stats RPC failure", async () => {
    use(
      OWNER,
      fdb({ rpc: statsHandlers(), tables: { daily_sales: pgErr("XX000", "boom: select note from daily_sales") } }),
    );
    const r1 = await getStats({ from: "2026-10-01", to: "2026-10-25" });
    expect(r1).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(r1)).not.toContain("boom");

    use(OWNER, fdb({ rpc: statsHandlers(), tables: { daily_sales: countRes(null) } }));
    expect(await getStats({ from: "2026-10-01", to: "2026-10-25" })).toMatchObject({
      ok: false,
      error: { code: "INTERNAL" },
    });
  });

  it("staff never reach the count (FORBIDDEN before any database call)", async () => {
    const f = use(STAFF, fdb({ rpc: statsHandlers() }));
    await getStats({ from: "2026-10-01", to: "2026-10-25" });
    expect(f.tableCalls).toHaveLength(0);
  });
});

// ================================================================================================================
describe("database error mapping (P0001 protocol, supabase/README.md)", () => {
  const securityLines = () =>
    warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"type":"security"') && l.includes('"event":"forbidden"'));

  it("FORBIDDEN from the database: hint shown, security event logged once with no PII", async () => {
    use(
      STAFF,
      fdb({
        rpc: {
          get_daily_sales: () =>
            pgErr("P0001", "FORBIDDEN", undefined, "Staff can see today and yesterday only."),
        },
      }),
    );
    const r = await getDailySales({ date: "2026-10-24" });
    expect(r).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "Staff can see today and yesterday only." },
    });
    const lines = securityLines();
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(ev).toMatchObject({
      event: "forbidden",
      userId: STAFF.userId,
      role: "staff",
      need: "staff",
      scope: "daily_sales",
      code: "db",
    });
    expect(Object.keys(ev).sort()).toEqual([
      "at",
      "code",
      "event",
      "level",
      "need",
      "role",
      "scope",
      "type",
      "userId",
    ]);
  });

  it("getStats: a FORBIDDEN from the RPCs (e.g. the profile was demoted) is FORBIDDEN, logged once", async () => {
    const forbid = () =>
      pgErr("P0001", "FORBIDDEN", undefined, "Statistics are for the owner only.");
    use(
      OWNER,
      fdb({ rpc: statsHandlers(Object.fromEntries(STATS_RPCS.map((n) => [n, forbid]))) }),
    );
    const r = await getStats({ from: "2026-10-01", to: "2026-10-25" });
    expect(r).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "Statistics are for the owner only." },
    });
    expect(securityLines()).toHaveLength(1);
    expect(JSON.parse(securityLines()[0]!)).toMatchObject({ scope: "stats", need: "owner" });
  });

  it("VALIDATION details become fieldErrors; tillTotal is renamed to the input's tillTotalPaisa", async () => {
    use(
      OWNER,
      fdb({
        rpc: {
          upsert_daily_sales: () =>
            pgErr(
              "P0001",
              "VALIDATION",
              JSON.stringify({
                tillTotal: ["0 to 1,000,000,000 paisa"],
                "lines.0": ["unknown menu item"],
              }),
            ),
        },
      }),
    );
    const r = await logDailySales({
      date: "2026-10-20",
      lines: [{ menuItemId: ITEM, qty: 1 }],
      tillTotalPaisa: 1,
      note: null,
    });
    expect(r).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION",
        fieldErrors: {
          tillTotalPaisa: ["0 to 1,000,000,000 paisa"],
          "lines.0": ["unknown menu item"],
        },
      },
    });
    expect(r.ok === false && r.error.fieldErrors?.tillTotal).toBeFalsy();
    expect(securityLines()).toHaveLength(0);
  });

  it("stats VALIDATION from the database passes through (compare.range)", async () => {
    use(
      OWNER,
      fdb({
        rpc: statsHandlers({
          stats_overview: () =>
            pgErr(
              "P0001",
              "VALIDATION",
              JSON.stringify({ "compare.range": ["at most 1096 days"] }),
            ),
        }),
      }),
    );
    expect(await getStats({ from: "2026-10-01", to: "2026-10-25" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { "compare.range": ["at most 1096 days"] } },
    });
  });

  it("anything else is INTERNAL with the generic message (no SQL text leaks)", async () => {
    use(
      OWNER,
      fdb({
        rpc: statsHandlers({
          stats_top_food: () => pgErr("42501", "permission denied for function stats_top_food"),
        }),
      }),
    );
    const r1 = await getStats({ from: "2026-10-01", to: "2026-10-25" });
    // 42501 (a missing EXECUTE grant) goes through unwrap -> mapDbError -> FORBIDDEN, never the raw text.
    expect(JSON.stringify(r1)).not.toContain("permission denied");
    expect(r1).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    use(
      OWNER,
      fdb({
        rpc: statsHandlers({ stats_top_food: () => pgErr("XX000", "boom: select * from secret") }),
      }),
    );
    const r2 = await getStats({ from: "2026-10-01", to: "2026-10-25" });
    expect(r2).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(r2)).not.toContain("secret");

    use(OWNER, fdb({ rpc: statsHandlers({ stats_cancellations: () => ok(null) }) }));
    expect(await getStats({ from: "2026-10-01", to: "2026-10-25" })).toMatchObject({
      ok: false,
      error: { code: "INTERNAL" },
    });

    use(STAFF, fdb({ rpc: { upsert_daily_sales: () => ok(null) } }));
    expect(
      await logDailySales({ date: "2026-10-25", lines: [], tillTotalPaisa: null, note: null }),
    ).toMatchObject({
      ok: false,
      error: { code: "INTERNAL" },
    });
  });
});

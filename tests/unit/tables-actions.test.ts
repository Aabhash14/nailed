import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/roles";
import { fakeDb, ok, pgErr, type PgResult } from "./helpers/fake-db";

// ---- module mocks: no real Supabase, no Next runtime (same pattern as admin-actions.test.ts) ---------------------
const state = vi.hoisted(() => ({
  user: null as null | { userId: string; role: "owner" | "staff"; displayName: string },
  db: null as unknown,
  scheduled: [] as (() => Promise<unknown>)[],
}));

vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("@/lib/deps", () => ({
  scheduleAfter: (w: () => Promise<unknown>) => void state.scheduled.push(w),
  ipSalt: () => "s".repeat(32),
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

import { revalidatePath, revalidateTag } from "next/cache";
import { getAlertCount, listAlerts, markAlertsRead } from "@/app/admin/_actions/alerts";
import { getSettings, updateSettings } from "@/app/admin/_actions/settings";
import {
  cancelTableRound,
  closeTable,
  getTableBoard,
  listCafeTables,
  openTable,
  rotateTableCode,
  saveCafeTables,
  setTableOrdering,
  setTableOrdersLocked,
  setTableRoundStatus,
} from "@/app/admin/_actions/tables";
import { alertData, deliveryStatus } from "@/lib/tables/alerts";
import { DB_INACTIVE_NUMBER_TEXT } from "@/lib/tables/save-errors";

const OWNER = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "owner", displayName: "Owner" } as const;
const STAFF = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "staff", displayName: "Sita" } as const;
const ID = "3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";
const ID2 = "4f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3c";

function use(user: AuthContext | null, f: ReturnType<typeof fakeDb>) {
  state.user = user;
  state.db = f.db;
  return f;
}

let logs: string[] = [];
beforeEach(() => {
  state.scheduled = [];
  logs = [];
  for (const m of ["info", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  }
  vi.mocked(revalidateTag).mockClear();
  vi.mocked(revalidatePath).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  // ADR 0002 rule 2: no table or alert action ever revalidates
  expect(revalidateTag).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
});

const round = (over: Record<string, unknown> = {}) => ({
  id: ID2,
  round: 1,
  status: "cancelled",
  items: [],
  note: null,
  subtotal: 100,
  createdAt: "2026-10-26T04:00:00Z",
  acceptedAt: null,
  servedAt: null,
  cancelledAt: "2026-10-26T04:05:00Z",
  cancelReason: "mistake",
  cancelledByName: "Sita",
  staffCanCancelUntil: null,
  ...over,
});

// ================================================================================================================
describe("tables actions (9.7)", () => {
  it("each action calls its RPC with the verified actor (p_actor), never a client-supplied one", async () => {
    const calls: [string, () => Promise<unknown>, string, Record<string, unknown>][] = [
      ["list", () => listCafeTables(), "list_cafe_tables", { p_actor: STAFF.userId }],
      ["board", () => getTableBoard({ since: "12-20261026" }), "table_board", { p_since: "12-20261026", p_actor: STAFF.userId }],
      ["board, first call", () => getTableBoard(), "table_board", { p_since: null, p_actor: STAFF.userId }],
      ["open", () => openTable({ tableId: ID, p_actor: OWNER.userId }), "open_table_session", { p_table_id: ID, p_actor: STAFF.userId }],
      ["rotate", () => rotateTableCode({ sessionId: ID }), "rotate_table_code", { p_session_id: ID, p_actor: STAFF.userId }],
      ["lock", () => setTableOrdersLocked({ sessionId: ID, locked: true }), "set_table_orders_locked", { p_session_id: ID, p_locked: true, p_actor: STAFF.userId }],
      ["accept", () => setTableRoundStatus({ roundId: ID, status: "preparing" }), "transition_table_order", { p_order_id: ID, p_to: "preparing", p_reason: null, p_actor: STAFF.userId }],
      ["mode", () => setTableOrdering({ mode: "paused" }), "set_table_ordering", { p_mode: "paused", p_actor: STAFF.userId }],
    ];
    for (const [label, run, rpc, args] of calls) {
      const f = use(STAFF, fakeDb({ rpc: { [rpc]: () => ok(rpc === "set_table_ordering" ? "paused" : { rows: [], changed: false }) } }));
      const r = await run();
      expect((r as { ok: boolean }).ok, label).toBe(true);
      expect(f.rpcCalls, label).toEqual([{ name: rpc, args }]);
    }
  });

  it("owner-only: staff calling saveCafeTables get FORBIDDEN with no database call; no session = UNAUTHENTICATED", async () => {
    const f = use(STAFF, fakeDb({}));
    expect(await saveCafeTables({ tables: [] })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    use(null, f);
    expect(await listCafeTables()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(await getTableBoard({})).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(f.rpcCalls).toHaveLength(0);
  });

  it("saveCafeTables: full set to save_cafe_tables; the inactive-number error gets the 2.3.0 text with the typed number", async () => {
    const f = use(
      OWNER,
      fakeDb({
        rpc: {
          save_cafe_tables: () =>
            pgErr("P0001", "VALIDATION", JSON.stringify({ "tables.1.number": [DB_INACTIVE_NUMBER_TEXT] })),
        },
      }),
    );
    const r = await saveCafeTables({ tables: [{ id: ID, number: 1, label: " Window ", isActive: true }, { number: 4, isActive: true }] });
    expect(r).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", fieldErrors: { "tables.1.number": ["Table 4 is still on file as inactive. Turn it back on instead."] } },
    });
    expect(f.rpcCalls[0]?.args).toEqual({
      p_tables: [
        { id: ID, number: 1, label: "Window", isActive: true },
        { number: 4, label: null, isActive: true },
      ],
      p_actor: OWNER.userId,
    });
  });

  it("CONFLICT / NOT_FOUND hints pass through as the safe message", async () => {
    use(STAFF, fakeDb({ rpc: { open_table_session: () => pgErr("P0001", "CONFLICT", undefined, "Table 7 is still open from 18:05. Close it first, or press New code.") } }));
    expect(await openTable({ tableId: ID })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: "Table 7 is still open from 18:05. Close it first, or press New code." },
    });
  });

  it("a database FORBIDDEN (staff void after acceptance) is logged as forbidden with scope tables", async () => {
    use(STAFF, fakeDb({ rpc: { close_table_session: () => pgErr("P0001", "FORBIDDEN", undefined, "Only the owner can void a table after an order was accepted.") } }));
    const r = await closeTable({ sessionId: ID, outcome: "void", expectedTotal: 0 });
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN", message: "Only the owner can void a table after an order was accepted." } });
    const line = logs.find((l) => l.includes('"event":"forbidden"'));
    expect(line).toContain('"scope":"tables"');
    expect(line).toContain(`"userId":"${STAFF.userId}"`);
  });

  it("closeTable: paid sends paidVia; void sends null, logs table_audit {kind, sessionId, profileId}; notifier hook adds nothing in v1", async () => {
    const summary = { sessionId: ID, tableNumber: 7, outcome: "void", total: 0, rounds: 0 };
    let f = use(OWNER, fakeDb({ rpc: { close_table_session: () => ok(summary) } }));
    expect((await closeTable({ sessionId: ID, outcome: "paid", paidVia: "cash", expectedTotal: 2500 })).ok).toBe(true);
    expect(f.rpcCalls[0]?.args).toEqual({ p_session_id: ID, p_outcome: "paid", p_paid_via: "cash", p_expected_total: 2500, p_actor: OWNER.userId });
    expect(logs.some((l) => l.includes("table_audit"))).toBe(false);

    f = use(OWNER, fakeDb({ rpc: { close_table_session: () => ok(summary) } }));
    expect((await closeTable({ sessionId: ID, outcome: "void", expectedTotal: 0 })).ok).toBe(true);
    expect(f.rpcCalls[0]?.args.p_paid_via).toBeNull();
    const audit = logs.find((l) => l.includes('"event":"table_audit"'));
    expect(audit).toContain('"kind":"void"');
    expect(audit).toContain(`"sessionId":"${ID}"`);
    expect(audit).toContain(`"profileId":"${OWNER.userId}"`);
    expect(audit).not.toMatch(/total|amount|2500/);
    expect(state.scheduled).toHaveLength(0); // no channel enabled (2.3.0)
  });

  it("closeTable: validation before any call (paidVia rules)", async () => {
    const f = use(STAFF, fakeDb({}));
    expect(await closeTable({ sessionId: ID, outcome: "paid", expectedTotal: 1 })).toMatchObject({ ok: false, error: { fieldErrors: { paidVia: expect.any(Array) } } });
    expect(f.rpcCalls).toHaveLength(0);
  });

  it("cancelTableRound: an accepted round is audited with its session id; an unaccepted one is not", async () => {
    let f = use(
      STAFF,
      fakeDb({
        rpc: { transition_table_order: () => ok(round({ acceptedAt: "2026-10-26T04:01:00Z" })) },
        tables: { table_orders: ok({ session_id: ID }) },
      }),
    );
    expect((await cancelTableRound({ roundId: ID2, reason: "mistake" })).ok).toBe(true);
    expect(f.rpcCalls[0]?.args).toEqual({ p_order_id: ID2, p_to: "cancelled", p_reason: "mistake", p_actor: STAFF.userId });
    const audit = logs.find((l) => l.includes('"event":"table_audit"'));
    expect(audit).toContain('"kind":"cancel_after_accept"');
    expect(audit).toContain(`"sessionId":"${ID}"`);

    logs = [];
    f = use(STAFF, fakeDb({ rpc: { transition_table_order: () => ok(round()) } }));
    await cancelTableRound({ roundId: ID2, reason: "guest_request" });
    expect(logs.some((l) => l.includes("table_audit"))).toBe(false);
    expect(f.tableCalls).toHaveLength(0);
    expect(await cancelTableRound({ roundId: ID2, reason: "session_closed" })).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { reason: expect.any(Array) } } });
  });

  it("staff cancelling after the window gets the database's FORBIDDEN text", async () => {
    const hint = "Only the owner can cancel this order now. The kitchen accepted it more than 10 minutes ago.";
    use(STAFF, fakeDb({ rpc: { transition_table_order: () => pgErr("P0001", "FORBIDDEN", undefined, hint) } }));
    expect(await cancelTableRound({ roundId: ID2, reason: "mistake" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", message: hint } });
  });

  it("no table-ordering source file mentions revalidateTag / revalidatePath (reviewer grep, contract section 6)", () => {
    const root = join(__dirname, "..", "..", "src");
    const files = [
      join(root, "app", "admin", "_actions", "tables.ts"),
      join(root, "app", "admin", "_actions", "alerts.ts"),
      join(root, "lib", "notify", "notifier.ts"),
    ];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(join(root, "lib", "tables"));
    walk(join(root, "app", "api", "table"));
    for (const p of files) expect(readFileSync(p, "utf8"), p).not.toMatch(/revalidate(Tag|Path)/);
  });
});

// ================================================================================================================
describe("alerts actions (9.10, 2.3.0)", () => {
  const alertRow = (over: Record<string, unknown> = {}) => ({
    id: ID,
    kind: "table_void",
    text: "Table 7 voided by Sita (Rs. 2,400, 3 accepted rounds).",
    data: { tableNumber: 7, amount: 240000, actorName: "Sita", acceptedRounds: 3, code: "K7M4QX", phone: "+9779800000000" },
    created_at: "2026-10-26T04:00:00Z",
    read_at: null,
    read_by: null,
    session_id: ID2,
    ...over,
  });

  function alertsDb(rows: unknown[], unread = 2) {
    return fakeDb({
      tables: {
        admin_alerts: (calls) => {
          const head = calls.some((c) => c.op === "select" && (c.args[1] as { head?: boolean } | undefined)?.head);
          return head ? ({ data: null, error: null, count: unread } as PgResult) : ({ data: rows, error: null, count: rows.length } as PgResult);
        },
        profiles: ok([{ id: OWNER.userId, display_name: "Owner" }]),
      },
    });
  }

  it("owner only: staff get FORBIDDEN on all three, with no database call", async () => {
    const f = use(STAFF, alertsDb([]));
    for (const r of [await listAlerts({}), await markAlertsRead({ all: true }), await getAlertCount()]) {
      expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
    expect(f.tableCalls).toHaveLength(0);
    expect(f.rpcCalls).toHaveLength(0);
  });

  it("listAlerts: newest first, delivery [] (no channel), data allow-listed, readByName from profiles, unread count", async () => {
    const f = use(
      OWNER,
      alertsDb([
        alertRow(),
        alertRow({ id: ID2, kind: "table_join_fail", data: { tableNumber: null, failures: 51 }, read_at: "2026-10-26T05:00:00Z", read_by: OWNER.userId }),
      ]),
    );
    const r = await listAlerts({ page: 1, pageSize: 25 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.unread).toBe(2);
    expect(r.data.total).toBe(2);
    expect(r.data.rows[0]).toEqual({
      id: ID,
      kind: "table_void",
      createdAt: "2026-10-26T04:00:00Z",
      text: "Table 7 voided by Sita (Rs. 2,400, 3 accepted rounds).",
      data: { tableNumber: 7, amount: 240000, actorName: "Sita", acceptedRounds: 3 },
      readAt: null,
      readByName: null,
      delivery: [],
    });
    expect(r.data.rows[1]).toMatchObject({ data: { failures: 51 }, readByName: "Owner", delivery: [] });
    expect(r.data.rows[1]?.data).not.toHaveProperty("tableNumber");
    expect(JSON.stringify(r.data)).not.toMatch(/K7M4QX|9800000000|whatsapp/);
    expect(f.tableCalls.some((c) => c.table === "alert_deliveries")).toBe(false);
    const list = f.tableCalls.find((c) => c.table === "admin_alerts" && c.calls.some((x) => x.op === "range"));
    expect(list?.calls.find((x) => x.op === "order")?.args).toEqual(["created_at", { ascending: false }]);
    expect(list?.calls.find((x) => x.op === "range")?.args).toEqual([0, 24]);
  });

  it("listAlerts unreadOnly filters read_at is null; markAlertsRead sends ids or all with the actor", async () => {
    let f = use(OWNER, alertsDb([]));
    await listAlerts({ unreadOnly: true, page: 2, pageSize: 10 });
    const list = f.tableCalls.find((c) => c.table === "admin_alerts" && c.calls.some((x) => x.op === "range"));
    expect(list?.calls.find((x) => x.op === "is")?.args).toEqual(["read_at", null]);
    expect(list?.calls.find((x) => x.op === "range")?.args).toEqual([10, 19]);

    f = use(OWNER, fakeDb({ rpc: { mark_admin_alerts_read: () => ok(3) } }));
    expect(await markAlertsRead({ ids: [ID] })).toEqual({ ok: true, data: { unread: 3 } });
    expect(f.rpcCalls[0]?.args).toEqual({ p_ids: [ID], p_all: false, p_actor: OWNER.userId });
    f = use(OWNER, fakeDb({ rpc: { mark_admin_alerts_read: () => ok(0) } }));
    expect(await markAlertsRead({ all: true })).toEqual({ ok: true, data: { unread: 0 } });
    expect(f.rpcCalls[0]?.args).toEqual({ p_ids: null, p_all: true, p_actor: OWNER.userId });
    expect(await markAlertsRead({})).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { ids: expect.any(Array) } } });
  });

  it("getAlertCount: one head-only count of unread alerts", async () => {
    const f = use(OWNER, alertsDb([], 5));
    expect(await getAlertCount()).toEqual({ ok: true, data: { unread: 5 } });
    expect(f.tableCalls).toHaveLength(1);
  });

  it("delivery status rules for when a channel exists (review item 9)", () => {
    const now = Date.parse("2026-10-27T05:00:00Z");
    const fresh = "2026-10-27T04:00:00Z";
    const old = "2026-10-26T04:00:00Z";
    expect(deliveryStatus(undefined, fresh, now)).toBe("pending");
    expect(deliveryStatus(undefined, old, now)).toBe("failed");
    expect(deliveryStatus({ status: "sent", attempts: 1 }, old, now)).toBe("sent");
    expect(deliveryStatus({ status: "failed", attempts: 1 }, fresh, now)).toBe("pending");
    expect(deliveryStatus({ status: "failed", attempts: 3 }, fresh, now)).toBe("failed");
    expect(deliveryStatus({ status: "sending", attempts: 1 }, fresh, now)).toBe("pending");
    expect(alertData({ reason: "bogus", round: 2, minutesAfterAccept: 4 })).toEqual({ round: 2, minutesAfterAccept: 4 });
  });
});

// ================================================================================================================
describe("settings (2.2.0 / 2.3.0)", () => {
  const site = {
    cafe_name: "Nailed", hours: { weekly: {}, closures: [] }, announcement: null, phone: null, whatsapp: null, email: null,
    address: null, landmark: null, map_url: null, prices_include_vat: true, service_charge_pct: 0, delivery_fee_paisa: 0,
    delivery_areas: [], min_order_delivery_paisa: 0, min_order_pickup_paisa: 0, payment_methods_enabled: ["pickup"],
    features: { lodge: false }, orders_paused: false, table_ordering: "paused",
  };
  const rules = {
    cod_max_total_paisa: null, max_open_orders_per_phone: 2, ip_open_orders_max: 3, ip_orders_max_per_day: 10,
    auto_cancel_placed_after_minutes: 120, staff_cancel_window_minutes: 7, owner_alert_whatsapp: [],
  };
  const settingsDb = (update?: (calls: { op: string; args: unknown[] }[]) => PgResult) =>
    fakeDb({
      tables: {
        site_settings: (calls) => (calls.some((c) => c.op === "update") && update ? update(calls) : ok(site)),
        order_rules: (calls) => (calls.some((c) => c.op === "update") && update ? update(calls) : ok(rules)),
      },
    });

  it("getSettings carries tableOrdering, staffCancelWindowMinutes and ownerAlertWhatsApp", async () => {
    use(OWNER, settingsDb());
    const r = await getSettings();
    expect(r).toMatchObject({ ok: true, data: { tableOrdering: "paused", staffCancelWindowMinutes: 7, ownerAlertWhatsApp: [] } });
  });

  it("updateSettings refuses tableOrdering (use setTableOrdering) and never writes table_ordering", async () => {
    const f = use(OWNER, settingsDb(() => ok(null)));
    const r = await updateSettings({ tableOrdering: "off" });
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(f.tableCalls).toHaveLength(0);
    await updateSettings({ cafeName: "Nailed Cafe", staffCancelWindowMinutes: 0, ownerAlertWhatsApp: ["9841234567"] });
    const updates = f.tableCalls.flatMap((t) => t.calls.filter((c) => c.op === "update").map((c) => [t.table, c.args[0]]));
    expect(updates).toEqual([
      ["site_settings", { cafe_name: "Nailed Cafe" }],
      ["order_rules", { staff_cancel_window_minutes: 0, owner_alert_whatsapp: ["+9779841234567"] }],
    ]);
    for (const [, row] of updates) expect(row).not.toHaveProperty("table_ordering");
    vi.mocked(revalidateTag).mockClear(); // updateSettings is a settings action: it revalidates settings + menu by design
  });

  it("field-error keys: staffCancelWindowMinutes, ownerAlertWhatsApp.N; database CHECK names map to the fields", async () => {
    use(OWNER, settingsDb());
    expect(await updateSettings({ staffCancelWindowMinutes: 61 })).toMatchObject({ error: { fieldErrors: { staffCancelWindowMinutes: expect.any(Array) } } });
    expect(await updateSettings({ ownerAlertWhatsApp: ["9841234567", "12"] })).toMatchObject({ error: { fieldErrors: { "ownerAlertWhatsApp.1": ["Enter a valid Nepal mobile number"] } } });
    use(OWNER, settingsDb(() => pgErr("23514", 'new row for relation "order_rules" violates check constraint "order_rules_staff_cancel_window_range"')));
    expect(await updateSettings({ staffCancelWindowMinutes: 5 })).toMatchObject({ error: { code: "VALIDATION", fieldErrors: { staffCancelWindowMinutes: expect.any(Array) } } });
    vi.mocked(revalidateTag).mockClear();
  });
});

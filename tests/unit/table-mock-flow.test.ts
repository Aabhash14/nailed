import { beforeEach, describe, expect, it } from "vitest";
import { seedDb, type MockDb } from "@/mocks/seed";
import {
  computeTableBill,
  mockCancelTableRound,
  mockCloseTable,
  mockCreateTableRound,
  mockGetAlertCount,
  mockGetTableBoard,
  mockGuestState,
  mockJoinTable,
  mockListAlerts,
  mockMarkAlertsRead,
  mockOccupancy,
  mockOpenTable,
  mockRotateTableCode,
  mockSaveCafeTables,
  mockSetTableOrdering,
  mockSetTableOrdersLocked,
  mockSetTableRoundStatus,
  mockTableStats,
  randomTableCode,
  sweepExpiredTables,
  JOIN_FAIL_TABLE_LIMIT,
  type MockTableCookie,
} from "@/mocks/tables";
import { TABLE_STOPPED_MESSAGE, type TableBoard, type ActionResult } from "@/types/contract";

/**
 * A realistic evening through the mock table-ordering "server" (contract 2.2.0 section 9): open a table, join,
 * place two rounds, staff move them through their statuses, close as paid. Plus the security-review rules the UI
 * depends on (SEC-022 cancel/void, SEC-023 new code and stop, SEC-027 replays) and the owner alerts (9.10).
 */

const T0 = Date.parse("2026-10-25T08:00:00Z"); // 13:45 Kathmandu
const min = (n: number) => T0 + n * 60_000;
const TEA = "00000000-0000-4000-8002-000000000001"; // 120
const COFFEE = "00000000-0000-4000-8002-000000000002"; // 150, options: Oat milk (sold out), Large +30
const LARGE = "00000000-0000-4000-8004-000000000002";
const OAT = "00000000-0000-4000-8004-000000000001";
const MOMO = "00000000-0000-4000-8002-000000000006"; // 260
const CHAI = "00000000-0000-4000-8002-000000000003"; // sold out
const TABLE3 = "00000000-0000-4000-8019-000000000003";
const id = (n: number) => `00000000-0000-4000-8aaa-${String(n).padStart(12, "0")}`;

function ok<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}
function err<T>(r: ActionResult<T>) {
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

let db: MockDb;
beforeEach(() => {
  db = seedDb(new Date(T0));
});

describe("a whole table, start to finish", () => {
  it("open -> join -> 2 rounds -> accept / serve -> close paid", () => {
    // Staff open table 3 (free in the seed); the guest sees it busy on the menu poll.
    expect(mockOccupancy(db, T0)!.tables.find((t) => t.number === 3)!.occupied).toBe(false);
    const opened = ok(mockOpenTable(db, "Sita", TABLE3, T0, "K7N4QX"));
    expect(opened.joinPath).toBe("/menu?t=3#c=K7N4QX");
    const occ = mockOccupancy(db, T0)!;
    expect(occ.tables.find((t) => t.number === 3)!.occupied).toBe(true);
    expect(occ.free).toBe(occ.tables.filter((t) => !t.occupied).length);

    // Join: wrong code, then the scanned one (typed with a space and in lower case)
    expect(err(mockJoinTable(db, { table: 3, code: "K7N4QA", turnstileToken: "t" }, min(1))).fieldErrors?.code).toEqual([
      "That code doesn't match this table. Check it, or ask our staff.",
    ]);
    const joined = ok(mockJoinTable(db, { table: 3, code: "k7n 4qx", turnstileToken: "t" }, min(1)));
    const cookie: MockTableCookie = { sessionId: joined.sessionId, epoch: joined.epoch };
    expect(joined.view).toMatchObject({ tableNumber: 3, ordering: "on", rounds: [] });
    expect(JSON.stringify(joined.view)).not.toMatch(/K7N4QX|Sita/); // SEC-029: no code, no staff names

    // Round 1: two teas (sent as two lines, merged) + a large coffee, with a note
    const r1 = ok(
      mockCreateTableRound(db, cookie, {
        clientRequestId: id(1),
        items: [{ menuItemId: TEA, qty: 1 }, { menuItemId: COFFEE, variantIds: [LARGE], qty: 1 }, { menuItemId: TEA, qty: 1 }],
        note: "less sugar",
      }, min(2)),
    );
    expect(r1).toMatchObject({ round: 1, replayed: false });
    expect(r1.session.rounds[0]!.items.map((l) => [l.name, l.options, l.qty, l.unitPrice])).toEqual([
      ["Sample milk tea", null, 2, 12000],
      ["Sample black coffee", "Large", 1, 18000],
    ]);
    expect(r1.session.bill).toMatchObject({ subtotal: 42000, total: 42000 }); // seed: VAT inside, no service charge

    // Round 2
    const r2 = ok(mockCreateTableRound(db, cookie, { clientRequestId: id(2), items: [{ menuItemId: MOMO, qty: 1 }] }, min(5)));
    expect(r2.round).toBe(2);

    // The guest's change-only view
    const rev = r2.session.rev;
    expect(mockGuestState(db, cookie, rev, min(6))).toEqual({ state: "unchanged", rev });

    // Staff board: change-only cursor
    const b1 = ok(mockGetTableBoard(db, undefined, min(6))) as TableBoard;
    const card = b1.tables.find((t) => t.number === 3)!;
    expect(card.session!.waiting).toEqual({ new: 2, preparing: 0 });
    expect(ok(mockGetTableBoard(db, b1.cursor, min(6)))).toMatchObject({ changed: false });

    // Staff: accept round 1, serve it; serve round 2 straight away (also accepts it)
    const [s1, s2] = card.session!.rounds;
    expect(ok(mockSetTableRoundStatus(db, s1!.id, "preparing", min(7)))).toMatchObject({ status: "preparing", staffCanCancelUntil: new Date(min(17)).toISOString() });
    ok(mockSetTableRoundStatus(db, s1!.id, "served", min(15)));
    const served2 = ok(mockSetTableRoundStatus(db, s2!.id, "served", min(16)));
    expect(served2.acceptedAt).toBe(new Date(min(16)).toISOString());
    expect(err(mockSetTableRoundStatus(db, s2!.id, "preparing", min(16))).message).toBe("That status change is not allowed.");

    // The guest sees both served (and stops polling)
    const view = mockGuestState(db, cookie, rev, min(17));
    expect(view.state === "open" && view.session.rounds.map((r) => r.status)).toEqual(["served", "served"]);

    // Close: the board moved, so an old expected total is refused; the right one closes it
    const b2 = ok(mockGetTableBoard(db, b1.cursor, min(20))) as TableBoard;
    const s = b2.tables.find((t) => t.number === 3)!.session!;
    expect(s.bill.total).toBe(68000);
    expect(err(mockCloseTable(db, "staff", "Sita", { sessionId: s.id, outcome: "paid", paidVia: "cash", expectedTotal: 42000 }, min(21))).message).toBe(
      "The total changed. Check the new total and close again.",
    );
    const closed = ok(mockCloseTable(db, "staff", "Sita", { sessionId: s.id, outcome: "paid", paidVia: "fonepay", expectedTotal: 68000 }, min(21)));
    expect(closed).toMatchObject({ outcome: "paid", paidVia: "fonepay", total: 68000, rounds: 2, closedByName: "Sita" });

    // Afterwards: the guest's cookie is dead, the table is free, the day totals add up, the stats see it
    expect(mockGuestState(db, cookie, undefined, min(22))).toEqual({ state: "closed", tableNumber: 3 });
    expect(err(mockCreateTableRound(db, cookie, { clientRequestId: id(3), items: [{ menuItemId: TEA, qty: 1 }] }, min(22))).code).toBe("TABLE_SESSION_INVALID");
    expect(mockOccupancy(db, min(22))!.tables.find((t) => t.number === 3)!.occupied).toBe(false);
    const b3 = ok(mockGetTableBoard(db, undefined, min(22))) as TableBoard;
    expect(b3.closedToday[0]).toMatchObject({ tableNumber: 3, outcome: "paid", total: 68000 });
    expect(b3.closedTodayTotals.byPaidVia.fonepay).toBeGreaterThanOrEqual(68000);
    const stats = mockTableStats(db, "2026-10-25", "2026-10-25");
    expect(stats.topItems.find((i) => i.menuItemId === MOMO)!.qty).toBeGreaterThanOrEqual(1);
    expect(stats.byHour).toHaveLength(24);
  });
});

describe("guest-side refusals", () => {
  function joinNew(at = T0) {
    const s = ok(mockOpenTable(db, "Sita", TABLE3, at, "K7N4QX"));
    const j = ok(mockJoinTable(db, { table: 3, code: "K7N4QX", turnstileToken: "t" }, at));
    return { session: s, cookie: { sessionId: j.sessionId, epoch: j.epoch } };
  }
  it("same answer for a free table, an unknown table and a wrong code", () => {
    const msgs = [
      err(mockJoinTable(db, { table: 4, code: "K7N4QX", turnstileToken: "t" }, T0)).message,
      err(mockJoinTable(db, { table: 42, code: "K7N4QX", turnstileToken: "t" }, T0)).message,
      err(mockJoinTable(db, { table: 2, code: "K7N4QX", turnstileToken: "t" }, T0)).message,
    ];
    expect(new Set(msgs).size).toBe(1);
  });
  it("sold out and invalid options are refused with the line index", () => {
    const { cookie } = joinNew();
    expect(err(mockCreateTableRound(db, cookie, { clientRequestId: id(1), items: [{ menuItemId: TEA, qty: 1 }, { menuItemId: CHAI, qty: 1 }] }, T0)).fieldErrors).toEqual({ "items.1": ["sold out"] });
    expect(err(mockCreateTableRound(db, cookie, { clientRequestId: id(2), items: [{ menuItemId: COFFEE, variantIds: [OAT], qty: 1 }] }, T0)).code).toBe("OUT_OF_STOCK");
    expect(err(mockCreateTableRound(db, cookie, { clientRequestId: id(3), items: [{ menuItemId: COFFEE, variantIds: [LARGE, LARGE], qty: 1 }] }, T0)).code).toBe("VALIDATION");
  });
  it("notes with control or bidi characters are refused (the frontend strips them first)", () => {
    const { cookie } = joinNew();
    expect(err(mockCreateTableRound(db, cookie, { clientRequestId: id(1), items: [{ menuItemId: TEA, qty: 1 }], note: "a‮b" }, T0)).fieldErrors).toHaveProperty("note");
  });
  it("3 rounds waiting as new stop the 4th", () => {
    const { cookie } = joinNew();
    for (let i = 1; i <= 3; i++) ok(mockCreateTableRound(db, cookie, { clientRequestId: id(i), items: [{ menuItemId: TEA, qty: 1 }] }, min(i)));
    expect(err(mockCreateTableRound(db, cookie, { clientRequestId: id(4), items: [{ menuItemId: TEA, qty: 1 }] }, min(4))).code).toBe("CONFLICT");
  });
  it("replays (SEC-027): same body = the original round; different body = CONFLICT; replay wins over paused", () => {
    const { cookie } = joinNew();
    const body = { clientRequestId: id(1), items: [{ menuItemId: TEA, qty: 2 }] };
    ok(mockCreateTableRound(db, cookie, body, min(1)));
    ok(mockSetTableOrdering(db, "staff", "paused"));
    expect(ok(mockCreateTableRound(db, cookie, body, min(2)))).toMatchObject({ round: 1, replayed: true });
    expect(err(mockCreateTableRound(db, cookie, { ...body, items: [{ menuItemId: TEA, qty: 3 }] }, min(2))).message).toBe(
      "This order was already sent with different items. Refresh and send again.",
    );
    expect(err(mockCreateTableRound(db, cookie, { clientRequestId: id(2), items: [{ menuItemId: TEA, qty: 1 }] }, min(2))).code).toBe("TABLE_ORDERS_PAUSED");
  });
  it("New code (SEC-023): old phones get 'none' / TABLE_SESSION_INVALID; the new code joins the same bill", () => {
    const { session, cookie } = joinNew();
    ok(mockCreateTableRound(db, cookie, { clientRequestId: id(1), items: [{ menuItemId: TEA, qty: 1 }] }, min(1)));
    const rotated = ok(mockRotateTableCode(db, session.id, min(2), "P4W9ZF"));
    expect(rotated.codeChanges).toBe(1);
    expect(mockGuestState(db, cookie, undefined, min(3))).toEqual({ state: "none" });
    expect(err(mockCreateTableRound(db, cookie, { clientRequestId: id(2), items: [{ menuItemId: TEA, qty: 1 }] }, min(3))).code).toBe("TABLE_SESSION_INVALID");
    expect(err(mockJoinTable(db, { table: 3, code: "K7N4QX", turnstileToken: "t" }, min(3))).code).toBe("VALIDATION");
    const again = ok(mockJoinTable(db, { table: 3, code: "P4W9ZF", turnstileToken: "t" }, min(3)));
    expect(again.view.rounds).toHaveLength(1);
  });
  it("Stop app orders (SEC-023): the guest view says 'stopped' and rounds get the table message", () => {
    const { session, cookie } = joinNew();
    expect(ok(mockSetTableOrdersLocked(db, session.id, true, min(1))).ordersLocked).toBe(true);
    const v = mockGuestState(db, cookie, undefined, min(1));
    expect(v.state === "open" && v.session.ordering).toBe("stopped");
    expect(err(mockCreateTableRound(db, cookie, { clientRequestId: id(1), items: [{ menuItemId: TEA, qty: 1 }] }, min(1)))).toMatchObject({
      code: "TABLE_ORDERS_PAUSED",
      message: TABLE_STOPPED_MESSAGE,
    });
    ok(mockSetTableOrdersLocked(db, session.id, false, min(2)));
    ok(mockCreateTableRound(db, cookie, { clientRequestId: id(2), items: [{ menuItemId: TEA, qty: 1 }] }, min(2)));
  });
});

describe("staff and owner rules (SEC-022, 9.10a) and owner alerts (9.10)", () => {
  function tableWithAcceptedRound() {
    const s = ok(mockOpenTable(db, "Sita", TABLE3, T0, "K7N4QX"));
    const j = ok(mockJoinTable(db, { table: 3, code: "K7N4QX", turnstileToken: "t" }, T0));
    const cookie = { sessionId: j.sessionId, epoch: j.epoch };
    ok(mockCreateTableRound(db, cookie, { clientRequestId: id(1), items: [{ menuItemId: MOMO, qty: 1 }] }, min(1)));
    const board = ok(mockGetTableBoard(db, undefined, min(1))) as TableBoard;
    const roundId = board.tables.find((t) => t.number === 3)!.session!.rounds[0]!.id;
    ok(mockSetTableRoundStatus(db, roundId, "preparing", min(2)));
    return { sessionId: s.id, roundId, cookie };
  }
  const unread = () => ok(mockGetAlertCount(db, "owner", min(60))).unread;

  it("staff cancel an accepted round inside the 10-minute window (owner alerted), not after", () => {
    const { roundId } = tableWithAcceptedRound();
    const before = unread();
    expect(err(mockCancelTableRound(db, "staff", "Sita", roundId, "mistake", min(13))).message).toBe(
      "Only the owner can cancel this order now. The kitchen accepted it more than 10 minutes ago.",
    );
    ok(mockCancelTableRound(db, "staff", "Sita", roundId, "mistake", min(11)));
    expect(unread()).toBe(before + 1);
    const latest = ok(mockListAlerts(db, "owner", { unreadOnly: true }, min(60))).rows[0]!;
    expect(latest).toMatchObject({ kind: "table_round_cancelled_after_accept", data: { tableNumber: 3, actorName: "Sita", minutesAfterAccept: 9 }, delivery: [] });
  });
  it("the window is the owner's setting; 0 = staff never cancel accepted rounds; the owner always can", () => {
    db.settings.staffCancelWindowMinutes = 0;
    const { roundId } = tableWithAcceptedRound();
    expect(err(mockCancelTableRound(db, "staff", "Sita", roundId, "other", min(2))).code).toBe("FORBIDDEN");
    ok(mockCancelTableRound(db, "owner", "Owner", roundId, "other", min(60)));
  });
  it("staff cannot void a table once a round was accepted, even after cancelling it; the owner can (alerted)", () => {
    const { sessionId, roundId } = tableWithAcceptedRound();
    ok(mockCancelTableRound(db, "staff", "Sita", roundId, "mistake", min(3)));
    expect(err(mockCloseTable(db, "staff", "Sita", { sessionId, outcome: "void", expectedTotal: 0 }, min(4))).message).toBe(
      "Only the owner can void a table after an order was accepted.",
    );
    expect(err(mockCloseTable(db, "staff", "Sita", { sessionId, outcome: "paid", paidVia: "cash", expectedTotal: 0 }, min(4))).code).toBe("FORBIDDEN");
    ok(mockCloseTable(db, "owner", "Owner", { sessionId, outcome: "void", expectedTotal: 0 }, min(4)));
    expect(ok(mockListAlerts(db, "owner", {}, min(60))).rows[0]!.kind).toBe("table_void");
  });
  it("staff may void a table where nothing was accepted; new rounds are cancelled", () => {
    const s = ok(mockOpenTable(db, "Sita", TABLE3, T0, "K7N4QX"));
    const j = ok(mockJoinTable(db, { table: 3, code: "K7N4QX", turnstileToken: "t" }, T0));
    ok(mockCreateTableRound(db, { sessionId: j.sessionId, epoch: j.epoch }, { clientRequestId: id(1), items: [{ menuItemId: TEA, qty: 1 }] }, min(1)));
    const bill = ((ok(mockGetTableBoard(db, undefined, min(1))) as TableBoard).tables.find((t) => t.number === 3)!.session!).bill;
    expect(err(mockCloseTable(db, "staff", "Sita", { sessionId: s.id, outcome: "paid", paidVia: "cash", expectedTotal: bill.total }, min(2))).message).toBe(
      "Accept or cancel the new order first.",
    );
    expect(ok(mockCloseTable(db, "staff", "Sita", { sessionId: s.id, outcome: "void", expectedTotal: bill.total }, min(2)))).toMatchObject({ outcome: "void", total: 0, rounds: 0 });
  });
  it("opening an open table names the time; 12 h expiry keeps preparing food on the bill and alerts the owner", () => {
    const { sessionId } = tableWithAcceptedRound();
    expect(err(mockOpenTable(db, "Hari", TABLE3, min(5))).message).toBe("Table 3 is still open from 13:45. Close it first, or press New code.");
    sweepExpiredTables(db, T0 + 12 * 3_600_000 + 60_000);
    const s = db.tables.sessions.find((x) => x.id === sessionId)!;
    expect(s).toMatchObject({ status: "closed", outcome: "expired", code: null });
    expect(s.rounds[0]!.status).toBe("served");
    expect(s.billAtClose!.total).toBe(26000);
    expect(db.tables.alerts[0]).toMatchObject({ kind: "table_expired_with_bill", data: { tableNumber: 3, amount: 26000 } });
  });
  it("a burst of wrong codes raises one alert, never a refusal", () => {
    ok(mockOpenTable(db, "Sita", TABLE3, T0, "K7N4QX"));
    const before = db.tables.alerts.length;
    for (let i = 0; i <= JOIN_FAIL_TABLE_LIMIT + 3; i++) mockJoinTable(db, { table: 3, code: "AAAAAA", turnstileToken: "t" }, min(i));
    expect(db.tables.alerts.length).toBe(before + 1);
    expect(db.tables.alerts[0]!.kind).toBe("table_join_fail");
    ok(mockJoinTable(db, { table: 3, code: "K7N4QX", turnstileToken: "t" }, min(30)));
  });
  it("alerts are owner only; mark one read, then all", () => {
    expect(err(mockListAlerts(db, "staff")).code).toBe("FORBIDDEN");
    const list = ok(mockListAlerts(db, "owner", { unreadOnly: true }, min(60)));
    expect(list.unread).toBe(2); // the seed's two unread alerts
    expect(ok(mockMarkAlertsRead(db, "owner", "Owner", { ids: [list.rows[0]!.id] }, min(61))).unread).toBe(1);
    expect(ok(mockMarkAlertsRead(db, "owner", "Owner", { all: true }, min(62))).unread).toBe(0);
  });
});

describe("mode and setup", () => {
  it("staff switch on <-> paused only; off needs every table closed", () => {
    expect(err(mockSetTableOrdering(db, "staff", "off")).code).toBe("FORBIDDEN");
    ok(mockSetTableOrdering(db, "staff", "paused"));
    expect(err(mockSetTableOrdering(db, "owner", "off")).message).toBe("Close all open tables first.");
  });
  it("saveCafeTables: owner only, unique numbers, open tables locked, used tables kept as inactive", () => {
    const rows = db.tables.rows;
    expect(err(mockSaveCafeTables(db, "staff", { tables: [] })).code).toBe("FORBIDDEN");
    expect(err(mockSaveCafeTables(db, "owner", { tables: [{ number: 1, isActive: true }, { number: 1, isActive: true }] })).fieldErrors).toEqual({
      "tables.1.number": ["That table number is used twice."],
    });
    // table 2 is open in the seed: leaving it out is refused
    expect(err(mockSaveCafeTables(db, "owner", { tables: rows.filter((r) => r.number !== 2) })).message).toBe("Close table 2 first.");
    // drop table 8 (has history in the seed's older days? either way it must not vanish if used)
    const saved = ok(mockSaveCafeTables(db, "owner", { tables: rows.filter((r) => r.number <= 7).map((r) => ({ id: r.id, number: r.number, label: r.label, isActive: true })) }));
    const eight = saved.rows.find((r) => r.number === 8);
    if (eight) expect(eight.isActive).toBe(false);
  });
  it("2.3.0: a new row may not take the number of a deactivated table with history", () => {
    // table 3 has history in the seed (closed today); leave it out, so it is kept as inactive
    const rows = db.tables.rows.filter((r) => r.number !== 3).map((r) => ({ id: r.id, number: r.number, label: r.label, isActive: r.isActive }));
    ok(mockSaveCafeTables(db, "owner", { tables: rows }));
    expect(db.tables.rows.find((r) => r.number === 3)!.isActive).toBe(false);
    const withNew = [...rows, { number: 3, isActive: true }];
    expect(err(mockSaveCafeTables(db, "owner", { tables: withNew })).fieldErrors).toEqual({
      [`tables.${withNew.length - 1}.number`]: ["Table 3 is still on file as inactive. Turn it back on instead."],
    });
    // turning the old one back on works
    const old = db.tables.rows.find((r) => r.number === 3)!;
    ok(mockSaveCafeTables(db, "owner", { tables: [...rows, { id: old.id, number: 3, isActive: true }] }));
  });
  it("mode off hides occupancy and refuses joins", () => {
    db.tables.sessions.forEach((s) => (s.status = "closed"));
    ok(mockSetTableOrdering(db, "owner", "off"));
    expect(mockOccupancy(db, T0)).toBeNull();
    expect(err(mockJoinTable(db, { table: 2, code: "K7M4QX", turnstileToken: "t" }, T0)).code).toBe("NOT_FOUND");
  });
});

describe("helpers", () => {
  it("bill formula: VAT inside or on top, with service charge", () => {
    expect(computeTableBill(10000, { pricesIncludeVat: true, serviceChargePct: 0 })).toMatchObject({ vat: 1150, total: 10000 });
    expect(computeTableBill(10000, { pricesIncludeVat: false, serviceChargePct: 10 })).toMatchObject({ serviceCharge: 1000, vat: 1430, total: 12430 });
  });
  it("random codes use the 31-symbol alphabet and reject biased bytes", () => {
    for (let i = 0; i < 50; i++) expect(randomTableCode()).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    let call = 0;
    const bytes = () => (call++ === 0 ? new Uint8Array([255, 250, 248, 0, 1, 2, 3, 4, 5, 6, 7, 8]) : new Uint8Array(12));
    expect(randomTableCode(bytes)).toBe("234567"); // 248..255 are skipped
  });
});

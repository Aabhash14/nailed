import { computeTableBill, type MockTableRound, type MockTableSession, type MockTablesState } from "./tables";

/**
 * Sample tables for the mock db (made-up development data, like everything in src/mocks). Matches the database seed
 * (data-model decision 22): 8 tables numbered 1..8 and table ordering "on" in the seed only.
 *
 * Open right now:
 *   table 2  code K7M4QX  round 1 served, round 2 being prepared
 *   table 5  code H3N8RT  one served round 2 h 40 min ago: shows the "idle" flag
 *   table 7  code P4W9ZE  one new round waiting: demo it from the guest side at /menu?t=7&code=P4W9ZE
 * Closed today: table 3 paid in cash, table 4 voided with no orders. Older days: a few paid tables for the stats card.
 */

const id = (n: number, ns: number): string =>
  `00000000-0000-4000-8${String(ns).padStart(3, "0")}-${String(n).padStart(12, "0")}`;

/** Menu ids from seed.ts (namespace 2 = items, 4 = variants). */
const MILK_TEA = { id: id(1, 2), name: "Sample milk tea", price: 12000 };
const COFFEE = { id: id(2, 2), name: "Sample black coffee", price: 15000 };
const LARGE = { id: id(2, 4), label: "Large", delta: 3000 };
const ICED = { id: id(4, 2), name: "Sample iced coffee", price: 22000 };
const SANDWICH = { id: id(5, 2), name: "Sample veg sandwich", price: 28000 };
const MOMO = { id: id(6, 2), name: "Sample chicken momo", price: 26000 };

type Item = { id: string; name: string; price: number };
const line = (it: Item, qty: number, opt?: { id: string; label: string; delta: number }) => {
  const unitPrice = it.price + (opt?.delta ?? 0);
  return {
    menuItemId: it.id,
    variantIds: opt ? [opt.id] : [],
    name: it.name,
    options: opt ? opt.label : null,
    qty,
    unitPrice,
    lineTotal: unitPrice * qty,
  };
};

const BILL = { pricesIncludeVat: true, serviceChargePct: 0 }; // the seed settings (seed.ts)

export function seedTables(now: Date): MockTablesState {
  const t = now.getTime();
  const ago = (min: number) => new Date(t - min * 60_000).toISOString();
  let rid = 0;
  const round = (
    n: number,
    status: MockTableRound["status"],
    minAgo: number,
    items: ReturnType<typeof line>[],
    note: string | null = null,
  ): MockTableRound => ({
    id: id(++rid, 21),
    round: n,
    status,
    items,
    note,
    subtotal: items.reduce((s, l) => s + l.lineTotal, 0),
    createdAt: ago(minAgo),
    acceptedAt: status === "new" ? null : ago(minAgo - 2),
    servedAt: status === "served" ? ago(minAgo - 12) : null,
    cancelledAt: null,
    cancelReason: null,
    cancelledByName: null,
    clientRequestId: null,
    fingerprint: null,
  });
  let sid = 0;
  const session = (
    table: number,
    code: string | null,
    openedMinAgo: number,
    by: string,
    rounds: MockTableRound[],
    closed?: { minAgo: number; outcome: "paid" | "void"; paidVia: "cash" | "fonepay" | null; by: string },
  ): MockTableSession => {
    const live = rounds.filter((r) => r.status !== "cancelled").reduce((s, r) => s + r.subtotal, 0);
    return {
      id: id(++sid, 20),
      tableId: id(table, 19),
      tableNumber: table,
      code: closed ? null : code,
      openedAt: ago(openedMinAgo),
      openedByName: by,
      status: closed ? "closed" : "open",
      outcome: closed?.outcome ?? null,
      paidVia: closed?.paidVia ?? null,
      closedAt: closed ? ago(closed.minAgo) : null,
      closedByName: closed?.by ?? null,
      billAtClose: closed ? computeTableBill(live, BILL) : null,
      rev: 1 + rounds.length,
      rounds,
      cookieEpoch: 1,
      ordersLocked: false,
    };
  };

  const sessions: MockTableSession[] = [
    session(2, "K7M4QX", 50, "Sample staff one", [
      round(1, "served", 45, [line(MILK_TEA, 2), line(MOMO, 1)]),
      round(2, "preparing", 8, [line(COFFEE, 1, LARGE)], "Less sugar, please"),
    ]),
    session(5, "H3N8RT", 180, "Sample owner", [round(1, "served", 160, [line(SANDWICH, 2)])]),
    session(7, "P4W9ZE", 4, "Sample staff one", [round(1, "new", 1, [line(ICED, 1)])]),
    session(3, null, 150, "Sample staff two", [round(1, "served", 140, [line(MOMO, 2), line(MILK_TEA, 2)])], {
      minAgo: 90,
      outcome: "paid",
      paidVia: "cash",
      by: "Sample staff two",
    }),
    session(4, null, 70, "Sample staff one", [], { minAgo: 60, outcome: "void", paidVia: null, by: "Sample staff one" }),
  ];
  // Older days for the stats card: two or three paid tables a day for the last 9 days, at lunch and in the evening.
  const menu: Item[] = [MILK_TEA, COFFEE, ICED, SANDWICH, MOMO];
  for (let day = 1; day <= 9; day++) {
    const perDay = 2 + (day % 2);
    for (let k = 0; k < perDay; k++) {
      const opened = day * 1440 + 300 + k * 160; // minutes ago
      const a = menu[(day + k) % menu.length]!;
      const b = menu[(day * 2 + k) % menu.length]!;
      sessions.push(
        session(1 + ((day + k) % 8), null, opened, "Sample staff one", [
          round(1, "served", opened - 5, [line(a, 1 + (k % 2)), line(b, 1)]),
          ...(k === 1 ? [round(2, "served", opened - 40, [line(MILK_TEA, 2)])] : []),
        ], { minAgo: opened - 70, outcome: "paid", paidVia: k % 2 ? "fonepay" : "cash", by: "Sample staff one" }),
      );
    }
  }
  return {
    rows: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      id: id(n, 19),
      number: n,
      label: n === 1 ? "Window" : n === 6 ? "Garden" : null,
      isActive: true,
    })),
    sessions,
    version: 1,
    // Sample owner alerts (9.10): two unread today, one read yesterday. No delivery channel in v1 (2.3.0).
    alerts: [
      {
        id: id(1, 22),
        kind: "table_round_cancelled_after_accept",
        createdAt: ago(35),
        text: "Table 2, round 1 (Rs. 220) cancelled by Sample staff one 6 min after the kitchen accepted it.",
        data: { tableNumber: 2, round: 1, amount: 22000, actorName: "Sample staff one", reason: "mistake", minutesAfterAccept: 6 },
        readAt: null,
        readByName: null,
        delivery: [],
      },
      {
        id: id(2, 22),
        kind: "table_join_fail",
        createdAt: ago(20),
        text: "Many wrong table codes in the last hour (table 5: 21). If guests are seated there, press New code.",
        data: { tableNumber: 5, failures: 21 },
        readAt: null,
        readByName: null,
        delivery: [],
      },
      {
        id: id(3, 22),
        kind: "table_expired_with_bill",
        createdAt: ago(1300),
        text: "Table 6 was open for 12 hours and closed by the system with Rs. 520 on the bill.",
        data: { tableNumber: 6, amount: 52000 },
        readAt: ago(1200),
        readByName: "Sample owner",
        delivery: [],
      },
    ],
    joinFailures: [],
    alertSeq: 1,
  };
}

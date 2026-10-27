import { describe, expect, it } from "vitest";
import {
  cancelState,
  closeChoices,
  deliveryLabels,
  NO_CHANNEL_TEXT,
  forwardMoves,
  isIdle,
  joinUrl,
  mergeBoard,
  newRoundIds,
  offlineText,
  rowsForCount,
  serverNow,
  setupProblems,
  stillOpenText,
  toSaveInput,
  type SetupRow,
} from "@/components/admin/tables/board-logic";
import { busiestHours, tableOrdersOf } from "@/components/admin/stats/table-orders-logic";
import type { AdminTableRound, AdminTableSession, TableBoard } from "@/types/contract";

/** Staff Tables board, setup and stats helpers (contract 2.2.0 section 9.7, 9.10a, 9.11; SEC-022/023/024). */

const T0 = Date.parse("2026-10-25T08:00:00Z"); // 13:45 in Kathmandu

const round = (id: string, status: AdminTableRound["status"], over: Partial<AdminTableRound> = {}): AdminTableRound => ({
  id,
  round: 1,
  status,
  items: [],
  note: null,
  subtotal: 10000,
  createdAt: new Date(T0).toISOString(),
  acceptedAt: null,
  servedAt: null,
  cancelledAt: null,
  cancelReason: null,
  cancelledByName: null,
  staffCanCancelUntil: null,
  ...over,
});

const session = (rounds: AdminTableRound[], over: Partial<AdminTableSession> = {}): AdminTableSession => ({
  id: "s1",
  code: "K7M4QX",
  joinPath: "/menu?t=7#c=K7M4QX",
  openedAt: new Date(T0 - 60 * 60_000).toISOString(),
  openedByName: "Sita",
  lastActivityAt: new Date(T0).toISOString(),
  ordersLocked: false,
  codeChanges: 0,
  everAccepted: rounds.some((r) => r.acceptedAt !== null),
  rounds,
  bill: { subtotal: 10000, serviceCharge: 0, vat: 1150, total: 10000, pricesIncludeVat: true, serviceChargePct: 0 },
  waiting: { new: 0, preparing: 0 },
  ...over,
});

const board = (rounds: AdminTableRound[], cursor = "v1"): TableBoard => ({
  changed: true,
  cursor,
  serverTime: new Date(T0).toISOString(),
  mode: "on",
  tables: [{ tableId: "t7", number: 7, label: null, session: session(rounds) }],
  closedToday: [],
  closedTodayTotals: { tables: 0, paid: 0, byPaidVia: { cash: 0, fonepay: 0, other: 0 }, voided: 0, expired: 0 },
});

describe("change-only feed (ADR 0002 decision 5)", () => {
  it("changed: false keeps the board and moves only the clock and cursor", () => {
    const prev = board([]);
    const r = mergeBoard(prev, { changed: false, cursor: "v1", serverTime: "2026-10-25T08:00:30Z" });
    expect(r.board).toBe(prev);
    expect(r).toMatchObject({ needFull: false, cursor: "v1", serverTime: "2026-10-25T08:00:30Z" });
  });
  it("a full answer replaces the board; changed: false with no board asks for a full read", () => {
    const next = board([], "v2");
    expect(mergeBoard(board([]), next).board).toBe(next);
    expect(mergeBoard(null, { changed: false, cursor: "v1", serverTime: "x" }).needFull).toBe(true);
  });
  it("new-round sound: only rounds that are new AND were not on the last board; nothing on first load", () => {
    const a = board([round("r1", "new")]);
    const b = board([round("r1", "new"), round("r2", "new"), round("r3", "served")]);
    expect(newRoundIds(null, a)).toEqual([]);
    expect(newRoundIds(a, b)).toEqual(["r2"]);
  });
  it("server clock moves with local time between polls (no fetch)", () => {
    expect(serverNow("2026-10-25T08:00:00Z", 1_000, 31_000)).toBe(T0 + 30_000);
    expect(serverNow("2026-10-25T08:00:00Z", 1_000, 500)).toBe(T0); // a local clock going back never moves it back
  });
  it("idle after 2 h without activity, with the 'still open from' text (SEC-023)", () => {
    const s = session([], { lastActivityAt: new Date(T0 - 2 * 3_600_000 - 1).toISOString() });
    expect(isIdle(s, T0)).toBe(true);
    expect(isIdle(session([]), T0)).toBe(false);
    expect(stillOpenText(s.openedAt)).toMatch(/^Still open from 12:45\./);
  });
  it("offline banner wording (9.12)", () => {
    expect(offlineText("2026-10-25T08:00:00Z")).toBe("Offline since 13:45. Take orders on paper.");
  });
});

describe("round actions (9.6, 9.10a, SEC-022)", () => {
  const accepted = new Date(T0 - 4 * 60_000).toISOString();
  const until = new Date(T0 + 6 * 60_000).toISOString();
  it("forward moves", () => {
    expect(forwardMoves(round("r", "new"))).toEqual(["preparing", "served"]);
    expect(forwardMoves(round("r", "preparing"))).toEqual(["served"]);
    expect(forwardMoves(round("r", "served"))).toEqual([]);
  });
  it("staff: new any time; accepted until staffCanCancelUntil (with minutes left); then owner only", () => {
    expect(cancelState(round("r", "new"), "staff", T0)).toEqual({ kind: "allowed" });
    expect(cancelState(round("r", "preparing", { acceptedAt: accepted, staffCanCancelUntil: until }), "staff", T0)).toEqual({ kind: "window", minutesLeft: 6 });
    expect(cancelState(round("r", "served", { acceptedAt: accepted, staffCanCancelUntil: until }), "staff", T0 + 6 * 60_000 + 1)).toEqual({ kind: "owner_only" });
    expect(cancelState(round("r", "preparing", { acceptedAt: accepted, staffCanCancelUntil: null }), "staff", T0)).toEqual({ kind: "owner_only" });
  });
  it("owner: any round not yet cancelled; nobody: a cancelled round", () => {
    expect(cancelState(round("r", "served", { acceptedAt: accepted }), "owner", T0 + 3_600_000)).toEqual({ kind: "allowed" });
    expect(cancelState(round("r", "cancelled"), "owner", T0)).toEqual({ kind: "none" });
  });
});

describe("close choices (9.7, SEC-022)", () => {
  it("paid is blocked while a round is new", () => {
    expect(closeChoices(session([round("r", "new")]), "staff").paidBlocked).toBe("Accept or cancel the new order first.");
  });
  it("staff may void only when no round was ever accepted, even if all were cancelled since", () => {
    expect(closeChoices(session([round("r", "new")]), "staff").voidAllowed).toBe(true);
    const cancelledAfterAccept = session([round("r", "cancelled", { acceptedAt: new Date(T0).toISOString() })], {
      bill: { subtotal: 0, serviceCharge: 0, vat: 0, total: 0, pricesIncludeVat: true, serviceChargePct: 0 },
    });
    const staff = closeChoices(cancelledAfterAccept, "staff");
    expect(staff.voidAllowed).toBe(false);
    expect(staff.voidNote).toMatch(/Only the owner can void/);
    expect(staff.paidBlocked).toMatch(/Rs\. 0/); // a paid close at Rs. 0 after acceptance is a void in disguise
    expect(closeChoices(cancelledAfterAccept, "owner")).toEqual({ paidBlocked: null, voidAllowed: true, voidNote: null });
  });
});

describe("join link (SEC-024)", () => {
  it("carries the code in the fragment, never the query", () => {
    expect(joinUrl("https://nailed.example/", 7, "K7M4QX")).toBe("https://nailed.example/menu?t=7#c=K7M4QX");
  });
});

describe("tables setup helper (9.7)", () => {
  const rows: SetupRow[] = [
    { id: "a", number: 1, label: "Window", isActive: true, isOpen: false, hasHistory: true },
    { id: "b", number: 2, label: "", isActive: false, isOpen: false, hasHistory: false },
    { id: "c", number: 5, label: "Garden", isActive: true, isOpen: true, hasHistory: true },
  ];
  it("'number of tables: N' keeps existing ids, labels and flags, adds new rows, drops rows above N", () => {
    const r = rowsForCount(rows, 3);
    expect(r.rows.map((x) => [x.id, x.number, x.label, x.isActive])).toEqual([
      ["a", 1, "Window", true],
      ["b", 2, "", false],
      [undefined, 3, "", true],
    ]);
    expect(r.openAbove).toEqual([5]); // the server would refuse: close table 5 first
    expect(rowsForCount(rows, 6).openAbove).toEqual([]);
  });
  it("2.3.0: a new row on a retired table's number says to turn that table back on; N brings it back", () => {
    const retired: SetupRow[] = [{ id: "d", number: 4, label: "Corner", isActive: false, isOpen: false, hasHistory: true }];
    const withNew = [...rows, { number: 4, label: "", isActive: true, isOpen: false, hasHistory: false }];
    expect(setupProblems(withNew, retired)).toEqual({ "tables.3.number": "Table 4 is still on file as inactive. Turn it back on instead." });
    const listedInactive = [...rows, { ...retired[0]! }, { number: 4, label: "", isActive: true, isOpen: false, hasHistory: false }];
    expect(setupProblems(listedInactive)["tables.4.number"]).toMatch(/still on file as inactive/);
    expect(rowsForCount(rows, 4, retired).rows[3]).toMatchObject({ id: "d", number: 4, label: "Corner", isActive: true });
  });
  it("2.3.0 alert delivery: no channel = no badges; channels get a label each", () => {
    expect(deliveryLabels([])).toEqual([]);
    expect(deliveryLabels([{ channel: "email", status: "sent" }, { channel: "webpush", status: "failed" }])).toEqual(["Email: sent", "Browser: not sent"]);
    expect(NO_CHANNEL_TEXT).toBe("Phone alerts: not set up yet. Alerts appear here.");
  });
  it("checks numbers and labels with the server's field keys, and sends blank labels as null", () => {
    const bad = [...rows, { number: 1, label: "x".repeat(41), isActive: true, isOpen: false, hasHistory: false }];
    expect(setupProblems(bad)).toEqual({ "tables.3.number": "That table number is used twice.", "tables.3.label": "Keep the name under 40 characters." });
    expect(toSaveInput(rows).tables[1]).toEqual({ id: "b", number: 2, label: null, isActive: false });
  });
});

describe("stats card", () => {
  it("busiest hours: top 3 with rounds, ties by earlier hour", () => {
    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, rounds: hour === 13 ? 5 : hour === 19 ? 5 : hour === 8 ? 1 : 0 }));
    expect(busiestHours(byHour)).toEqual(["13:00", "19:00", "08:00"]);
    expect(busiestHours(byHour.map((h) => ({ ...h, rounds: 0 })))).toEqual([]);
  });
  it("reads tableOrders defensively (absent until the backend adds it to StatsBundle)", () => {
    expect(tableOrdersOf({} as never)).toBeNull();
    expect(tableOrdersOf({ tableOrders: { byHour: [] } } as never)).toEqual({ byHour: [] });
  });
});

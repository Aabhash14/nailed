import { formatNpr } from "@/lib/money";
import { kathmanduDateKey } from "@/components/format";
import {
  TABLE_LIMITS,
  TABLE_ORDERS_PAUSED,
  TABLE_PAUSED_MESSAGE,
  TABLE_SESSION_INVALID,
  TABLE_STOPPED_MESSAGE,
  type AdminAlert,
  type AdminAlertKind,
  type AdminMenuCategory,
  type AdminTableCard,
  type AdminTableRound,
  type AdminTableSession,
  type CafeTable,
  type ClosedTableSummary,
  type CloseTableInput,
  type GuestTableRound,
  type JoinTableRequest,
  type ListAlertsInput,
  type MarkAlertsReadInput,
  type Role,
  type SaveCafeTablesInput,
  type StatsTableOrders,
  type ApiError,
  type TableBill,
  type TableBoard,
  type TableBoardResult,
  type TableCancelReason,
  type TableCloseOutcome,
  type TableGuestState,
  type TableOccupancy,
  type TableOrderingMode,
  type TableOrderLine,
  type TableOrderRequest,
  type TableOrderResponse,
  type TablePaidVia,
  type ActionResult,
  type TableSessionView,
  type Uuid,
} from "@/types/contract";
import type { MockDb } from "./seed";

/**
 * MOCK table ordering "server" (api-contract 2.2.0 section 9) over the browser mock db. It follows the contract's
 * checks, their order and their messages closely enough to build and demo the UI in both roles, and the unit tests
 * drive a whole evening through it (open, join, two rounds, staff move them, close). It is NOT the real thing and has
 * no security value: the real rules live in Postgres and the route handlers.
 */

// ---- state ------------------------------------------------------------------------------------------------------

export type MockCafeTable = { id: Uuid; number: number; label: string | null; isActive: boolean };

/** Stored round: the admin shape minus the derived `staffCanCancelUntil`, plus the replay keys. */
export type MockTableRound = Omit<AdminTableRound, "staffCanCancelUntil"> & {
  clientRequestId: Uuid | null;
  /** SEC-027 request fingerprint (the DB stores a SHA-256; the mock keeps the normalised text). */
  fingerprint: string | null;
};

export type MockTableSession = {
  id: Uuid;
  tableId: Uuid;
  /** Snapshot: closed sessions keep their own number when the table is renumbered later. */
  tableNumber: number;
  /** Plaintext while open, null once closed (ADR 0002 decision 2). */
  code: string | null;
  openedAt: string;
  openedByName: string | null;
  status: "open" | "closed";
  outcome: TableCloseOutcome | null;
  paidVia: TablePaidVia | null;
  closedAt: string | null;
  closedByName: string | null;
  /** Bill snapshot taken at close. */
  billAtClose: TableBill | null;
  rev: number;
  rounds: MockTableRound[];
  /** SEC-023: goes up on "New code"; cookies from an older epoch stop working. */
  cookieEpoch: number;
  /** SEC-023: "Stop app orders" for this table. */
  ordersLocked: boolean;
};

/** Stored alert (the contract shape). */
export type MockAlert = AdminAlert;

export type MockTablesState = {
  rows: MockCafeTable[];
  sessions: MockTableSession[];
  /** table_board_state.version: goes up on every write to tables, sessions, rounds or the mode. */
  version: number;
  /** admin_alerts (9.10), newest first. */
  alerts: MockAlert[];
  /** Failed join times (ms) in the last hour, per table number ("all" = any), for the 9.3 thresholds. */
  joinFailures: { table: number; at: number }[];
  /** Goes up when alerts or join counters change (so the mock db is saved; not part of the board cursor). */
  alertSeq: number;
};

/** The mock stand-in for the signed table cookie: session id + epoch (9.2). */
export type MockTableCookie = { sessionId: Uuid; epoch: number };

type BillSettings = { pricesIncludeVat: boolean; serviceChargePct: number };

// ---- small helpers ----------------------------------------------------------------------------------------------

/** 31 symbols, no look-alikes (no 0/O, no 1/I/L). ADR 0002 decision 2. */
export const TABLE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const SESSION_MS = TABLE_LIMITS.sessionHours * 3_600_000;
const HOUR_MS = 3_600_000;
/** 9.3 failed-join thresholds (count only, never refuse): over 50 / hour overall or 20 / hour per table = one alert. */
export const JOIN_FAIL_GLOBAL_LIMIT = 50;
export const JOIN_FAIL_TABLE_LIMIT = 20;

const fail = (
  code: ApiError["code"],
  message: string,
  fieldErrors?: Record<string, string[]>,
): { ok: false; error: ApiError } => ({
  ok: false,
  error: fieldErrors ? { code, message, fieldErrors } : { code, message },
});

/** Random 6-character code with rejection sampling (no modulo bias), like the Postgres generator. */
export function randomTableCode(rand: (n: number) => Uint8Array = defaultRandom): string {
  let out = "";
  const limit = 256 - (256 % TABLE_CODE_ALPHABET.length); // 248
  while (out.length < 6) {
    for (const b of rand(12)) {
      if (b < limit && out.length < 6) out += TABLE_CODE_ALPHABET[b % TABLE_CODE_ALPHABET.length];
    }
  }
  return out;
}
function defaultRandom(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/** Contract section 9.1 bill formula (same as shop orders). */
export function computeTableBill(subtotal: number, s: BillSettings): TableBill {
  const serviceCharge = Math.round((subtotal * s.serviceChargePct) / 100);
  const taxable = subtotal + serviceCharge;
  const vat = s.pricesIncludeVat ? Math.round((taxable * 13) / 113) : Math.round((taxable * 13) / 100);
  return {
    subtotal,
    serviceCharge,
    vat,
    total: s.pricesIncludeVat ? taxable : taxable + vat,
    pricesIncludeVat: s.pricesIncludeVat,
    serviceChargePct: s.serviceChargePct,
  };
}

function liveSubtotal(rounds: Pick<GuestTableRound, "status" | "subtotal">[]): number {
  return rounds.filter((r) => r.status !== "cancelled").reduce((n, r) => n + r.subtotal, 0);
}

function billOf(db: MockDb, s: MockTableSession): TableBill {
  return s.billAtClose ?? computeTableBill(liveSubtotal(s.rounds), db.settings);
}

function bump(db: MockDb, s?: MockTableSession) {
  db.tables.version += 1;
  if (s) s.rev += 1;
}

function modeOf(db: MockDb): TableOrderingMode {
  return db.settings.tableOrdering ?? "off";
}

function cancelWindowMin(db: MockDb): number {
  const w = db.settings.staffCancelWindowMinutes;
  return typeof w === "number" && w >= 0 ? Math.min(TABLE_LIMITS.maxStaffCancelWindowMinutes, w) : 10;
}

function rowOf(db: MockDb, s: MockTableSession): MockCafeTable | undefined {
  return db.tables.rows.find((r) => r.id === s.tableId);
}

function openSessionFor(db: MockDb, tableId: Uuid): MockTableSession | undefined {
  return db.tables.sessions.find((s) => s.tableId === tableId && s.status === "open");
}

const iso = (t: number) => new Date(t).toISOString();
const clock = (isoTime: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(isoTime),
  );

/** Remove spaces and dashes, uppercase. ADR 0002: input is case-insensitive and ignores spaces and dashes. */
export function normaliseCodeForServer(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}
const CODE_RE = /^[2-9A-HJKMNP-Z]{6}$/;
const NOTE_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

// ---- alerts (9.10) ----------------------------------------------------------------------------------------------

function addAlert(db: MockDb, kind: AdminAlertKind, now: number, text: string, data: AdminAlert["data"]) {
  db.tables.alerts.unshift({
    id: crypto.randomUUID(),
    kind,
    createdAt: iso(now),
    text,
    data,
    readAt: null,
    readByName: null,
    delivery: [], // 2.3.0: no delivery channel in v1; the Alerts view is the only surface
  });
  db.tables.alertSeq += 1;
}

// ---- system jobs ------------------------------------------------------------------------------------------------

function closeSession(
  db: MockDb,
  s: MockTableSession,
  outcome: TableCloseOutcome,
  paidVia: TablePaidVia | null,
  byName: string | null,
  now: number,
) {
  const t = iso(now);
  const acceptedRounds = s.rounds.filter((r) => r.acceptedAt !== null && r.status !== "cancelled");
  for (const r of s.rounds) {
    if (r.status === "preparing" && (outcome === "paid" || outcome === "expired")) {
      // paid close and the 12 h expiry: the food stays on the bill (SEC-022)
      r.status = "served";
      r.servedAt = t;
    } else if (r.status === "new" && outcome !== "paid") {
      r.status = "cancelled";
      r.cancelReason = "session_closed";
      r.cancelledAt = t;
      r.cancelledByName = null;
    }
    // owner void: preparing / served stay as they are, so the snapshot shows what was given away
  }
  s.billAtClose = computeTableBill(liveSubtotal(s.rounds), db.settings);
  s.status = "closed";
  s.outcome = outcome;
  s.paidVia = paidVia;
  s.closedAt = t;
  s.closedByName = outcome === "expired" ? null : byName;
  s.code = null; // the code dies with the table
  s.ordersLocked = false;
  bump(db, s);
  if (outcome === "void") {
    const amount = acceptedRounds.reduce((n, r) => n + r.subtotal, 0);
    addAlert(
      db,
      "table_void",
      now,
      `Table ${s.tableNumber} voided by ${byName ?? "someone"} (${formatNpr(amount)}, ${acceptedRounds.length} accepted round${acceptedRounds.length === 1 ? "" : "s"}).`,
      { tableNumber: s.tableNumber, amount, actorName: byName, acceptedRounds: acceptedRounds.length },
    );
  }
  if (outcome === "expired" && s.billAtClose.total > 0) {
    addAlert(
      db,
      "table_expired_with_bill",
      now,
      `Table ${s.tableNumber} was open for 12 hours and closed by the system with ${formatNpr(s.billAtClose.total)} on the bill.`,
      { tableNumber: s.tableNumber, amount: s.billAtClose.total },
    );
  }
}

/** Mock of the pg_cron job: sessions open longer than 12 h are closed as "expired". */
export function sweepExpiredTables(db: MockDb, now: number = Date.now()): void {
  for (const s of db.tables.sessions) {
    if (s.status === "open" && now - new Date(s.openedAt).getTime() > SESSION_MS) {
      closeSession(db, s, "expired", null, null, now);
    }
  }
}

// ---- public: occupancy, join, session, rounds -------------------------------------------------------------------

/** GET /api/menu `tables`: null when the mode is "off". Active tables only, by number. */
export function mockOccupancy(db: MockDb, now: number = Date.now()): TableOccupancy | null {
  if (modeOf(db) === "off") return null;
  sweepExpiredTables(db, now);
  const tables = db.tables.rows
    .filter((r) => r.isActive)
    .sort((a, b) => a.number - b.number)
    .map((r) => ({ number: r.number, label: r.label, occupied: openSessionFor(db, r.id) !== undefined }));
  return { total: tables.length, free: tables.filter((t) => !t.occupied).length, tables };
}

/** The guest view: no ids, code, join link, staff names or cancel reasons (SEC-029). */
export function toGuestView(db: MockDb, s: MockTableSession): TableSessionView {
  const row = rowOf(db, s);
  return {
    rev: s.rev,
    tableNumber: s.tableNumber,
    tableLabel: row?.label ?? null,
    openedAt: s.openedAt,
    ordering: modeOf(db) === "paused" ? "paused" : s.ordersLocked ? "stopped" : "on",
    rounds: s.rounds.map((r) => ({
      round: r.round,
      status: r.status,
      items: r.items,
      note: r.note,
      subtotal: r.subtotal,
      createdAt: r.createdAt,
    })),
    bill: billOf(db, s),
    limits: { maxLines: 20, maxQty: 20, maxWaitingRounds: 3, maxLiveRounds: 30, maxNoteLength: 200 },
  };
}

const CODE_MISMATCH = "That code doesn't match this table. Check it, or ask our staff.";

/** 9.3: count a failed join; the first one over an hourly threshold records one owner alert. Never refuses. */
function noteJoinFailure(db: MockDb, table: number, now: number) {
  const recent = db.tables.joinFailures.filter((f) => now - f.at < HOUR_MS);
  recent.push({ table, at: now });
  db.tables.joinFailures = recent;
  db.tables.alertSeq += 1;
  const forTable = recent.filter((f) => f.table === table).length;
  const overTable = forTable === JOIN_FAIL_TABLE_LIMIT + 1;
  const overGlobal = recent.length === JOIN_FAIL_GLOBAL_LIMIT + 1;
  if (overTable || overGlobal) {
    addAlert(
      db,
      "table_join_fail",
      now,
      `Many wrong table codes in the last hour (table ${table}: ${forTable}). If guests are seated there, press New code.`,
      { tableNumber: table, failures: forTable },
    );
  }
}

/** POST /api/table/join (9.3). On success the caller stores the session id and epoch as the mock "cookie". */
export function mockJoinTable(
  db: MockDb,
  req: JoinTableRequest,
  now: number = Date.now(),
): ActionResult<{ sessionId: Uuid; epoch: number; view: TableSessionView }> {
  if (!Number.isInteger(req.table) || req.table < 1 || req.table > 99)
    return fail("VALIDATION", "Please check the form.", { table: ["Pick a table from 1 to 99."] });
  const code = normaliseCodeForServer(typeof req.code === "string" ? req.code : "");
  if (!CODE_RE.test(code))
    return fail("VALIDATION", "Please check the form.", { code: ["Enter the 6-character code from our staff."] });
  if (!req.turnstileToken) return fail("BOT_CHECK_FAILED", "Please complete the check and try again.");
  if (modeOf(db) === "off") return fail("NOT_FOUND", "Not found.");
  sweepExpiredTables(db, now);
  const row = db.tables.rows.find((r) => r.number === req.table && r.isActive);
  const s = row ? openSessionFor(db, row.id) : undefined;
  // One answer for an unknown, inactive or free table, a wrong code and an old code (9.3 step 7).
  if (!s || s.code !== code) {
    noteJoinFailure(db, req.table, now);
    return fail("VALIDATION", CODE_MISMATCH, { code: [CODE_MISMATCH] });
  }
  return { ok: true, data: { sessionId: s.id, epoch: s.cookieEpoch, view: toGuestView(db, s) } };
}

/** GET /api/table/session (9.4). `cookie` = the mock cookie (null = no cookie). */
export function mockGuestState(
  db: MockDb,
  cookie: MockTableCookie | null,
  since: number | undefined,
  now: number = Date.now(),
): TableGuestState {
  if (!cookie || modeOf(db) === "off") return { state: "none" };
  sweepExpiredTables(db, now);
  const s = db.tables.sessions.find((x) => x.id === cookie.sessionId);
  if (!s) return { state: "none" };
  if (s.status === "closed") return { state: "closed", tableNumber: s.tableNumber };
  if (s.cookieEpoch !== cookie.epoch) return { state: "none" }; // the code was renewed (SEC-023)
  if (since !== undefined && since === s.rev) return { state: "unchanged", rev: s.rev };
  return { state: "open", session: toGuestView(db, s) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MenuLookup = Map<Uuid, { item: AdminMenuCategory["items"][number]; categoryVisible: boolean }>;
function menuLookup(menu: AdminMenuCategory[]): MenuLookup {
  const m: MenuLookup = new Map();
  for (const c of menu) for (const item of c.items) m.set(item.id, { item, categoryVisible: c.isVisible });
  return m;
}

/** SEC-027: the normalised merged lines plus the trimmed note. */
export function requestBodyFingerprint(req: Pick<TableOrderRequest, "items" | "note">): string {
  const merged = new Map<string, number>();
  for (const l of req.items ?? []) {
    const k = `${l.menuItemId}|${[...(l.variantIds ?? [])].sort().join(",")}`;
    merged.set(k, (merged.get(k) ?? 0) + l.qty);
  }
  return JSON.stringify([[...merged.entries()].sort(), (req.note ?? "").trim()]);
}

/** POST /api/table/orders (9.5), checks in the 2.1.0 order (session -> replay -> mode -> the rest). */
export function mockCreateTableRound(
  db: MockDb,
  cookie: MockTableCookie | null,
  req: TableOrderRequest,
  now: number = Date.now(),
): ActionResult<TableOrderResponse> {
  const invalid = () =>
    fail(TABLE_SESSION_INVALID, "Your table is not open for ordering. Enter the code from our staff to order.");
  // 3. cookie
  if (!cookie) return invalid();
  // 4. shape (Zod in the real route)
  const fieldErrors: Record<string, string[]> = {};
  if (typeof req.clientRequestId !== "string" || !UUID_RE.test(req.clientRequestId))
    fieldErrors.clientRequestId = ["Invalid request id."];
  if (!Array.isArray(req.items) || req.items.length < 1 || req.items.length > TABLE_LIMITS.maxLines)
    fieldErrors.items = ["Send 1 to 20 lines."];
  (req.items ?? []).forEach((l, i) => {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > TABLE_LIMITS.maxQty)
      fieldErrors[`items.${i}.qty`] = ["Choose 1 to 20."];
    const v = l.variantIds ?? [];
    if (v.length > TABLE_LIMITS.maxOptions || new Set(v).size !== v.length)
      fieldErrors[`items.${i}.variantIds`] = ["Pick at most one option of each kind."];
  });
  const note = (req.note ?? "").trim();
  if (note.length > TABLE_LIMITS.maxNoteLength) fieldErrors.note = ["Keep the note under 200 characters."];
  else if (NOTE_FORBIDDEN.test(note)) fieldErrors.note = ["Write the note as one line of plain text."];
  if (Object.keys(fieldErrors).length > 0) return fail("VALIDATION", "Please check the order.", fieldErrors);

  // 6. session open, under 12 h, cookie epoch current
  sweepExpiredTables(db, now);
  const s = db.tables.sessions.find((x) => x.id === cookie.sessionId);
  if (!s || s.status !== "open" || s.cookieEpoch !== cookie.epoch) return invalid();
  // 7. replay BEFORE the mode check (SEC-027): a round that exists is always reported as sent
  const fingerprint = requestBodyFingerprint(req);
  const replay = s.rounds.find((r) => r.clientRequestId === req.clientRequestId);
  if (replay) {
    if (replay.fingerprint !== null && replay.fingerprint !== fingerprint)
      return fail("CONFLICT", "This order was already sent with different items. Refresh and send again.");
    return { ok: true, data: { round: replay.round, replayed: true, session: toGuestView(db, s) } };
  }
  if (db.tables.sessions.some((x) => x.id !== s.id && x.rounds.some((r) => r.clientRequestId === req.clientRequestId)))
    return fail("VALIDATION", "Please check the order.", { clientRequestId: ["Invalid request id."] });
  // 8. mode, then the per-table stop
  const mode = modeOf(db);
  if (mode === "off") return fail("NOT_FOUND", "Not found.");
  if (mode === "paused") return fail(TABLE_ORDERS_PAUSED, TABLE_PAUSED_MESSAGE);
  if (s.ordersLocked) return fail(TABLE_ORDERS_PAUSED, TABLE_STOPPED_MESSAGE);
  // 10-12. per-session caps
  const recent = s.rounds.filter((r) => now - new Date(r.createdAt).getTime() < 10 * 60_000).length;
  if (recent >= 6) return fail("RATE_LIMITED", "Too many orders in a short time. Please wait a few minutes.");
  if (s.rounds.filter((r) => r.status === "new").length >= TABLE_LIMITS.maxWaitingRounds)
    return fail("CONFLICT", "Your earlier orders are still waiting for the kitchen. Please wait a moment or ask our staff.");
  if (
    s.rounds.filter((r) => r.status !== "cancelled").length >= TABLE_LIMITS.maxLiveRounds ||
    s.rounds.length >= TABLE_LIMITS.maxRounds
  )
    return fail("CONFLICT", "Please order the rest with our staff.");

  // 13-14. re-price every line from the menu; merge lines with the same item and the same SET of options
  const menu = menuLookup(db.menu);
  const merged = new Map<string, { first: number; menuItemId: Uuid; variantIds: Uuid[]; qty: number }>();
  const lineErrors: Record<string, string[]> = {};
  const soldOut: Record<string, string[]> = {};
  req.items.forEach((l, i) => {
    const variantIds = [...(l.variantIds ?? [])].sort();
    const hit = menu.get(l.menuItemId);
    if (!hit || !hit.item.isVisible || !hit.categoryVisible) {
      lineErrors[`items.${i}`] = ["This item is no longer on the menu."];
      return;
    }
    const opts = variantIds.map((id) => hit.item.variants.find((v) => v.id === id));
    if (opts.some((o) => !o)) {
      lineErrors[`items.${i}`] = ["This item is no longer on the menu."];
      return;
    }
    const kinds = opts.map((o) => o!.kind);
    if (new Set(kinds).size !== kinds.length) {
      lineErrors[`items.${i}`] = ["Pick at most one option of each kind."];
      return;
    }
    if (hit.item.isSoldOut || opts.some((o) => o!.isSoldOut)) soldOut[`items.${i}`] = ["sold out"];
    const key = `${l.menuItemId}|${variantIds.join(",")}`;
    const prev = merged.get(key);
    if (prev) prev.qty += l.qty;
    else merged.set(key, { first: i, menuItemId: l.menuItemId, variantIds, qty: l.qty });
  });
  for (const m of merged.values()) {
    if (m.qty > TABLE_LIMITS.maxQty) lineErrors[`items.${m.first}`] = ["Choose 1 to 20."];
  }
  if (Object.keys(lineErrors).length > 0) return fail("VALIDATION", "Please check the order.", lineErrors);
  if (Object.keys(soldOut).length > 0) return fail("OUT_OF_STOCK", "Some items are sold out.", soldOut);

  const items: TableOrderLine[] = [...merged.values()].map((m) => {
    const item = menu.get(m.menuItemId)!.item;
    const chosen = item.variants.filter((v) => m.variantIds.includes(v.id)); // the item's variant order
    const unitPrice = Math.max(0, item.price + chosen.reduce((n, v) => n + v.priceDelta, 0));
    return {
      menuItemId: m.menuItemId,
      variantIds: m.variantIds,
      name: item.name,
      options: chosen.length ? chosen.map((v) => v.label).join(", ") : null,
      qty: m.qty,
      unitPrice,
      lineTotal: unitPrice * m.qty,
    };
  });
  const subtotal = items.reduce((n, l) => n + l.lineTotal, 0);
  // 15. round cap
  if (subtotal > 2_000_000)
    return fail("VALIDATION", "Please check the order.", {
      items: ["This order is too large to send from the app. Please order with our staff."],
    });
  // 16. insert
  const round: MockTableRound = {
    id: crypto.randomUUID(),
    round: s.rounds.length + 1,
    status: "new",
    items,
    note: note || null,
    subtotal,
    createdAt: iso(now),
    acceptedAt: null,
    servedAt: null,
    cancelledAt: null,
    cancelReason: null,
    cancelledByName: null,
    clientRequestId: req.clientRequestId,
    fingerprint,
  };
  s.rounds.push(round);
  bump(db, s);
  return { ok: true, data: { round: round.round, replayed: false, session: toGuestView(db, s) } };
}

// ---- admin ------------------------------------------------------------------------------------------------------

function toCafeTable(db: MockDb, r: MockCafeTable): CafeTable {
  return {
    ...r,
    isOpen: openSessionFor(db, r.id) !== undefined,
    hasHistory: db.tables.sessions.some((s) => s.tableId === r.id),
  };
}

export function mockListCafeTables(db: MockDb): ActionResult<{ rows: CafeTable[]; mode: TableOrderingMode }> {
  return {
    ok: true,
    data: {
      rows: [...db.tables.rows].sort((a, b) => a.number - b.number).map((r) => toCafeTable(db, r)),
      mode: modeOf(db),
    },
  };
}

export function mockSaveCafeTables(db: MockDb, role: Role, input: SaveCafeTablesInput): ActionResult<{ rows: CafeTable[] }> {
  if (role !== "owner") return fail("FORBIDDEN", "Only the owner can do this.");
  const list = Array.isArray(input.tables) ? input.tables : [];
  if (list.length > 99) return fail("VALIDATION", "Please check the form.", { tables: ["Up to 99 tables."] });
  const fe: Record<string, string[]> = {};
  const seen = new Set<number>();
  list.forEach((t, i) => {
    if (!Number.isInteger(t.number) || t.number < 1 || t.number > 99) fe[`tables.${i}.number`] = ["Use a number from 1 to 99."];
    else if (seen.has(t.number)) fe[`tables.${i}.number`] = ["That table number is used twice."];
    else seen.add(t.number);
    const label = typeof t.label === "string" ? t.label.trim() : "";
    if (label.length > TABLE_LIMITS.maxLabelLength) fe[`tables.${i}.label`] = ["Keep the name under 40 characters."];
  });
  if (Object.keys(fe).length > 0) return fail("VALIDATION", "Please check the form.", fe);
  for (const t of list) if (t.id && !db.tables.rows.some((r) => r.id === t.id)) return fail("NOT_FOUND", "Not found.");
  // 2.3.0: a NEW row may not take the number of a deactivated table with history (turn that one back on instead)
  const retiredFe: Record<string, string[]> = {};
  list.forEach((t, i) => {
    if (t.id) return;
    const old = db.tables.rows.find(
      (r) => r.number === t.number && !list.some((x) => x.id === r.id) && db.tables.sessions.some((s) => s.tableId === r.id),
    );
    if (old) retiredFe[`tables.${i}.number`] = [`Table ${t.number} is still on file as inactive. Turn it back on instead.`];
  });
  if (Object.keys(retiredFe).length > 0) return fail("VALIDATION", "Please check the form.", retiredFe);
  // A table with an open session may not be renumbered, set inactive or left out.
  for (const r of db.tables.rows) {
    if (!openSessionFor(db, r.id)) continue;
    const next = list.find((t) => t.id === r.id);
    if (!next || next.number !== r.number || !next.isActive) return fail("CONFLICT", `Close table ${r.number} first.`);
  }
  const keep: MockCafeTable[] = list.map((t) => ({
    id: t.id ?? crypto.randomUUID(),
    number: t.number,
    label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : null,
    isActive: t.isActive,
  }));
  // Left out: deleted when never used, otherwise deactivated (kept under its number, so its history stays).
  for (const r of db.tables.rows) {
    if (keep.some((k) => k.id === r.id)) continue;
    if (db.tables.sessions.some((s) => s.tableId === r.id)) keep.push({ ...r, isActive: false });
  }
  db.tables.rows = keep.sort((a, b) => a.number - b.number);
  bump(db);
  return { ok: true, data: { rows: db.tables.rows.map((r) => toCafeTable(db, r)) } };
}

export function mockSetTableOrdering(db: MockDb, role: Role, mode: TableOrderingMode): ActionResult<{ mode: TableOrderingMode }> {
  const current = modeOf(db);
  if (mode !== "off" && mode !== "on" && mode !== "paused")
    return fail("VALIDATION", "Please check the form.", { mode: ["Choose off, on or paused."] });
  if (role !== "owner" && (mode === "off" || current === "off"))
    return fail("FORBIDDEN", "Only the owner can switch table ordering on or off.");
  if (mode === "off" && db.tables.sessions.some((s) => s.status === "open"))
    return fail("CONFLICT", "Close all open tables first.");
  db.settings.tableOrdering = mode;
  bump(db);
  return { ok: true, data: { mode } };
}

function withWindow(db: MockDb, r: MockTableRound): AdminTableRound {
  const { clientRequestId: _c, fingerprint: _f, ...rest } = r;
  void _c;
  void _f;
  const w = cancelWindowMin(db);
  return {
    ...rest,
    staffCanCancelUntil: r.acceptedAt && w > 0 ? iso(new Date(r.acceptedAt).getTime() + w * 60_000) : null,
  };
}

function toAdminSession(db: MockDb, s: MockTableSession): AdminTableSession {
  const last = s.rounds.reduce((t, r) => (r.createdAt > t ? r.createdAt : t), s.openedAt);
  return {
    id: s.id,
    code: s.code ?? "",
    joinPath: `/menu?t=${s.tableNumber}#c=${s.code ?? ""}`, // 2.1.0 fragment form (SEC-024)
    openedAt: s.openedAt,
    openedByName: s.openedByName,
    lastActivityAt: last,
    ordersLocked: s.ordersLocked,
    codeChanges: s.cookieEpoch - 1,
    everAccepted: s.rounds.some((r) => r.acceptedAt !== null),
    rounds: s.rounds.map((r) => withWindow(db, r)),
    bill: billOf(db, s),
    waiting: {
      new: s.rounds.filter((r) => r.status === "new").length,
      preparing: s.rounds.filter((r) => r.status === "preparing").length,
    },
  };
}

function toClosedSummary(s: MockTableSession): ClosedTableSummary {
  return {
    sessionId: s.id,
    tableNumber: s.tableNumber,
    openedAt: s.openedAt,
    closedAt: s.closedAt ?? s.openedAt,
    outcome: s.outcome ?? "void",
    paidVia: s.paidVia,
    total: s.billAtClose?.total ?? 0,
    rounds: s.rounds.filter((r) => r.status !== "cancelled").length,
    closedByName: s.closedByName,
  };
}

/** The board cursor: version plus the Kathmandu date, so "closed today" rolls over at midnight. */
export function boardCursor(db: MockDb, now: number): string {
  return `v${db.tables.version}.${kathmanduDateKey(new Date(now))}`;
}

export function mockGetTableBoard(db: MockDb, since: string | undefined, now: number = Date.now()): ActionResult<TableBoardResult> {
  if (since !== undefined && (typeof since !== "string" || since.length > 64))
    return fail("VALIDATION", "Please check the form.", { since: ["Invalid cursor."] });
  sweepExpiredTables(db, now);
  const cursor = boardCursor(db, now);
  const serverTime = iso(now);
  if (since === cursor) return { ok: true, data: { changed: false, cursor, serverTime } };
  const today = kathmanduDateKey(new Date(now));
  const tables: AdminTableCard[] = db.tables.rows
    .filter((r) => r.isActive)
    .sort((a, b) => a.number - b.number)
    .map((r) => {
      const s = openSessionFor(db, r.id);
      return { tableId: r.id, number: r.number, label: r.label, session: s ? toAdminSession(db, s) : null };
    });
  const closed = db.tables.sessions
    .filter((s) => s.status === "closed" && s.closedAt && kathmanduDateKey(s.closedAt) === today)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    .slice(0, 200)
    .map(toClosedSummary);
  const byPaidVia: Record<TablePaidVia, number> = { cash: 0, fonepay: 0, other: 0 };
  for (const c of closed) if (c.outcome === "paid" && c.paidVia) byPaidVia[c.paidVia] += c.total;
  const board: TableBoard = {
    changed: true,
    cursor,
    serverTime,
    mode: modeOf(db),
    tables,
    closedToday: closed,
    closedTodayTotals: {
      tables: closed.length,
      paid: closed.filter((c) => c.outcome === "paid").reduce((n, c) => n + c.total, 0),
      byPaidVia,
      voided: closed.filter((c) => c.outcome === "void").length,
      expired: closed.filter((c) => c.outcome === "expired").length,
    },
  };
  return { ok: true, data: board };
}

export function mockOpenTable(
  db: MockDb,
  actorName: string,
  tableId: Uuid,
  now: number = Date.now(),
  code: string = randomTableCode(),
): ActionResult<AdminTableSession> {
  if (modeOf(db) === "off") return fail("CONFLICT", "Table ordering is off. Turn it on in Tables setup.");
  sweepExpiredTables(db, now);
  const row = db.tables.rows.find((r) => r.id === tableId);
  if (!row) return fail("NOT_FOUND", "Not found.");
  if (!row.isActive) return fail("CONFLICT", "This table is not in use.");
  const already = openSessionFor(db, row.id);
  if (already)
    return fail("CONFLICT", `Table ${row.number} is still open from ${clock(already.openedAt)}. Close it first, or press New code.`);
  const s: MockTableSession = {
    id: crypto.randomUUID(),
    tableId: row.id,
    tableNumber: row.number,
    code,
    openedAt: iso(now),
    openedByName: actorName,
    status: "open",
    outcome: null,
    paidVia: null,
    closedAt: null,
    closedByName: null,
    billAtClose: null,
    rev: 1,
    rounds: [],
    cookieEpoch: 1,
    ordersLocked: false,
  };
  db.tables.sessions.push(s);
  bump(db);
  return { ok: true, data: toAdminSession(db, s) };
}

/** rotateTableCode (2.1.0, SEC-023): new code, same session, rounds, bill and stop flag; earlier cookies end. */
export function mockRotateTableCode(
  db: MockDb,
  sessionId: Uuid,
  now: number = Date.now(),
  code: string = randomTableCode(),
): ActionResult<AdminTableSession> {
  sweepExpiredTables(db, now);
  const s = db.tables.sessions.find((x) => x.id === sessionId);
  if (!s) return fail("NOT_FOUND", "Not found.");
  if (s.status !== "open") return fail("CONFLICT", "This table is closed.");
  let next = code;
  while (next === s.code) next = randomTableCode();
  s.code = next;
  s.cookieEpoch += 1;
  bump(db, s);
  return { ok: true, data: toAdminSession(db, s) };
}

/** setTableOrdersLocked (2.1.0, SEC-023). Idempotent; closing the table clears it. */
export function mockSetTableOrdersLocked(
  db: MockDb,
  sessionId: Uuid,
  locked: boolean,
  now: number = Date.now(),
): ActionResult<AdminTableSession> {
  sweepExpiredTables(db, now);
  const s = db.tables.sessions.find((x) => x.id === sessionId);
  if (!s) return fail("NOT_FOUND", "Not found.");
  if (s.status !== "open") return fail("CONFLICT", "This table is closed.");
  if (s.ordersLocked !== locked) {
    s.ordersLocked = locked;
    bump(db, s);
  }
  return { ok: true, data: toAdminSession(db, s) };
}

export function mockCloseTable(
  db: MockDb,
  role: Role,
  actorName: string,
  input: CloseTableInput,
  now: number = Date.now(),
): ActionResult<ClosedTableSummary> {
  if (input.outcome !== "paid" && input.outcome !== "void")
    return fail("VALIDATION", "Please check the form.", { outcome: ["Choose paid or void."] });
  if (input.outcome === "paid" && !input.paidVia)
    return fail("VALIDATION", "Please check the form.", { paidVia: ["Choose how the table paid."] });
  if (input.outcome === "void" && input.paidVia !== undefined)
    return fail("VALIDATION", "Please check the form.", { paidVia: ["A voided table has no payment."] });
  if (!Number.isInteger(input.expectedTotal) || input.expectedTotal < 0)
    return fail("VALIDATION", "Please check the form.", { expectedTotal: ["Invalid total."] });
  sweepExpiredTables(db, now);
  const s = db.tables.sessions.find((x) => x.id === input.sessionId);
  if (!s) return fail("NOT_FOUND", "Not found.");
  if (s.status !== "open") return fail("CONFLICT", "This table is already closed.");
  const bill = billOf(db, s);
  if (input.expectedTotal !== bill.total) return fail("CONFLICT", "The total changed. Check the new total and close again.");
  const everAccepted = s.rounds.some((r) => r.acceptedAt !== null);
  if (input.outcome === "paid") {
    if (s.rounds.some((r) => r.status === "new")) return fail("CONFLICT", "Accept or cancel the new order first.");
    if (role !== "owner" && everAccepted && bill.total === 0)
      return fail("FORBIDDEN", "Only the owner can void a table after an order was accepted.");
  } else if (role !== "owner" && everAccepted) {
    return fail("FORBIDDEN", "Only the owner can void a table after an order was accepted.");
  }
  closeSession(db, s, input.outcome, input.outcome === "paid" ? (input.paidVia ?? null) : null, actorName, now);
  return { ok: true, data: toClosedSummary(s) };
}

function findRound(db: MockDb, roundId: Uuid): { s: MockTableSession; r: MockTableRound } | null {
  for (const s of db.tables.sessions) {
    const r = s.rounds.find((x) => x.id === roundId);
    if (r) return { s, r };
  }
  return null;
}

export function mockSetTableRoundStatus(
  db: MockDb,
  roundId: Uuid,
  status: "preparing" | "served",
  now: number = Date.now(),
): ActionResult<AdminTableRound> {
  if (status !== "preparing" && status !== "served")
    return fail("VALIDATION", "Please check the form.", { status: ["Choose preparing or served."] });
  sweepExpiredTables(db, now);
  const hit = findRound(db, roundId);
  if (!hit) return fail("NOT_FOUND", "Not found.");
  const { s, r } = hit;
  if (s.status !== "open") return fail("CONFLICT", "This table is closed.");
  const allowed = status === "preparing" ? r.status === "new" : r.status === "new" || r.status === "preparing";
  if (!allowed) return fail("CONFLICT", "That status change is not allowed.");
  if (r.status === "new") r.acceptedAt = iso(now); // leaving `new` (to preparing or straight to served) = accepted
  r.status = status;
  if (status === "served") r.servedAt = iso(now);
  bump(db, s);
  return { ok: true, data: withWindow(db, r) };
}

/** 9.6 / 9.10a: staff may cancel `new` rounds, and accepted ones until acceptedAt + the window. */
export function staffMayCancel(r: Pick<AdminTableRound, "status" | "acceptedAt">, windowMinutes: number, now: number): boolean {
  if (r.status === "cancelled") return false;
  if (r.status === "new") return true;
  if (!r.acceptedAt || windowMinutes <= 0) return false;
  return now <= new Date(r.acceptedAt).getTime() + windowMinutes * 60_000;
}

export function mockCancelTableRound(
  db: MockDb,
  role: Role,
  actorName: string,
  roundId: Uuid,
  reason: Exclude<TableCancelReason, "session_closed">,
  now: number = Date.now(),
): ActionResult<AdminTableRound> {
  const reasons: TableCancelReason[] = ["guest_request", "unavailable", "mistake", "other"];
  if (!reasons.includes(reason)) return fail("VALIDATION", "Please check the form.", { reason: ["Choose a reason."] });
  sweepExpiredTables(db, now);
  const hit = findRound(db, roundId);
  if (!hit) return fail("NOT_FOUND", "Not found.");
  const { s, r } = hit;
  if (s.status !== "open") return fail("CONFLICT", "This table is closed.");
  if (r.status === "cancelled") return fail("CONFLICT", "That status change is not allowed.");
  const w = cancelWindowMin(db);
  if (role !== "owner" && !staffMayCancel(r, w, now))
    return fail(
      "FORBIDDEN",
      `Only the owner can cancel this order now. The kitchen accepted it more than ${w} minutes ago.`,
    );
  const accepted = r.acceptedAt !== null;
  r.status = "cancelled";
  r.cancelReason = reason;
  r.cancelledAt = iso(now);
  r.cancelledByName = actorName;
  bump(db, s);
  if (accepted) {
    const minutes = Math.max(0, Math.round((now - new Date(r.acceptedAt!).getTime()) / 60_000));
    addAlert(
      db,
      "table_round_cancelled_after_accept",
      now,
      `Table ${s.tableNumber}, round ${r.round} (${formatNpr(r.subtotal)}) cancelled by ${actorName} ${minutes} min after the kitchen accepted it.`,
      { tableNumber: s.tableNumber, round: r.round, amount: r.subtotal, actorName, reason, minutesAfterAccept: minutes },
    );
  }
  return { ok: true, data: withWindow(db, r) };
}

// ---- owner alerts (9.10) ----------------------------------------------------------------------------------------

export function mockListAlerts(
  db: MockDb,
  role: Role,
  input: ListAlertsInput = {},
  now: number = Date.now(),
): ActionResult<{ rows: AdminAlert[]; total: number; unread: number }> {
  if (role !== "owner") return fail("FORBIDDEN", "Only the owner can see alerts.");
  sweepExpiredTables(db, now);
  const page = Math.max(1, Math.min(1000, input.page ?? 1));
  const size = Math.max(1, Math.min(100, input.pageSize ?? 25));
  const all = [...db.tables.alerts]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((a) => !input.unreadOnly || !a.readAt);
  return {
    ok: true,
    data: {
      rows: all.slice((page - 1) * size, page * size),
      total: all.length,
      unread: db.tables.alerts.filter((a) => !a.readAt).length,
    },
  };
}

export function mockMarkAlertsRead(
  db: MockDb,
  role: Role,
  actorName: string,
  input: MarkAlertsReadInput,
  now: number = Date.now(),
): ActionResult<{ unread: number }> {
  if (role !== "owner") return fail("FORBIDDEN", "Only the owner can see alerts.");
  const ids = "all" in input ? null : input.ids;
  if (ids && (ids.length < 1 || ids.length > 100)) return fail("VALIDATION", "Please check the form.", { ids: ["1 to 100 ids."] });
  for (const a of db.tables.alerts) {
    if (!a.readAt && (ids === null || ids.includes(a.id))) {
      a.readAt = iso(now);
      a.readByName = actorName;
      db.tables.alertSeq += 1;
    }
  }
  return { ok: true, data: { unread: db.tables.alerts.filter((a) => !a.readAt).length } };
}

export function mockGetAlertCount(db: MockDb, role: Role, now: number = Date.now()): ActionResult<{ unread: number }> {
  if (role !== "owner") return fail("FORBIDDEN", "Only the owner can see alerts.");
  sweepExpiredTables(db, now);
  return { ok: true, data: { unread: db.tables.alerts.filter((a) => !a.readAt).length } };
}

// ---- stats (9.11) -----------------------------------------------------------------------------------------------

const KTM_OFFSET_MS = (5 * 60 + 45) * 60_000;

/** stats_table_orders over Kathmandu dates from..to (inclusive), from the mock sessions. */
export function mockTableStats(db: MockDb, from: string, to: string): StatsTableOrders {
  const inRange = (t: string | null) => {
    if (!t) return false;
    const d = kathmanduDateKey(t);
    return d >= from && d <= to;
  };
  let rounds = 0;
  let cancelledRounds = 0;
  let cancelledAfterAccept = 0;
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, rounds: 0 }));
  const items = new Map<string, { menuItemId: string; name: string; qty: number; revenuePaisa: number }>();
  for (const s of db.tables.sessions) {
    for (const r of s.rounds) {
      if (!inRange(r.createdAt)) continue;
      if (r.status === "cancelled") {
        cancelledRounds += 1;
        if (r.acceptedAt) cancelledAfterAccept += 1;
        continue;
      }
      rounds += 1;
      const hour = new Date(new Date(r.createdAt).getTime() + KTM_OFFSET_MS).getUTCHours();
      byHour[hour]!.rounds += 1;
      if (s.status === "open" || s.outcome === "paid") {
        for (const l of r.items) {
          const prev = items.get(l.menuItemId) ?? { menuItemId: l.menuItemId, name: l.name, qty: 0, revenuePaisa: 0 };
          prev.qty += l.qty;
          prev.revenuePaisa += l.lineTotal;
          prev.name = l.name;
          items.set(l.menuItemId, prev);
        }
      }
    }
  }
  const closed = db.tables.sessions.filter((s) => s.status === "closed" && inRange(s.closedAt));
  const paid = closed.filter((s) => s.outcome === "paid");
  const expired = closed.filter((s) => s.outcome === "expired");
  return {
    rounds,
    cancelledRounds,
    cancelledAfterAccept,
    paidTables: paid.length,
    paidTotalPaisa: paid.reduce((n, s) => n + (s.billAtClose?.total ?? 0), 0),
    voidedTables: closed.filter((s) => s.outcome === "void").length,
    expiredTables: expired.length,
    expiredWithOrdersPaisa: expired.reduce((n, s) => n + (s.billAtClose?.total ?? 0), 0),
    topItems: [...items.values()].sort((a, b) => b.qty - a.qty || b.revenuePaisa - a.revenuePaisa).slice(0, 10),
    byHour,
  };
}

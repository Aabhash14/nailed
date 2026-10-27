import {
  TABLE_LIMITS,
  type MenuCategory,
  type MenuItem,
  type MenuVariant,
  type ApiError,
  type TableBill,
  type TableOrderRequest,
  type TableSessionView,
  type Uuid,
} from "@/types/contract";

/**
 * Pure logic for the guest table-ordering UI (api-contract 2.0.0 section 9). No React, no browser APIs; unit-tested
 * in tests/unit/table-guest-logic.test.ts. The server re-prices and re-checks everything: these helpers only keep the
 * guest from sending what the server would refuse anyway, and show an estimate.
 */

// ---- table codes ------------------------------------------------------------------------------------------------

/** Spaces and dashes removed, uppercased (the server does the same). */
export function normaliseTableCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/** 6 symbols from 23456789ABCDEFGHJKMNPQRSTUVWXYZ (ADR 0002 decision 2), after normalising. */
export function isTableCodeShape(raw: string): boolean {
  return /^[2-9A-HJKMNP-Z]{6}$/.test(normaliseTableCode(raw));
}

/** "K7M4QX" -> "K7M 4QX" (how staff read it out). Anything that is not 6 characters is returned as is. */
export function formatTableCode(code: string): string {
  const c = normaliseTableCode(code);
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : code;
}

// ---- cart -------------------------------------------------------------------------------------------------------

export type CartLine = { key: string; menuItemId: Uuid; variantIds: Uuid[]; qty: number };

/**
 * The guest's table cart, kept in sessionStorage. `pending` remembers the clientRequestId of a send whose outcome is
 * unknown (network error, INTERNAL, 5xx): "Send again" with the SAME request reuses that id, so the kitchen never
 * gets the round twice (section 9.12). If the guest changes the cart first, the request is a different one and gets
 * a new id.
 */
export type TableCart = {
  tableNumber: number | null;
  lines: CartLine[];
  note: string;
  pending: { id: Uuid; fingerprint: string } | null;
};

export const EMPTY_CART: TableCart = { tableNumber: null, lines: [], note: "", pending: null };
export const CART_STORAGE_KEY = "nc_table_cart";

/** Same item + same SET of options = one line (the server merges the same way). */
export function lineKey(menuItemId: Uuid, variantIds: readonly Uuid[]): string {
  return `${menuItemId}|${[...variantIds].sort().join(",")}`;
}

export type AddResult = { cart: TableCart; added: number; tooManyLines: boolean };

/** Adds qty of an item (with options) to the cart. Qty per line is capped at 20; at most 20 different lines. */
export function addToCart(cart: TableCart, menuItemId: Uuid, variantIds: readonly Uuid[], qty: number): AddResult {
  const want = Math.max(1, Math.floor(qty));
  const key = lineKey(menuItemId, variantIds);
  const existing = cart.lines.find((l) => l.key === key);
  if (existing) {
    const next = Math.min(TABLE_LIMITS.maxQty, existing.qty + want);
    return {
      cart: { ...cart, lines: cart.lines.map((l) => (l.key === key ? { ...l, qty: next } : l)) },
      added: next - existing.qty,
      tooManyLines: false,
    };
  }
  if (cart.lines.length >= TABLE_LIMITS.maxLines) return { cart, added: 0, tooManyLines: true };
  const line: CartLine = { key, menuItemId, variantIds: [...variantIds].sort(), qty: Math.min(TABLE_LIMITS.maxQty, want) };
  return { cart: { ...cart, lines: [...cart.lines, line] }, added: line.qty, tooManyLines: false };
}

/** Sets a line's qty (1..20); 0 or less removes the line. */
export function setLineQty(cart: TableCart, key: string, qty: number): TableCart {
  const q = Math.floor(qty);
  if (q <= 0) return { ...cart, lines: cart.lines.filter((l) => l.key !== key) };
  return { ...cart, lines: cart.lines.map((l) => (l.key === key ? { ...l, qty: Math.min(TABLE_LIMITS.maxQty, q) } : l)) };
}

export function cartCount(cart: TableCart): number {
  return cart.lines.reduce((n, l) => n + l.qty, 0);
}

/** How many of this menu item (any options) are in the cart. */
export function itemQtyInCart(cart: TableCart, menuItemId: Uuid): number {
  return cart.lines.filter((l) => l.menuItemId === menuItemId).reduce((n, l) => n + l.qty, 0);
}

export type LineProblem = "gone" | "sold_out" | "bad_options" | null;
export type DescribedLine = {
  line: CartLine;
  item: MenuItem | null;
  /** Chosen options in the item's own variant order. */
  options: MenuVariant[];
  unitPrice: number;
  lineTotal: number;
  problem: LineProblem;
};

function findItem(categories: readonly MenuCategory[], id: Uuid): MenuItem | null {
  for (const c of categories) {
    const it = c.items.find((i) => i.id === id);
    if (it) return it;
  }
  return null;
}

/** A cart line against the latest menu: name, options, price estimate and whether it can be sent. */
export function describeLine(line: CartLine, categories: readonly MenuCategory[]): DescribedLine {
  const item = findItem(categories, line.menuItemId);
  if (!item) return { line, item: null, options: [], unitPrice: 0, lineTotal: 0, problem: "gone" };
  const options = item.variants.filter((v) => line.variantIds.includes(v.id));
  const kinds = options.map((o) => o.kind);
  const unitPrice = Math.max(0, item.price + options.reduce((n, o) => n + o.priceDelta, 0));
  let problem: LineProblem = null;
  if (options.length !== line.variantIds.length || new Set(kinds).size !== kinds.length) problem = "bad_options";
  else if (item.isSoldOut || options.some((o) => o.isSoldOut)) problem = "sold_out";
  return { line, item, options, unitPrice, lineTotal: unitPrice * line.qty, problem };
}

export function describeCart(cart: TableCart, categories: readonly MenuCategory[]): DescribedLine[] {
  return cart.lines.map((l) => describeLine(l, categories));
}

/** Estimated subtotal of the lines that can be sent. The kitchen's own price is the one on the order summary. */
export function cartEstimate(lines: readonly DescribedLine[]): number {
  return lines.filter((d) => d.problem === null).reduce((n, d) => n + d.lineTotal, 0);
}

/**
 * F5 (threat model section 6): the note is plain text. Strip C0/C1 control characters (keeping nothing but spaces) and
 * bidi overrides / isolates (U+202A..U+202E, U+2066..U+2069) before sending; collapse runs of whitespace; trim; cap
 * at 200. The database is meant to enforce the same.
 */
export function cleanNote(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TABLE_LIMITS.maxNoteLength);
}

/** A stable description of what would be sent (lines in cart order + the cleaned note). */
export function requestFingerprint(cart: TableCart): string {
  return JSON.stringify([cart.lines.map((l) => [l.menuItemId, l.variantIds, l.qty]), cleanNote(cart.note)]);
}

/**
 * The request for "Send to kitchen". SEC-027 / F3: reuses the pending clientRequestId ONLY when the identical cart is
 * sent again after an unknown outcome; any edit gives `newId`, which the caller makes with crypto.randomUUID() per
 * press. Returns the cart with `pending` set: keep it
 * until the server answers for sure (success clears the cart, a refusal clears `pending`).
 */
export function prepareSend(cart: TableCart, newId: Uuid): { request: TableOrderRequest; cart: TableCart } {
  const fingerprint = requestFingerprint(cart);
  const id = cart.pending && cart.pending.fingerprint === fingerprint ? cart.pending.id : newId;
  const note = cleanNote(cart.note);
  const request: TableOrderRequest = {
    clientRequestId: id,
    items: cart.lines.map((l) => ({
      menuItemId: l.menuItemId,
      ...(l.variantIds.length ? { variantIds: l.variantIds } : {}),
      qty: l.qty,
    })),
    ...(note ? { note } : {}),
  };
  return { request, cart: { ...cart, pending: { id, fingerprint } } };
}

/** What the UI does with a failed send (section 9.5, 9.9, 9.12). */
export type SendFailure =
  /** Outcome unknown (network, INTERNAL, 5xx): keep the cart and the request id; offer "Send again". */
  | "retry"
  /** TABLE_SESSION_INVALID: forget the join, KEEP the cart, show the join sheet. */
  | "session"
  /** TABLE_ORDERS_PAUSED: keep the cart, no automatic retry. */
  | "paused"
  /** VALIDATION / OUT_OF_STOCK: the guest changes the cart (line messages from fieldErrors). */
  | "fix"
  /** CONFLICT / RATE_LIMITED: wait or ask staff (server message). */
  | "wait"
  /** NOT_FOUND: table ordering was switched off. */
  | "off"
  /** FORBIDDEN (origin check) or anything unexpected: show the server message. */
  | "other";

export function classifySendError(error: Pick<ApiError, "code">, network = false): SendFailure {
  if (network) return "retry";
  switch (error.code) {
    case "INTERNAL":
      return "retry";
    case "TABLE_SESSION_INVALID":
      return "session";
    case "TABLE_ORDERS_PAUSED":
      return "paused";
    case "VALIDATION":
    case "OUT_OF_STOCK":
      return "fix";
    case "CONFLICT":
    case "RATE_LIMITED":
      return "wait";
    case "NOT_FOUND":
      return "off";
    default:
      return "other";
  }
}

/**
 * Maps the server's `items.N` field errors back to cart lines. N is the index in the request, which is the cart's
 * line order (prepareSend sends every line, in order). Returns line key -> message.
 */
export function lineErrorsFrom(
  fieldErrors: Record<string, string[]> | undefined,
  sentLines: readonly CartLine[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fieldErrors) return out;
  for (const [k, msgs] of Object.entries(fieldErrors)) {
    const m = /^items\.(\d+)(?:\.|$)/.exec(k);
    const line = m ? sentLines[Number(m[1])] : undefined;
    if (line && msgs[0]) out[line.key] = msgs[0];
  }
  return out;
}

/** Strict parse of a stored cart (sessionStorage). Anything malformed is an empty cart. */
export function parseStoredCart(raw: string | null | undefined): TableCart {
  if (!raw) return EMPTY_CART;
  try {
    const v = JSON.parse(raw) as Partial<TableCart>;
    if (!v || typeof v !== "object" || !Array.isArray(v.lines)) return EMPTY_CART;
    const lines: CartLine[] = [];
    for (const l of v.lines.slice(0, TABLE_LIMITS.maxLines)) {
      if (!l || typeof l.menuItemId !== "string" || !Array.isArray(l.variantIds)) continue;
      if (!l.variantIds.every((x) => typeof x === "string") || l.variantIds.length > TABLE_LIMITS.maxOptions) continue;
      const qty = Number.isInteger(l.qty) ? Math.min(TABLE_LIMITS.maxQty, Math.max(1, l.qty)) : 1;
      const variantIds = [...l.variantIds].sort();
      const key = lineKey(l.menuItemId, variantIds);
      if (lines.some((x) => x.key === key)) continue;
      lines.push({ key, menuItemId: l.menuItemId, variantIds, qty });
    }
    const pending =
      v.pending && typeof v.pending.id === "string" && typeof v.pending.fingerprint === "string"
        ? { id: v.pending.id, fingerprint: v.pending.fingerprint }
        : null;
    return {
      tableNumber: typeof v.tableNumber === "number" && v.tableNumber >= 1 && v.tableNumber <= 99 ? v.tableNumber : null,
      lines,
      note: typeof v.note === "string" ? v.note.slice(0, TABLE_LIMITS.maxNoteLength) : "",
      pending,
    };
  } catch {
    return EMPTY_CART;
  }
}

// ---- options sheet ----------------------------------------------------------------------------------------------

export type OptionGroup = { kind: MenuVariant["kind"]; options: MenuVariant[] };

/** The item's options grouped by kind, in the item's own variant order (one choice per kind, or none). */
export function optionGroups(item: Pick<MenuItem, "variants">): OptionGroup[] {
  const groups: OptionGroup[] = [];
  for (const v of item.variants) {
    const g = groups.find((x) => x.kind === v.kind);
    if (g) g.options.push(v);
    else groups.push({ kind: v.kind, options: [v] });
  }
  return groups;
}

/** Price of one item with the chosen options (never below 0, like the server's snapshot). */
export function unitPriceWith(item: Pick<MenuItem, "price" | "variants">, variantIds: readonly Uuid[]): number {
  return Math.max(0, item.price + item.variants.filter((v) => variantIds.includes(v.id)).reduce((n, v) => n + v.priceDelta, 0));
}

// ---- session view -----------------------------------------------------------------------------------------------

/** Guests poll their own rounds only while one is waiting or being prepared (ADR 0002 free-tier rule 3). */
export function hasLiveRound(view: Pick<TableSessionView, "rounds"> | null | undefined): boolean {
  return !!view?.rounds.some((r) => r.status === "new" || r.status === "preparing");
}

export function waitingRounds(view: Pick<TableSessionView, "rounds"> | null | undefined): number {
  return view?.rounds.filter((r) => r.status === "new").length ?? 0;
}

/** Guest poll interval: 30 s, never under 15 s (contract section 5). A server Retry-After (ms) can only make it longer. */
export const GUEST_POLL_MS = 30_000;
export function guestPollDelay(retryAfterMs: number | null): number {
  return Math.max(15_000, retryAfterMs ?? GUEST_POLL_MS, GUEST_POLL_MS);
}

export type BillRow = { key: "subtotal" | "service" | "vat_included" | "vat_added" | "total"; amount: number; pct?: number };

/** Rows of the "Order summary, not a bill or tax invoice". VAT inside the prices is shown as "included". */
export function billRows(bill: TableBill, vatPct = 13): BillRow[] {
  const rows: BillRow[] = [{ key: "subtotal", amount: bill.subtotal }];
  if (bill.serviceCharge > 0) rows.push({ key: "service", amount: bill.serviceCharge, pct: bill.serviceChargePct });
  if (bill.vat > 0) rows.push({ key: bill.pricesIncludeVat ? "vat_included" : "vat_added", amount: bill.vat, pct: vatPct });
  rows.push({ key: "total", amount: bill.total });
  return rows;
}

/**
 * SEC-027 / F3: a fresh UUID v4 from the browser's CSPRNG for each "Send to kitchen" press. crypto.randomUUID needs a
 * secure context (https or localhost); elsewhere the same v4 layout is built from crypto.getRandomValues.
 */
export function newRequestId(c: Pick<Crypto, "getRandomValues"> & { randomUUID?: () => string } = crypto): string {
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Frontend copy of the shapes in engineering/decisions/api-contract.md v2.3.0 (sections 0 to 4, and 9: table ordering).
 * Types, plus a handful of contract constants and one-line helpers with no imports of their own, so client bundles
 * stay small. If the contract changes, change this file (and tell backend-engineer). The envelope types (ApiOk,
 * ApiErr, ActionResult, ErrorCode) come from src/lib/validation/api.ts and are re-exported here for convenience.
 *
 * 2026-10-22: src/data-access/contract-ext.ts (the 1.2.0 -> 1.3.0 stop-gap) is folded in here and removed.
 */
import type { ActionResult, ApiError, ErrorCode } from "@/lib/validation/api";
import type { Fulfilment, PaymentMethod } from "@/lib/payments/types";

export type { ActionResult, ApiError, ErrorCode, Fulfilment, PaymentMethod };

// ---- 0. Conventions -------------------------------------------------------------------------------------------------

export type Paisa = number;
export type Uuid = string;
export type IsoDateTime = string;

/** Section 0: checkout only, HTTP 503, while PublicSettings.ordersPaused is true. Show the server's `message`. */
export const ORDERS_PAUSED = "ORDERS_PAUSED" satisfies ErrorCode;

export function isOrdersPausedError(e: { code: string } | null | undefined): boolean {
  return e?.code === ORDERS_PAUSED;
}

/** 2.0.0 error codes (section 9.9), part of `ErrorCode` (src/lib/validation/api.ts). */
export const TABLE_SESSION_INVALID = "TABLE_SESSION_INVALID" satisfies ErrorCode;
export const TABLE_ORDERS_PAUSED = "TABLE_ORDERS_PAUSED" satisfies ErrorCode;

/** Section 4, changePassword / inviteStaff: 12..72 characters (and at most 72 UTF-8 bytes; the server checks bytes). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 72;

// ---- 1. Shared types ------------------------------------------------------------------------------------------------

export type Diet = "veg" | "non_veg" | "egg";

/**
 * Menu translations (api-contract 1.4.0, data-model decision 19, DB 20261024000001).
 * English stays primary in name / description / label. A guest may add ONE secondary language next to it.
 * Keys: ne (Nepali), zh (zh-Hans), ja, ko, pt (pt-BR). Always present on read shapes; {} or a missing language =
 * English only. Display rule (contract section 2): missing, empty or equal to the English = show English only.
 */
export type MenuLanguage = "ne" | "zh" | "ja" | "ko" | "pt";
export const MENU_LANGUAGES: readonly MenuLanguage[] = ["ne", "zh", "ja", "ko", "pt"];
/** DB CHECK limits in characters (char_length = Unicode code points). Optional keys are omitted, never "". */
export const TRANSLATION_LIMITS = {
  name: 80,
  description: 240,
  pronunciation: 80,
  label: 40,
} as const;
export type ItemTranslation = {
  name: string;
  description?: string;
  /** Romanised Nepali ("Say it"). Allowed on "ne" only. */
  pronunciation?: string;
};
export type ItemTranslations = Partial<Record<MenuLanguage, ItemTranslation>>;
export type CategoryTranslations = Partial<Record<MenuLanguage, { name: string }>>;
export type VariantTranslations = Partial<Record<MenuLanguage, { label: string }>>;
export type MenuTag = "spicy" | "new" | "bestseller" | "chef_pick";

export type MenuVariant = {
  id: Uuid;
  kind: "size" | "milk" | "addon" | "temperature";
  label: string;
  priceDelta: Paisa;
  isSoldOut: boolean;
  /** 1.4.0 */
  translations: VariantTranslations;
};

export type ImageVariant = { widthPx: 480 | 960 | 1600; url: string };

export type MenuItem = {
  id: Uuid;
  categoryId: Uuid;
  name: string;
  description: string | null;
  price: Paisa;
  diet: Diet;
  tags: MenuTag[];
  isSoldOut: boolean;
  imageUrl: string | null;
  imageVariants: ImageVariant[];
  variants: MenuVariant[];
  sortOrder: number;
  /** 1.4.0 */
  translations: ItemTranslations;
};

export type MenuCategory = {
  id: Uuid;
  slug: string;
  name: string;
  sortOrder: number;
  items: MenuItem[];
  /** 1.4.0 */
  translations: CategoryTranslations;
};

export type MenuSpecial = {
  id: Uuid;
  title: string;
  note: string | null;
  endsAt: IsoDateTime | null;
  itemId: Uuid | null;
};

export type DayHours = { open: string; close: string }[] | null;
export type OpeningHours = {
  weekly: Record<0 | 1 | 2 | 3 | 4 | 5 | 6, DayHours>;
  closures: { date: string; label: string }[];
};

export type PublicSettings = {
  cafeName: string;
  hours: OpeningHours;
  announcement: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  landmark: string | null;
  mapUrl: string | null;
  pricesIncludeVat: boolean;
  serviceChargePct: number;
  vatPct: 13;
  deliveryFee: Paisa;
  deliveryAreas: string[];
  minOrderDelivery: Paisa;
  minOrderPickup: Paisa;
  paymentMethods: PaymentMethod[];
  features: { lodge: boolean };
  /** 1.3.0. Owner kill switch: true = checkout answers ORDERS_PAUSED; cart and checkout show "please phone us". */
  ordersPaused: boolean;
  /**
   * 2.0.0 (section 9.0). "off" = no occupancy, no join, no table orders. Shop checkout ignores it. The ISR copy of
   * /menu may carry an old value for up to an hour: the menu trusts the value from its GET /api/menu poll.
   */
  tableOrdering: TableOrderingMode;
};

/**
 * The table-ordering mode from any menu snapshot (ISR, polled, or the break-glass file). Missing or unknown = "off"
 * (2.0.0: an older or break-glass snapshot has no `tableOrdering`).
 */
export function tableOrderingOf(s: { tableOrdering?: unknown } | null | undefined): TableOrderingMode {
  return s?.tableOrdering === "on" || s?.tableOrdering === "paused" ? s.tableOrdering : "off";
}

/** Missing settings (a page that could not load them) count as "not paused"; checkout still refuses server-side. */
export function ordersArePaused(
  s: Pick<PublicSettings, "ordersPaused"> | null | undefined,
): boolean {
  return s?.ordersPaused === true;
}

export type StockState = "in_stock" | "few_left" | "sold_out";

export type ProductVariant = {
  id: Uuid;
  size: string;
  colour: string;
  stockState: StockState;
  price: Paisa;
};

export type ProductDetails = {
  fabric?: string;
  gsm?: number;
  printMethod?: string;
  credit?: string;
  sizeChartCm?: Record<string, Record<string, number>>;
};

export type ProductImage = { url: string; alt: string; variants: ImageVariant[] };

export type Product = {
  id: Uuid;
  slug: string;
  name: string;
  description: string | null;
  price: Paisa;
  /** url = the 960 variant */
  images: ProductImage[];
  details: ProductDetails;
  variants: ProductVariant[];
};

export type OrderStatus =
  "placed" | "confirmed" | "out_for_delivery" | "ready_for_pickup" | "completed" | "cancelled";

/** Moved to section 1 in 1.3.0. The public OrderView never carries "fake" (the server shows it as "other"). */
export type CancelReason =
  | "customer_request"
  | "unreachable"
  | "no_show"
  | "refused"
  | "fake"
  | "out_of_stock"
  | "other"
  | "auto_unconfirmed"; // 1.3.0: set ONLY by the database auto-cancel job; cancelOrder refuses it

// ---- 2. Public read endpoints ---------------------------------------------------------------------------------------

/** GET /api/menu payload. */
export type MenuSnapshot = {
  categories: MenuCategory[];
  specials: MenuSpecial[];
  settings: Pick<
    PublicSettings,
    "hours" | "announcement" | "pricesIncludeVat" | "serviceChargePct" | "vatPct" | "tableOrdering"
  >;
  updatedAt: IsoDateTime;
  degraded?: boolean;
  /**
   * 2.0.0 (ADR 0002 option 4C): table occupancy, read fresh on every GET /api/menu answer. Never part of the ISR page,
   * so the server-rendered snapshot has none. null when the mode is "off", the answer is degraded, or the read failed.
   */
  tables?: TableOccupancy | null;
};

/** GET /api/orders/[token] and POST /api/orders/[token]/cancel. */
export type OrderView = {
  number: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: "unpaid" | "paid";
  fulfilment: Fulfilment;
  items: { name: string; qty: number; unitPrice: Paisa }[];
  subtotal: Paisa;
  deliveryFee: Paisa;
  vat: Paisa;
  total: Paisa;
  /** First name only; "Customer" once personal data is purged. */
  customerName: string;
  canCancel: boolean;
  /** 1.3.0. null unless status = "cancelled". Never "fake". */
  cancelReason: CancelReason | null;
  createdAt: IsoDateTime;
};

// ---- 3. Checkout ----------------------------------------------------------------------------------------------------

export type CheckoutRequest = {
  items: { variantId: Uuid; qty: number }[];
  fulfilment: Fulfilment;
  paymentMethod: PaymentMethod;
  customer: { name: string; phone: string; email?: string };
  delivery?: { address: string; landmark: string; area: string };
  notes?: string;
  turnstileToken: string;
};

export type CheckoutResponse = {
  orderToken: Uuid;
  orderNumber: string;
  total: Paisa;
  willCallToConfirm: true;
  payment: { type: "none" };
};

// ---- 4. Admin server actions ----------------------------------------------------------------------------------------

export type Role = "owner" | "staff";

/** listStaff rows (1.3.0). Deactivated staff are deleted, so they are never listed. */
export type StaffMember = {
  userId: Uuid;
  displayName: string;
  role: Role;
  email: string | null;
  createdAt: IsoDateTime;
  lastSignInAt: IsoDateTime | null;
  /** The signed-in owner's own row. */
  isSelf: boolean;
  isActive: true;
};

export type UpsertMenuItemInput = {
  id?: Uuid;
  categoryId: Uuid;
  name: string;
  description?: string | null;
  price: Paisa;
  diet: Diet;
  tags: MenuTag[];
  isVisible: boolean;
  /** "menu/<uuid>" group path. 1.3.1: omitted = keep the stored photo; null = remove it; a path = replace it. */
  imagePath?: string | null;
  /**
   * 1.4.0: omitted = keep the stored translations (create: {}); an object (also {}) REPLACES the whole set, so send
   * every language you want to keep. Never null. The admin editor sends it only when it changed.
   */
  translations?: ItemTranslations;
  /** Full set: omitted variants are deleted. Per variant, omitted `translations` = unchanged (new variant: none). */
  variants: {
    id?: Uuid;
    kind: MenuVariant["kind"];
    label: string;
    priceDelta: Paisa;
    translations?: VariantTranslations;
  }[];
};

/** upsertCategory input (1.4.0). `translations`: omitted = unchanged (create: {}), an object replaces the whole set. */
export type UpsertCategoryInput = {
  id?: Uuid;
  name: string;
  slug?: string;
  isVisible: boolean;
  translations?: CategoryTranslations;
};

/** Admin read shapes (1.3.0). Hidden items and categories are included, deleted items are not. */
export type AdminMenuItem = MenuItem & { isVisible: boolean; imagePath: string | null };
export type AdminMenuCategory = Omit<MenuCategory, "items"> & {
  isVisible: boolean;
  items: AdminMenuItem[];
};

/** 1.3.1 details patch: an omitted key keeps the stored value, null removes it, a value replaces it. */
export type ProductDetailsPatch = { [K in keyof ProductDetails]?: ProductDetails[K] | null };

export type UpsertProductInput = {
  id?: Uuid;
  slug?: string;
  name: string;
  /** Omitted clears the description (it is not "unchanged"): always send the current text. */
  description?: string;
  price: Paisa;
  isPublished: boolean;
  /** 1.3.1: MERGED into the stored details (sizeChartCm is replaced as a whole). Omitted = keep all; on create = {}. */
  details?: ProductDetailsPatch;
  /**
   * 1.3.1: omitted = stored images and their files are left untouched. An explicit array (also []) is the FULL set, in
   * display order: any stored image not listed is removed and its files deleted. When the photos changed, send the
   * kept ones too (start from AdminProduct.images[].path).
   */
  images?: { path: string; alt: string }[];
  /** Full set: omitted variants are deleted. */
  variants: {
    id?: Uuid;
    size: string;
    colour: string;
    sku?: string;
    stock: number;
    priceOverride?: Paisa | null;
  }[];
};

/** path = "products/<uuid>" group path, needed to resend the set. */
export type AdminProductImage = ProductImage & { path: string };
export type AdminProductVariant = ProductVariant & { sku: string | null; stock: number };
/** Owner only (exact stock). Published and unpublished, oldest first. */
export type AdminProduct = Omit<Product, "images" | "variants"> & {
  isPublished: boolean;
  images: AdminProductImage[];
  variants: AdminProductVariant[];
};

export type AdminOrderRow = Omit<OrderView, "cancelReason"> & {
  id: Uuid;
  customerPhone: string;
  customerEmail: string | null;
  address: string | null;
  landmark: string | null;
  area: string | null;
  notes: string | null;
  /** Full reason, including "fake" and "auto_unconfirmed". */
  cancelReason: CancelReason | null;
  confirmedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  cancelledAt: IsoDateTime | null;
  isStale: boolean;
  phoneIsBlocked: boolean;
};

export type OrderFilter = {
  status?: OrderStatus[];
  fulfilment?: Fulfilment[];
  from?: IsoDateTime;
  to?: IsoDateTime;
  q?: string;
  page?: number;
  pageSize?: number;
};

export type BlockedContact = {
  id: Uuid;
  kind: "phone" | "ip_hash";
  value: string;
  reason: string | null;
  /** "" when the staff account that created it has been deactivated (1.3.0). */
  createdBy: Uuid | "";
  createdAt: IsoDateTime;
};

/** Admin-only order rules (not in PublicSettings). Defaults are ESTIMATES, owner-tunable. */
export type OrderRules = {
  /** 0 and null both mean no limit; the server stores and returns null for 0. */
  codMaxTotal: Paisa | null;
  maxOpenOrdersPerPhone: number;
  /** 1..100, default 3 (1.3.0). */
  ipOpenOrdersMax: number;
  /** 1..1000, default 10 (1.3.0). */
  ipOrdersMaxPerDay: number;
  /** 15..10080, default 120; null = auto-cancel off (1.3.0). */
  autoCancelPlacedAfterMinutes: number | null;
  /** 2.2.0 (9.10a): 0..60, default 10. Staff may cancel an accepted table round this long after acceptance. */
  staffCancelWindowMinutes: number;
  /** 2.2.0; 2.3.0: UNUSED and hidden in the UI (WhatsApp was not chosen). Kept for the shape only; never sent. */
  ownerAlertWhatsApp: string[];
  // (2.0.0 tableOrderAlerts was removed in 2.2.0 before it was built.)
};

/** getSettings / updateSettings output. Includes ordersPaused. */
export type AdminSettings = PublicSettings & OrderRules;

// ---- 9. Table ordering (2.0.0; revised 2.1.0 security review SEC-022..029; 2.2.0 Aabhash decisions) -----------------
// One batch of items a guest sends is a "round" (DB table_orders), never confused with shop orders.

export type TableOrderingMode = "off" | "on" | "paused";
export type TableRoundStatus = "new" | "preparing" | "served" | "cancelled";
/** "session_closed" is system only (`new` rounds when a table is voided or expires); cancelTableRound refuses it. */
export type TableCancelReason = "guest_request" | "unavailable" | "mistake" | "other" | "session_closed";
/** "expired" is system only (12 h auto-close). */
export type TableCloseOutcome = "paid" | "void" | "expired";
/** Recorded by staff at close; the system never takes payment. */
export type TablePaidVia = "cash" | "fonepay" | "other";

/** Public occupancy (GET /api/menu `tables`). Active tables only, by number. No codes, times or orders. */
export type TableOccupancy = {
  total: number;
  free: number;
  tables: { number: number; label: string | null; occupied: boolean }[];
};

/**
 * Same formula as shop orders: serviceCharge = round(subtotal x pct / 100); taxable = subtotal + serviceCharge; VAT 13%
 * inside (round(taxable x 13 / 113)) or on top (round(taxable x 13 / 100)). UI label: "Order summary, not a bill or tax
 * invoice". The VAT and service lines depend on brief Q22.
 */
export type TableBill = {
  subtotal: Paisa;
  serviceCharge: Paisa;
  vat: Paisa;
  total: Paisa;
  pricesIncludeVat: boolean;
  serviceChargePct: number;
};

export type TableOrderLine = {
  /** Lets the guest UI show the translated name from its menu snapshot. */
  menuItemId: Uuid;
  /** Sorted; [] = base item. */
  variantIds: Uuid[];
  /** English snapshot at send time (the staff board shows English). */
  name: string;
  /** English option labels joined with ", " in the item's variant order; null = none. */
  options: string | null;
  qty: number;
  /** Snapshot: max(0, item price + option deltas) at send time. */
  unitPrice: Paisa;
  lineTotal: Paisa;
};

export type GuestTableRound = {
  /** 1..60 within the session (cancelled rounds keep their number). */
  round: number;
  status: TableRoundStatus;
  items: TableOrderLine[];
  note: string | null;
  subtotal: Paisa;
  createdAt: IsoDateTime;
};

/** The GUEST view. Never contains ids, the code, the join link, staff names or cancel reasons (SEC-029). */
export type TableSessionView = {
  /** Goes up on every change to this session or its rounds; send it back as `since`. */
  rev: number;
  tableNumber: number;
  tableLabel: string | null;
  openedAt: IsoDateTime;
  /** 2.1.0: "stopped" = staff stopped app orders for this table (bill requested). */
  ordering: "on" | "paused" | "stopped";
  /** Oldest first; cancelled rounds included (shown struck through). */
  rounds: GuestTableRound[];
  bill: TableBill;
  limits: { maxLines: 20; maxQty: 20; maxWaitingRounds: 3; maxLiveRounds: 30; maxNoteLength: 200 };
};

export type TableGuestState =
  | { state: "none" }
  | { state: "closed"; tableNumber: number }
  | { state: "open"; session: TableSessionView }
  | { state: "unchanged"; rev: number };

/** POST /api/table/join (section 9.3). Turnstile widget rendered with action "table-join" (SEC-028). */
export type JoinTableRequest = {
  table: number;
  /** 1..20 characters as typed; the server removes spaces and "-" and uppercases. */
  code: string;
  turnstileToken: string;
};
/** SEC-028: the Turnstile action the join widget must use (the server checks it). */
export const TABLE_JOIN_TURNSTILE_ACTION = "table-join";

/** POST /api/table/orders (section 9.5). The client sends no prices. */
export type TableOrderRequest = {
  /** crypto.randomUUID(). REUSED only to re-send the identical cart after a failure; any cart or note edit = new id. */
  clientRequestId: Uuid;
  items: { menuItemId: Uuid; variantIds?: Uuid[]; qty: number }[];
  /** Max 200 after trimming; one line of plain text: no control characters and no bidi overrides. */
  note?: string;
};
export type TableOrderResponse = { round: number; replayed: boolean; session: TableSessionView };

/** Contract limits the UI mirrors (section 9.8). The server and the database are the authority. */
export const TABLE_LIMITS = {
  maxLines: 20,
  maxQty: 20,
  maxOptions: 4,
  maxWaitingRounds: 3,
  /** Rounds that are not cancelled (2.1.0). */
  maxLiveRounds: 30,
  /** Any rounds, cancelled included (2.1.0). */
  maxRounds: 60,
  maxNoteLength: 200,
  maxLabelLength: 40,
  minTable: 1,
  maxTable: 99,
  /** Session and cookie lifetime. */
  sessionHours: 12,
  /** OrderRules.staffCancelWindowMinutes range (9.10a). */
  maxStaffCancelWindowMinutes: 60,
  /** OrderRules.ownerAlertWhatsApp: at most this many numbers (9.10). */
  maxOwnerAlertWhatsApp: 3,
} as const;

/** 9.9 TABLE_ORDERS_PAUSED messages: the mode is "paused", or this one table was stopped (2.1.0). */
export const TABLE_PAUSED_MESSAGE =
  "The kitchen is not taking orders from the app right now. Please order with our staff.";
export const TABLE_STOPPED_MESSAGE = "Ordering from the app is stopped for this table. Please order with our staff.";

// ---- 9.7 admin ----

export type CafeTable = {
  id: Uuid;
  number: number;
  label: string | null;
  isActive: boolean;
  /** Has an open session now. */
  isOpen: boolean;
  /** Has ever had a session (cannot be deleted, only deactivated). */
  hasHistory: boolean;
};

export type AdminTableRound = GuestTableRound & {
  id: Uuid;
  acceptedAt: IsoDateTime | null;
  servedAt: IsoDateTime | null;
  cancelledAt: IsoDateTime | null;
  cancelReason: TableCancelReason | null;
  /** profiles.display_name; null for system cancels or a deleted profile. */
  cancelledByName: string | null;
  /** 2.2.0: acceptedAt + staffCancelWindowMinutes; null if not accepted or the window is 0. */
  staffCanCancelUntil: IsoDateTime | null;
};

export type AdminTableSession = {
  id: Uuid;
  /** 6 characters, e.g. "K7M4QX"; the UI shows "K7M 4QX". */
  code: string;
  /** 2.1.0 (SEC-024): "/menu?t=7#c=K7M4QX". The UI adds the site origin and renders the QR in the browser. */
  joinPath: string;
  openedAt: IsoDateTime;
  openedByName: string | null;
  /** max(openedAt, last round createdAt). "Still open from the previous party?" when > 2 h before serverTime. */
  lastActivityAt: IsoDateTime;
  /** 2.1.0: staff stopped app orders for this table. */
  ordersLocked: boolean;
  /** 2.1.0: how many times "New code" was pressed (cookie_epoch - 1). */
  codeChanges: number;
  /** 2.1.0: any round was ever accepted. If true, void is owner only. */
  everAccepted: boolean;
  rounds: AdminTableRound[];
  bill: TableBill;
  waiting: { new: number; preparing: number };
};

export type AdminTableCard = {
  tableId: Uuid;
  number: number;
  label: string | null;
  session: AdminTableSession | null;
};

export type ClosedTableSummary = {
  sessionId: Uuid;
  tableNumber: number;
  openedAt: IsoDateTime;
  closedAt: IsoDateTime;
  outcome: TableCloseOutcome;
  paidVia: TablePaidVia | null;
  /** Bill snapshot at close (for "expired", served and preparing food stays in it). */
  total: Paisa;
  /** Rounds not cancelled. */
  rounds: number;
  /** null for "expired" or a deleted profile. */
  closedByName: string | null;
};

export type TableBoard = {
  changed: true;
  /** Opaque, max 64 characters; send it back as `since`. */
  cursor: string;
  serverTime: IsoDateTime;
  mode: TableOrderingMode;
  /** Active tables, by number. */
  tables: AdminTableCard[];
  /** Closed on the current Kathmandu date, newest first, max 200. */
  closedToday: ClosedTableSummary[];
  closedTodayTotals: {
    tables: number;
    paid: Paisa;
    byPaidVia: Record<TablePaidVia, Paisa>;
    voided: number;
    expired: number;
  };
};
export type TableBoardResult = TableBoard | { changed: false; cursor: string; serverTime: IsoDateTime };

export type SaveCafeTablesInput = {
  /** The FULL set: tables left out are deleted (never used) or deactivated (have history). */
  tables: { id?: Uuid; number: number; label?: string | null; isActive: boolean }[];
};

export type CloseTableInput = {
  sessionId: Uuid;
  outcome: "paid" | "void";
  /** Required for "paid", refused for "void". */
  paidVia?: TablePaidVia;
  /** Must equal the current bill.total, or CONFLICT "The total changed. Check the new total and close again." */
  expectedTotal: Paisa;
};

// ---- 9.10 owner alerts (2.2.0: no Telegram; 2.3.0: no delivery channel in v1, the Alerts view is the only surface) ----

/** 2.3.0: reserved names for the pending free channel; none is enabled in v1. */
export type AlertChannel = "webpush" | "email";

export type AdminAlertKind =
  | "table_void"
  | "table_round_cancelled_after_accept"
  | "table_expired_with_bill"
  | "table_join_fail";

export type AdminAlert = {
  id: Uuid;
  kind: AdminAlertKind;
  createdAt: IsoDateTime;
  /** One English line built by the database, e.g. "Table 7 voided by Sita (Rs. 2,400, 3 accepted rounds)." */
  text: string;
  /** Structured copy for the UI; every key optional. */
  data: {
    tableNumber?: number;
    round?: number;
    amount?: Paisa;
    actorName?: string | null;
    reason?: TableCancelReason;
    acceptedRounds?: number;
    failures?: number;
    minutesAfterAccept?: number;
  };
  readAt: IsoDateTime | null;
  readByName: string | null;
  /** 2.3.0: one entry per enabled channel; [] in v1 (no channel). Over 24 h old and never sent = "failed". */
  delivery: { channel: AlertChannel; status: "pending" | "sent" | "failed" }[];
};

export type ListAlertsInput = { unreadOnly?: boolean; page?: number; pageSize?: number };
export type MarkAlertsReadInput = { ids: Uuid[] } | { all: true };

// ---- 9.11 stats ----

/** StatsBundle.tableOrders (owner, getStats). A SEPARATE block: never added to food revenue from the daily log. */
export type StatsTableOrders = {
  rounds: number;
  cancelledRounds: number;
  /** 2.1.0 (SEC-022): cancelled rounds that had acceptedAt set. */
  cancelledAfterAccept: number;
  paidTables: number;
  paidTotalPaisa: number;
  voidedTables: number;
  expiredTables: number;
  /** 2.1.0 (SEC-022): sum of bill snapshots of "expired" sessions closed in the range. */
  expiredWithOrdersPaisa: number;
  /** Top 10 by qty, then revenue. */
  topItems: { menuItemId: Uuid; name: string; qty: number; revenuePaisa: number }[];
  /** Always 24 entries, hour 0..23 Kathmandu. */
  byHour: { hour: number; rounds: number }[];
};

/**
 * HAND-WRITTEN database types (the Supabase CLI was not available, so `supabase gen types` was not run).
 * Source of truth: supabase/migrations. Regenerate with the CLI as soon as it is installed and replace this file:
 *   supabase gen types typescript --local > src/types/db.generated.ts
 * Money is integer paisa. Timestamps are ISO strings (timestamptz). Intended location in the app: src/types/db.ts.
 * Updated 2026-10-21 for migrations 20261021000001..5 (orders_paused, IP caps, auto-cancel, block_contact,
 * ORDERS_PAUSED, cancel reason auto_unconfirmed). Updated 2026-10-23 for 20261023000002 (product_variants.size_rank).
 * Updated 2026-10-24 for 20261024000001 (menu_items / menu_categories / menu_variants.translations).
 * Updated 2026-10-25 for 20261025000001..2 (daily_sales, daily_sales_lines, upsert_daily_sales, get_daily_sales and the
 * eight owner-only stats_* RPCs). The stats RPCs return jsonb, so the generated file types them as `Json`; the shapes
 * below are the contract (documented in supabase/README.md "Statistics", pinned by daily_sales_stats.test.sql).
 * Updated 2026-10-25 for 20261026000001..2 (table ordering, data-model decision 22, api-contract 2.2.0): cafe_tables,
 * table_sessions, table_orders, table_order_items, table_board_state, the table_occupancy view, admin_alerts,
 * alert_deliveries, site_settings.table_ordering, order_rules.staff_cancel_window_minutes / owner_alert_whatsapp, and
 * the 18 new RPCs. Their jsonb results are typed with the api-contract section 9 shapes (pinned by table_ordering.test.sql).
 */

export type Uuid = string;
export type IsoDateTime = string;
/** Calendar date "YYYY-MM-DD". For the sales log and statistics it is always a Kathmandu (Asia/Kathmandu) date. */
export type IsoDate = string;
export type Paisa = number;

export type Role = "owner" | "staff";
export type Diet = "veg" | "non_veg" | "egg";
export type MenuTag = "spicy" | "new" | "bestseller" | "chef_pick";
export type VariantKind = "size" | "milk" | "addon" | "temperature";
export type Fulfilment = "pickup" | "delivery";
export type PaymentMethod = "cod" | "pickup";
export type PaymentStatus = "unpaid" | "paid";
export type OrderStatus =
  "placed" | "confirmed" | "out_for_delivery" | "ready_for_pickup" | "completed" | "cancelled";
export type CancelReason =
  | "customer_request"
  | "unreachable"
  | "no_show"
  | "refused"
  | "fake"
  | "out_of_stock"
  | "other"
  /** Set only by auto_cancel_unconfirmed_orders() (order stayed `placed` past the timeout). Not accepted from staff. */
  | "auto_unconfirmed";
/** Reasons staff/owner may pass to set_order_status / cancel_order. */
export type StaffCancelReason = Exclude<CancelReason, "auto_unconfirmed">;
export type StockState = "in_stock" | "few_left" | "sold_out";
export type BlockKind = "phone" | "ip_hash";

export interface ProfileRow {
  id: Uuid;
  role: Role;
  display_name: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface SiteSettingsRow {
  id: true;
  cafe_name: string;
  hours: {
    weekly: Record<
      "0" | "1" | "2" | "3" | "4" | "5" | "6",
      { open: string; close: string }[] | null
    >;
    closures: { date: string; label: string }[];
  };
  announcement: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  landmark: string | null;
  map_url: string | null;
  prices_include_vat: boolean;
  service_charge_pct: number;
  delivery_fee_paisa: Paisa;
  delivery_areas: string[];
  payment_methods_enabled: PaymentMethod[];
  min_order_delivery_paisa: Paisa;
  min_order_pickup_paisa: Paisa;
  features: { lodge: boolean };
  /** Owner kill switch: true = create_order fails with ORDERS_PAUSED. Public (also in public_settings, Realtime). */
  orders_paused: boolean;
  /** Table ordering mode (decision 22). Public. Changed ONLY by rpc('set_table_ordering'): any other writer gets 42501. */
  table_ordering: TableOrderingMode;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
/** View public_settings = site_settings minus id/created_at, plus vat_pct (always 13). */
export type PublicSettingsRow = Omit<SiteSettingsRow, "id" | "created_at"> & { vat_pct: 13 };

export interface OrderRulesRow {
  id: true;
  /** null or 0 = no limit (BUG-003). >= 0. */
  cod_max_total_paisa: Paisa | null;
  max_open_orders_per_phone: number; // 1..5
  ip_orders_max: number; // per ip_window_minutes
  ip_window_minutes: number;
  phone_orders_max_per_day: number;
  /** Max open orders per IP hash (1..100, default 3 = ESTIMATE). Over it: ORDER_REFUSED. */
  ip_open_orders_max: number;
  /** Max orders per IP hash per rolling 24 h (1..1000, default 10 = ESTIMATE). Over it: RATE_LIMITED. */
  ip_orders_max_per_day: number;
  /** Auto-cancel `placed` orders older than this (15..10080 min, default 120 = ESTIMATE). null = off. */
  auto_cancel_placed_after_minutes: number | null;
  retention_days: number;
  blocklist_months: number;
  /** Table ordering (2.2.0): staff may cancel an accepted round within this many minutes of acceptedAt. 0..60, default 10. */
  staff_cancel_window_minutes: number;
  /** Owner alert recipients for the optional WhatsApp adapter (off until approved): 0..3 numbers, "+97798XXXXXXXX". */
  owner_alert_whatsapp: string[];
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/**
 * Secondary menu languages stored in the `translations` jsonb columns (20261024000001). English is never a key: it is
 * the row's own name / description / label. ne = Nepali, zh = Simplified Chinese (zh-Hans), ja, ko, pt = Brazilian
 * Portuguese (pt-BR). A missing language means "English only".
 */
export type MenuTranslationLang = "ne" | "zh" | "ja" | "ko" | "pt";
/** DB CHECK limits, in characters (char_length). Optional keys must be non-empty when present (omit, never ""). */
export interface MenuItemTranslation {
  /** 1..80, required */
  name: string;
  /** 1..240 */
  description?: string;
}
/** menu_items.translations. `pronunciation` (romanised, 1..80) is allowed on "ne" only. No other keys. */
export type MenuItemTranslations = {
  ne?: MenuItemTranslation & { pronunciation?: string };
} & Partial<Record<Exclude<MenuTranslationLang, "ne">, MenuItemTranslation>>;
/** menu_categories.translations. name 1..80. No other keys. */
export type MenuCategoryTranslations = Partial<Record<MenuTranslationLang, { name: string }>>;
/** menu_variants.translations. label 1..40. No other keys. */
export type MenuVariantTranslations = Partial<Record<MenuTranslationLang, { label: string }>>;

export interface MenuCategoryRow {
  id: Uuid;
  slug: string;
  name: string;
  sort_order: number;
  is_visible: boolean;
  /** Secondary-language names; '{}' when none. Never null. */
  translations: MenuCategoryTranslations;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
export interface MenuItemRow {
  id: Uuid;
  category_id: Uuid;
  name: string;
  description: string | null;
  price_paisa: Paisa;
  diet: Diet;
  tags: MenuTag[];
  is_sold_out: boolean;
  is_visible: boolean;
  image_path: string | null;
  sort_order: number;
  deleted_at: IsoDateTime | null;
  /** Secondary-language name / description / pronunciation (ne); '{}' when none. Never null. */
  translations: MenuItemTranslations;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
export interface MenuVariantRow {
  id: Uuid;
  item_id: Uuid;
  kind: VariantKind;
  label: string;
  price_delta_paisa: Paisa;
  is_sold_out: boolean;
  sort_order: number;
  /** Secondary-language labels; '{}' when none. Never null. */
  translations: MenuVariantTranslations;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
export interface MenuSpecialRow {
  id: Uuid;
  item_id: Uuid | null;
  title: string;
  note: string | null;
  ends_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface ProductRow {
  id: Uuid;
  slug: string;
  name: string;
  description: string | null;
  price_paisa: Paisa;
  is_published: boolean;
  details: {
    fabric?: string;
    gsm?: number;
    printMethod?: string;
    credit?: string;
    sizeChartCm?: Record<string, Record<string, number>>;
  };
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
export interface ProductImageRow {
  id: Uuid;
  product_id: Uuid;
  path: string;
  alt: string;
  sort_order: number;
  created_at: IsoDateTime;
}
/** Full row (staff/owner/service role). Anon cannot read `stock`. */
export interface ProductVariantRow {
  id: Uuid;
  product_id: Uuid;
  size: string;
  colour: string;
  sku: string | null;
  stock: number;
  price_override_paisa: Paisa | null;
  stock_state: StockState;
  /** BUG-015 (20261023000002): generated, read-only sort key from `size` (S 30 < M 40 < L 50 < XL 60 < XXL 70 ...).
   *  Order variants by colour, size_rank, size, id. */
  size_rank: number;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
/** What anon may select from product_variants (select these columns explicitly). */
export type PublicProductVariantRow = Pick<
  ProductVariantRow,
  | "id"
  | "product_id"
  | "size"
  | "colour"
  | "sku"
  | "price_override_paisa"
  | "stock_state"
  | "size_rank"
>;

export interface OrderRow {
  id: Uuid;
  number: string;
  public_token: Uuid;
  status: OrderStatus;
  fulfilment: Fulfilment;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  prices_include_vat: boolean;
  subtotal_paisa: Paisa;
  service_charge_paisa: Paisa;
  delivery_fee_paisa: Paisa;
  vat_paisa: Paisa;
  total_paisa: Paisa;
  /** Personal data: null after the retention purge (personal_data_purged_at is set). */
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  address: string | null;
  landmark: string | null;
  area: string | null;
  notes: string | null;
  ip_hash: string | null;
  personal_data_purged_at: IsoDateTime | null;
  cancel_reason: CancelReason | null;
  stock_restocked_at: IsoDateTime | null;
  created_at: IsoDateTime;
  confirmed_at: IsoDateTime | null;
  completed_at: IsoDateTime | null;
  cancelled_at: IsoDateTime | null;
  updated_at: IsoDateTime;
}
export interface OrderItemRow {
  id: Uuid;
  order_id: Uuid;
  product_variant_id: Uuid;
  name: string;
  variant_label: string;
  unit_price_paisa: Paisa;
  qty: number;
  created_at: IsoDateTime;
}
export interface BlockedContactRow {
  id: Uuid;
  kind: BlockKind;
  value: string;
  reason: string | null;
  created_by: Uuid | null;
  created_at: IsoDateTime;
  expires_at: IsoDateTime;
}

/** RPC argument and result shapes (service role unless noted). */
export interface CreateOrderArgs {
  p_items: { variantId: Uuid; qty: number }[];
  p_fulfilment: Fulfilment;
  p_payment_method: PaymentMethod;
  p_customer_name: string;
  p_customer_phone: string; // normalised +977 9[78]xxxxxxxx
  p_customer_email?: string | null;
  p_address?: string | null;
  p_landmark?: string | null;
  p_area?: string | null;
  p_notes?: string | null;
  p_ip_hash?: string | null; // lowercase hex SHA-256 (salted); never the raw IP
}
export interface CreateOrderRow {
  out_order_id: Uuid;
  out_order_token: Uuid;
  out_order_number: string;
  out_total_paisa: Paisa;
  out_status: "placed";
}
export interface SetOrderStatusArgs {
  p_order_id: Uuid;
  p_status: Exclude<OrderStatus, "placed">;
  p_actor: Uuid; // verified staff profile id
  p_reason?: StaffCancelReason | null; // required when p_status = "cancelled"; "auto_unconfirmed" -> VALIDATION
  p_restock?: boolean;
  p_block_contact?: boolean;
}
/** block_contact: staff "block" action. Insert-or-nothing; a live entry is never changed. */
export interface BlockContactArgs {
  p_kind: BlockKind;
  p_value: string; // phone "+97798xxxxxxxx" / "+97797xxxxxxxx", or lowercase hex SHA-256 IP hash
  p_reason: string | null; // max 200
  p_actor: Uuid; // verified staff/owner profile id
}
export interface BlockContactRow {
  out_id: Uuid;
  /** false = a live entry already existed and was left unchanged (show "already blocked until <out_expires_at>"). */
  out_created: boolean;
  out_expires_at: IsoDateTime;
}
export type AutoCancelResult =
  | { enabled: false; cancelled: 0; failed: 0; ranAt: IsoDateTime }
  | {
      enabled: true;
      timeoutMinutes: number;
      cancelled: number;
      failed: number;
      ranAt: IsoDateTime;
    };

export interface RateLimitInfoRow {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

/** One food sales log per Kathmandu business day (20261025000001). Staff: today/yesterday; owner: any past date. */
export interface DailySalesRow {
  id: Uuid;
  business_date: IsoDate;
  till_total_paisa: Paisa | null; // optional till cash total for food; NOT used as revenue
  note: string | null; // max 500
  created_by: Uuid | null;
  updated_by: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
/** Item count of one day. name/label/price are snapshotted by the database (trigger), never by the client. */
export interface DailySalesLineRow {
  id: Uuid;
  daily_sales_id: Uuid;
  menu_item_id: Uuid | null; // null once the menu item is hard-deleted
  variant_id: Uuid | null; // null = base item (or the variant was deleted; see variant_ref)
  menu_item_ref: Uuid; // original menu item id, never nulled
  variant_ref: Uuid | null; // original variant id, null = no variant
  name_snapshot: string;
  variant_label_snapshot: string | null;
  qty: number; // 0..9999
  unit_price_paisa: Paisa; // item price + variant delta at first entry (>= 0)
  line_total_paisa: Paisa; // generated: qty x unit_price_paisa
  updated_by: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** upsert_daily_sales line input. Any other key (e.g. a price) is ignored by the database. */
export interface DailySalesLineInput {
  menuItemId: Uuid;
  variantId?: Uuid | null;
  qty: number; // whole number 0..9999; one line per (menuItemId, variantId)
}
/**
 * upsert_daily_sales (service role). Header REPLACED (send current till/note to keep them); lines MERGED (unsent
 * lines stay; send qty 0 to zero one). Staff: today/yesterday only (FORBIDDEN otherwise). No future dates.
 */
export interface UpsertDailySalesArgs {
  p_date: IsoDate; // Kathmandu business date
  p_lines: DailySalesLineInput[]; // 0..500
  p_till_total?: Paisa | null; // 0..1,000,000,000
  p_note?: string | null; // <= 500, trimmed, "" = null
  p_actor: Uuid; // verified staff/owner profile id
}
export interface DailySalesLogLine {
  id: Uuid;
  menuItemId: Uuid; // original id (menu_item_ref)
  variantId: Uuid | null;
  menuItemExists: boolean; // false once the menu item was hard-deleted
  name: string;
  variantLabel: string | null;
  qty: number;
  unitPricePaisa: Paisa;
  lineTotalPaisa: Paisa;
  updatedBy: Uuid | null;
  updatedAt: IsoDateTime;
}
/** Returned by upsert_daily_sales and get_daily_sales (get_daily_sales returns null when the day has no log). */
export interface DailySalesLog {
  id: Uuid;
  businessDate: IsoDate;
  tillTotalPaisa: Paisa | null;
  note: string | null;
  createdBy: Uuid | null;
  updatedBy: Uuid | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  linesTotalPaisa: Paisa;
  itemsSold: number;
  lines: DailySalesLogLine[]; // ordered by name, variant label (base first)
}

/* ---- Statistics (20261025000002). Owner only: service role + p_actor = the owner's profile id. ---- */
export type StatsGrain = "day" | "week" | "month";
/** 0 = Sunday ... 6 = Saturday (Kathmandu). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** changePct = round((value - compare) / compare * 100, 1); null without a compare range or when compare is 0/null. */
export interface StatsMetric {
  value: number | null; // null only for avgMerchOrderPaisa with 0 orders
  compare: number | null;
  changePct: number | null;
}
export interface StatsOverview {
  from: IsoDate;
  to: IsoDate;
  compareFrom: IsoDate | null;
  compareTo: IsoDate | null;
  timezone: "Asia/Kathmandu";
  foodRevenuePaisa: StatsMetric; // sum of logged lines (qty x snapshot price)
  merchRevenuePaisa: StatsMetric; // completed orders, by completed_at, orders.total_paisa
  totalRevenuePaisa: StatsMetric; // food + merch
  merchOrders: StatsMetric; // completed orders, by completed_at
  avgMerchOrderPaisa: StatsMetric; // round(merch revenue / merch orders)
  foodItemsSold: StatsMetric;
  foodDaysLogged: StatsMetric;
  foodTillTotalPaisa: StatsMetric; // sum of the optional till totals (separate from revenue)
  foodTillDays: StatsMetric; // days that have a till total
}
export interface StatsTimeseriesBucket {
  bucket: IsoDate; // natural bucket start (day; week = Sunday; month = 1st)
  start: IsoDate; // clipped to the range
  end: IsoDate; // clipped to the range
  partial: boolean; // bucket clipped by the range
  foodRevenuePaisa: Paisa;
  foodItemsSold: number;
  merchRevenuePaisa: Paisa; // completed, by completed_at
  merchOrders: number; // completed, by completed_at
  merchOrdersPlaced: number; // any status, by created_at
  totalRevenuePaisa: Paisa;
}
export interface StatsTimeseries {
  from: IsoDate;
  to: IsoDate;
  grain: StatsGrain;
  weekStartsOn: "sunday";
  timezone: "Asia/Kathmandu";
  buckets: StatsTimeseriesBucket[]; // every bucket, zeros included, ascending
}
export interface StatsTopFoodItem {
  rank: number;
  menuItemId: Uuid; // original id; may no longer exist
  name: string; // current menu name, else the last logged name
  isDeleted: boolean;
  qty: number;
  revenuePaisa: Paisa;
}
export interface StatsTopFood {
  from: IsoDate;
  to: IsoDate;
  limit: number;
  byQty: StatsTopFoodItem[]; // qty > 0 only
  byRevenue: StatsTopFoodItem[]; // revenue > 0 only
}
export interface StatsBestFoodDay {
  date: IsoDate;
  logged: boolean;
  menuItemId: Uuid | null; // null when not logged or nothing sold
  name: string | null;
  qty: number | null; // null when not logged; 0 when logged with nothing sold
  revenuePaisa: Paisa | null;
  dayItemsSold: number | null;
  dayFoodRevenuePaisa: Paisa | null;
}
export interface StatsBestFoodPerDay {
  from: IsoDate;
  to: IsoDate;
  days: StatsBestFoodDay[]; // one per date in the range, ascending
}
export interface StatsTopMerchProduct {
  rank: number;
  productId: Uuid;
  name: string;
  qty: number;
  revenuePaisa: Paisa; // unit price x qty (no delivery fee)
}
export interface StatsTopMerchVariant {
  rank: number;
  variantId: Uuid;
  productId: Uuid;
  productName: string;
  size: string;
  colour: string;
  label: string; // "M / Black"
  qty: number;
  revenuePaisa: Paisa;
}
export interface StatsTopMerch {
  from: IsoDate;
  to: IsoDate;
  limit: number;
  byProduct: StatsTopMerchProduct[]; // completed orders, by completed_at; ranked by qty, then revenue
  byVariant: StatsTopMerchVariant[];
}
export interface StatsHeatmapCell {
  weekday: Weekday;
  hour: number; // 0..23 Kathmandu
  orders: number; // placed (created_at), any status
  completedOrders: number;
}
export interface StatsFoodWeekday {
  weekday: Weekday;
  daysLogged: number;
  itemsSold: number;
  revenuePaisa: Paisa;
  avgItemsSoldPerDay: number | null; // 1 decimal; null when no day logged
  avgRevenuePaisaPerDay: Paisa | null;
}
export interface StatsBusyHeatmap {
  from: IsoDate;
  to: IsoDate;
  timezone: "Asia/Kathmandu";
  weekdays: string; // "0 = Sunday ... 6 = Saturday"
  merch: StatsHeatmapCell[]; // all 168 cells, ordered weekday, hour
  foodByWeekday: StatsFoodWeekday[]; // 7 rows
}
export interface StatsCancellations {
  from: IsoDate;
  to: IsoDate;
  ordersPlaced: number; // orders created in the range (any status)
  completed: number;
  cancelled: number;
  open: number; // placed / confirmed / out_for_delivery / ready_for_pickup
  cancelRatePct: number | null; // 1 decimal; null when ordersPlaced = 0
  completionRatePct: number | null;
  byReason: Record<CancelReason, number>; // all 8 keys always present
  refusedAttempts: { recorded: false; count: null; note: string }; // ORDER_REFUSED is not stored in the DB
}
export interface StatsStockAlert {
  variantId: Uuid;
  productId: Uuid;
  productName: string;
  isPublished: boolean;
  size: string;
  colour: string;
  sku: string | null;
  stock: number;
  stockState: Exclude<StockState, "in_stock">;
  sold7d: number; // rolling 7 x 24 h, non-cancelled orders
  sold30d: number; // rolling 30 x 24 h
  dailyRate30d: number | null; // sold30d / 30, 2 decimals; null when 0
  daysOfStockLeft: number | null; // 0 when sold out; stock / dailyRate (1 decimal); null when nothing sold in 30 days
}
export interface StatsStockAlerts {
  generatedAt: IsoDateTime;
  fewLeftThreshold: 3;
  items: StatsStockAlert[]; // sold_out first, then fewest days left
}

// ---------------------------------------------------------------------------------------------------------------
// Table ordering (20261026000001..2, data-model decision 22, api-contract 2.2.0 section 9)
// ---------------------------------------------------------------------------------------------------------------
export type TableOrderingMode = "off" | "on" | "paused";
export type TableRoundStatus = "new" | "preparing" | "served" | "cancelled";
export type TableCancelReason =
  "guest_request" | "unavailable" | "mistake" | "other" | "session_closed";
/** Reasons staff/owner may pass to transition_table_order (session_closed is system only: VALIDATION). */
export type StaffTableCancelReason = Exclude<TableCancelReason, "session_closed">;
export type TableCloseOutcome = "paid" | "void" | "expired";
export type TablePaidVia = "cash" | "fonepay" | "other";
export type AdminAlertKind =
  | "table_void"
  | "table_round_cancelled_after_accept"
  | "table_expired_with_bill"
  | "table_join_fail";

export interface CafeTableRow {
  id: Uuid;
  number: number; // 1..99, unique (deferrable)
  label: string | null; // 1..40, trimmed, plain text
  is_active: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
export interface TableSessionRow {
  id: Uuid;
  table_id: Uuid;
  table_number: number; // snapshot at open
  status: "open" | "closed";
  code: string | null; // ^[2-9A-HJKMNP-Z]{6}$ while open, null after close. NEVER send to a guest
  cookie_epoch: number; // 1..32767, +1 per rotate_table_code
  orders_locked: boolean;
  rev: number;
  opened_by: Uuid | null;
  opened_at: IsoDateTime;
  closed_by: Uuid | null;
  closed_at: IsoDateTime | null;
  outcome: TableCloseOutcome | null;
  paid_via: TablePaidVia | null;
  prices_include_vat: boolean | null; // snapshots at close
  subtotal_paisa: Paisa | null;
  service_charge_paisa: Paisa | null;
  vat_paisa: Paisa | null;
  total_paisa: Paisa | null;
  updated_at: IsoDateTime;
}
export interface TableOrderRow {
  id: Uuid;
  session_id: Uuid;
  round: number; // 1..60
  client_request_id: Uuid;
  request_fingerprint: string; // SHA-256 hex
  status: TableRoundStatus;
  note: string | null;
  subtotal_paisa: Paisa;
  cancel_reason: TableCancelReason | null;
  cancelled_by: Uuid | null;
  created_at: IsoDateTime;
  accepted_at: IsoDateTime | null; // set on the first move out of `new`, never cleared
  served_at: IsoDateTime | null;
  cancelled_at: IsoDateTime | null;
  updated_at: IsoDateTime;
}
export interface TableOrderItemRow {
  id: Uuid;
  order_id: Uuid;
  line_no: number; // 1..20
  menu_item_ref: Uuid; // no FK
  variant_refs: Uuid[]; // sorted, 0..4
  name_snapshot: string;
  options_snapshot: string | null;
  unit_price_paisa: Paisa;
  qty: number; // 1..20
  line_total_paisa: Paisa; // generated
}
export interface TableBoardStateRow {
  id: true;
  version: number;
  changed_at: IsoDateTime;
}
/** View table_occupancy (service role only; GET /api/menu). */
export interface TableOccupancyRow {
  number: number;
  label: string | null;
  occupied: boolean;
}
export interface AdminAlertRow {
  id: Uuid;
  kind: AdminAlertKind;
  text: string; // one English line, max 200, no control characters
  data: AdminAlertData;
  session_id: Uuid | null;
  created_at: IsoDateTime;
  read_at: IsoDateTime | null;
  read_by: Uuid | null;
}
export interface AdminAlertData {
  tableNumber?: number | null;
  round?: number;
  amount?: Paisa;
  actorName?: string | null;
  reason?: TableCancelReason;
  acceptedRounds?: number;
  failures?: number;
  minutesAfterAccept?: number;
}
export interface AlertDeliveryRow {
  alert_id: Uuid;
  channel: "whatsapp";
  status: "sending" | "sent" | "failed";
  attempts: number; // 1..3
  last_error: string | null; // max 100, HTTP status / provider code only
  claimed_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** Same rounding as create_order. Live while open; the close snapshot after. */
export interface TableBill {
  subtotal: Paisa;
  serviceCharge: Paisa;
  vat: Paisa;
  total: Paisa;
  pricesIncludeVat: boolean;
  serviceChargePct: number;
}
export interface TableOrderLine {
  menuItemId: Uuid;
  variantIds: Uuid[];
  name: string;
  options: string | null;
  qty: number;
  unitPrice: Paisa;
  lineTotal: Paisa;
}
export interface GuestTableRound {
  round: number;
  status: TableRoundStatus;
  items: TableOrderLine[];
  note: string | null;
  subtotal: Paisa;
  createdAt: IsoDateTime;
}
/** Guest builder: never ids, the code, the join link, staff names, cancel reasons or waiting counts. */
export interface TableSessionView {
  rev: number;
  tableNumber: number;
  tableLabel: string | null;
  openedAt: IsoDateTime;
  ordering: "on" | "paused" | "stopped";
  rounds: GuestTableRound[];
  bill: TableBill;
  limits: { maxLines: 20; maxQty: 20; maxWaitingRounds: 3; maxLiveRounds: 30; maxNoteLength: 200 };
}
export type TableGuestState =
  | { state: "none" }
  | { state: "closed"; tableNumber: number }
  | { state: "open"; session: TableSessionView }
  | { state: "unchanged"; rev: number };
export interface CafeTable {
  id: Uuid;
  number: number;
  label: string | null;
  isActive: boolean;
  isOpen: boolean;
  hasHistory: boolean;
}
export interface AdminTableRound extends GuestTableRound {
  id: Uuid;
  acceptedAt: IsoDateTime | null;
  servedAt: IsoDateTime | null;
  cancelledAt: IsoDateTime | null;
  cancelReason: TableCancelReason | null;
  cancelledByName: string | null;
  staffCanCancelUntil: IsoDateTime | null;
}
export interface AdminTableSession {
  id: Uuid;
  code: string;
  joinPath: string; // "/menu?t=7#c=K7M4QX"
  openedAt: IsoDateTime;
  openedByName: string | null;
  lastActivityAt: IsoDateTime;
  ordersLocked: boolean;
  codeChanges: number;
  everAccepted: boolean;
  rounds: AdminTableRound[];
  bill: TableBill;
  waiting: { new: number; preparing: number };
}
export interface AdminTableCard {
  tableId: Uuid;
  number: number;
  label: string | null;
  session: AdminTableSession | null;
}
export interface ClosedTableSummary {
  sessionId: Uuid;
  tableNumber: number;
  openedAt: IsoDateTime;
  closedAt: IsoDateTime;
  outcome: TableCloseOutcome;
  paidVia: TablePaidVia | null;
  total: Paisa;
  rounds: number;
  closedByName: string | null;
}
export type TableBoardResult =
  | {
      changed: true;
      cursor: string;
      serverTime: IsoDateTime;
      mode: TableOrderingMode;
      tables: AdminTableCard[];
      closedToday: ClosedTableSummary[];
      closedTodayTotals: {
        tables: number;
        paid: Paisa;
        byPaidVia: Record<TablePaidVia, Paisa>;
        voided: number;
        expired: number;
      };
    }
  | { changed: false; cursor: string; serverTime: IsoDateTime };
export interface JoinTableResult {
  sessionId: Uuid;
  epoch: number; // cookie_epoch: sign it into the cookie
  view: TableSessionView;
}
export interface CreateTableOrderResult {
  round: number;
  replayed: boolean;
  session: TableSessionView;
}
export interface StatsTableOrders {
  rounds: number;
  cancelledRounds: number;
  cancelledAfterAccept: number;
  paidTables: number;
  paidTotalPaisa: Paisa;
  voidedTables: number;
  expiredTables: number;
  expiredWithOrdersPaisa: Paisa;
  topItems: { menuItemId: Uuid; name: string; qty: number; revenuePaisa: Paisa }[];
  byHour: { hour: number; rounds: number }[]; // always 24
}
export interface ClaimedAlert {
  alertId: Uuid;
  kind: AdminAlertKind;
  text: string;
  createdAt: IsoDateTime;
}

/** Error codes carried in PostgREST error.message for the order / table functions (SQLSTATE P0001). */
export type OrderFnError =
  | "VALIDATION"
  | "ORDERS_PAUSED" // create_order only: owner paused online orders. Safe to show; hint carries the text
  | "ORDER_REFUSED"
  | "OUT_OF_STOCK"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "TABLE_SESSION_INVALID" // table guest RPCs: closed, unknown, older than 12 h, or a wrong epoch
  | "TABLE_ORDERS_PAUSED"; // create_table_order: mode paused, or the table's orders are locked (hint says which)

export interface Database {
  public: {
    Tables: {
      profiles: { Row: ProfileRow };
      site_settings: { Row: SiteSettingsRow };
      order_rules: { Row: OrderRulesRow };
      menu_categories: { Row: MenuCategoryRow };
      menu_items: { Row: MenuItemRow };
      menu_variants: { Row: MenuVariantRow };
      menu_specials: { Row: MenuSpecialRow };
      products: { Row: ProductRow };
      product_images: { Row: ProductImageRow };
      product_variants: { Row: ProductVariantRow };
      orders: { Row: OrderRow };
      order_items: { Row: OrderItemRow };
      blocked_contacts: { Row: BlockedContactRow };
      daily_sales: { Row: DailySalesRow };
      daily_sales_lines: { Row: DailySalesLineRow };
      cafe_tables: { Row: CafeTableRow };
      table_sessions: { Row: TableSessionRow };
      table_orders: { Row: TableOrderRow };
      table_order_items: { Row: TableOrderItemRow };
      table_board_state: { Row: TableBoardStateRow };
      admin_alerts: { Row: AdminAlertRow };
      alert_deliveries: { Row: AlertDeliveryRow };
    };
    Views: {
      public_settings: { Row: PublicSettingsRow };
      table_occupancy: { Row: TableOccupancyRow };
    };
    Functions: {
      create_order: { Args: CreateOrderArgs; Returns: CreateOrderRow[] };
      set_order_status: { Args: SetOrderStatusArgs; Returns: OrderRow };
      cancel_order: {
        Args: {
          p_order_id: Uuid;
          p_actor: Uuid;
          p_reason: StaffCancelReason;
          p_restock: boolean;
          p_block_contact?: boolean;
        };
        Returns: OrderRow;
      };
      customer_cancel_order: { Args: { p_token: Uuid }; Returns: OrderRow };
      rate_limit_hit: {
        Args: { p_key: string; p_window_seconds: number; p_max: number };
        Returns: boolean;
      };
      rate_limit_hit_info: {
        Args: { p_key: string; p_window_seconds: number; p_max: number };
        Returns: RateLimitInfoRow[];
      };
      block_contact: { Args: BlockContactArgs; Returns: BlockContactRow[] };
      auto_cancel_unconfirmed_orders: { Args: Record<string, never>; Returns: AutoCancelResult };
      health_ping: { Args: Record<string, never>; Returns: IsoDateTime };
      purge_personal_data: {
        Args: Record<string, never>;
        Returns: {
          ordersPurged: number;
          blocksExpired: number;
          rateLimitRowsDeleted: number;
          alertsDeleted: number; // 2.2.0: admin_alerts older than 180 days
          retentionDays: number;
          ranAt: IsoDateTime;
        };
      };
      upsert_daily_sales: { Args: UpsertDailySalesArgs; Returns: DailySalesLog };
      get_daily_sales: { Args: { p_date: IsoDate; p_actor: Uuid }; Returns: DailySalesLog | null };
      stats_overview: {
        Args: {
          p_from: IsoDate;
          p_to: IsoDate;
          p_cmp_from?: IsoDate | null;
          p_cmp_to?: IsoDate | null;
          p_actor: Uuid;
        };
        Returns: StatsOverview;
      };
      stats_timeseries: {
        Args: { p_from: IsoDate; p_to: IsoDate; p_grain?: StatsGrain; p_actor: Uuid };
        Returns: StatsTimeseries;
      };
      stats_top_food: {
        Args: { p_from: IsoDate; p_to: IsoDate; p_limit?: number; p_actor: Uuid };
        Returns: StatsTopFood;
      };
      stats_best_food_per_day: {
        Args: { p_from: IsoDate; p_to: IsoDate; p_actor: Uuid };
        Returns: StatsBestFoodPerDay;
      };
      stats_top_merch: {
        Args: { p_from: IsoDate; p_to: IsoDate; p_limit?: number; p_actor: Uuid };
        Returns: StatsTopMerch;
      };
      stats_busy_heatmap: {
        Args: { p_from: IsoDate; p_to: IsoDate; p_actor: Uuid };
        Returns: StatsBusyHeatmap;
      };
      stats_cancellations: {
        Args: { p_from: IsoDate; p_to: IsoDate; p_actor: Uuid };
        Returns: StatsCancellations;
      };
      stats_stock_alerts: { Args: { p_actor: Uuid }; Returns: StatsStockAlerts };
      // Table ordering (all service role; p_actor = the verified profiles.id)
      list_cafe_tables: {
        Args: { p_actor: Uuid };
        Returns: { rows: CafeTable[]; mode: TableOrderingMode };
      };
      save_cafe_tables: {
        Args: {
          p_tables: {
            id?: Uuid | null;
            number: number;
            label?: string | null;
            isActive: boolean;
          }[];
          p_actor: Uuid;
        };
        Returns: { rows: CafeTable[] };
      };
      set_table_ordering: {
        Args: { p_mode: TableOrderingMode; p_actor: Uuid };
        Returns: TableOrderingMode;
      };
      open_table_session: { Args: { p_table_id: Uuid; p_actor: Uuid }; Returns: AdminTableSession };
      rotate_table_code: {
        Args: { p_session_id: Uuid; p_actor: Uuid };
        Returns: AdminTableSession;
      };
      set_table_orders_locked: {
        Args: { p_session_id: Uuid; p_locked: boolean; p_actor: Uuid };
        Returns: AdminTableSession;
      };
      join_table_session: {
        Args: { p_table_number: number; p_code: string };
        Returns: JoinTableResult;
      };
      table_session_guest_view: {
        Args: { p_session_id: Uuid; p_epoch: number; p_since?: number | null };
        Returns: TableGuestState;
      };
      create_table_order: {
        Args: {
          p_session_id: Uuid;
          p_epoch: number;
          p_client_request_id: Uuid;
          p_items: { menuItemId: Uuid; variantIds?: Uuid[]; qty: number }[];
          p_note?: string | null;
        };
        Returns: CreateTableOrderResult;
      };
      transition_table_order: {
        Args: {
          p_order_id: Uuid;
          p_to: "preparing" | "served" | "cancelled";
          p_reason: StaffTableCancelReason | null;
          p_actor: Uuid;
        };
        Returns: AdminTableRound;
      };
      close_table_session: {
        Args: {
          p_session_id: Uuid;
          p_outcome: "paid" | "void";
          p_paid_via: TablePaidVia | null;
          p_expected_total: Paisa;
          p_actor: Uuid;
        };
        Returns: ClosedTableSummary;
      };
      table_board: { Args: { p_since: string | null; p_actor: Uuid }; Returns: TableBoardResult };
      auto_close_stale_table_sessions: {
        Args: Record<string, never>;
        Returns: { closed: number; failed: number; ranAt: IsoDateTime };
      };
      stats_table_orders: {
        Args: { p_from: IsoDate; p_to: IsoDate; p_actor: Uuid };
        Returns: StatsTableOrders;
      };
      // Owner alerts (2.2.0)
      record_admin_alert: {
        Args: {
          p_kind: "table_join_fail";
          p_data: { tableNumber: number | null; failures: number };
        };
        Returns: Uuid;
      };
      mark_admin_alerts_read: {
        Args: { p_ids: Uuid[] | null; p_all: boolean; p_actor: Uuid };
        Returns: number; // unread left
      };
      claim_alert_deliveries: {
        Args: { p_channel: "whatsapp"; p_limit: number };
        Returns: ClaimedAlert[];
      };
      finish_alert_delivery: {
        Args: { p_alert_id: Uuid; p_channel: "whatsapp"; p_ok: boolean; p_error: string | null };
        Returns: null;
      };
      current_app_role: { Args: Record<string, never>; Returns: Role | null };
      is_staff: { Args: Record<string, never>; Returns: boolean };
      is_owner: { Args: Record<string, never>; Returns: boolean };
    };
  };
}

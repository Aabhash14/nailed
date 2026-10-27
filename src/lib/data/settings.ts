import type { Db } from "./types";
import { unwrap } from "./db-errors";
import { AppError } from "@/lib/errors";
import type { OrderRulesRow, SiteSettingsRow, TableOrderingMode } from "@/types/db";

/** PublicSettings & OrderRules (api-contract section 1 and 4). Service-role read: includes admin-only rules. */
export type SettingsDto = {
  cafeName: string;
  hours: SiteSettingsRow["hours"];
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
  deliveryFee: number;
  deliveryAreas: string[];
  minOrderDelivery: number;
  minOrderPickup: number;
  paymentMethods: SiteSettingsRow["payment_methods_enabled"];
  features: { lodge: boolean };
  /** Owner kill switch (SEC-003): when true, create_order refuses with ORDERS_PAUSED. Public column. */
  ordersPaused: boolean;
  codMaxTotal: number | null;
  maxOpenOrdersPerPhone: number;
  /** SEC-003 rules (migration 20261021000002). Defaults are ESTIMATES, owner-tunable. */
  ipOpenOrdersMax: number;
  ipOrdersMaxPerDay: number;
  autoCancelPlacedAfterMinutes: number | null;
  /** 2.0.0: table ordering mode. Read here; written ONLY by setTableOrdering (database guard, SEC-029). */
  tableOrdering: TableOrderingMode;
  /** 2.2.0 (9.10a): 0..60, default 10. Staff may cancel an accepted table round this long after acceptance. */
  staffCancelWindowMinutes: number;
  /** 2.2.0; 2.3.0: UNUSED (WhatsApp not chosen). Still in OrderRules, so returned and accepted; the UI hides it. */
  ownerAlertWhatsApp: string[];
};

export async function loadSettings(db: Db): Promise<SettingsDto> {
  const [s, r] = await Promise.all([
    db.from("site_settings").select("*").limit(1).maybeSingle(),
    db.from("order_rules").select("*").limit(1).maybeSingle(),
  ]);
  const site = unwrap(s) as SiteSettingsRow | null;
  const rules = unwrap(r) as OrderRulesRow | null;
  if (!site || !rules) throw new AppError("INTERNAL", undefined, { logDetail: "settings rows missing" });
  return {
    cafeName: site.cafe_name,
    hours: site.hours,
    announcement: site.announcement,
    phone: site.phone,
    whatsapp: site.whatsapp,
    email: site.email,
    address: site.address,
    landmark: site.landmark,
    mapUrl: site.map_url,
    pricesIncludeVat: site.prices_include_vat,
    serviceChargePct: Number(site.service_charge_pct),
    vatPct: 13,
    deliveryFee: site.delivery_fee_paisa,
    deliveryAreas: site.delivery_areas,
    minOrderDelivery: site.min_order_delivery_paisa,
    minOrderPickup: site.min_order_pickup_paisa,
    paymentMethods: site.payment_methods_enabled,
    features: site.features,
    ordersPaused: site.orders_paused === true,
    // 0 and null both mean "no limit" (BUG-003); always report null so the UI has one meaning
    codMaxTotal: rules.cod_max_total_paisa ? rules.cod_max_total_paisa : null,
    maxOpenOrdersPerPhone: rules.max_open_orders_per_phone,
    ipOpenOrdersMax: rules.ip_open_orders_max ?? 3,
    ipOrdersMaxPerDay: rules.ip_orders_max_per_day ?? 10,
    autoCancelPlacedAfterMinutes: rules.auto_cancel_placed_after_minutes ?? null,
    tableOrdering: site.table_ordering === "on" || site.table_ordering === "paused" ? site.table_ordering : "off",
    staffCancelWindowMinutes: rules.staff_cancel_window_minutes ?? 10,
    ownerAlertWhatsApp: Array.isArray(rules.owner_alert_whatsapp) ? rules.owner_alert_whatsapp : [],
  };
}

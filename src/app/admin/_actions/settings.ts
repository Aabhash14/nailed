"use server";

import { revalidateTag } from "next/cache";
import { CACHE_TAG } from "@/lib/cache-tags";
import { runAction } from "@/lib/actions";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/data/server-admin";
import { loadSettings } from "@/lib/data/settings";
import { unwrap } from "@/lib/data/db-errors";
import { AppError } from "@/lib/errors";
import { securityEvent } from "@/lib/log";
import {
  DELIVERY_NEEDS_AREA,
  setAnnouncementSchema,
  setOrdersPausedSchema,
  updateSettingsSchema,
} from "@/lib/validation/admin";
import { parseInput } from "@/lib/validation/common";

/** Owner read of all settings including the admin-only order rules (read helper, not in the contract table). */
export async function getSettings() {
  return runAction(async () => {
    await requireRole("owner");
    return loadSettings(createAdminClient());
  });
}

export async function updateSettings(input: unknown) {
  return runAction(async () => {
    const user = await requireRole("owner");
    const p = parseInput(updateSettingsSchema, input);
    const db = createAdminClient();

    // BUG-006: delivery (cod) needs at least one area. When only one of the two fields is sent,
    // check against the stored value of the other.
    if ((p.paymentMethods !== undefined) !== (p.deliveryAreas !== undefined)) {
      const current = await loadSettings(db);
      const methods = p.paymentMethods ?? current.paymentMethods;
      const areas = p.deliveryAreas ?? current.deliveryAreas;
      if (methods.includes("cod") && areas.length === 0) {
        throw new AppError("VALIDATION", undefined, { fieldErrors: { deliveryAreas: [DELIVERY_NEEDS_AREA] } });
      }
    }

    // Explicit column list, built field by field: `table_ordering` is never written here (the schema refuses
    // `tableOrdering` and the database guard answers 42501 to any writer but set_table_ordering(), SEC-029).
    const site: Record<string, unknown> = {};
    if (p.cafeName !== undefined) site.cafe_name = p.cafeName;
    if (p.hours !== undefined) site.hours = p.hours;
    if (p.announcement !== undefined) site.announcement = p.announcement || null;
    if (p.phone !== undefined) site.phone = p.phone || null;
    if (p.whatsapp !== undefined) site.whatsapp = p.whatsapp || null;
    if (p.email !== undefined) site.email = p.email || null;
    if (p.address !== undefined) site.address = p.address || null;
    if (p.landmark !== undefined) site.landmark = p.landmark || null;
    if (p.mapUrl !== undefined) site.map_url = p.mapUrl || null;
    if (p.pricesIncludeVat !== undefined) site.prices_include_vat = p.pricesIncludeVat;
    if (p.serviceChargePct !== undefined) site.service_charge_pct = p.serviceChargePct;
    if (p.deliveryFee !== undefined) site.delivery_fee_paisa = p.deliveryFee;
    if (p.deliveryAreas !== undefined) site.delivery_areas = p.deliveryAreas;
    if (p.minOrderDelivery !== undefined) site.min_order_delivery_paisa = p.minOrderDelivery;
    if (p.minOrderPickup !== undefined) site.min_order_pickup_paisa = p.minOrderPickup;
    if (p.paymentMethods !== undefined) site.payment_methods_enabled = [...new Set(p.paymentMethods)];
    if (p.ordersPaused !== undefined) site.orders_paused = p.ordersPaused;

    const rules: Record<string, unknown> = {};
    if (p.codMaxTotal !== undefined) rules.cod_max_total_paisa = p.codMaxTotal; // 0 already became null (BUG-003)
    if (p.maxOpenOrdersPerPhone !== undefined) rules.max_open_orders_per_phone = p.maxOpenOrdersPerPhone;
    if (p.ipOpenOrdersMax !== undefined) rules.ip_open_orders_max = p.ipOpenOrdersMax;
    if (p.ipOrdersMaxPerDay !== undefined) rules.ip_orders_max_per_day = p.ipOrdersMaxPerDay;
    if (p.autoCancelPlacedAfterMinutes !== undefined) rules.auto_cancel_placed_after_minutes = p.autoCancelPlacedAfterMinutes;
    if (p.staffCancelWindowMinutes !== undefined) rules.staff_cancel_window_minutes = p.staffCancelWindowMinutes;
    if (p.ownerAlertWhatsApp !== undefined) rules.owner_alert_whatsapp = [...new Set(p.ownerAlertWhatsApp)];

    if (Object.keys(site).length > 0) unwrap(await db.from("site_settings").update(site).eq("id", true));
    if (Object.keys(rules).length > 0) unwrap(await db.from("order_rules").update(rules).eq("id", true));
    securityEvent("settings_changed", { userId: user.userId, fields: Object.keys(p) });
    if (p.ordersPaused !== undefined) securityEvent(p.ordersPaused ? "orders_paused" : "orders_resumed", { userId: user.userId });

    revalidateTag(CACHE_TAG.settings);
    revalidateTag(CACHE_TAG.menu);
    return loadSettings(db);
  });
}

/** Owner or staff. */
export async function setAnnouncement(input: unknown) {
  return runAction(async (): Promise<null> => {
    await requireRole("staff");
    const { text } = parseInput(setAnnouncementSchema, input);
    unwrap(await createAdminClient().from("site_settings").update({ announcement: text || null }).eq("id", true));
    revalidateTag(CACHE_TAG.settings);
    revalidateTag(CACHE_TAG.menu);
    return null;
  });
}

/**
 * Owner only. Kill switch (SEC-003): pauses or resumes ALL online orders. Writes site_settings.orders_paused;
 * create_order checks it first and raises ORDERS_PAUSED, which checkout returns as HTTP 503.
 * The column is public (site_settings), so the checkout page can show "please phone us" while paused.
 */
export async function setOrdersPaused(input: unknown) {
  return runAction(async (): Promise<{ paused: boolean }> => {
    const user = await requireRole("owner");
    const { paused } = parseInput(setOrdersPausedSchema, input);
    const rows = unwrap(
      await createAdminClient().from("site_settings").update({ orders_paused: paused }).eq("id", true).select("orders_paused"),
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError("INTERNAL", undefined, { logDetail: "site_settings row missing on pause" });
    }
    securityEvent(paused ? "orders_paused" : "orders_resumed", { userId: user.userId });
    revalidateTag(CACHE_TAG.settings);
    revalidateTag(CACHE_TAG.shop);
    return { paused };
  });
}

"use server";

import { runAction } from "@/lib/actions";
import { requireRole } from "@/lib/auth/require-role";
import { mapRpcError } from "@/lib/data/db-errors";
import { createAdminClient } from "@/lib/data/server-admin";
import { scheduleAfter } from "@/lib/deps";
import { AppError } from "@/lib/errors";
import { securityEvent } from "@/lib/log";
import { sendOrderConfirmedEmail } from "@/lib/notify/email";
import {
  blockedPhoneSet,
  getAdminOrderRow,
  getOrderById,
  ORDER_SELECT,
  toAdminOrderRow,
  type AdminOrderRow,
  type OrderWithItems,
} from "@/lib/orders/view";
import { normalizeNepalPhone } from "@/lib/phone";
import { cancelOrderSchema, getOrderSchema, orderFilterSchema, updateOrderStatusSchema } from "@/lib/validation/admin";
import { parseInput } from "@/lib/validation/common";

/** Owner or staff. Filters are applied with typed builder calls only: no user text is ever put into a filter string. */
export async function listOrders(input: unknown) {
  return runAction(async (): Promise<{ rows: AdminOrderRow[]; total: number }> => {
    await requireRole("staff");
    const f = parseInput(orderFilterSchema, input ?? {});
    const page = f.page ?? 1;
    const pageSize = f.pageSize ?? 25;
    const db = createAdminClient();

    let q = db.from("orders").select(ORDER_SELECT, { count: "exact" });
    if (f.status?.length) q = q.in("status", f.status);
    if (f.fulfilment?.length) q = q.in("fulfilment", f.fulfilment);
    if (f.from) q = q.gte("created_at", f.from);
    if (f.to) q = q.lte("created_at", f.to);
    if (f.q) {
      const text = f.q.trim();
      if (/^[A-Za-z]{1,4}-?\d+$/.test(text)) {
        const digits = text.replace(/\D/g, "");
        q = q.ilike("number", `%${digits}`);
      } else {
        const phone = normalizeNepalPhone(text);
        const digits = text.replace(/\D/g, "");
        if (phone) q = q.eq("customer_phone", phone);
        else if (digits.length >= 4) q = q.ilike("customer_phone", `%${digits}%`);
        else q = q.eq("id", "00000000-0000-0000-0000-000000000000"); // nothing can match a short junk query
      }
    }
    const res = await q.order("created_at", { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
    if (res.error) throw new AppError("INTERNAL", undefined, { logDetail: `listOrders: ${res.error.code}` });
    const rows = (res.data ?? []) as unknown as OrderWithItems[];
    const blocked = await blockedPhoneSet(
      db,
      rows.map((r) => r.customer_phone ?? ""),
    );
    return { rows: rows.map((r) => toAdminOrderRow(r, blocked)), total: res.count ?? rows.length };
  });
}

/** Owner or staff. One order by id (read helper for the order detail page; not in the 1.2.0 contract table). */
export async function getOrder(input: unknown) {
  return runAction(async (): Promise<AdminOrderRow> => {
    await requireRole("staff");
    const { orderId } = parseInput(getOrderSchema, input);
    return getAdminOrderRow(createAdminClient(), orderId);
  });
}

/**
 * Owner or staff. Transition rules are enforced by the database function set_order_status.
 * On `confirmed` (staff have phoned the customer) the optional customer email is sent (SEC-017: never at
 * placement, so checkout cannot be used to make the cafe mail arbitrary addresses).
 */
export async function updateOrderStatus(input: unknown) {
  return runAction(async (): Promise<AdminOrderRow> => {
    const user = await requireRole("staff");
    const data = parseInput(updateOrderStatusSchema, input);
    const db = createAdminClient();
    const { error } = await db.rpc("set_order_status", {
      p_order_id: data.orderId,
      p_status: data.status,
      p_actor: user.userId,
    });
    if (error) throw mapRpcError(error);
    securityEvent("order_status_changed", { userId: user.userId, orderId: data.orderId, to: data.status });

    const o = await getOrderById(db, data.orderId);
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    if (data.status === "confirmed" && o.status === "confirmed" && o.customer_email && siteUrl) {
      const mail = {
        to: o.customer_email,
        orderNumber: o.number,
        total: o.total_paisa,
        fulfilment: o.fulfilment,
        orderUrl: `${siteUrl.replace(/\/$/, "")}/order/${o.public_token}`,
      };
      scheduleAfter(() => sendOrderConfirmedEmail(mail));
    }
    return toAdminOrderRow(o, await blockedPhoneSet(db, [o.customer_phone ?? ""]));
  });
}

/**
 * Owner or staff. A reason is required (Zod). Cancelling an out_for_delivery / ready_for_pickup order is
 * owner only: set_order_status reads the actor role from `profiles` and raises FORBIDDEN otherwise.
 */
export async function cancelOrder(input: unknown) {
  return runAction(async (): Promise<AdminOrderRow> => {
    const user = await requireRole("staff");
    const data = parseInput(cancelOrderSchema, input);
    const db = createAdminClient();
    const { error } = await db.rpc("cancel_order", {
      p_order_id: data.orderId,
      p_actor: user.userId,
      p_reason: data.reason,
      p_restock: data.restock,
      p_block_contact: data.blockContact ?? false,
    });
    if (error) throw mapRpcError(error);
    securityEvent("order_status_changed", { userId: user.userId, orderId: data.orderId, to: "cancelled", reason: data.reason });
    if (data.blockContact) securityEvent("blocklist_added", { userId: user.userId, kind: "phone", orderId: data.orderId });
    return getAdminOrderRow(db, data.orderId);
  });
}

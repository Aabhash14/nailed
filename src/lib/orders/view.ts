import type { Db } from "@/lib/data/types";
import { AppError } from "@/lib/errors";
import type { CancelReason, Fulfilment, OrderItemRow, OrderRow, OrderStatus, PaymentMethod } from "@/types/db";

/** api-contract.md OrderView / AdminOrderRow. */
export type OrderView = {
  number: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: "unpaid" | "paid";
  fulfilment: Fulfilment;
  items: { name: string; qty: number; unitPrice: number }[];
  subtotal: number;
  deliveryFee: number;
  vat: number;
  total: number;
  customerName: string;
  canCancel: boolean;
  createdAt: string;
  /**
   * Why the order was cancelled (null unless status = cancelled). Added 2026-10-21 so the customer page can explain
   * an `auto_unconfirmed` cancel. PENDING CONTRACT (additive, minor bump; tech-lead to fold into api-contract).
   * Public form: see publicCancelReason (staff's "fake" judgement is not shown to the customer).
   */
  cancelReason: CancelReason | null;
};

export type AdminOrderRow = OrderView & {
  id: string;
  customerPhone: string;
  customerEmail: string | null;
  address: string | null;
  landmark: string | null;
  area: string | null;
  notes: string | null;
  cancelReason: CancelReason | null;
  confirmedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  isStale: boolean;
  phoneIsBlocked: boolean;
};

export type OrderWithItems = OrderRow & {
  order_items: Pick<OrderItemRow, "name" | "variant_label" | "unit_price_paisa" | "qty">[];
};

export const STALE_PLACED_MS = 30 * 60 * 1000;

export const ORDER_SELECT = "*, order_items(name, variant_label, unit_price_paisa, qty)";

/** First name only; purged orders have no name. */
export function firstName(name: string | null): string {
  const n = (name ?? "").trim().split(/\s+/)[0];
  return n || "Customer";
}

/**
 * Cancel reason as shown to the token holder. "fake" is staff's fraud judgement: showing it would tell an abuser the
 * order was flagged (and hint at the blocklist, which ORDER_REFUSED deliberately hides), so it reads as "other".
 * Every other reason, including auto_unconfirmed and customer_request, is passed through. Staff see the real value
 * in AdminOrderRow.
 */
export function publicCancelReason(r: CancelReason | null): CancelReason | null {
  if (r === "fake") return "other";
  return r ?? null;
}

export function toOrderView(o: OrderWithItems): OrderView {
  return {
    number: o.number,
    status: o.status,
    paymentMethod: o.payment_method,
    paymentStatus: o.payment_status,
    fulfilment: o.fulfilment,
    items: (o.order_items ?? []).map((i) => ({
      name: i.variant_label ? `${i.name} (${i.variant_label})` : i.name,
      qty: i.qty,
      unitPrice: i.unit_price_paisa,
    })),
    subtotal: o.subtotal_paisa,
    deliveryFee: o.delivery_fee_paisa,
    vat: o.vat_paisa,
    total: o.total_paisa,
    customerName: firstName(o.customer_name),
    canCancel: o.status === "placed",
    createdAt: o.created_at,
    cancelReason: o.status === "cancelled" ? publicCancelReason(o.cancel_reason) : null,
  };
}

export function toAdminOrderRow(
  o: OrderWithItems,
  blockedPhones: ReadonlySet<string>,
  now: Date = new Date(),
): AdminOrderRow {
  return {
    ...toOrderView(o),
    // staff see the full name, not the first-name-only public form
    customerName: (o.customer_name ?? "").trim() || "Customer (purged)",
    id: o.id,
    customerPhone: o.customer_phone ?? "",
    customerEmail: o.customer_email,
    address: o.address,
    landmark: o.landmark,
    area: o.area,
    notes: o.notes,
    cancelReason: o.cancel_reason,
    confirmedAt: o.confirmed_at,
    completedAt: o.completed_at,
    cancelledAt: o.cancelled_at,
    isStale: o.status === "placed" && now.getTime() - new Date(o.created_at).getTime() > STALE_PLACED_MS,
    phoneIsBlocked: o.customer_phone ? blockedPhones.has(o.customer_phone) : false,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/** Public lookup by token. Malformed and unknown tokens give the identical NOT_FOUND. */
export async function getOrderByToken(db: Db, token: string): Promise<OrderWithItems> {
  if (!isUuid(token)) throw new AppError("NOT_FOUND");
  const { data, error } = await db.from("orders").select(ORDER_SELECT).eq("public_token", token).maybeSingle();
  if (error) throw new AppError("INTERNAL", undefined, { logDetail: `order lookup: ${error.code}` });
  if (!data) throw new AppError("NOT_FOUND");
  return data as unknown as OrderWithItems;
}

/** Blocked phones among the given list (non-expired entries only). */
export async function blockedPhoneSet(db: Db, phones: string[]): Promise<Set<string>> {
  const list = [...new Set(phones.filter(Boolean))];
  if (list.length === 0) return new Set();
  const { data, error } = await db
    .from("blocked_contacts")
    .select("value")
    .eq("kind", "phone")
    .in("value", list)
    .gt("expires_at", new Date().toISOString());
  if (error) throw new AppError("INTERNAL", undefined, { logDetail: `blocklist lookup: ${error.code}` });
  return new Set(((data ?? []) as { value: string }[]).map((r) => r.value));
}

/** Full order row by id (service client). Server-side only: includes public_token and contact data. */
export async function getOrderById(db: Db, orderId: string): Promise<OrderWithItems> {
  const { data, error } = await db.from("orders").select(ORDER_SELECT).eq("id", orderId).maybeSingle();
  if (error) throw new AppError("INTERNAL", undefined, { logDetail: `order read: ${error.code}` });
  if (!data) throw new AppError("NOT_FOUND");
  return data as unknown as OrderWithItems;
}

export async function getAdminOrderRow(db: Db, orderId: string): Promise<AdminOrderRow> {
  const o = await getOrderById(db, orderId);
  return toAdminOrderRow(o, await blockedPhoneSet(db, [o.customer_phone ?? ""]));
}

import { normaliseNepalPhone } from "@/components/format";
import { canCancelAs, canTransition, isActive, type ForwardStatus } from "@/types/order-flow";
import {
  ORDERS_PAUSED,
  type ActionResult,
  type AdminOrderRow,
  type ApiError,
  type BlockedContact,
  type CancelReason,
  type CheckoutRequest,
  type CheckoutResponse,
  type MenuSnapshot,
  type OrderFilter,
  type OrderView,
  type Product,
  type PublicSettings,
  type Role,
} from "@/types/contract";
import { stockStateFor, uid, type MockDb, type MockOrder } from "./seed";

/**
 * Mock "server" logic over a MockDb. It imitates the contract's behaviour closely enough to build and
 * demo the UI (re-pricing, stock, blocklist, caps, state machine). It is NOT the real thing and has no
 * security value: the real rules live in Postgres (create_order, set_order_status).
 */

const fail = (
  code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "OUT_OF_STOCK" | "FORBIDDEN" | "ORDER_REFUSED",
  message: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> => ({ ok: false, error: { code, message, fieldErrors } });

const STALE_MINUTES = 30;

export function toMenuSnapshot(db: MockDb): MenuSnapshot {
  return {
    categories: db.menu
      .filter((c) => c.isVisible)
      .map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        sortOrder: c.sortOrder,
        translations: c.translations ?? {}, // ?? {}: browser copies saved before 1.4.0
        items: c.items
          .filter((i) => i.isVisible)
          .map(({ isVisible: _v, imagePath: _p, ...pub }) => {
            void _v;
            void _p;
            return pub;
          }),
      }))
      .filter((c) => c.items.length > 0),
    specials: db.specials,
    settings: {
      hours: db.settings.hours,
      announcement: db.settings.announcement,
      pricesIncludeVat: db.settings.pricesIncludeVat,
      serviceChargePct: db.settings.serviceChargePct,
      vatPct: db.settings.vatPct,
      tableOrdering: db.settings.tableOrdering ?? "off",
    },
    // `tables` (occupancy) is never part of the server-rendered snapshot; public-client adds it to polled ones
    updatedAt: db.updatedAt,
  };
}

export function toPublicProducts(db: MockDb): Product[] {
  return db.products
    .filter((p) => p.isPublished)
    .map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      price: p.price,
      images: p.images.map((im) => ({ url: im.url, alt: im.alt, variants: im.variants })), // no storage path in public
      details: p.details,
      variants: p.variants.map((v) => ({
        id: v.id,
        size: v.size,
        colour: v.colour,
        stockState: v.stockState,
        price: v.price,
      })),
    }));
}

function withDerived(db: MockDb, o: MockOrder, now: number): MockOrder {
  const blocked = db.blocked.some((b) => b.kind === "phone" && b.value === o.customerPhone);
  return {
    ...o,
    canCancel: o.status === "placed",
    isStale:
      o.status === "placed" && (now - new Date(o.createdAt).getTime()) / 60000 > STALE_MINUTES,
    phoneIsBlocked: blocked,
  };
}

/** Contract section 4 ORDERS_PAUSED text: the cafe phone when there is one. */
export function ordersPausedError(s: Pick<PublicSettings, "phone">): ApiError {
  const call = s.phone
    ? `Please call us on ${s.phone} to order.`
    : "Please call the cafe to order.";
  return { code: ORDERS_PAUSED, message: `We are not taking online orders right now. ${call}` };
}

function toView(o: MockOrder): OrderView {
  return {
    // contract section 1: staff's "fake" judgement is shown to the token holder as "other"
    cancelReason: o.cancelReason === "fake" ? "other" : o.cancelReason,
    number: o.number,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    fulfilment: o.fulfilment,
    items: o.items,
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    vat: o.vat,
    total: o.total,
    customerName: o.customerName.split(" ")[0] ?? o.customerName,
    canCancel: o.status === "placed",
    createdAt: o.createdAt,
  };
}

/** Same fixed text as the server (no phone in it, SEC-001); the checkout page adds the cafe phone itself. */
export function refusedText(): string {
  return "We can't take this order online right now. Please call us.";
}

export function mockCheckout(
  db: MockDb,
  req: CheckoutRequest,
  now: number = Date.now(),
): ActionResult<CheckoutResponse> {
  const s = db.settings;
  // Owner kill switch (SEC-003): checked first, like create_order.
  if (s.ordersPaused) return { ok: false, error: ordersPausedError(s) };
  if (req.items.length === 0) return fail("VALIDATION", "Your cart is empty.");
  if (!req.turnstileToken)
    return {
      ok: false,
      error: { code: "BOT_CHECK_FAILED", message: "Please complete the check and try again." },
    };
  if (!s.paymentMethods.includes(req.paymentMethod))
    return fail("VALIDATION", "That payment method is not available.");
  if ((req.fulfilment === "delivery") !== (req.paymentMethod === "cod"))
    return fail("VALIDATION", "Payment method does not match delivery or pickup.");
  const phone = normaliseNepalPhone(req.customer.phone);
  if (!phone)
    return fail("VALIDATION", "Please check the form.", {
      "customer.phone": ["Enter a Nepal mobile number"],
    });
  if (req.fulfilment === "delivery") {
    if (!req.delivery?.address)
      return fail("VALIDATION", "Please check the form.", {
        "delivery.address": ["Enter the address"],
      });
    if (!s.deliveryAreas.includes(req.delivery.area))
      return fail("VALIDATION", "Please check the form.", {
        "delivery.area": ["Choose one of the delivery areas"],
      });
  }

  const lines: MockOrder["lines"] = [];
  const stockErrors: Record<string, string[]> = {};
  req.items.forEach((line, idx) => {
    for (const p of db.products) {
      const v = p.variants.find((x) => x.id === line.variantId);
      if (!v) continue;
      if (v.stock < line.qty) {
        stockErrors[`items.${idx}`] = [v.stock <= 0 ? "sold out" : `only ${v.stock} left`];
      }
      lines.push({
        variantId: v.id,
        name: `${p.name} (${v.size}, ${v.colour})`,
        qty: line.qty,
        unitPrice: v.price,
      });
    }
  });
  if (lines.length !== req.items.length)
    return fail("VALIDATION", "An item in your cart is no longer available.");

  const sub = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  const deliveryFee = req.fulfilment === "delivery" ? s.deliveryFee : 0;
  const vat = s.pricesIncludeVat ? 0 : Math.round((sub * s.vatPct) / 100);
  const total = sub + deliveryFee + vat;

  const blocked = db.blocked.some((b) => b.kind === "phone" && b.value === phone);
  const open = db.orders.filter((o) => o.customerPhone === phone && isActive(o.status)).length;
  // BUG-003 (Manager decision): codMaxTotal null OR 0 means "no limit".
  const overCodLimit = s.codMaxTotal !== null && s.codMaxTotal > 0 && total > s.codMaxTotal;
  if (blocked || open >= s.maxOpenOrdersPerPhone || overCodLimit) {
    return fail("ORDER_REFUSED", refusedText()); // same text whatever fired
  }
  const min = req.fulfilment === "delivery" ? s.minOrderDelivery : s.minOrderPickup;
  if (min > 0 && sub < min) {
    return fail("VALIDATION", "Minimum order not reached.", {
      items: [`Minimum order for ${req.fulfilment} is Rs. ${min / 100}`],
    });
  }
  if (Object.keys(stockErrors).length > 0)
    return fail("OUT_OF_STOCK", "Some items are not available in that quantity.", stockErrors);

  for (const l of lines) {
    for (const p of db.products) {
      const v = p.variants.find((x) => x.id === l.variantId);
      if (v) {
        v.stock -= l.qty;
        v.stockState = stockStateFor(v.stock);
      }
    }
  }
  db.seq += 1;
  const token = crypto.randomUUID();
  const order: MockOrder = {
    id: crypto.randomUUID(),
    token,
    number: `NC-${db.seq}`,
    status: "placed",
    paymentMethod: req.paymentMethod,
    paymentStatus: "unpaid",
    fulfilment: req.fulfilment,
    items: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice })),
    lines,
    subtotal: sub,
    deliveryFee,
    vat,
    total,
    customerName: req.customer.name,
    canCancel: true,
    createdAt: new Date(now).toISOString(),
    customerPhone: phone,
    customerEmail: req.customer.email ?? null,
    address: req.delivery?.address ?? null,
    landmark: req.delivery?.landmark ?? null,
    area: req.delivery?.area ?? null,
    notes: req.notes ?? null,
    cancelReason: null,
    confirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    isStale: false,
    phoneIsBlocked: false,
  };
  db.orders.unshift(order);
  db.updatedAt = new Date(now).toISOString();
  return {
    ok: true,
    data: {
      orderToken: token,
      orderNumber: order.number,
      total,
      willCallToConfirm: true,
      payment: { type: "none" },
    },
  };
}

/**
 * Mock of the DB job auto_cancel_unconfirmed_orders(): orders still `placed` after
 * settings.autoCancelPlacedAfterMinutes are cancelled with reason auto_unconfirmed and restocked. null = off.
 * Called before reads that go through mutateDb, so the demo behaves like the scheduled job.
 */
export function sweepAutoCancel(db: MockDb, now: number = Date.now()): void {
  const mins = db.settings.autoCancelPlacedAfterMinutes;
  if (mins === null || mins === undefined || mins <= 0) return;
  for (const o of db.orders) {
    if (o.status === "placed" && now - new Date(o.createdAt).getTime() > mins * 60_000) {
      o.status = "cancelled";
      o.cancelReason = "auto_unconfirmed";
      o.cancelledAt = new Date(now).toISOString();
      restock(db, o);
    }
  }
}

export function mockOrderByToken(db: MockDb, token: string): ActionResult<OrderView> {
  const o = db.orders.find((x) => x.token === token);
  return o ? { ok: true, data: toView(o) } : fail("NOT_FOUND", "We could not find that order.");
}

function restock(db: MockDb, o: MockOrder) {
  for (const l of o.lines) {
    for (const p of db.products) {
      const v = p.variants.find((x) => x.id === l.variantId);
      if (v) {
        v.stock += l.qty;
        v.stockState = stockStateFor(v.stock);
      }
    }
  }
}

export function mockCustomerCancel(
  db: MockDb,
  token: string,
  now = Date.now(),
): ActionResult<OrderView> {
  const o = db.orders.find((x) => x.token === token);
  if (!o) return fail("NOT_FOUND", "We could not find that order.");
  if (o.status === "cancelled" && o.cancelReason === "customer_request")
    return { ok: true, data: toView(o) };
  if (o.status !== "placed") return fail("CONFLICT", "Please call us to change this order");
  o.status = "cancelled";
  o.cancelReason = "customer_request";
  o.cancelledAt = new Date(now).toISOString();
  restock(db, o);
  return { ok: true, data: toView(o) };
}

export function mockListOrders(
  db: MockDb,
  f: OrderFilter,
  now = Date.now(),
): ActionResult<{ rows: AdminOrderRow[]; total: number }> {
  let rows = db.orders.map((o) => withDerived(db, o, now));
  if (f.status?.length) rows = rows.filter((o) => f.status!.includes(o.status));
  if (f.fulfilment?.length) rows = rows.filter((o) => f.fulfilment!.includes(o.fulfilment));
  if (f.from) rows = rows.filter((o) => o.createdAt >= f.from!);
  if (f.to) rows = rows.filter((o) => o.createdAt <= f.to!);
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((o) => o.number.toLowerCase().includes(q) || o.customerPhone.includes(q));
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const size = Math.min(100, f.pageSize ?? 25);
  const page = Math.max(1, f.page ?? 1);
  return {
    ok: true,
    data: { rows: rows.slice((page - 1) * size, page * size), total: rows.length },
  };
}

export function mockUpdateStatus(
  db: MockDb,
  orderId: string,
  status: ForwardStatus,
  now = Date.now(),
): ActionResult<AdminOrderRow> {
  const o = db.orders.find((x) => x.id === orderId);
  if (!o) return fail("NOT_FOUND", "Order not found.");
  if (!canTransition(o.status, status, o.fulfilment))
    return fail("CONFLICT", "That change is not allowed for this order.");
  o.status = status;
  const t = new Date(now).toISOString();
  if (status === "confirmed") o.confirmedAt = t;
  if (status === "completed") {
    o.completedAt = t;
    o.paymentStatus = "paid";
  }
  return { ok: true, data: withDerived(db, o, now) };
}

export function mockCancelOrder(
  db: MockDb,
  input: { orderId: string; reason: CancelReason; restock: boolean; blockContact?: boolean },
  role: Role,
  now = Date.now(),
): ActionResult<AdminOrderRow> {
  const o = db.orders.find((x) => x.id === input.orderId);
  if (!o) return fail("NOT_FOUND", "Order not found.");
  if (!isActive(o.status)) return fail("CONFLICT", "This order can no longer be cancelled.");
  if (!canCancelAs(o.status, role))
    return fail(
      "FORBIDDEN",
      "Only the owner can cancel an order that is already out for delivery or ready for pickup.",
    );
  o.status = "cancelled";
  o.cancelReason = input.reason;
  o.cancelledAt = new Date(now).toISOString();
  if (input.restock) restock(db, o);
  if (input.blockContact)
    mockBlock(
      db,
      { kind: "phone", value: o.customerPhone, reason: `Order ${o.number}: ${input.reason}` },
      now,
    );
  return { ok: true, data: withDerived(db, o, now) };
}

export function mockBlock(
  db: MockDb,
  input: { kind: "phone" | "ip_hash"; value: string; reason?: string },
  now = Date.now(),
): ActionResult<BlockedContact> {
  const value = input.kind === "phone" ? normaliseNepalPhone(input.value) : input.value;
  if (!value)
    return fail("VALIDATION", "Enter a Nepal mobile number.", {
      value: ["Enter a Nepal mobile number"],
    });
  const existing = db.blocked.find((b) => b.kind === input.kind && b.value === value);
  if (existing) return { ok: true, data: existing };
  const row: BlockedContact = {
    id: uid(db.blocked.length + 1 + Math.floor(now % 100000), 10),
    kind: input.kind,
    value,
    reason: input.reason ?? null,
    createdBy: uid(1, 11),
    createdAt: new Date(now).toISOString(),
  };
  db.blocked.unshift(row);
  return { ok: true, data: row };
}

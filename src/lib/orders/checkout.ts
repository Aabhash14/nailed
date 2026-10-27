import type { Db } from "@/lib/data/types";
import { AppError, newRequestId } from "@/lib/errors";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { mapRpcError } from "@/lib/data/db-errors";
import { securityEvent } from "@/lib/log";
import { notifyInternalError, notifyNewOrder } from "@/lib/notify/telegram";
import { revalidateShopAfterCheckout } from "@/lib/orders/shop-revalidate";
import { prepare } from "@/lib/payments/cod";
import { clientIp, enforceLimit, ipKey, LIMITS } from "@/lib/ratelimit";
import { verifyTurnstile } from "@/lib/turnstile";
import { parseInput } from "@/lib/validation/common";
import { checkoutRequestSchema } from "@/lib/validation/checkout";
import type { CreateOrderRow } from "@/types/db";

export type CheckoutResponse = {
  orderToken: string;
  orderNumber: string;
  total: number;
  willCallToConfirm: true;
  payment: { type: "none" };
};

export type CheckoutDeps = {
  db: () => Db;
  salt: () => string;
  siteUrl: () => string | undefined;
  /** Run work after the response (Next `after`). Failures must never reach the customer. */
  schedule: (work: () => Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
  turnstile?: typeof verifyTurnstile;
  /**
   * revalidateTag("shop") (ADR 0001 F1). Called only from post-response work, threshold-gated and coalesced
   * (src/lib/orders/shop-revalidate.ts). Omitted = never revalidate.
   */
  revalidateShop?: () => void;
};

const REFUSED_FALLBACK = "We can't take this order online right now. Please call us.";
const PAUSED_FALLBACK = "We are not taking online orders right now. Please call the cafe to order.";

async function cafePhone(db: Db): Promise<string | null> {
  try {
    const { data } = await db.from("public_settings").select("phone").limit(1).maybeSingle();
    return (data as { phone: string | null } | null)?.phone ?? null;
  } catch {
    return null;
  }
}

/**
 * Same text whatever rule fired (api-contract 0). SEC-001: no database read on the refusal path (it made a
 * refusal measurably slower than other answers). The checkout page adds the cafe phone from public settings.
 */
const REFUSED_MESSAGE = REFUSED_FALLBACK;

/**
 * Kill switch (SEC-003). Unlike ORDER_REFUSED this is disclosable (the whole shop is paused, not this person),
 * so reading the phone here leaks nothing.
 */
async function pausedMessage(db: Db): Promise<string> {
  const phone = await cafePhone(db);
  return phone ? `We are not taking online orders right now. Please call us on ${phone} to order.` : PAUSED_FALLBACK;
}

/**
 * POST /api/checkout (api-contract 3.1). Order of checks: body (JSON content type, size cap) -> Zod ->
 * Turnstile -> IP limit -> create_order (kill switch, per-phone and per-IP order caps, blocklist,
 * open-order cap, COD max, min order, stock: all inside one transaction). Pricing is never taken from
 * the client. There is no per-phone ATTEMPT limiter any more (SEC-002); the database counts real orders.
 * The customer email is NOT sent here; it goes out when staff confirm the order (SEC-017).
 */
export async function handleCheckout(req: Request, deps: CheckoutDeps): Promise<Response> {
  const requestId = newRequestId();
  let db: Db | null = null;
  try {
    const input = parseInput(checkoutRequestSchema, await readJson(req, { requireJsonContentType: true }));

    const ip = clientIp(req.headers);
    await (deps.turnstile ?? verifyTurnstile)(input.turnstileToken, ip);

    db = deps.db();
    const salt = deps.salt();
    const ipk = await ipKey("checkout", req.headers, salt);
    await enforceLimit(db, ipk.key, LIMITS.checkoutIp);

    const delivery = input.fulfilment === "delivery" ? input.delivery : undefined;
    const { data, error } = await db.rpc("create_order", {
      p_items: input.items,
      p_fulfilment: input.fulfilment,
      p_payment_method: input.paymentMethod,
      p_customer_name: input.customer.name,
      p_customer_phone: input.customer.phone,
      p_customer_email: input.customer.email ?? null,
      p_address: delivery?.address ?? null,
      p_landmark: delivery?.landmark ?? null,
      p_area: delivery?.area ?? null,
      p_notes: input.notes ?? null,
      p_ip_hash: ipk.hash, // never null: a missing IP is the shared "unknown" bucket (SEC-009)
    });
    if (error) {
      const mapped = mapRpcError(error);
      if (mapped.code === "ORDER_REFUSED") {
        // The database hides the cause (blocklist, open-order cap, COD max); we log only that a refusal happened.
        securityEvent("order_refused", { requestId, ipHashPrefix: ipk.hash });
        return jsonError(new AppError("ORDER_REFUSED", REFUSED_MESSAGE), requestId);
      }
      if (mapped.code === "ORDERS_PAUSED") {
        securityEvent("order_refused_paused", { requestId });
        return jsonError(new AppError("ORDERS_PAUSED", await pausedMessage(db)), requestId);
      }
      if (mapped.code === "RATE_LIMITED") securityEvent("rate_limited", { scope: "checkout-db", requestId, ipHashPrefix: ipk.hash });
      throw mapped;
    }
    const row = (Array.isArray(data) ? data[0] : data) as CreateOrderRow | undefined;
    if (!row) throw new AppError("INTERNAL", undefined, { logDetail: "create_order returned no row" });

    const payment = prepare(input.paymentMethod);
    const alertDb = db;
    deps.schedule(() =>
      notifyNewOrder(
        alertDb,
        {
          orderId: row.out_order_id,
          orderNumber: row.out_order_number,
          itemCount: input.items.reduce((n, i) => n + i.qty, 0),
          fulfilment: input.fulfilment,
          total: row.out_total_paisa,
        },
        deps.fetchImpl,
      ),
    );
    // F1: post-response only (never before create_order, SEC-001). Revalidates `shop` when an ordered size is
    // now few_left / sold_out, at most once per 10 minutes.
    const revalidateShop = deps.revalidateShop;
    if (revalidateShop) {
      const variantIds = input.items.map((i) => i.variantId);
      deps.schedule(() => revalidateShopAfterCheckout(alertDb, variantIds, revalidateShop));
    }

    return jsonOk<CheckoutResponse>(
      {
        orderToken: row.out_order_token,
        orderNumber: row.out_order_number,
        total: row.out_total_paisa,
        willCallToConfirm: true,
        payment,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof AppError && e.code === "INTERNAL") {
      const alertDb = db;
      deps.schedule(() => notifyInternalError(alertDb, "checkout", requestId, deps.fetchImpl));
    }
    return jsonError(e, requestId);
  }
}

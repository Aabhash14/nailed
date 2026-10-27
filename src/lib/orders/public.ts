import type { Db } from "@/lib/data/types";
import { AppError, newRequestId } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { mapRpcError } from "@/lib/data/db-errors";
import { notifyCustomerCancelled } from "@/lib/notify/telegram";
import { enforceLimit, ipKey, LIMITS } from "@/lib/ratelimit";
import { revalidateShopAfterCancel } from "./shop-revalidate";
import { getOrderByToken, isUuid, toOrderView } from "./view";

export type PublicOrderDeps = {
  db: () => Db;
  salt: () => string;
  schedule: (work: () => Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
  /** revalidateTag("shop") for ADR 0001 F1 (cancel route only). Omitted = never revalidate. */
  revalidateShop?: () => void;
};

/** GET /api/orders/[token]: the token is the credential. Phone and address are never returned. */
export async function handleOrderGet(req: Request, token: string, deps: PublicOrderDeps): Promise<Response> {
  const requestId = newRequestId();
  try {
    const db = deps.db();
    const ipk = await ipKey("order-get", req.headers, deps.salt());
    await enforceLimit(db, ipk.key, LIMITS.orderLookupIp);
    return jsonOk(toOrderView(await getOrderByToken(db, token)));
  } catch (e) {
    return jsonError(e, requestId);
  }
}

/**
 * POST /api/orders/[token]/cancel (api-contract 2). Rate limit 10/hour/IP, no Turnstile. The state rule
 * (only while `placed`, restock, idempotent) lives in the database function customer_cancel_order.
 */
export async function handleOrderCancel(req: Request, token: string, deps: PublicOrderDeps): Promise<Response> {
  const requestId = newRequestId();
  try {
    const db = deps.db();
    const ipk = await ipKey("order-cancel", req.headers, deps.salt());
    await enforceLimit(db, ipk.key, LIMITS.orderCancelIp);
    if (!isUuid(token)) throw new AppError("NOT_FOUND");

    const before = await getOrderByToken(db, token); // same NOT_FOUND for unknown tokens
    const { error } = await db.rpc("customer_cancel_order", { p_token: token });
    if (error) throw mapRpcError(error);
    const after = await getOrderByToken(db, token);
    if (before.status !== "cancelled" && after.status === "cancelled") {
      // not on idempotent repeats; coalesced to one message a minute (SEC-003)
      deps.schedule(() => notifyCustomerCancelled(db, after.number, deps.fetchImpl));
    }
    // F1: post-response only. Revalidate `shop` when THIS request restocked (not on idempotent repeats), coalesced.
    const restocked = !before.stock_restocked_at && Boolean(after.stock_restocked_at);
    const revalidateShop = deps.revalidateShop;
    if (restocked && revalidateShop) {
      deps.schedule(() => revalidateShopAfterCancel(db, true, revalidateShop));
    }
    return jsonOk(toOrderView(after));
  } catch (e) {
    return jsonError(e, requestId);
  }
}

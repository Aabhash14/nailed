import type { Db } from "@/lib/data/types";
import type { RateLimitInfoRow, StockState } from "@/types/db";

/**
 * ADR 0001 follow-up F1 (option C): after a successful checkout or a real customer cancel, revalidate the `shop`
 * cache tag, but only when it changes what the shop pages show, and at most once per window.
 *
 *  - After checkout: only if any ordered variant is now `few_left` or `sold_out`.
 *  - After a customer cancel: only if the cancel restocked something (orders.stock_restocked_at went from null to set).
 *  - Gate: `rate_limits` key `revalidate:shop`, max 1 per 10 minutes (same table and RPC as the Telegram gate).
 *    The condition is checked FIRST, so an order that changes nothing never uses up the window.
 *  - Fails closed on cost: if the stock read or the gate cannot answer, skip (the page is only cosmetically stale;
 *    checkout re-checks stock and answers OUT_OF_STOCK).
 *
 * Runs only in post-response work (`deps.schedule`, Next `after`), never before create_order (SEC-001), and never
 * throws. Every revalidation is one Workers KV write plus re-rendered pages (R13: 1,000 KV writes a day on Free).
 * The database auto-cancel job cannot call this; its restocks show up at the next coalesced revalidation or the
 * hourly ISR regeneration (F2).
 */

export const SHOP_REVALIDATE_KEY = "revalidate:shop";
/** ESTIMATE (ADR 0001 F1): at most 6 tag writes an hour. */
export const SHOP_REVALIDATE_WINDOW_SECONDS = 10 * 60;

const LOW_STATES: ReadonlySet<StockState> = new Set<StockState>(["few_left", "sold_out"]);

export type ShopRevalidateOutcome = "revalidated" | "not-needed" | "coalesced" | "skipped-error";

/** Claim the single revalidation slot of the current 10-minute window. Fails closed (false) on any error. */
export async function shopRevalidateGate(db: Db): Promise<boolean> {
  try {
    const { data, error } = await db.rpc("rate_limit_hit_info", {
      p_key: SHOP_REVALIDATE_KEY,
      p_window_seconds: SHOP_REVALIDATE_WINDOW_SECONDS,
      p_max: 1,
    });
    if (error) return false;
    const row = (Array.isArray(data) ? data[0] : data) as RateLimitInfoRow | undefined;
    return row?.allowed === true;
  } catch {
    return false;
  }
}

async function gateAndRevalidate(db: Db, revalidate: () => void): Promise<ShopRevalidateOutcome> {
  if (!(await shopRevalidateGate(db))) return "coalesced";
  try {
    revalidate();
    return "revalidated";
  } catch {
    return "skipped-error";
  }
}

/**
 * After a successful checkout. `variantIds` are the product variants in the order. Reads their stock_state
 * (service client; the order is already committed) and revalidates when one of them is now low.
 */
export async function revalidateShopAfterCheckout(
  db: Db,
  variantIds: readonly string[],
  revalidate: () => void,
): Promise<ShopRevalidateOutcome> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return "not-needed";
  let rows: { stock_state: StockState }[];
  try {
    const { data, error } = await db.from("product_variants").select("id, stock_state").in("id", ids);
    if (error) return "skipped-error";
    rows = (data ?? []) as { stock_state: StockState }[];
  } catch {
    return "skipped-error";
  }
  if (!rows.some((r) => LOW_STATES.has(r.stock_state))) return "not-needed";
  return gateAndRevalidate(db, revalidate);
}

/**
 * After a customer cancel. `restocked` = this request's cancel put stock back (stock_restocked_at was null before
 * and is set after). Idempotent repeats and cancels that restocked nothing do not revalidate.
 */
export async function revalidateShopAfterCancel(
  db: Db,
  restocked: boolean,
  revalidate: () => void,
): Promise<ShopRevalidateOutcome> {
  if (!restocked) return "not-needed";
  return gateAndRevalidate(db, revalidate);
}

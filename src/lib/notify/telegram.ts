import type { Db } from "@/lib/data/types";
import { optionalEnv } from "@/lib/env";
import { formatNpr } from "@/lib/money";
import type { RateLimitInfoRow } from "@/types/db";

type FetchLike = typeof fetch;

/** True when both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set (empty = unset). */
export function telegramConfigured(): boolean {
  return !!optionalEnv("TELEGRAM_BOT_TOKEN") && !!optionalEnv("TELEGRAM_CHAT_ID");
}

/** Staff alert. No-op (returns false) when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset. Never throws. */
export async function sendTelegram(text: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const token = optionalEnv("TELEGRAM_BOT_TOKEN");
  const chatId = optionalEnv("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return false;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 1000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- Coalescing (SEC-003, loosened by SEC-019) -------------------------------------------------------

/**
 * Flood control, not traffic control (SEC-019): up to ALERT_MAX_PER_WINDOW messages per alert kind per
 * ALERT_WINDOW_SECONDS are sent one by one. Only a burst above that is coalesced. ESTIMATE: a cafe with phone-
 * confirmed orders does not take 5 orders in one minute outside a merch drop.
 * Held-back alerts are always reported later: by the next alert that gets through ("+N more" line) or, if no
 * further alert comes, by the staff digest (src/lib/notify/staff-digest.ts) that the keep-alive cron runs every
 * 5 minutes. A burst therefore never stays silent for more than about 10 minutes.
 */
export const ALERT_WINDOW_SECONDS = 60;
export const ALERT_MAX_PER_WINDOW = 5;
export const ALERT_KINDS = ["new-order", "customer-cancel", "internal-error"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const alertKey = (kind: AlertKind) => `alert:${kind}`;

/**
 * Decide whether an alert of this kind may be sent now. Uses the shared rate_limits table (Workers have no
 * shared memory): key `alert:<kind>`, 60 s window, max ALERT_MAX_PER_WINDOW. Alerts within the max are sent;
 * the rest are held back and counted. The FIRST alert of a later window reports how many were held back in the
 * previous busy window. Fails OPEN: if the database cannot answer, the alert is sent (missing a real order is
 * worse than a duplicate message).
 */
export async function alertGate(db: Db | null, kind: AlertKind): Promise<{ send: boolean; heldBack: number }> {
  if (!db) return { send: true, heldBack: 0 };
  const key = alertKey(kind);
  try {
    // Read the newest window BEFORE counting this one: if this hit turns out to be the first of a new window,
    // that row is an earlier window and holds the alerts held back there (count - max of them).
    const prev = await db
      .from("rate_limits")
      .select("window_start, count")
      .eq("key", key)
      .order("window_start", { ascending: false })
      .limit(1);
    const { data, error } = await db.rpc("rate_limit_hit_info", {
      p_key: key,
      p_window_seconds: ALERT_WINDOW_SECONDS,
      p_max: ALERT_MAX_PER_WINDOW,
    });
    if (error) return { send: true, heldBack: 0 };
    const row = (Array.isArray(data) ? data[0] : data) as RateLimitInfoRow | undefined;
    if (!row) return { send: true, heldBack: 0 };
    if (!row.allowed) return { send: false, heldBack: 0 };
    // Only the first hit of a window (count 1) reports the previous window; hits 2..max read the current window.
    const firstOfWindow = row.remaining === ALERT_MAX_PER_WINDOW - 1;
    const last = (Array.isArray(prev.data) ? prev.data[0] : prev.data) as { count?: number } | undefined;
    const heldBack =
      firstOfWindow && !prev.error && last && typeof last.count === "number" ? Math.max(0, last.count - ALERT_MAX_PER_WINDOW) : 0;
    return { send: true, heldBack };
  } catch {
    return { send: true, heldBack: 0 };
  }
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function heldBackLine(n: number, what: [string, string]): string {
  if (n <= 0) return "";
  return `\n(+${plural(n, ...what)} since the previous alert. Alerts are limited to ${ALERT_MAX_PER_WINDOW} a minute; check the Today board.)`;
}

// ---- Messages ----------------------------------------------------------------------------------

export type OrderAlert = {
  orderId: string;
  orderNumber: string;
  itemCount: number;
  fulfilment: "pickup" | "delivery";
  total: number;
};

/** New-order alert. Contains NO phone, address or name (architecture.md section 7). */
export function formatNewOrderAlert(o: OrderAlert, siteUrl: string | undefined, heldBack = 0): string {
  const link = siteUrl ? `\n${siteUrl.replace(/\/$/, "")}/admin/orders/${o.orderId}` : "";
  return `New order ${o.orderNumber}: ${o.itemCount} item${o.itemCount === 1 ? "" : "s"}, ${o.fulfilment}, ${formatNpr(o.total)}. Call to confirm.${link}${heldBackLine(heldBack, ["more new order", "more new orders"])}`;
}

/** Coalesced above 5 a minute; the next alert or the staff digest reports how many orders were not alerted. */
export async function notifyNewOrder(db: Db | null, o: OrderAlert, fetchImpl?: FetchLike): Promise<boolean> {
  const gate = await alertGate(db, "new-order");
  if (!gate.send) return false;
  return sendTelegram(formatNewOrderAlert(o, optionalEnv("NEXT_PUBLIC_SITE_URL"), gate.heldBack), fetchImpl);
}

export async function notifyCustomerCancelled(db: Db | null, orderNumber: string, fetchImpl?: FetchLike): Promise<boolean> {
  const gate = await alertGate(db, "customer-cancel");
  if (!gate.send) return false;
  return sendTelegram(
    `Order ${orderNumber} was cancelled by the customer.${heldBackLine(gate.heldBack, ["more customer cancellation", "more customer cancellations"])}`,
    fetchImpl,
  );
}

/** INTERNAL error alert: request id and place only, never request content. Coalesced like the others. */
export async function notifyInternalError(db: Db | null, where: string, requestId: string, fetchImpl?: FetchLike): Promise<boolean> {
  const gate = await alertGate(db, "internal-error");
  if (!gate.send) return false;
  return sendTelegram(
    `Server error in ${where}. Request id ${requestId}.${heldBackLine(gate.heldBack, ["more server error", "more server errors"])}`,
    fetchImpl,
  );
}

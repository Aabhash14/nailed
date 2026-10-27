import { optionalEnv } from "@/lib/env";
import { formatNpr } from "@/lib/money";

type FetchLike = typeof fetch;

export type OrderConfirmedEmail = {
  to: string;
  orderNumber: string;
  total: number;
  fulfilment: "pickup" | "delivery";
  orderUrl: string;
};

/**
 * Optional "order confirmed" email through Resend. Sent only AFTER staff confirm the order by phone
 * (SEC-017: sending at placement let anyone make the cafe mail any address). No-op (returns false) unless
 * both RESEND_API_KEY and RESEND_FROM_EMAIL are set (a verified domain is needed). Plain text, no customer
 * name or address. Never throws.
 */
export async function sendOrderConfirmedEmail(m: OrderConfirmedEmail, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const key = optionalEnv("RESEND_API_KEY");
  const from = optionalEnv("RESEND_FROM_EMAIL");
  if (!key || !from) return false;
  const how = m.fulfilment === "delivery" ? "on delivery" : "at pickup";
  const text = [
    `Your order ${m.orderNumber} is confirmed.`,
    `Please pay ${formatNpr(m.total)} in cash ${how}.`,
    `Track your order: ${m.orderUrl}`,
  ].join("\n\n");
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [m.to], subject: `Order ${m.orderNumber} confirmed`, text }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

import { hasLeadingZeroMobile, normaliseNepalPhone } from "@/components/format";
import { formatNpr } from "@/lib/money";
import type { CheckoutRequest, Fulfilment, PublicSettings } from "@/types/contract";
import { methodForFulfilment } from "@/lib/payments/cod";
import { minimumFor, type CartLine } from "./cart-logic";

export type CheckoutValues = {
  fulfilment: Fulfilment;
  name: string;
  phone: string;
  email: string;
  address: string;
  landmark: string;
  area: string;
  notes: string;
};

export type FieldErrors = Partial<Record<string, string>>;

/** Which fulfilment options this cafe has switched on: delivery needs cod + at least one area, pickup needs pickup. */
export function availableFulfilments(
  s: Pick<PublicSettings, "paymentMethods" | "deliveryAreas">,
): Fulfilment[] {
  const out: Fulfilment[] = [];
  if (s.paymentMethods.includes("pickup")) out.push("pickup");
  if (s.paymentMethods.includes("cod") && s.deliveryAreas.length > 0) out.push("delivery");
  return out;
}

/** The sentence the customer must see before ordering (contract: "Pay Rs. X in cash on delivery/pickup"). */
export function payLine(total: number, fulfilment: Fulfilment): string {
  return `Pay ${formatNpr(total)} in cash on ${fulfilment === "delivery" ? "delivery" : "pickup"}`;
}

export function validateCheckout(
  v: CheckoutValues,
  lines: CartLine[],
  s: Pick<PublicSettings, "minOrderDelivery" | "minOrderPickup" | "deliveryAreas">,
  subtotal: number,
): FieldErrors {
  const e: FieldErrors = {};
  const name = v.name.trim();
  if (name.length < 2 || name.length > 80) e.name = "Enter your name (2 to 80 characters)";
  if (!normaliseNepalPhone(v.phone)) {
    e.phone = hasLeadingZeroMobile(v.phone)
      ? "Leave out the 0 at the start: type the 10-digit mobile number, for example 98XXXXXXXX."
      : "Enter a Nepal mobile number, for example 98XXXXXXXX. We will call it.";
  }
  if (v.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) e.email = "That email does not look right";
  if (v.notes.length > 300) e.notes = "Notes can be up to 300 characters";
  if (v.fulfilment === "delivery") {
    if (!v.address.trim()) e.address = "Enter the delivery address";
    if (!v.landmark.trim()) e.landmark = "Enter a landmark so the rider can find you";
    if (!s.deliveryAreas.includes(v.area)) e.area = "Choose your area";
  }
  if (lines.length === 0) e.items = "Your cart is empty";
  const min = minimumFor(v.fulfilment, s);
  if (lines.length > 0 && min > 0 && subtotal < min) {
    e.items = `Minimum order for ${v.fulfilment} is ${formatNpr(min)}. Add ${formatNpr(min - subtotal)} more.`;
  }
  return e;
}

export function buildRequest(v: CheckoutValues, lines: CartLine[], turnstileToken: string): CheckoutRequest {
  const phone = normaliseNepalPhone(v.phone) ?? v.phone;
  const req: CheckoutRequest = {
    items: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
    fulfilment: v.fulfilment,
    paymentMethod: methodForFulfilment(v.fulfilment),
    customer: { name: v.name.trim(), phone },
    turnstileToken,
  };
  if (v.email.trim()) req.customer.email = v.email.trim();
  if (v.fulfilment === "delivery") {
    req.delivery = { address: v.address.trim(), landmark: v.landmark.trim(), area: v.area };
  }
  if (v.notes.trim()) req.notes = v.notes.trim();
  return req;
}

/** Contract fieldErrors use dotted paths ("customer.phone", "items.0"); map them onto our form keys. */
export function mapServerFieldErrors(fe: Record<string, string[]> | undefined): {
  fields: FieldErrors;
  lines: Record<number, string>;
} {
  const fields: FieldErrors = {};
  const lines: Record<number, string> = {};
  if (!fe) return { fields, lines };
  const alias: Record<string, string> = {
    "customer.name": "name",
    "customer.phone": "phone",
    "customer.email": "email",
    "delivery.address": "address",
    "delivery.landmark": "landmark",
    "delivery.area": "area",
    notes: "notes",
    items: "items",
    turnstileToken: "turnstile",
  };
  for (const [k, msgs] of Object.entries(fe)) {
    const m = /^items\.(\d+)$/.exec(k);
    if (m?.[1] !== undefined) lines[Number(m[1])] = msgs.join(", ");
    else {
      const key = alias[k];
      if (key) fields[key] = msgs.join(", ");
    }
  }
  return { fields, lines };
}

export function refusedMessage(phone: string | null): string {
  return `We can't take this order online right now. Please call us${phone ? ` on ${phone}` : ""}.`;
}

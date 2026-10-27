import type { Fulfilment, Paisa, PublicSettings } from "@/types/contract";

/** Pure cart maths. Prices here are for DISPLAY only: the server re-prices every order (contract 3.1). */

export type CartLine = {
  variantId: string;
  productSlug: string;
  productName: string;
  size: string;
  colour: string;
  unitPrice: Paisa;
  qty: number;
};

export const MAX_LINES = 20;
export const MAX_QTY = 10;

export function addLine(lines: CartLine[], line: Omit<CartLine, "qty">, qty = 1): CartLine[] {
  const existing = lines.find((l) => l.variantId === line.variantId);
  if (existing) {
    return lines.map((l) =>
      l.variantId === line.variantId ? { ...l, qty: Math.min(MAX_QTY, l.qty + qty) } : l,
    );
  }
  if (lines.length >= MAX_LINES) return lines;
  return [...lines, { ...line, qty: Math.min(MAX_QTY, Math.max(1, qty)) }];
}

export function setQty(lines: CartLine[], variantId: string, qty: number): CartLine[] {
  if (qty <= 0) return lines.filter((l) => l.variantId !== variantId);
  return lines.map((l) => (l.variantId === variantId ? { ...l, qty: Math.min(MAX_QTY, qty) } : l));
}

export function removeLine(lines: CartLine[], variantId: string): CartLine[] {
  return lines.filter((l) => l.variantId !== variantId);
}

export function itemCount(lines: CartLine[]): number {
  return lines.reduce((n, l) => n + l.qty, 0);
}

export function subtotal(lines: CartLine[]): Paisa {
  return lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
}

export type Totals = {
  subtotal: Paisa;
  deliveryFee: Paisa;
  vat: Paisa;
  total: Paisa;
  vatIncluded: boolean;
};

/**
 * ASSUMPTION: when prices include VAT the shown subtotal already contains it (vat line = 0 extra);
 * when they exclude VAT, 13% is added on the subtotal. The server's figure is the real one.
 */
export function estimateTotals(
  lines: CartLine[],
  fulfilment: Fulfilment,
  settings: Pick<PublicSettings, "deliveryFee" | "pricesIncludeVat" | "vatPct">,
): Totals {
  const sub = subtotal(lines);
  const deliveryFee = fulfilment === "delivery" ? settings.deliveryFee : 0;
  const vat = settings.pricesIncludeVat ? 0 : Math.round((sub * settings.vatPct) / 100);
  return {
    subtotal: sub,
    deliveryFee,
    vat,
    total: sub + deliveryFee + vat,
    vatIncluded: settings.pricesIncludeVat,
  };
}

export function minimumFor(
  fulfilment: Fulfilment,
  settings: Pick<PublicSettings, "minOrderDelivery" | "minOrderPickup">,
): Paisa {
  return fulfilment === "delivery" ? settings.minOrderDelivery : settings.minOrderPickup;
}

/** Parse stored cart JSON defensively; anything malformed becomes an empty cart. */
export function parseStoredCart(raw: string | null): CartLine[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: CartLine[] = [];
    for (const d of data) {
      if (
        d &&
        typeof d === "object" &&
        typeof (d as CartLine).variantId === "string" &&
        typeof (d as CartLine).productSlug === "string" &&
        typeof (d as CartLine).productName === "string" &&
        typeof (d as CartLine).size === "string" &&
        typeof (d as CartLine).colour === "string" &&
        Number.isInteger((d as CartLine).unitPrice) &&
        Number.isInteger((d as CartLine).qty) &&
        (d as CartLine).qty > 0
      ) {
        const l = d as CartLine;
        out.push({ ...l, qty: Math.min(MAX_QTY, l.qty) });
      }
    }
    return out.slice(0, MAX_LINES);
  } catch {
    return [];
  }
}

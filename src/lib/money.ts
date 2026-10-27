/** Money is integer paisa, NPR only (api-contract.md section 0). 1 NPR = 100 paisa. */
export type Paisa = number;

export function formatNpr(paisa: Paisa): string {
  if (!Number.isInteger(paisa)) throw new Error("Money must be integer paisa");
  const rupees = paisa / 100;
  const whole = paisa % 100 === 0;
  const text = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rupees);
  return `Rs. ${text}`;
}

/** Largest amount the API accepts anywhere (validation `paisa`): Rs. 2,00,00,000. */
export const MAX_PAISA = 2_000_000_000;

/**
 * Strict rupee text -> integer paisa (BUG-006). Accepts "1250", "1,250", "12,500", "1,25,000" (Indian or
 * western thousands grouping), an optional "Rs." prefix and up to 2 decimals ("12.5", "12.50").
 * Rejects ambiguous or malformed text instead of guessing: "12,50" (a decimal comma) is null, NOT Rs. 1,250.
 * Also null: "", "-5", "1e3", "1.234", "1,25,0", over MAX_PAISA.
 */
export function parseRupeesToPaisa(input: string): Paisa | null {
  if (typeof input !== "string") return null;
  const t = input.trim().replace(/^rs\.?\s*/i, "");
  const m = /^(\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const rupees = Number(m[1]!.replace(/,/g, ""));
  const paise = Number((m[2] ?? "").padEnd(2, "0"));
  const total = rupees * 100 + paise;
  if (!Number.isSafeInteger(total) || total > MAX_PAISA) return null;
  return total;
}

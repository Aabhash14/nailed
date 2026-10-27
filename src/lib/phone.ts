/**
 * Nepal mobile normalisation (api-contract.md section 0).
 * Accepts 98XXXXXXXX, 97XXXXXXXX, 977 98XXXXXXXX, +977 98XXXXXXXX, 00977..., with spaces/dashes/brackets.
 * Returns `+97798XXXXXXXX` / `+97797XXXXXXXX`, or null when it is not a Nepal mobile.
 */
export function normalizeNepalPhone(input: string): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/[\s\-().]/g, "");
  if (s.startsWith("00977")) s = `+${s.slice(2)}`;
  if (/^\+?977(97|98)\d{8}$/.test(s)) s = s.replace(/^\+?977/, "");
  else if (s.startsWith("+")) return null;
  return /^(97|98)\d{8}$/.test(s) ? `+977${s}` : null;
}

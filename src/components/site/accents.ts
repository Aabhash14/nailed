/**
 * Devanagari accent words (concept C: "one Devanagari word per view, short and meaningful, never filler").
 * They only repeat the English heading next to them, so the markup hides them from screen readers (aria-hidden).
 * ASSUMPTION: words taken from concept-c-mato-dhaka.html. NOT proofread yet: translator / the owners must check every
 * word before launch. Keep them all in this one file so the proofread is one look.
 * Direction-specific (concept C). Another direction sets a word to "" and its accent disappears everywhere.
 */
export const ACCENT: Record<"menu" | "shop" | "story" | "visit" | "thanks" | "soldOut", string> = {
  menu: "मेनु",
  shop: "पसल",
  story: "हाम्रो कथा",
  visit: "आउनुहोस्",
  thanks: "धन्यवाद",
  soldOut: "सकियो",
};

/** Devanagari digits for decorative numerals (menu categories, story chapters). Index 1..n. */
const DIGITS = ["०", "१", "२", "३", "४", "५", "६", "७", "८", "९"];
export function devanagariNumeral(n: number): string {
  return String(n)
    .split("")
    .map((d) => DIGITS[Number(d)] ?? d)
    .join("");
}

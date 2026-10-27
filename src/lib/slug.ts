/** Lowercase ASCII slug. Falls back to the given word when nothing usable is left (e.g. Devanagari-only names). */
export function slugify(input: string, fallback = "item"): string {
  const s = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || fallback;
}

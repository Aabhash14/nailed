import type {
  MenuCategoryTranslations,
  MenuItemTranslations,
  MenuTranslationLang,
  MenuVariantTranslations,
} from "@/types/db";

/**
 * Multi-language menu (api-contract 1.4.0, data-model decision 19, migration 20261024000001).
 * English stays in the row's own name / description / label. `translations` holds the secondary languages, keyed by
 * language, same shape in the database and in the DTO:
 *   item      { [lang]: { name, description?, pronunciation? (ne only) } }
 *   category  { [lang]: { name } }
 *   variant   { [lang]: { label } }
 * This module holds the shared constants and the READ-side sanitizers (row jsonb -> DTO). The write-side rules
 * (trim, drop blanks, lengths) are the Zod schemas in src/lib/validation/admin.ts, built from the same constants.
 */

/** Allowed secondary languages, in display order. Never "en" (English is the row's own column). */
export const MENU_TRANSLATION_LANGS = ["ne", "zh", "ja", "ko", "pt"] as const satisfies readonly MenuTranslationLang[];

/** Database CHECK limits, in characters (Postgres char_length = Unicode code points). */
export const TRANSLATION_LIMITS = {
  item: { name: 80, description: 240, pronunciation: 80 },
  category: { name: 80 },
  variant: { label: 40 },
} as const;

/** Only this language may carry `pronunciation` (romanised Nepali). */
export const PRONUNCIATION_LANG: MenuTranslationLang = "ne";

/**
 * Length the way Postgres char_length counts it: Unicode code points, not UTF-16 units. "😀" is 1 here and 1 in
 * Postgres but 2 in String.length. Devanagari combining marks count as their own code points in both.
 */
export function charCount(s: string): number {
  return Array.from(s).length;
}

export function isTranslationLang(v: string): v is MenuTranslationLang {
  return (MENU_TRANSLATION_LANGS as readonly string[]).includes(v);
}

type Raw = Record<string, unknown>;

function asObject(v: unknown): Raw | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null;
}

/** A non-empty string within the limit, or undefined. Read side: never throws, just drops what does not fit. */
function text(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && charCount(v) <= max ? v : undefined;
}

/**
 * Read side. The database CHECK already guarantees the shape, so this is defence in depth for the DTO (and for the
 * break-glass snapshot's key allow-list): only allowed languages and keys, string values only, a language without
 * its required name / label is dropped, and a missing / null / malformed column reads as `{}`. Output keys follow
 * MENU_TRANSLATION_LANGS order, so the JSON is stable.
 */
export function itemTranslationsFromRow(raw: unknown): MenuItemTranslations {
  const src = asObject(raw);
  const out: MenuItemTranslations = {};
  if (!src) return out;
  const lim = TRANSLATION_LIMITS.item;
  for (const lang of MENU_TRANSLATION_LANGS) {
    const e = asObject(src[lang]);
    const name = e ? text(e.name, lim.name) : undefined;
    if (!e || !name) continue;
    const description = text(e.description, lim.description);
    const pronunciation = lang === PRONUNCIATION_LANG ? text(e.pronunciation, lim.pronunciation) : undefined;
    const entry: { name: string; description?: string; pronunciation?: string } = { name };
    if (description) entry.description = description;
    if (pronunciation) entry.pronunciation = pronunciation;
    (out as Record<string, unknown>)[lang] = entry;
  }
  return out;
}

export function categoryTranslationsFromRow(raw: unknown): MenuCategoryTranslations {
  const src = asObject(raw);
  const out: MenuCategoryTranslations = {};
  if (!src) return out;
  for (const lang of MENU_TRANSLATION_LANGS) {
    const name = text(asObject(src[lang])?.name, TRANSLATION_LIMITS.category.name);
    if (name) out[lang] = { name };
  }
  return out;
}

export function variantTranslationsFromRow(raw: unknown): MenuVariantTranslations {
  const src = asObject(raw);
  const out: MenuVariantTranslations = {};
  if (!src) return out;
  for (const lang of MENU_TRANSLATION_LANGS) {
    const label = text(asObject(src[lang])?.label, TRANSLATION_LIMITS.variant.label);
    if (label) out[lang] = { label };
  }
  return out;
}

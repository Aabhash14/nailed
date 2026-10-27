// Owner: frontend-engineer. Pure helpers for the admin "Translations" sections (menu items, categories, option labels).
// Rules mirror the DB CHECKs from 20261024000001 (data-model decision 19), so the form catches problems before the
// server does: keys ne | zh | ja | ko | pt only; the name / label is required per language; optional keys are omitted,
// never ""; pronunciation on "ne" only; lengths in characters (Unicode code points, like Postgres char_length).
import {
  MENU_LANGUAGES,
  TRANSLATION_LIMITS,
  type CategoryTranslations,
  type ItemTranslations,
  type MenuLanguage,
  type VariantTranslations,
} from "@/types/contract";

export type TranslationKind = "item" | "category" | "variant";

/** Characters as Postgres counts them (code points), not UTF-16 units. */
export function charCount(s: string): number {
  return [...s].length;
}

const FIELDS: Record<
  TranslationKind,
  readonly ("name" | "description" | "pronunciation" | "label")[]
> = {
  item: ["name", "description", "pronunciation"],
  category: ["name"],
  variant: ["label"],
};
const REQUIRED: Record<TranslationKind, "name" | "label"> = {
  item: "name",
  category: "name",
  variant: "label",
};

/** Null when the value would pass the DB CHECK for that kind; otherwise a short reason for the owner. */
export function translationsProblem(value: unknown, kind: TranslationKind): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Translations must be an object.";
  for (const [lang, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(MENU_LANGUAGES as readonly string[]).includes(lang)) return `Unknown language "${lang}".`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return `Translations for ${lang} must be an object.`;
    const e = entry as Record<string, unknown>;
    if (!(REQUIRED[kind] in e)) return `Add the ${REQUIRED[kind]} for ${lang}.`;
    for (const [key, v] of Object.entries(e)) {
      if (!(FIELDS[kind] as readonly string[]).includes(key))
        return `Unknown field "${key}" for ${lang}.`;
      if (key === "pronunciation" && lang !== "ne") return "Pronunciation is for Nepali only.";
      if (typeof v !== "string") return `The ${key} for ${lang} must be text.`;
      const n = charCount(v);
      const max = TRANSLATION_LIMITS[key as keyof typeof TRANSLATION_LIMITS];
      if (n < 1 || n > max) return `The ${key} for ${lang} must be 1 to ${max} characters.`;
    }
  }
  return null;
}

// ---- Form drafts: one text box per language and field, "" = empty ------------------------------------------------

export type ItemTrDraft = Record<
  MenuLanguage,
  { name: string; description: string; pronunciation: string }
>;
export type NameTrDraft = Record<MenuLanguage, string>;

function each<T>(fn: (l: MenuLanguage) => T): Record<MenuLanguage, T> {
  return Object.fromEntries(MENU_LANGUAGES.map((l) => [l, fn(l)])) as Record<MenuLanguage, T>;
}

export function itemDraft(tr: ItemTranslations | null | undefined): ItemTrDraft {
  return each((l) => ({
    name: tr?.[l]?.name ?? "",
    description: tr?.[l]?.description ?? "",
    pronunciation: l === "ne" ? (tr?.ne?.pronunciation ?? "") : "",
  }));
}
export function categoryDraft(tr: CategoryTranslations | null | undefined): NameTrDraft {
  return each((l) => tr?.[l]?.name ?? "");
}
export function variantDraft(tr: VariantTranslations | null | undefined): NameTrDraft {
  return each((l) => tr?.[l]?.label ?? "");
}

/** Field errors are keyed `<lang>.<field>` (e.g. "ja.name"). */
export type TrErrors = Record<string, string>;

function limit(errors: TrErrors, key: string, text: string, max: number) {
  if (charCount(text) > max) errors[key] = `Up to ${max} characters (now ${charCount(text)})`;
}

/** Draft -> stored shape. Empty languages are left out; a description or pronunciation without a name is an error. */
export function itemFromDraft(d: ItemTrDraft): { value: ItemTranslations; errors: TrErrors } {
  const value: ItemTranslations = {};
  const errors: TrErrors = {};
  for (const l of MENU_LANGUAGES) {
    const name = d[l].name.trim();
    const description = d[l].description.trim();
    const pronunciation = l === "ne" ? d[l].pronunciation.trim() : "";
    limit(errors, `${l}.name`, name, TRANSLATION_LIMITS.name);
    limit(errors, `${l}.description`, description, TRANSLATION_LIMITS.description);
    limit(errors, `${l}.pronunciation`, pronunciation, TRANSLATION_LIMITS.pronunciation);
    if (!name) {
      if (description || pronunciation)
        errors[`${l}.name`] = "Add the name too, or clear this language";
      continue;
    }
    value[l] = {
      name,
      ...(description ? { description } : {}),
      ...(pronunciation ? { pronunciation } : {}),
    };
  }
  return { value, errors };
}

function namesFromDraft(d: NameTrDraft, max: number, key: "name" | "label") {
  const value: Partial<Record<MenuLanguage, Record<string, string>>> = {};
  const errors: TrErrors = {};
  for (const l of MENU_LANGUAGES) {
    const t = d[l].trim();
    limit(errors, `${l}.${key}`, t, max);
    if (t) value[l] = { [key]: t };
  }
  return { value, errors };
}
export function categoryFromDraft(d: NameTrDraft): {
  value: CategoryTranslations;
  errors: TrErrors;
} {
  const r = namesFromDraft(d, TRANSLATION_LIMITS.name, "name");
  return { value: r.value as CategoryTranslations, errors: r.errors };
}
export function variantFromDraft(d: NameTrDraft): { value: VariantTranslations; errors: TrErrors } {
  const r = namesFromDraft(d, TRANSLATION_LIMITS.label, "label");
  return { value: r.value as VariantTranslations, errors: r.errors };
}

/** Order-independent JSON, so {} / undefined / null and key order do not count as a change. */
function canonical(v: unknown): string {
  if (v === null || v === undefined) return "{}";
  if (typeof v !== "object") return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export function sameTranslations(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Contract rule "omitted = unchanged": the value to send, or undefined when nothing changed (so the caller leaves the
 * `translations` key out of the request entirely).
 */
export function translationsPatch<T>(stored: T | null | undefined, next: T): T | undefined {
  return sameTranslations(stored, next) ? undefined : next;
}

/** How many languages have a name / label, for the collapsed summary ("2 of 5 languages"). */
export function filledCount(tr: Partial<Record<MenuLanguage, unknown>> | null | undefined): number {
  return MENU_LANGUAGES.filter((l) => !!tr?.[l]).length;
}

/**
 * Server VALIDATION fieldErrors (contract 1.4.0) -> form errors. Keys: "translations", "translations.<lang>",
 * "translations.<lang>.<field>", "variants.N.translations", "variants.N.translations.<lang>[.label]". Field-level ones
 * land on their input (`<lang>.<field>`); the rest become general messages shown at the top of the section.
 */
export function mapServerTranslationErrors(fieldErrors: Record<string, string[]> | undefined): {
  item: TrErrors;
  variants: Record<number, TrErrors>;
  general: string[];
} {
  const out = {
    item: {} as TrErrors,
    variants: {} as Record<number, TrErrors>,
    general: [] as string[],
  };
  for (const [key, msgs] of Object.entries(fieldErrors ?? {})) {
    const msg = msgs.join(", ");
    const item =
      /^translations(?:\.(ne|zh|ja|ko|pt)(?:\.(name|description|pronunciation))?)?$/.exec(key);
    if (item) {
      if (item[1] && item[2]) out.item[`${item[1]}.${item[2]}`] = msg;
      else out.general.push(item[1] ? `${item[1]}: ${msg}` : msg);
      continue;
    }
    const v = /^variants\.(\d+)\.translations(?:\.(ne|zh|ja|ko|pt)(?:\.label)?)?$/.exec(key);
    if (v) {
      const n = Number(v[1]);
      if (v[2]) out.variants[n] = { ...out.variants[n], [`${v[2]}.label`]: msg };
      else out.general.push(`Option ${n + 1}: ${msg}`);
    }
  }
  return out;
}

// Owner: frontend-engineer. Secondary menu language helper (same idea as projects/aduwa src/lib/menu-i18n).
//
// English is always the primary language on /menu. A mode adds ONE secondary language next to it. Components only ask
// "what is the secondary text for this string / item / category / option in this mode?" and get null when there is
// nothing to show: mode "none", a missing or empty translation, a non-string value, or a "translation" identical to the
// English (so a stub never doubles the English).
//
// Two sources:
//   - Menu CONTENT (item / category / variant names, descriptions, Nepali pronunciation) comes from the menu DTO's
//     optional `translations` field (DB decision 19).
//   - Menu UI strings come from the per-language packs next to this file, GENERATED from the translator's
//     design/copy/menu-translations-2026-10-24.json by scripts/gen-menu-i18n.mjs. English (./en) is static; the five
//     secondary packs are loaded on demand with import(), so the menu only downloads the pack a guest picks.
//
// Translator rules kept here: no space between sentences for zh/ja; each language's relative-time ("ago.*") strings are
// only ever placed inside that same language's status.live template, never mixed with the English agoLabel output.
import {
  MENU_LANGUAGES,
  type CategoryTranslations,
  type ItemTranslations,
  type MenuLanguage,
  type VariantTranslations,
} from "@/types/contract";
import { EN } from "./en";
import type { MenuLang, MenuUiKey, MenuUiPack } from "./types";

export type { MenuLang, MenuUiKey, MenuUiPack } from "./types";
export { EN } from "./en";

/** localStorage key. Strict values only (see parseMenuLang); never a cookie, never sent to the server. */
export const MENU_LANG_STORAGE_KEY = "nailed.menuLang";
/** First visit and the server render: English only. */
export const DEFAULT_MENU_LANG: MenuLang = "none";

/** BCP 47 tag for every lang="" attribute, so the browser picks the right glyphs (Han forms differ zh vs ja). */
export const BCP47: Record<MenuLanguage, string> = {
  ne: "ne",
  zh: "zh-Hans",
  ja: "ja",
  ko: "ko",
  pt: "pt-BR",
};

/** Language names in their own script (translator file "language.self_name"). */
export const SELF_NAME: Record<MenuLanguage, string> = {
  ne: "नेपाली",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
  pt: "Português",
};

/** Picker options, in the brief's order. `lang` is set on each <option> so its own-script name renders correctly. */
export const MENU_LANG_OPTIONS: readonly { value: MenuLang; label: string; lang: string }[] = [
  { value: "none", label: "English only", lang: "en" },
  ...MENU_LANGUAGES.map((l) => ({ value: l, label: `English + ${SELF_NAME[l]}`, lang: BCP47[l] })),
];

const MODES = new Set<string>(MENU_LANG_OPTIONS.map((o) => o.value));

/** Strict parse of a stored or selected value: anything that is not exactly a known mode means the default. */
export function parseMenuLang(raw: unknown): MenuLang {
  return typeof raw === "string" && MODES.has(raw) ? (raw as MenuLang) : DEFAULT_MENU_LANG;
}

/** Trimmed text, or null when it is not a string, is empty, or is the same as the English (case-insensitive). */
export function secondaryOnly(text: unknown, english?: string | null): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  if (english && t.toLocaleLowerCase() === english.trim().toLocaleLowerCase()) return null;
  return t;
}

/** Fills {token} placeholders. Unknown tokens are left as written so a copy mistake is visible, not silent. */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Chinese and Japanese put no space between sentences (translator note); every other language uses one space. */
export function joinSentences(lang: MenuLang | "en", parts: readonly string[]): string {
  return parts.join(lang === "zh" || lang === "ja" ? "" : " ");
}

/** Which "ago.*" string and value fit a number of minutes. Same thresholds as agoLabel() in components/format.ts. */
export function agoKey(minutes: number): { key: MenuUiKey; vars: Record<string, number> } {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return { key: "ago.just_now", vars: {} };
  if (m < 60) return { key: "ago.minutes", vars: { m } };
  const h = Math.floor(m / 60);
  if (h < 24) return { key: "ago.hours", vars: { h } };
  return { key: "ago.days", vars: { d: Math.floor(h / 24) } };
}

/** English UI string with its tokens filled (the primary text, always shown). */
export function en(key: MenuUiKey, vars?: Record<string, string | number>): string {
  return fill(EN[key], vars);
}

/** "Prices include 13% VAT." plus the service-charge sentence when there is one, for any pack. */
export function footerText(
  pack: MenuUiPack,
  lang: MenuLang | "en",
  s: { pricesIncludeVat: boolean; vatPct: number; serviceChargePct: number },
): string {
  const parts = [
    fill(pack[s.pricesIncludeVat ? "footer.vat_included" : "footer.vat_excluded"], {
      vat: s.vatPct,
    }),
  ];
  if (s.serviceChargePct > 0)
    parts.push(fill(pack["footer.service_charge"], { pct: s.serviceChargePct }));
  return joinSentences(lang, parts);
}

type CategoryLike = { name: string; translations?: CategoryTranslations | null };
type ItemLike = {
  name: string;
  description: string | null;
  translations?: ItemTranslations | null;
};
type VariantLike = { label: string; translations?: VariantTranslations | null };

/** What the menu needs from the active secondary language. Every getter returns null when there is nothing to show. */
export interface MenuSecondary {
  lang: MenuLanguage;
  /** BCP 47 tag for the lang="" attribute on every secondary run. */
  bcp47: string;
  /** A UI string with tokens filled; null when it would only repeat the English. */
  t(key: MenuUiKey, vars?: Record<string, string | number>): string | null;
  categoryName(c: CategoryLike): string | null;
  itemName(i: ItemLike): string | null;
  itemDescription(i: ItemLike): string | null;
  /** Romanised Nepali for the "Say it" aid: Nepali mode only, and only when the Nepali name itself is shown. */
  pronunciation(i: ItemLike): string | null;
  variantLabel(v: VariantLike): string | null;
  /** "Live. Updated <ago>." built entirely in this language (its own ago.* inside its own status.live). */
  liveStatus(minutesAgo: number): string | null;
  footer(s: { pricesIncludeVat: boolean; vatPct: number; serviceChargePct: number }): string | null;
}

function entry<T>(
  map: Partial<Record<MenuLanguage, T>> | null | undefined,
  lang: MenuLanguage,
): T | undefined {
  if (!map || typeof map !== "object") return undefined;
  const e = (map as Record<string, unknown>)[lang];
  return e && typeof e === "object" ? (e as T) : undefined;
}

export function buildSecondary(lang: MenuLanguage, pack: MenuUiPack): MenuSecondary {
  const itemName = (i: ItemLike) => secondaryOnly(entry(i.translations, lang)?.name, i.name);
  return {
    lang,
    bcp47: BCP47[lang],
    t: (key, vars) => secondaryOnly(fill(pack[key] ?? "", vars), fill(EN[key], vars)),
    categoryName: (c) => secondaryOnly(entry(c.translations, lang)?.name, c.name),
    itemName,
    itemDescription: (i) => secondaryOnly(entry(i.translations, lang)?.description, i.description),
    pronunciation: (i) =>
      lang === "ne" && itemName(i)
        ? secondaryOnly(entry(i.translations, "ne")?.pronunciation, i.name)
        : null,
    variantLabel: (v) => secondaryOnly(entry(v.translations, lang)?.label, v.label),
    liveStatus: (minutes) => {
      const { key, vars } = agoKey(minutes);
      return secondaryOnly(
        fill(pack["status.live"], { ago: fill(pack[key], vars) }),
        fill(EN["status.live"], { ago: fill(EN[key], vars) }),
      );
    },
    footer: (s) => secondaryOnly(footerText(pack, lang, s), footerText(EN, "en", s)),
  };
}

const LOADERS: Record<MenuLanguage, () => Promise<MenuUiPack>> = {
  ne: () => import("./ne").then((m) => m.NE),
  zh: () => import("./zh").then((m) => m.ZH),
  ja: () => import("./ja").then((m) => m.JA),
  ko: () => import("./ko").then((m) => m.KO),
  pt: () => import("./pt").then((m) => m.PT),
};
const loaded = new Map<MenuLanguage, MenuSecondary>();
const loading = new Map<MenuLanguage, Promise<MenuSecondary>>();

/**
 * The secondary language for a mode: null for "none", undefined while its pack is not loaded yet (call
 * loadMenuSecondary, then read again). Results are stable objects, safe to compare by identity.
 */
export function getMenuSecondary(mode: MenuLang): MenuSecondary | null | undefined {
  if (mode === "none") return null;
  return loaded.get(mode);
}

/** Loads (once) the pack for a language. A failed load (offline) is not cached, so the next call retries. */
export function loadMenuSecondary(lang: MenuLanguage): Promise<MenuSecondary> {
  const hit = loaded.get(lang);
  if (hit) return Promise.resolve(hit);
  let p = loading.get(lang);
  if (!p) {
    p = LOADERS[lang]()
      .then((pack) => {
        const sec = buildSecondary(lang, pack);
        loaded.set(lang, sec);
        return sec;
      })
      .finally(() => loading.delete(lang));
    loading.set(lang, p);
  }
  return p;
}

"use client";
// Owner: frontend-engineer. Table-ordering UI strings: English always, plus the guest's ONE secondary menu language,
// with the same rules as the menu (components/menu/i18n): a missing key, an empty string or a "translation" equal to
// the English shows English only. Secondary packs load on demand, inside the already lazy table chunk.
import { useEffect, useReducer } from "react";
import { BCP47, fill, secondaryOnly, type MenuLang } from "../../i18n";
import type { MenuLanguage } from "@/types/contract";
import { TABLE_EN, type TableUiKey, type TableUiPack } from "./en";

export { TABLE_EN, type TableUiKey, type TableUiPack };

type Vars = Record<string, string | number>;

export type TableText = {
  /** English (primary), tokens filled. */
  en(key: TableUiKey, vars?: Vars): string;
  /** Secondary-language text, or null (English only). */
  sec(key: TableUiKey, vars?: Vars): string | null;
  /** lang="" for secondary runs; undefined in English-only mode. */
  lang: string | undefined;
};

const en = (key: TableUiKey, vars?: Vars) => fill(TABLE_EN[key], vars);

export function buildTableText(lang: MenuLanguage | null, pack: TableUiPack | null): TableText {
  return {
    en,
    sec: (key, vars) => {
      if (!lang || !pack) return null;
      const raw = pack[key];
      return raw ? secondaryOnly(fill(raw, vars), en(key, vars)) : null;
    },
    lang: lang && pack ? BCP47[lang] : undefined,
  };
}

const LOADERS: Record<MenuLanguage, () => Promise<TableUiPack>> = {
  ne: () => import("./ne").then((m) => m.TABLE_NE),
  zh: () => import("./zh").then((m) => m.TABLE_ZH),
  ja: () => import("./ja").then((m) => m.TABLE_JA),
  ko: () => import("./ko").then((m) => m.TABLE_KO),
  pt: () => import("./pt").then((m) => m.TABLE_PT),
};
const packs = new Map<MenuLanguage, TableUiPack>();
const ENGLISH_ONLY = buildTableText(null, null);
const built = new Map<MenuLanguage, TableText>();

/** The table strings for the menu's language mode. English only until the pack arrives (or if it fails offline). */
export function useTableText(mode: MenuLang): TableText {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const lang = mode === "none" ? null : mode;
  useEffect(() => {
    if (!lang || packs.has(lang)) return;
    let live = true;
    LOADERS[lang]().then(
      (p) => {
        packs.set(lang, p);
        if (live) rerender();
      },
      () => {
        /* offline: stay English only; the next mode change retries */
      },
    );
    return () => {
      live = false;
    };
  }, [lang]);
  if (!lang) return ENGLISH_ONLY;
  const pack = packs.get(lang);
  if (!pack) return ENGLISH_ONLY;
  let t = built.get(lang);
  if (!t) {
    t = buildTableText(lang, pack);
    built.set(lang, t);
  }
  return t;
}

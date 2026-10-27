// Owner: frontend-engineer. Regenerates src/components/menu/i18n/{keys,en,ne,zh,ja,ko,pt}.ts from the translator file
// design/copy/menu-translations-2026-10-24.json ("ui" block). Run from the app folder:
//   node scripts/gen-menu-i18n.mjs ../../design/copy/menu-translations-2026-10-24.json src/components/menu/i18n
// then `pnpm exec prettier --write src/components/menu/i18n`.
import { readFileSync, writeFileSync } from "node:fs";
const [, , jsonPath, outDir] = process.argv;
const j = JSON.parse(readFileSync(jsonPath, "utf8"));
const keys = Object.keys(j.ui).filter((k) => k !== "language.self_name");
const NAMES = {
  en: "English",
  ne: "Nepali",
  zh: "Simplified Chinese",
  ja: "Japanese",
  ko: "Korean",
  pt: "Brazilian Portuguese",
};
const q = (s) => JSON.stringify(s);
// types.ts key union
let keyUnion = keys.map((k) => `  | ${q(k)}`).join("\n");
writeFileSync(
  `${outDir}/keys.ts`,
  `// GENERATED from design/copy/menu-translations-2026-10-24.json "ui" (translator). Do not edit by hand: re-run the
// generator (see ./index.ts header) when the copy file changes. language.self_name lives in MENU_LANG_OPTIONS instead.
/** Every UI string on /menu that has a secondary-language version (${keys.length} keys + language.self_name = ${keys.length + 1}). */
export type MenuUiKey =
${keyUnion};

export const MENU_UI_KEYS: readonly MenuUiKey[] = [
${keys.map((k) => `  ${q(k)},`).join("\n")}
];
`,
);
for (const lang of ["en", "ne", "zh", "ja", "ko", "pt"]) {
  const constName = lang.toUpperCase();
  const reviewed =
    lang === "en"
      ? "English source (primary)."
      : lang === "ne"
        ? "Translator: high confidence; owners confirmed मम and लेमन टी (2026-10-24)."
        : "Concept translation, NOT yet checked by a native speaker (needs review before launch).";
  const lines = keys.map((k) => {
    const v = j.ui[k][lang];
    if (typeof v !== "string") throw new Error(`missing ${lang} ${k}`);
    return `  ${q(k)}: ${q(v)},`;
  });
  writeFileSync(
    `${outDir}/${lang}.ts`,
    `// GENERATED from design/copy/menu-translations-2026-10-24.json "ui".${lang} (owner: translator). ${NAMES[lang]}.
// ${reviewed}
// Placeholder tokens ({n}, {ago}, {vat}, {pct}, {name}, {m}, {h}, {d}) are filled by code; keep them exactly.
import type { MenuUiPack } from "./types";

export const ${constName}: MenuUiPack = {
${lines.join("\n")}
};
`,
  );
}
console.log(keys.length, "keys");

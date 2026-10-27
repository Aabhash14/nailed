import { describe, expect, it } from "vitest";
import {
  BCP47,
  EN,
  MENU_LANG_OPTIONS,
  agoKey,
  buildSecondary,
  fill,
  footerText,
  getMenuSecondary,
  joinSentences,
  loadMenuSecondary,
  parseMenuLang,
  secondaryOnly,
} from "@/components/menu/i18n";
import { MENU_UI_KEYS } from "@/components/menu/i18n/keys";
import { JA } from "@/components/menu/i18n/ja";
import { KO } from "@/components/menu/i18n/ko";
import { NE } from "@/components/menu/i18n/ne";
import { PT } from "@/components/menu/i18n/pt";
import { ZH } from "@/components/menu/i18n/zh";
import {
  charCount,
  itemDraft,
  itemFromDraft,
  mapServerTranslationErrors,
  sameTranslations,
  translationsPatch,
  translationsProblem,
  variantDraft,
  variantFromDraft,
} from "@/components/admin/translations-logic";

describe("menu language: parse of the stored value (localStorage 'nailed.menuLang')", () => {
  it("accepts exactly the six modes", () => {
    for (const m of ["none", "ne", "zh", "ja", "ko", "pt"]) expect(parseMenuLang(m)).toBe(m);
  });
  it("anything else is English only", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "en",
      "NE",
      "zh-Hans",
      " ne",
      "ne ",
      "fr",
      '"ne"',
      "pt-BR",
      1,
      {},
      ["ne"],
    ]) {
      expect(parseMenuLang(bad)).toBe("none");
    }
  });
  it("picker options: English only first, then each language in its own script with its lang tag", () => {
    expect(MENU_LANG_OPTIONS.map((o) => o.label)).toEqual([
      "English only",
      "English + नेपाली",
      "English + 中文",
      "English + 日本語",
      "English + 한국어",
      "English + Português",
    ]);
    expect(MENU_LANG_OPTIONS.map((o) => o.lang)).toEqual([
      "en",
      "ne",
      "zh-Hans",
      "ja",
      "ko",
      "pt-BR",
    ]);
    expect(BCP47).toEqual({ ne: "ne", zh: "zh-Hans", ja: "ja", ko: "ko", pt: "pt-BR" });
  });
});

describe("menu language: the null rules (secondary text is hidden when there is nothing worth showing)", () => {
  it("missing, non-string or empty -> null", () => {
    expect(secondaryOnly(undefined, "Tea")).toBeNull();
    expect(secondaryOnly(null, "Tea")).toBeNull();
    expect(secondaryOnly(42, "Tea")).toBeNull();
    expect(secondaryOnly("", "Tea")).toBeNull();
    expect(secondaryOnly("   ", "Tea")).toBeNull();
  });
  it("identical to the English (case and outer spaces ignored) -> null", () => {
    expect(secondaryOnly("Espresso", "Espresso")).toBeNull();
    expect(secondaryOnly(" espresso ", "Espresso")).toBeNull();
    expect(secondaryOnly("Masala Chai", "masala chai")).toBeNull();
  });
  it("a real translation is trimmed and kept", () => {
    expect(secondaryOnly("  चिया ", "Tea")).toBe("चिया");
    expect(secondaryOnly("Chás", null)).toBe("Chás");
  });

  const ne = buildSecondary("ne", NE);
  const ja = buildSecondary("ja", JA);
  const pt = buildSecondary("pt", PT);
  const item = {
    name: "Espresso",
    description: "Short, strong, single shot.",
    translations: {
      ne: { name: "एस्प्रेसो", description: "सानो र कडा, एउटा सट।", pronunciation: "espresso" },
      ja: { name: "エスプレッソ", description: "" },
      pt: { name: "Espresso", description: "Curto, forte, dose única." },
    },
  };

  it("item name / description per language, null when missing or same as English", () => {
    expect(ne.itemName(item)).toBe("एस्प्रेसो");
    expect(ja.itemName(item)).toBe("エスプレッソ");
    expect(ja.itemDescription(item)).toBeNull(); // empty
    expect(pt.itemName(item)).toBeNull(); // identical to the English
    expect(pt.itemDescription(item)).toBe("Curto, forte, dose única.");
    expect(buildSecondary("zh", ZH).itemName(item)).toBeNull(); // language missing
    expect(ne.itemName({ name: "X", description: null })).toBeNull(); // no translations at all
    expect(
      ne.itemName({ name: "X", description: null, translations: { ne: "oops" } as never }),
    ).toBeNull(); // bad shape
  });

  it("pronunciation: Nepali only, only with the Nepali name, hidden when it just repeats the English", () => {
    expect(ne.pronunciation(item)).toBeNull(); // "espresso" = English "Espresso"
    const chai = {
      name: "Masala Chai",
      description: null,
      translations: { ne: { name: "मसला चिया", pronunciation: "masala chiya" } },
    };
    expect(ne.pronunciation(chai)).toBe("masala chiya");
    expect(ja.pronunciation(chai)).toBeNull();
    const noName = {
      name: "Masala Chai",
      description: null,
      translations: { ne: { name: "", pronunciation: "masala chiya" } },
    };
    expect(ne.pronunciation(noName)).toBeNull();
  });

  it("category and option labels", () => {
    expect(ja.categoryName({ name: "Coffee", translations: { ja: { name: "コーヒー" } } })).toBe(
      "コーヒー",
    );
    expect(ja.categoryName({ name: "Coffee", translations: {} })).toBeNull();
    expect(ne.variantLabel({ label: "Large", translations: { ne: { label: "ठूलो" } } })).toBe(
      "ठूलो",
    );
    expect(
      pt.variantLabel({ label: "Large", translations: { pt: { label: " large " } } }),
    ).toBeNull();
  });

  it("UI strings fill their tokens and hide when the language says the same as English", () => {
    expect(ja.t("table.badge", { n: 7 })).toBe("7番テーブル");
    expect(pt.t("count.item", { n: 1 })).toBeNull(); // pt "{n} item" = en "{n} item"
    expect(pt.t("count.items", { n: 3 })).toBe("3 itens");
    expect(ne.t("item.sold_out")).toBe("सकियो");
    expect(ne.t("variant.options_label", { name: "Tea" })).toBe("Tea का विकल्पहरू");
  });
});

describe("menu language: packs, tokens, sentences and relative time", () => {
  const packs = { EN, NE, ZH, JA, KO, PT };
  it("every pack has all 42 keys (+ language.self_name in the picker = 43) and keeps each English token", () => {
    expect(MENU_UI_KEYS).toHaveLength(42);
    for (const [name, pack] of Object.entries(packs)) {
      expect(Object.keys(pack).sort(), name).toEqual([...MENU_UI_KEYS].sort());
      for (const k of MENU_UI_KEYS) {
        const tokens = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
        expect(tokens(pack[k]), `${name} ${k}`).toEqual(tokens(EN[k]));
        expect(pack[k], `${name} ${k}`).toBe(pack[k].trim());
      }
    }
  });
  it("fill leaves unknown tokens visible", () => {
    expect(fill("Table {n} {x}", { n: 3 })).toBe("Table 3 {x}");
  });
  it("no space between sentences for zh / ja", () => {
    expect(joinSentences("zh", ["a。", "b。"])).toBe("a。b。");
    expect(joinSentences("ja", ["a。", "b。"])).toBe("a。b。");
    expect(joinSentences("ne", ["a।", "b।"])).toBe("a। b।");
    expect(joinSentences("en", ["A.", "B."])).toBe("A. B.");
  });
  it("footer: VAT + service charge in each language", () => {
    const s = { pricesIncludeVat: true, vatPct: 13, serviceChargePct: 10 };
    expect(footerText(EN, "en", s)).toBe("Prices include 13% VAT. A 10% service charge is added.");
    expect(buildSecondary("ja", JA).footer(s)).toBe(
      "価格は13%のVAT（付加価値税）込みです。10%のサービス料が加算されます。",
    );
    expect(buildSecondary("ko", KO).footer({ ...s, serviceChargePct: 0 })).toBe(
      "가격에 부가세 13%가 포함되어 있어요.",
    );
    expect(buildSecondary("zh", ZH).footer({ ...s, pricesIncludeVat: false })).toBe(
      "价格不含13%增值税，将在账单中加收。另收10%服务费。",
    );
  });
  it("agoKey uses the same thresholds as the English agoLabel", () => {
    expect(agoKey(0)).toEqual({ key: "ago.just_now", vars: {} });
    expect(agoKey(59)).toEqual({ key: "ago.minutes", vars: { m: 59 } });
    expect(agoKey(60)).toEqual({ key: "ago.hours", vars: { h: 1 } });
    expect(agoKey(60 * 24)).toEqual({ key: "ago.days", vars: { d: 1 } });
  });
  it("the live status line is built entirely in its own language (never the English ago inside)", () => {
    expect(buildSecondary("ja", JA).liveStatus(0)).toBe("ライブ表示中。更新：たった今");
    expect(buildSecondary("zh", ZH).liveStatus(5)).toBe("实时 · 5分钟前更新");
    expect(buildSecondary("ne", NE).liveStatus(120)).toBe("लाइभ। 2 घण्टा अगाडि अपडेट भयो।");
    expect(buildSecondary("pt", PT).liveStatus(3)).toBe("Ao vivo. Atualizado há 3 min.");
    for (const l of ["zh", "ja", "ko"] as const) {
      expect(buildSecondary(l, { zh: ZH, ja: JA, ko: KO }[l]).liveStatus(3)).not.toMatch(
        /ago|min|just now/,
      );
    }
  });
  it("packs load on demand, once, and are stable objects", async () => {
    expect(getMenuSecondary("none")).toBeNull();
    expect(getMenuSecondary("ko")).toBeUndefined();
    const a = await loadMenuSecondary("ko");
    expect(getMenuSecondary("ko")).toBe(a);
    expect(await loadMenuSecondary("ko")).toBe(a);
    expect(a.bcp47).toBe("ko");
  });
});

describe("admin translations: drafts, DB rules, 'omitted = unchanged'", () => {
  it("counts characters as code points, like Postgres char_length", () => {
    expect(charCount("मसला")).toBe(4);
    expect(charCount("😀")).toBe(1);
    expect(charCount("커피")).toBe(2);
  });
  it('draft round-trip drops empty languages and optional keys (never sends "")', () => {
    const d = itemDraft({
      ne: { name: "चिया", pronunciation: "chiya" },
      ja: { name: "ティー", description: "紅茶" },
    });
    d.zh.name = "  ";
    const r = itemFromDraft(d);
    expect(r.errors).toEqual({});
    expect(r.value).toEqual({
      ne: { name: "चिया", pronunciation: "chiya" },
      ja: { name: "ティー", description: "紅茶" },
    });
  });
  it("a description or pronunciation without a name is an error, not a silent drop", () => {
    const d = itemDraft({});
    d.ko.description = "설명";
    d.ne.pronunciation = "chiya";
    const r = itemFromDraft(d);
    expect(Object.keys(r.errors).sort()).toEqual(["ko.name", "ne.name"]);
  });
  it("length limits 80 / 240 / 80 / 40 in code points", () => {
    const d = itemDraft({});
    d.ne.name = "क".repeat(80);
    d.ne.description = "क".repeat(241);
    expect(Object.keys(itemFromDraft(d).errors)).toEqual(["ne.description"]);
    const v = variantDraft({});
    v.ja = "ア".repeat(41);
    expect(Object.keys(variantFromDraft(v).errors)).toEqual(["ja.label"]);
  });
  it("mirrors the DB CHECK", () => {
    expect(translationsProblem({}, "item")).toBeNull();
    expect(
      translationsProblem({ ne: { name: "चिया", pronunciation: "chiya" } }, "item"),
    ).toBeNull();
    expect(translationsProblem({ ja: { name: "x", pronunciation: "y" } }, "item")).toMatch(
      /Nepali only/,
    );
    expect(translationsProblem({ en: { name: "x" } }, "item")).toMatch(/Unknown language/);
    expect(translationsProblem({ ne: { description: "x" } }, "item")).toMatch(/name/);
    expect(translationsProblem({ ne: { name: "" } }, "category")).toMatch(/1 to 80/);
    expect(translationsProblem({ ne: { label: "x", extra: "y" } }, "variant")).toMatch(
      /Unknown field/,
    );
    expect(translationsProblem([], "variant")).not.toBeNull();
  });
  it("sends translations only when they changed", () => {
    expect(translationsPatch(undefined, {})).toBeUndefined();
    expect(translationsPatch({}, {})).toBeUndefined();
    expect(
      translationsPatch(
        { ne: { name: "a" }, ja: { name: "b" } },
        { ja: { name: "b" }, ne: { name: "a" } },
      ),
    ).toBeUndefined();
    expect(translationsPatch({ ne: { name: "a" } }, {})).toEqual({}); // clearing sends {} (never null)
    expect(translationsPatch(undefined, { ko: { label: "라지" } })).toEqual({
      ko: { label: "라지" },
    });
    expect(
      sameTranslations({ ne: { name: "a", description: undefined } }, { ne: { name: "a" } }),
    ).toBe(true);
  });
  it("maps the server's nested field errors onto the right inputs", () => {
    const r = mapServerTranslationErrors({
      "translations.ja.name": ["Too long"],
      "translations.zh": ["Unknown field"],
      "variants.1.translations.ko.label": ["Too long"],
      "variants.0.translations": ["Invalid"],
      name: ["Required"],
    });
    expect(r.item).toEqual({ "ja.name": "Too long" });
    expect(r.variants).toEqual({ 1: { "ko.label": "Too long" } });
    expect(r.general).toEqual(["zh: Unknown field", "Option 1: Invalid"]);
  });
});

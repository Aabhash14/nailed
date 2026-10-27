// GENERATED from design/copy/menu-translations-2026-10-24.json (translator; DRAFT, zh/ja/ko/pt need native review).
// Mock-mode sample translations only. The mock menu's English names are made-up samples ("Sample black coffee"), so
// each entry borrows the CLOSEST real seed item's translations (ASSUMPTION, mock only):
//   Sample black coffee <- "Americano", Sample masala chai <- "Masala Chai", Sample iced coffee <- "Iced Coffee",
//   Sample chicken momo <- "Steam Chicken Momo", category cold-drinks <- "cold-drinks", options Oat milk / Large.
// "Hot drinks", "Food" and the other items deliberately have NO translations, so mock mode also shows the
// "missing translation = English only" rule. Regenerate: see scripts/gen-menu-i18n.mjs (same source file).
import type { CategoryTranslations, ItemTranslations, VariantTranslations } from "@/types/contract";

export const MOCK_ITEM_TR: Record<
  "americano" | "masalaChai" | "icedCoffee" | "chickenMomo",
  ItemTranslations
> = {
  americano: {
    ne: {
      name: "अमेरिकानो",
      description: "एस्प्रेसोमा तातो पानी थपेको।",
      pronunciation: "amerikano",
    },
    zh: {
      name: "美式咖啡",
      description: "浓缩咖啡加热水。",
    },
    ja: {
      name: "アメリカーノ",
      description: "エスプレッソをお湯で割りました。",
    },
    ko: {
      name: "아메리카노",
      description: "에스프레소에 뜨거운 물을 더했어요.",
    },
    pt: {
      name: "Americano",
      description: "Espresso completado com água quente.",
    },
  },
  masalaChai: {
    ne: {
      name: "मसला चिया",
      description: "अदुवा, सुकमेल र मसला हालेको दूध चिया।",
      pronunciation: "masala chiya",
    },
    zh: {
      name: "马萨拉香料奶茶",
      description: "加了姜、小豆蔻和香料的奶茶。",
    },
    ja: {
      name: "マサラチャイ",
      description: "生姜、カルダモン、スパイス入りのミルクティー。",
    },
    ko: {
      name: "마살라 차이",
      description: "생강, 카다멈, 향신료를 넣은 밀크티.",
    },
    pt: {
      name: "Masala Chai",
      description: "Chá com leite, gengibre, cardamomo e especiarias.",
    },
  },
  icedCoffee: {
    ne: {
      name: "आइस्ड कफी",
      description: "कोल्ड ब्रु शैलीको कफी, बरफमाथि थोरै दूध हालेर।",
      pronunciation: "aaisd kafi",
    },
    zh: {
      name: "冰咖啡",
      description: "冷萃风格，倒在冰上，再加少许牛奶。",
    },
    ja: {
      name: "アイスコーヒー",
      description: "コールドブリュー風を氷に注ぎ、ミルクを少し。",
    },
    ko: {
      name: "아이스 커피",
      description: "콜드브루 스타일로 얼음 위에, 우유를 살짝.",
    },
    pt: {
      name: "Café Gelado",
      description: "Estilo cold brew, servido com gelo e um pouco de leite.",
    },
  },
  chickenMomo: {
    ne: {
      name: "स्टिम चिकेन मम",
      description: "१० वटा, गोलभेडाको अचारसँग।",
      pronunciation: "stim chikan momo",
    },
    zh: {
      name: "蒸鸡肉馍馍",
      description: "10个，配番茄阿查酱。",
    },
    ja: {
      name: "スチーム・チキンモモ",
      description: "10個。トマトのアチャール添え。",
    },
    ko: {
      name: "치킨 찐 모모",
      description: "10개, 토마토 아차르와 함께.",
    },
    pt: {
      name: "Momo de Frango no Vapor",
      description: "10 unidades, com achar de tomate.",
    },
  },
};

export const MOCK_CATEGORY_TR: Record<"coldDrinks", CategoryTranslations> = {
  coldDrinks: {
    ne: {
      name: "चिसो पेय",
    },
    zh: {
      name: "冷饮",
    },
    ja: {
      name: "コールドドリンク",
    },
    ko: {
      name: "차가운 음료",
    },
    pt: {
      name: "Bebidas geladas",
    },
  },
};

export const MOCK_VARIANT_TR: Record<"oatMilk" | "large", VariantTranslations> = {
  oatMilk: {
    ne: {
      label: "ओट मिल्क",
    },
    zh: {
      label: "燕麦奶",
    },
    ja: {
      label: "オーツミルク",
    },
    ko: {
      label: "오트밀크",
    },
    pt: {
      label: "Leite de aveia",
    },
  },
  large: {
    ne: {
      label: "ठूलो",
    },
    zh: {
      label: "大杯",
    },
    ja: {
      label: "ラージ",
    },
    ko: {
      label: "라지",
    },
    pt: {
      label: "Grande",
    },
  },
};

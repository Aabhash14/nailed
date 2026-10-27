import type {
  AdminMenuCategory,
  AdminMenuItem,
  AdminProduct,
  AdminProductImage,
  AdminProductVariant,
  AdminSettings,
  BlockedContact,
  AdminOrderRow,
  MenuSpecial,
  StaffMember,
  StockState,
} from "@/types/contract";
import { MOCK_CATEGORY_TR, MOCK_ITEM_TR, MOCK_VARIANT_TR } from "./translations";
import type { MockTablesState } from "./tables";
import { seedTables } from "./tables-seed";

/**
 * Typed MOCK data that matches api-contract.md v1.3.0 exactly, so pages run with no database.
 * EVERYTHING here is a made-up sample for development. None of it is a fact about Nailed Cafe & Lodge:
 * not the items, prices, hours, phone numbers or products. The pages show a "sample data" banner while mocks are active.
 * Only the cafe name and the address line are real (brief.md, confirmed by Aabhash 2026-10-19).
 */

export type MockOrder = AdminOrderRow & {
  token: string;
  lines: { variantId: string; name: string; qty: number; unitPrice: number }[];
};

export type MockDb = {
  v: 5; // 2: added staff + settings.ordersPaused (2026-10-21). 3: contract 1.3.0 staff rows + sample product photos (2026-10-22). 4: menu translations (2026-10-24). 5: table ordering (2026-10-25). Older browser copies are re-seeded

  menu: AdminMenuCategory[];
  specials: MenuSpecial[];
  products: AdminProduct[];
  settings: AdminSettings;
  orders: MockOrder[];
  staff: StaffMember[];
  blocked: BlockedContact[];
  /** 2.0.0 table ordering (src/mocks/tables.ts). */
  tables: MockTablesState;
  seq: number;
  updatedAt: string;
};

export const uid = (n: number, ns = 1): string =>
  `00000000-0000-4000-8${String(ns).padStart(3, "0")}-${String(n).padStart(12, "0")}`;

export function stockStateFor(stock: number): StockState {
  if (stock <= 0) return "sold_out";
  if (stock <= 3) return "few_left";
  return "in_stock";
}

function item(
  n: number,
  categoryId: string,
  name: string,
  priceRupees: number,
  diet: AdminMenuItem["diet"],
  extra: Partial<AdminMenuItem> = {},
): AdminMenuItem {
  return {
    id: uid(n, 2),
    categoryId,
    name,
    description: null,
    price: priceRupees * 100,
    diet,
    tags: [],
    isSoldOut: false,
    imageUrl: null,
    imageVariants: [],
    variants: [],
    sortOrder: n,
    isVisible: true,
    imagePath: null,
    ...extra,
    translations: extra.translations ?? {},
  };
}

/**
 * A sample product photo with no network fetch: an inline SVG data URL (the CSP allows data: images), labelled so
 * nobody mistakes it for a real photo. `path` is a contract-shaped group path ("products/<uuid>").
 */
export function mockProductImage(n: number, alt: string, label: string): AdminProductImage {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720" viewBox="0 0 960 720">` +
    `<rect width="960" height="720" fill="#d9d2c5"/>` +
    `<text x="480" y="372" font-family="sans-serif" font-size="56" text-anchor="middle" fill="#3b3a36">${label}</text></svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return {
    path: `products/${uid(n, 13)}`,
    alt,
    url,
    variants: ([480, 960, 1600] as const).map((widthPx) => ({ widthPx, url })),
  };
}

function variant(
  id: string,
  size: string,
  colour: string,
  stock: number,
  priceRupees: number,
): AdminProductVariant {
  return {
    id,
    size,
    colour,
    stock,
    stockState: stockStateFor(stock),
    price: priceRupees * 100,
    sku: null,
  };
}

export function seedDb(now: Date = new Date()): MockDb {
  const cHot = uid(1, 3);
  const cCold = uid(2, 3);
  const cFood = uid(3, 3);
  const iso = (minAgo: number) => new Date(now.getTime() - minAgo * 60000).toISOString();

  const menu: AdminMenuCategory[] = [
    {
      id: cHot,
      slug: "hot-drinks",
      name: "Hot drinks",
      sortOrder: 1,
      isVisible: true,
      translations: {}, // none on purpose: mock mode shows "missing translation = English only"
      items: [
        item(1, cHot, "Sample milk tea", 120, "veg", {
          description: "Sample description text.",
          tags: ["bestseller"],
        }),
        item(2, cHot, "Sample black coffee", 150, "veg", {
          translations: MOCK_ITEM_TR.americano,
          variants: [
            {
              id: uid(1, 4),
              kind: "milk",
              label: "Oat milk",
              priceDelta: 5000,
              isSoldOut: true,
              translations: MOCK_VARIANT_TR.oatMilk,
            },
            {
              id: uid(2, 4),
              kind: "size",
              label: "Large",
              priceDelta: 3000,
              isSoldOut: false,
              translations: MOCK_VARIANT_TR.large,
            },
          ],
        }),
        item(3, cHot, "Sample masala chai", 140, "veg", {
          isSoldOut: true,
          tags: ["spicy"],
          translations: MOCK_ITEM_TR.masalaChai,
        }),
      ],
    },
    {
      id: cCold,
      slug: "cold-drinks",
      name: "Cold drinks",
      sortOrder: 2,
      isVisible: true,
      translations: MOCK_CATEGORY_TR.coldDrinks,
      items: [
        item(4, cCold, "Sample iced coffee", 220, "veg", {
          tags: ["new"],
          translations: MOCK_ITEM_TR.icedCoffee,
        }),
      ],
    },
    {
      id: cFood,
      slug: "food",
      name: "Food",
      sortOrder: 3,
      isVisible: true,
      translations: {},
      items: [
        item(5, cFood, "Sample veg sandwich", 280, "veg", {
          description: "Sample description text.",
        }),
        item(6, cFood, "Sample chicken momo", 260, "non_veg", {
          tags: ["spicy", "chef_pick"],
          translations: MOCK_ITEM_TR.chickenMomo,
        }),
        item(7, cFood, "Sample egg toast", 240, "egg"),
        item(8, cFood, "Hidden sample item", 100, "veg", { isVisible: false }),
      ],
    },
  ];

  const products: AdminProduct[] = [
    {
      id: uid(1, 5),
      slug: "sample-tee",
      name: "Sample tee",
      description: "Sample product text. Real merch, copy and photos are not designed yet.",
      price: 149900,
      images: [],
      details: {},
      isPublished: true,
      variants: [
        variant(uid(1, 6), "M", "Black", 12, 1499),
        variant(uid(2, 6), "L", "Black", 2, 1499),
        variant(uid(3, 6), "XL", "Black", 0, 1499),
        variant(uid(4, 6), "M", "Natural", 8, 1499),
      ],
    },
    {
      id: uid(2, 5),
      slug: "sample-hoodie",
      name: "Sample hoodie",
      description: null,
      price: 299900,
      images: [],
      details: {},
      isPublished: true,
      variants: [
        variant(uid(5, 6), "L", "Black", 0, 2999),
        variant(uid(6, 6), "XL", "Black", 0, 2999),
      ],
    },
    {
      id: uid(3, 5),
      slug: "sample-draft",
      name: "Unpublished sample",
      description: null,
      price: 99900,
      // Photos and every details field, so the admin editor can be tested for keeping what it does not edit.
      images: [
        mockProductImage(1, "Sample photo one: front of the draft tee", "Sample photo 1"),
        mockProductImage(2, "Sample photo two: back of the draft tee", "Sample photo 2"),
      ],
      details: {
        fabric: "Sample cotton",
        gsm: 180,
        printMethod: "Sample screen print",
        credit: "Sample artist",
        sizeChartCm: { M: { chest: 102, length: 71 }, L: { chest: 108, length: 74 } },
      },
      isPublished: false,
      variants: [variant(uid(7, 6), "M", "Black", 5, 999)],
    },
  ];

  const settings: AdminSettings = {
    cafeName: "Nailed Cafe & Lodge",
    hours: {
      weekly: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
      closures: [],
    },
    announcement: null,
    phone: null,
    whatsapp: null,
    email: null,
    address: "Uphar Marg, Baluwatar, Kathmandu",
    landmark: null,
    mapUrl: null,
    pricesIncludeVat: true, // ASSUMPTION: brief Q22 default, client has not answered
    serviceChargePct: 0,
    vatPct: 13,
    deliveryFee: 15000, // sample
    deliveryAreas: ["Baluwatar", "Maharajgunj", "Lazimpat"], // sample
    minOrderDelivery: 50000, // sample
    minOrderPickup: 0,
    paymentMethods: ["cod", "pickup"],
    features: { lodge: false },
    codMaxTotal: 500000, // sample
    maxOpenOrdersPerPhone: 2,
    ordersPaused: false,
    ipOpenOrdersMax: 3, // DB defaults (ESTIMATE, owner-tunable)
    ipOrdersMaxPerDay: 10,
    autoCancelPlacedAfterMinutes: 120,
    tableOrdering: "on", // 2.0.0: "on" in the seed only (data-model decision 22); the real default is "off"
    staffCancelWindowMinutes: 10, // 2.2.0 default (9.10a)
    ownerAlertWhatsApp: [], // 2.3.0: unused and hidden (WhatsApp not chosen)
  };

  const mkOrder = (
    n: number,
    token: string,
    status: AdminOrderRow["status"],
    fulfilment: "delivery" | "pickup",
    minAgo: number,
    name: string,
    phone: string,
    qty: number,
  ): MockOrder => {
    const unit = 149900;
    const sub = unit * qty;
    const fee = fulfilment === "delivery" ? settings.deliveryFee : 0;
    return {
      id: uid(n, 7),
      token,
      number: `NC-${1040 + n}`,
      status,
      paymentMethod: fulfilment === "delivery" ? "cod" : "pickup",
      paymentStatus: status === "completed" ? "paid" : "unpaid",
      fulfilment,
      items: [{ name: "Sample tee (M, Black)", qty, unitPrice: unit }],
      lines: [{ variantId: uid(1, 6), name: "Sample tee (M, Black)", qty, unitPrice: unit }],
      subtotal: sub,
      deliveryFee: fee,
      vat: 0,
      total: sub + fee,
      customerName: name,
      canCancel: status === "placed",
      createdAt: iso(minAgo),
      customerPhone: phone,
      customerEmail: null,
      address: fulfilment === "delivery" ? "Sample address" : null,
      landmark: fulfilment === "delivery" ? "Sample landmark" : null,
      area: fulfilment === "delivery" ? "Baluwatar" : null,
      notes: null,
      cancelReason: null,
      confirmedAt: status === "placed" ? null : iso(minAgo - 5),
      completedAt: status === "completed" ? iso(minAgo - 20) : null,
      cancelledAt: null,
      isStale: false,
      phoneIsBlocked: false,
    };
  };

  return {
    v: 5,
    menu,
    specials: [
      { id: uid(1, 8), title: "Sample special", note: "Sample note", endsAt: null, itemId: null },
    ],
    products,
    settings,
    orders: [
      mkOrder(1, uid(1, 9), "placed", "delivery", 45, "Sample Sita", "+9779800000001", 1),
      mkOrder(2, uid(2, 9), "confirmed", "pickup", 20, "Sample Ram", "+9779800000002", 2),
      mkOrder(3, uid(3, 9), "placed", "pickup", 3, "Sample Hari", "+9779800000003", 1),
    ],
    blocked: [],
    tables: seedTables(now),
    staff: [
      // isSelf: the mock signs everyone in as "the owner" row (it has no real accounts)
      {
        userId: uid(1, 12),
        displayName: "Sample owner",
        email: "owner@example.com",
        role: "owner",
        createdAt: iso(60 * 24 * 30),
        lastSignInAt: iso(5),
        isSelf: true,
        isActive: true,
      },
      {
        userId: uid(2, 12),
        displayName: "Sample staff one",
        email: "staff1@example.com",
        role: "staff",
        createdAt: iso(60 * 24 * 10),
        lastSignInAt: iso(60 * 3),
        isSelf: false,
        isActive: true,
      },
      {
        userId: uid(3, 12),
        displayName: "Sample staff two",
        email: "staff2@example.com",
        role: "staff",
        createdAt: iso(60 * 24 * 2),
        lastSignInAt: null,
        isSelf: false,
        isActive: true,
      },
    ],
    seq: 1044,
    updatedAt: now.toISOString(),
  };
}

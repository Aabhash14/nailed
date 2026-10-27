import { z } from "zod";
import {
  charCount,
  MENU_TRANSLATION_LANGS,
  PRONUNCIATION_LANG,
  TRANSLATION_LIMITS,
} from "@/lib/menu-translations";
import type {
  MenuCategoryTranslations,
  MenuItemTranslations,
  MenuTranslationLang,
  MenuVariantTranslations,
} from "@/types/db";
import { nepalPhone, paisa, uuid } from "./common";

/** Zod schemas for every admin action input (api-contract.md section 4). */

const name80 = z.string().trim().min(1).max(80);
const dietSchema = z.enum(["veg", "non_veg", "egg"]);
const tagSchema = z.enum(["spicy", "new", "bestseller", "chef_pick"]);
const variantKind = z.enum(["size", "milk", "addon", "temperature"]);
const menuPrice = z.number().int().min(0).max(1_000_000);

/** Group path as stored in the DB: "<folder>/<uuid>". Only paths our own createUploadUrl could have produced. */
export const GROUP_PATH_RE = /^(menu|products|site)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const groupPath = (folder: "menu" | "products") =>
  z.string().regex(GROUP_PATH_RE, "Invalid image path").refine((p) => p.startsWith(`${folder}/`), "Wrong image folder");

/*
 * Menu translations (api-contract 1.4.0; mirrors the database CHECKs <table>_translations_valid in
 * 20261024000001_menu_translations.sql, so the CHECK is only a backstop):
 * - keys: ne | zh | ja | ko | pt only (unknown language = VALIDATION on `translations`); per language only the listed
 *   fields (unknown field = VALIDATION on `translations.<lang>`);
 * - every value is trimmed; "" / whitespace / null / omitted = blank. A blank optional field is dropped (the database
 *   refuses ""), a language whose name / label is blank is dropped as a whole, `null` for a language drops it;
 * - lengths in characters as Postgres counts them (code points): item name 80, description 240, pronunciation 80;
 *   category name 80; variant label 40;
 * - `pronunciation` only on "ne" (a non-blank one on another language is VALIDATION).
 * The output is the exact jsonb to store (keys in MENU_TRANSLATION_LANGS order); `{}` = English only.
 */
const UNKNOWN_LANGUAGE = `Only these languages can be added: ${MENU_TRANSLATION_LANGS.join(", ")}`;
const UNKNOWN_FIELD = "Unknown field in this translation";

const translatedText = (max: number) =>
  z
    .string({ invalid_type_error: "Must be text" })
    .nullish()
    .transform((v) => (v ?? "").trim())
    .refine((v) => charCount(v) <= max, `Use at most ${max} characters`);

/** { ne?, zh?, ja?, ko?, pt? }, each the given entry schema or null; any other key is refused. */
function perLanguage<S extends z.ZodTypeAny>(entry: S) {
  const shape = Object.fromEntries(MENU_TRANSLATION_LANGS.map((l) => [l, entry.nullish()])) as Record<
    MenuTranslationLang,
    z.ZodOptional<z.ZodNullable<S>>
  >;
  return z.object(shape).strict(UNKNOWN_LANGUAGE);
}

const L = TRANSLATION_LIMITS;

export const itemTranslationsSchema = perLanguage(
  z
    .object({
      name: translatedText(L.item.name),
      description: translatedText(L.item.description),
      pronunciation: translatedText(L.item.pronunciation),
    })
    .strict(UNKNOWN_FIELD),
)
  .superRefine((v, ctx) => {
    for (const lang of MENU_TRANSLATION_LANGS) {
      if (lang !== PRONUNCIATION_LANG && v[lang]?.pronunciation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [lang, "pronunciation"],
          message: "Pronunciation is only for Nepali (ne)",
        });
      }
    }
  })
  .transform((v): MenuItemTranslations => {
    const out: Record<string, { name: string; description?: string; pronunciation?: string }> = {};
    for (const lang of MENU_TRANSLATION_LANGS) {
      const e = v[lang];
      if (!e?.name) continue;
      out[lang] = {
        name: e.name,
        ...(e.description ? { description: e.description } : {}),
        ...(lang === PRONUNCIATION_LANG && e.pronunciation ? { pronunciation: e.pronunciation } : {}),
      };
    }
    return out as MenuItemTranslations;
  });

export const categoryTranslationsSchema = perLanguage(
  z.object({ name: translatedText(L.category.name) }).strict(UNKNOWN_FIELD),
).transform((v): MenuCategoryTranslations => {
  const out: MenuCategoryTranslations = {};
  for (const lang of MENU_TRANSLATION_LANGS) {
    const name = v[lang]?.name;
    if (name) out[lang] = { name };
  }
  return out;
});

export const variantTranslationsSchema = perLanguage(
  z.object({ label: translatedText(L.variant.label) }).strict(UNKNOWN_FIELD),
).transform((v): MenuVariantTranslations => {
  const out: MenuVariantTranslations = {};
  for (const lang of MENU_TRANSLATION_LANGS) {
    const label = v[lang]?.label;
    if (label) out[lang] = { label };
  }
  return out;
});

export const signInSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
  turnstileToken: z.string().min(1).max(4096),
});
/** Supabase Auth hashes with bcrypt, which only uses the first 72 bytes: longer passwords are refused. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 72;
/** A new password (inviteStaff, changePassword): 12..72 characters AND at most 72 UTF-8 bytes. */
const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`)
  .refine((p) => new TextEncoder().encode(p).length <= PASSWORD_MAX, `Use at most ${PASSWORD_MAX} bytes`);

export const inviteStaffSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: name80,
  // 2026-10-22: capped at 72 characters / 72 bytes like changePassword (was 200; bcrypt ignores bytes past 72).
  password: newPasswordSchema,
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: newPasswordSchema,
    /** Required only when Supabase Auth CAPTCHA is on (AUTH_CAPTCHA_ENABLED=true): the current password is re-checked through Auth. */
    turnstileToken: z.string().min(1).max(4096).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.newPassword === v.currentPassword) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["newPassword"], message: "Choose a password different from the current one" });
    }
  });
export const deactivateStaffSchema = z.object({ userId: uuid });
export const setOrdersPausedSchema = z.object({ paused: z.boolean() });

export const toggleSoldOutSchema = z.object({ itemId: uuid, isSoldOut: z.boolean() });
export const toggleVariantSoldOutSchema = z.object({ variantId: uuid, isSoldOut: z.boolean() });
export const upsertMenuItemSchema = z.object({
  id: uuid.optional(),
  categoryId: uuid,
  name: name80,
  description: z.string().trim().max(240).nullish(),
  price: menuPrice,
  diet: dietSchema,
  tags: z.array(tagSchema).max(4),
  isVisible: z.boolean(),
  /** api-contract 1.3.1: omitted = keep the stored image; null = remove it (files deleted); a path = replace it. */
  imagePath: groupPath("menu").nullish(),
  /** api-contract 1.4.0: omitted = keep the stored translations; an object (also {}) replaces them. Owner only. */
  translations: itemTranslationsSchema.optional(),
  variants: z
    .array(
      z.object({
        id: uuid.optional(),
        kind: variantKind,
        label: name80,
        priceDelta: z.number().int().min(-1_000_000).max(1_000_000),
        /** 1.4.0: omitted = keep (existing variant) / {} (new variant); an object replaces. */
        translations: variantTranslationsSchema.optional(),
      }),
    )
    .max(12),
});
export const setItemPriceSchema = z.object({ itemId: uuid, price: menuPrice });
export const deleteMenuItemSchema = z.object({ itemId: uuid });
export const upsertCategorySchema = z.object({
  id: uuid.optional(),
  name: name80,
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, numbers and dashes")
    .max(60)
    .optional(),
  isVisible: z.boolean(),
  /** api-contract 1.4.0: omitted = keep the stored translations; an object (also {}) replaces them. */
  translations: categoryTranslationsSchema.optional(),
});
export const reorderCategoriesSchema = z.object({ orderedIds: z.array(uuid).min(1).max(100) });
export const reorderItemsSchema = z.object({ categoryId: uuid, orderedIds: z.array(uuid).min(1).max(300) });
export const upsertSpecialSchema = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1).max(80),
  note: z.string().trim().max(240).optional(),
  itemId: uuid.optional(),
  endsAt: z.string().datetime().optional(),
});
export const deleteSpecialSchema = z.object({ id: uuid });

export const IMAGE_SIZE_CAPS = { 480: 40 * 1024, 960: 120 * 1024, 1600: 300 * 1024 } as const;
export const createUploadUrlSchema = z
  .object({
    folder: z.enum(["menu", "products", "site"]),
    groupId: uuid.optional(),
    widthPx: z.union([z.literal(480), z.literal(960), z.literal(1600)]),
    contentType: z.literal("image/webp"),
    sizeBytes: z.number().int().min(1),
  })
  .superRefine((v, ctx) => {
    const cap = IMAGE_SIZE_CAPS[v.widthPx];
    if (v.sizeBytes > cap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sizeBytes"],
        message: `The ${v.widthPx}px image must be at most ${Math.round(cap / 1024)} KB`,
      });
    }
  });

export const upsertProductSchema = z.object({
  id: uuid.optional(),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(80)
    .optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  price: paisa,
  isPublished: z.boolean(),
  /**
   * api-contract 1.3.1: MERGED into the stored details. An omitted key (or an omitted `details`) keeps the stored
   * value; `null` removes that key; a value replaces it (`sizeChartCm` is replaced as a whole).
   */
  details: z
    .object({
      fabric: z.string().max(120).nullish(),
      gsm: z.number().int().min(0).max(2000).nullish(),
      printMethod: z.string().max(120).nullish(),
      credit: z.string().max(200).nullish(),
      sizeChartCm: z.record(z.string().max(20), z.record(z.string().max(30), z.number().min(0).max(500))).nullish(),
    })
    .optional(),
  /**
   * api-contract 1.3.1: omitted = leave the stored images (and their files) unchanged. An explicit array (also [])
   * is the full set: stored images not listed are removed and their files deleted.
   */
  images: z.array(z.object({ path: groupPath("products"), alt: z.string().trim().max(200) })).max(10).optional(),
  variants: z
    .array(
      z.object({
        id: uuid.optional(),
        size: z.string().trim().min(1).max(20),
        colour: z.string().trim().min(1).max(40),
        sku: z.string().trim().max(60).optional(),
        stock: z.number().int().min(0).max(9999),
        priceOverride: paisa.nullish(),
      }),
    )
    .min(1)
    .max(60),
});
export const setStockSchema = z.object({ variantId: uuid, stock: z.number().int().min(0).max(9999) });
export const setProductPublishedSchema = z.object({ productId: uuid, isPublished: z.boolean() });
export const deleteProductSchema = z.object({ productId: uuid });

export const cancelReasonSchema = z.enum([
  "customer_request",
  "unreachable",
  "no_show",
  "refused",
  "fake",
  "out_of_stock",
  "other",
]);
export const orderStatusSchema = z.enum([
  "placed",
  "confirmed",
  "out_for_delivery",
  "ready_for_pickup",
  "completed",
  "cancelled",
]);
export const orderFilterSchema = z.object({
  status: z.array(orderStatusSchema).max(6).optional(),
  fulfilment: z.array(z.enum(["pickup", "delivery"])).max(2).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9+\-\s]*$/, "Letters, numbers, + and - only")
    .optional(),
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export const getOrderSchema = z.object({ orderId: uuid });
export const updateOrderStatusSchema = z.object({
  orderId: uuid,
  status: z.enum(["confirmed", "out_for_delivery", "ready_for_pickup", "completed"]),
});
export const cancelOrderSchema = z.object({
  orderId: uuid,
  reason: cancelReasonSchema,
  restock: z.boolean(),
  blockContact: z.boolean().optional(),
});

export const listBlockedSchema = z.object({
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export const blockContactSchema = z
  .object({
    kind: z.enum(["phone", "ip_hash"]),
    value: z.string().trim().min(1).max(100),
    reason: z.string().trim().max(200).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "ip_hash" && !/^[0-9a-f]{64}$/.test(v.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Invalid contact" });
    }
    if (v.kind === "phone" && !nepalPhone.safeParse(v.value).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Enter a valid Nepal mobile number" });
    }
  });
export const unblockContactSchema = z.object({ id: uuid });

/** "HH:mm", 24-hour, 00:00..23:59. Zero-padded, so plain string comparison orders times correctly. */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:30");
/** Closing may also be "24:00" (midnight), same as the database check. */
const closeTime = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "Use a 24-hour time like 18:30");
/** BUG-006: a slot must close after it opens (no reversed "18:00-09:00"; overnight slots are not supported). */
const timeRange = z
  .object({ open: hhmm, close: closeTime })
  .refine((r) => r.close > r.open, { path: ["close"], message: "Closing time must be after opening time" });
const hoursSchema = z.object({
  weekly: z.object({
    "0": z.array(timeRange).max(4).nullable(),
    "1": z.array(timeRange).max(4).nullable(),
    "2": z.array(timeRange).max(4).nullable(),
    "3": z.array(timeRange).max(4).nullable(),
    "4": z.array(timeRange).max(4).nullable(),
    "5": z.array(timeRange).max(4).nullable(),
    "6": z.array(timeRange).max(4).nullable(),
  }),
  closures: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), label: z.string().max(80) })).max(100),
});
const nullableText = (max: number) => z.string().trim().max(max).nullable();

/**
 * SEC-012: a public phone / WhatsApp number shown as a tel: link. Digits with optional leading +,
 * spaces, dashes and brackets; 6..15 digits (landlines like 01-4000000 are allowed). Empty clears it.
 */
const contactPhone = z
  .string()
  .trim()
  .max(30)
  .refine((v) => {
    if (v === "") return true;
    if (!/^\+?[0-9 ()-]+$/.test(v)) return false;
    const digits = v.replace(/\D/g, "").length;
    return digits >= 6 && digits <= 15;
  }, "Use digits only (spaces, dashes, brackets and a leading + are fine)")
  .nullable();

/** SEC-012: https only (no javascript:, data:, http:). The page also guards the href. */
export function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password;
  } catch {
    return false;
  }
}
const httpsUrl = z.string().trim().max(500).url("Enter a full link starting with https://").refine(isHttpsUrl, "The link must start with https://");

export const DELIVERY_NEEDS_AREA = "Add at least one delivery area, or turn off delivery.";

export const updateSettingsSchema = z
  .object({
    cafeName: name80,
    hours: hoursSchema,
    announcement: nullableText(300),
    phone: contactPhone,
    whatsapp: contactPhone,
    email: z.string().trim().email().max(254).nullable(),
    address: nullableText(300),
    landmark: nullableText(200),
    mapUrl: httpsUrl.nullable(),
    pricesIncludeVat: z.boolean(),
    serviceChargePct: z.number().min(0).max(30),
    deliveryFee: z.number().int().min(0).max(1_000_000),
    deliveryAreas: z.array(z.string().trim().min(1).max(100)).max(100),
    minOrderDelivery: z.number().int().min(0).max(10_000_000),
    minOrderPickup: z.number().int().min(0).max(10_000_000),
    paymentMethods: z.array(z.enum(["cod", "pickup"])).min(1).max(2),
    // BUG-003 (Manager decision): 0 means NO limit, same as null. Stored as null (DB check is "> 0 or null").
    codMaxTotal: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .nullable()
      .transform((v) => (v === 0 ? null : v)),
    maxOpenOrdersPerPhone: z.number().int().min(1).max(5),
    // SEC-003 owner-tunable rules (ranges = DB checks in migration 20261021000002)
    ipOpenOrdersMax: z.number().int().min(1).max(100),
    ipOrdersMaxPerDay: z.number().int().min(1).max(1000),
    autoCancelPlacedAfterMinutes: z.number().int().min(15).max(10080).nullable(),
    /** Kill switch, same as setOrdersPaused (data-model "Contract changes needed" item 2). */
    ordersPaused: z.boolean(),
    // Table ordering (api-contract 2.2.0). `tableOrdering` is deliberately NOT here: .strict() refuses it as an unknown
    // key (use setTableOrdering; the database guard refuses any other writer, SEC-029).
    staffCancelWindowMinutes: z.number().int().min(0).max(60),
    /** 2.3.0: unused (WhatsApp not chosen) but still part of OrderRules. Field errors: `ownerAlertWhatsApp.N`. */
    ownerAlertWhatsApp: z.array(nepalPhone).max(3),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .superRefine((v, ctx) => {
    // BUG-006, when both fields are in the same request (the action re-checks against stored values otherwise)
    if (v.paymentMethods?.includes("cod") && v.deliveryAreas !== undefined && v.deliveryAreas.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveryAreas"], message: DELIVERY_NEEDS_AREA });
    }
  });
export const setAnnouncementSchema = z.object({ text: z.string().trim().max(300).nullable() });

"use server";

import { revalidateTag } from "next/cache";
import { CACHE_TAG } from "@/lib/cache-tags";
import { runAction } from "@/lib/actions";
import { requireRole } from "@/lib/auth/require-role";
import { mapMenuCategory, mapMenuItem, type MenuItemDto } from "@/lib/data/menu";
import { unwrap } from "@/lib/data/db-errors";
import { createAdminClient } from "@/lib/data/server-admin";
import type { Db } from "@/lib/data/types";
import { AppError } from "@/lib/errors";
import { assertImageGroupsValid } from "@/lib/images/verify";
import { resolveMenuImage } from "@/lib/data/upsert-merge";
import { slugify } from "@/lib/slug";
import {
  deleteMenuItemSchema,
  deleteSpecialSchema,
  reorderCategoriesSchema,
  reorderItemsSchema,
  setItemPriceSchema,
  toggleSoldOutSchema,
  toggleVariantSoldOutSchema,
  upsertCategorySchema,
  upsertMenuItemSchema,
  upsertSpecialSchema,
} from "@/lib/validation/admin";
import { parseInput } from "@/lib/validation/common";
import type { MenuCategoryRow, MenuItemRow, MenuSpecialRow, MenuVariantRow } from "@/types/db";

const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

function bump() {
  revalidateTag(CACHE_TAG.menu);
}

async function loadItem(db: Db, id: string): Promise<MenuItemDto> {
  const item = unwrap(await db.from("menu_items").select("*").eq("id", id).maybeSingle()) as MenuItemRow | null;
  if (!item) throw new AppError("NOT_FOUND");
  const variants = (unwrap(await db.from("menu_variants").select("*").eq("item_id", id)) ?? []) as MenuVariantRow[];
  return mapMenuItem(item, variants, supabaseUrl());
}

/**
 * A translations CHECK violation on a variant write maps to `fieldErrors.translations` (db-errors). Re-key it to the
 * variant's own path so the editor can show it next to the right row (same path Zod uses: variants.N.translations).
 */
function rekeyVariantError(e: unknown, index: number): unknown {
  if (!(e instanceof AppError) || e.code !== "VALIDATION" || !e.fieldErrors?.translations) return e;
  const { translations, ...rest } = e.fieldErrors;
  return new AppError("VALIDATION", e.message, {
    fieldErrors: { ...rest, [`variants.${index}.translations`]: translations },
  });
}

/** Best effort: remove the three stored widths of an image group no longer referenced. */
async function removeImageGroup(db: Db, path: string | null | undefined) {
  if (!path) return;
  try {
    await db.storage.from("public-media").remove([480, 960, 1600].map((w) => `${path}/${w}.webp`));
  } catch {
    // orphan files are harmless; never fail the edit because of cleanup
  }
}

/** Owner or staff. */
export async function toggleSoldOut(input: unknown) {
  return runAction(async () => {
    await requireRole("staff");
    const { itemId, isSoldOut } = parseInput(toggleSoldOutSchema, input);
    const rows = unwrap(
      await createAdminClient().from("menu_items").update({ is_sold_out: isSoldOut }).eq("id", itemId).select("id"),
    );
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError("NOT_FOUND");
    bump();
    return { itemId, isSoldOut };
  });
}

/** Owner or staff. */
export async function toggleVariantSoldOut(input: unknown) {
  return runAction(async () => {
    await requireRole("staff");
    const { variantId, isSoldOut } = parseInput(toggleVariantSoldOutSchema, input);
    const rows = unwrap(
      await createAdminClient().from("menu_variants").update({ is_sold_out: isSoldOut }).eq("id", variantId).select("id"),
    );
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError("NOT_FOUND");
    bump();
    return { variantId, isSoldOut };
  });
}

/**
 * Owner only. NOT atomic: PostgREST cannot run item + variants in one transaction. Item first, then variants;
 * a failure part-way leaves the item saved and reports the error (see report: request for an RPC).
 * Translations (1.4.0) are owner-only like every other field here: staff get FORBIDDEN from requireRole before any
 * read or write, whatever they send (the database would refuse them too: guard trigger 42501, mapped to FORBIDDEN).
 */
export async function upsertMenuItem(input: unknown) {
  return runAction(async (): Promise<MenuItemDto> => {
    await requireRole("owner");
    const d = parseInput(upsertMenuItemSchema, input);
    const db = createAdminClient();

    const cat = unwrap(await db.from("menu_categories").select("id").eq("id", d.categoryId).maybeSingle());
    if (!cat) throw new AppError("VALIDATION", undefined, { fieldErrors: { categoryId: ["Unknown category"] } });

    const fields: Record<string, unknown> = {
      category_id: d.categoryId,
      name: d.name,
      price_paisa: d.price,
      diet: d.diet,
      tags: d.tags,
      is_visible: d.isVisible,
    };
    // api-contract 1.3.2 (section 4, "Omitted description"): on update an omitted description keeps the stored
    // text; "" / whitespace / null clear it (stored as null, never ""). On create, omitted = null.
    if (!d.id || d.description !== undefined) fields.description = d.description || null;
    // api-contract 1.4.0: omitted translations = keep the stored ones (create: the column default {}); an explicit
    // object (already trimmed and cleaned by the schema, {} included) replaces them as a whole.
    if (d.translations !== undefined) fields.translations = d.translations;

    let itemId = d.id;
    // api-contract 1.3.1: omitted imagePath = keep the stored image (row AND files); null = remove; path = replace.
    let removeAfterSave: string | null = null;
    if (itemId) {
      const prev = unwrap(
        await db.from("menu_items").select("image_path").eq("id", itemId).is("deleted_at", null).maybeSingle(),
      ) as { image_path: string | null } | null;
      if (!prev) throw new AppError("NOT_FOUND");
      const img = resolveMenuImage(prev.image_path, d.imagePath);
      if (img.isNew && img.path) await assertImageGroupsValid(db, [img.path], "imagePath"); // SEC-018
      if (d.imagePath !== undefined) fields.image_path = img.path;
      removeAfterSave = img.remove;
      unwrap(await db.from("menu_items").update(fields).eq("id", itemId));
    } else {
      fields.image_path = d.imagePath ?? null;
      if (d.imagePath) await assertImageGroupsValid(db, [d.imagePath], "imagePath"); // SEC-018
      const last = unwrap(
        await db
          .from("menu_items")
          .select("sort_order")
          .eq("category_id", d.categoryId)
          .order("sort_order", { ascending: false })
          .limit(1),
      ) as { sort_order: number }[] | null;
      const created = unwrap(
        await db
          .from("menu_items")
          .insert({ ...fields, sort_order: (last?.[0]?.sort_order ?? 0) + 1 })
          .select("id")
          .single(),
      ) as { id: string } | null;
      if (!created) throw new AppError("INTERNAL");
      itemId = created.id;
    }

    // Variants: update those with ids that belong to this item, insert new ones, delete the ones left out.
    const existing = (unwrap(await db.from("menu_variants").select("id").eq("item_id", itemId)) ?? []) as {
      id: string;
    }[];
    const existingIds = new Set(existing.map((v) => v.id));
    for (const v of d.variants) if (v.id && !existingIds.has(v.id)) throw new AppError("NOT_FOUND");
    const keep = new Set(d.variants.flatMap((v) => (v.id ? [v.id] : [])));
    const drop = existing.filter((v) => !keep.has(v.id)).map((v) => v.id);
    if (drop.length > 0) unwrap(await db.from("menu_variants").delete().in("id", drop));
    for (const [i, v] of d.variants.entries()) {
      const row: Record<string, unknown> = {
        item_id: itemId,
        kind: v.kind,
        label: v.label,
        price_delta_paisa: v.priceDelta,
        sort_order: i,
      };
      // 1.4.0: omitted = keep (existing variant) or the column default {} (new variant); an object replaces.
      if (v.translations !== undefined) row.translations = v.translations;
      try {
        if (v.id) unwrap(await db.from("menu_variants").update(row).eq("id", v.id));
        else unwrap(await db.from("menu_variants").insert(row));
      } catch (e) {
        throw rekeyVariantError(e, i);
      }
    }

    // Only a group the caller explicitly replaced or removed; never on an omitted imagePath.
    if (removeAfterSave) await removeImageGroup(db, removeAfterSave);
    bump();
    return loadItem(db, itemId);
  });
}

/** Owner only. */
export async function setItemPrice(input: unknown) {
  return runAction(async () => {
    await requireRole("owner");
    const { itemId, price } = parseInput(setItemPriceSchema, input);
    const rows = unwrap(
      await createAdminClient().from("menu_items").update({ price_paisa: price }).eq("id", itemId).select("id"),
    );
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError("NOT_FOUND");
    bump();
    return { itemId, price };
  });
}

/** Owner only. Soft delete: hidden + deleted_at. */
export async function deleteMenuItem(input: unknown) {
  return runAction(async (): Promise<null> => {
    await requireRole("owner");
    const { itemId } = parseInput(deleteMenuItemSchema, input);
    const rows = unwrap(
      await createAdminClient()
        .from("menu_items")
        .update({ is_visible: false, deleted_at: new Date().toISOString() })
        .eq("id", itemId)
        .select("id"),
    );
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError("NOT_FOUND");
    bump();
    return null;
  });
}

/**
 * Owner only. Slug generated from the name when omitted; a taken slug is CONFLICT. Translations (1.4.0): omitted =
 * unchanged, an object replaces; staff get FORBIDDEN from requireRole first (they have no category UPDATE policy).
 */
export async function upsertCategory(input: unknown) {
  return runAction(async () => {
    await requireRole("owner");
    const d = parseInput(upsertCategorySchema, input);
    const db = createAdminClient();
    const conflictMessage = "That slug is already taken.";
    if (d.id) {
      const fields: Record<string, unknown> = { name: d.name, is_visible: d.isVisible };
      if (d.slug) fields.slug = d.slug;
      // api-contract 1.4.0: omitted = keep; an object (also {}) replaces.
      if (d.translations !== undefined) fields.translations = d.translations;
      const row = unwrap(
        await db.from("menu_categories").update(fields).eq("id", d.id).select("id, slug").maybeSingle(),
        { conflictMessage },
      ) as { id: string; slug: string } | null;
      if (!row) throw new AppError("NOT_FOUND");
      bump();
      return { id: row.id, slug: row.slug };
    }
    const last = unwrap(
      await db.from("menu_categories").select("sort_order").order("sort_order", { ascending: false }).limit(1),
    ) as { sort_order: number }[] | null;
    const row = unwrap(
      await db
        .from("menu_categories")
        .insert({
          name: d.name,
          slug: d.slug ?? slugify(d.name, "category"),
          is_visible: d.isVisible,
          sort_order: (last?.[0]?.sort_order ?? 0) + 1,
          translations: d.translations ?? {},
        })
        .select("id, slug")
        .single(),
      { conflictMessage },
    ) as { id: string; slug: string } | null;
    if (!row) throw new AppError("INTERNAL");
    bump();
    return { id: row.id, slug: row.slug };
  });
}

/** Owner only. */
export async function reorderCategories(input: unknown) {
  return runAction(async (): Promise<null> => {
    await requireRole("owner");
    const { orderedIds } = parseInput(reorderCategoriesSchema, input);
    const db = createAdminClient();
    const known = (unwrap(await db.from("menu_categories").select("id")) ?? []) as { id: string }[];
    const ids = new Set(known.map((k) => k.id));
    if (orderedIds.some((id) => !ids.has(id))) throw new AppError("NOT_FOUND");
    for (const [i, id] of orderedIds.entries()) {
      unwrap(await db.from("menu_categories").update({ sort_order: i + 1 }).eq("id", id));
    }
    bump();
    return null;
  });
}

/** Owner only. */
export async function reorderItems(input: unknown) {
  return runAction(async (): Promise<null> => {
    await requireRole("owner");
    const { categoryId, orderedIds } = parseInput(reorderItemsSchema, input);
    const db = createAdminClient();
    const known = (unwrap(await db.from("menu_items").select("id").eq("category_id", categoryId)) ?? []) as {
      id: string;
    }[];
    const ids = new Set(known.map((k) => k.id));
    if (orderedIds.some((id) => !ids.has(id))) throw new AppError("NOT_FOUND");
    for (const [i, id] of orderedIds.entries()) {
      unwrap(await db.from("menu_items").update({ sort_order: i + 1 }).eq("id", id).eq("category_id", categoryId));
    }
    bump();
    return null;
  });
}

/** Owner only. */
export async function upsertSpecial(input: unknown) {
  return runAction(async () => {
    await requireRole("owner");
    const d = parseInput(upsertSpecialSchema, input);
    const db = createAdminClient();
    const fields = { title: d.title, note: d.note || null, item_id: d.itemId ?? null, ends_at: d.endsAt ?? null };
    let row: MenuSpecialRow | null;
    if (d.id) {
      row = unwrap(
        await db.from("menu_specials").update(fields).eq("id", d.id).select("*").maybeSingle(),
      ) as MenuSpecialRow | null;
      if (!row) throw new AppError("NOT_FOUND");
    } else {
      row = unwrap(await db.from("menu_specials").insert(fields).select("*").single()) as MenuSpecialRow | null;
      if (!row) throw new AppError("INTERNAL");
    }
    bump();
    return { id: row.id, title: row.title, note: row.note, endsAt: row.ends_at, itemId: row.item_id };
  });
}

/** Owner only. */
export async function deleteSpecial(input: unknown) {
  return runAction(async (): Promise<null> => {
    await requireRole("owner");
    const { id } = parseInput(deleteSpecialSchema, input);
    const rows = unwrap(await createAdminClient().from("menu_specials").delete().eq("id", id).select("id"));
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError("NOT_FOUND");
    bump();
    return null;
  });
}

/** Admin read helper (all categories and items including hidden, no deleted). Owner or staff. */
export async function getAdminMenu() {
  return runAction(async () => {
    await requireRole("staff");
    const db = createAdminClient();
    const [c, i, v] = await Promise.all([
      db.from("menu_categories").select("*").order("sort_order"),
      db.from("menu_items").select("*").is("deleted_at", null).order("sort_order"),
      db.from("menu_variants").select("*").order("sort_order"),
    ]);
    const cats = (unwrap(c) ?? []) as MenuCategoryRow[];
    const items = (unwrap(i) ?? []) as MenuItemRow[];
    const variants = (unwrap(v) ?? []) as MenuVariantRow[];
    return cats.map((cat) => ({
      ...mapMenuCategory(cat), // id, slug, name, sortOrder, translations (1.4.0)
      isVisible: cat.is_visible,
      items: items
        .filter((it) => it.category_id === cat.id)
        .map((it) => ({
          ...mapMenuItem(it, variants, supabaseUrl()),
          isVisible: it.is_visible,
          imagePath: it.image_path,
        })),
    }));
  });
}

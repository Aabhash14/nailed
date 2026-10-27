"use server";

import { revalidateTag } from "next/cache";
import { CACHE_TAG } from "@/lib/cache-tags";
import { runAction } from "@/lib/actions";
import { requireRole } from "@/lib/auth/require-role";
import { unwrap } from "@/lib/data/db-errors";
import { imageVariantsFor } from "@/lib/data/menu";
import { createAdminClient } from "@/lib/data/server-admin";
import type { Db } from "@/lib/data/types";
import { AppError } from "@/lib/errors";
import { assertImageGroupsValid } from "@/lib/images/verify";
import { mergeProductDetails, removedImagePaths } from "@/lib/data/upsert-merge";
import { slugify } from "@/lib/slug";
import {
  deleteProductSchema,
  setProductPublishedSchema,
  setStockSchema,
  upsertProductSchema,
} from "@/lib/validation/admin";
import { parseInput } from "@/lib/validation/common";
import type { ProductImageRow, ProductRow, ProductVariantRow } from "@/types/db";

const bump = () => revalidateTag(CACHE_TAG.shop);
const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

async function removeImageGroup(db: Db, path: string) {
  try {
    await db.storage.from("public-media").remove([480, 960, 1600].map((w) => `${path}/${w}.webp`));
  } catch {
    // orphaned files are harmless
  }
}

/**
 * Owner only. NOT atomic (PostgREST): product, then images, then variants. Variants with orders cannot be
 * deleted (FK), so removing one that was sold gives CONFLICT: set its stock to 0 instead.
 * api-contract 1.3.1: omitted `images` leaves the stored images and files untouched; `details` is merged
 * (omitted keys kept, null removes a key).
 */
export async function upsertProduct(input: unknown) {
  return runAction(async () => {
    await requireRole("owner");
    const d = parseInput(upsertProductSchema, input);
    const db = createAdminClient();
    const conflictMessage = "That slug is already taken.";

    // api-contract 1.3.1: omitted `images` = leave the stored set (and its files) alone; omitted `details` keys
    // are kept. So an update reads the stored details (to merge) and, only for an explicit set, the image rows.
    let storedDetails: Record<string, unknown> | null = null;
    let storedImages: { id: string; path: string }[] = [];
    if (d.id) {
      const prev = unwrap(await db.from("products").select("details").eq("id", d.id).maybeSingle()) as {
        details: Record<string, unknown> | null;
      } | null;
      if (!prev) throw new AppError("NOT_FOUND");
      storedDetails = prev.details;
      if (d.images !== undefined) {
        storedImages = (unwrap(await db.from("product_images").select("id, path").eq("product_id", d.id)) ?? []) as {
          id: string;
          path: string;
        }[];
      }
    }

    // SEC-018: check newly attached image groups (real size + WebP bytes) before anything is written.
    if (d.images !== undefined) {
      const storedPaths = new Set(storedImages.map((s) => s.path));
      await assertImageGroupsValid(
        db,
        d.images.map((im) => im.path).filter((p) => !storedPaths.has(p)),
        "images",
      );
    }

    const fields: Record<string, unknown> = {
      name: d.name,
      price_paisa: d.price,
      is_published: d.isPublished,
      details: mergeProductDetails(storedDetails, d.details),
    };
    // api-contract 1.3.2 (section 4, "Omitted description"): on update an omitted description keeps the stored
    // text; "" / whitespace clears it (stored as null, never ""). On create, omitted = null.
    if (!d.id || d.description !== undefined) fields.description = d.description || null;
    let id = d.id;
    let slug: string;
    if (id) {
      if (d.slug) fields.slug = d.slug;
      const row = unwrap(await db.from("products").update(fields).eq("id", id).select("id, slug").maybeSingle(), {
        conflictMessage,
      }) as { id: string; slug: string } | null;
      if (!row) throw new AppError("NOT_FOUND");
      slug = row.slug;
    } else {
      const row = unwrap(
        await db
          .from("products")
          .insert({ ...fields, slug: d.slug ?? slugify(d.name, "product") })
          .select("id, slug")
          .single(),
        { conflictMessage },
      ) as { id: string; slug: string } | null;
      if (!row) throw new AppError("INTERNAL");
      id = row.id;
      slug = row.slug;
    }

    // Images, only when the caller sent an explicit set. Insert the new rows first, then delete the old rows by
    // id, so a failure part-way never leaves the product without image rows. Files are deleted last and only for
    // groups the caller explicitly left out of the set.
    if (d.images !== undefined) {
      if (d.images.length > 0) {
        unwrap(
          await db
            .from("product_images")
            .insert(d.images.map((im, i) => ({ product_id: id, path: im.path, alt: im.alt, sort_order: i }))),
        );
      }
      if (storedImages.length > 0) {
        unwrap(await db.from("product_images").delete().in("id", storedImages.map((s) => s.id)));
      }
      for (const p of removedImagePaths(
        storedImages.map((s) => s.path),
        d.images,
      )) {
        await removeImageGroup(db, p);
      }
    }

    // Variants: update by id (must belong to this product), insert new, delete omitted.
    const existing = (unwrap(await db.from("product_variants").select("id").eq("product_id", id)) ?? []) as {
      id: string;
    }[];
    const existingIds = new Set(existing.map((v) => v.id));
    for (const v of d.variants) if (v.id && !existingIds.has(v.id)) throw new AppError("NOT_FOUND");
    const keep = new Set(d.variants.flatMap((v) => (v.id ? [v.id] : [])));
    const drop = existing.filter((v) => !keep.has(v.id)).map((v) => v.id);
    if (drop.length > 0) {
      unwrap(await db.from("product_variants").delete().in("id", drop), {
        conflictMessage: "A size that has been ordered cannot be removed. Set its stock to 0 instead.",
      });
    }
    for (const v of d.variants) {
      const row = {
        product_id: id,
        size: v.size,
        colour: v.colour,
        sku: v.sku || null,
        stock: v.stock,
        price_override_paisa: v.priceOverride ?? null,
      };
      if (v.id) unwrap(await db.from("product_variants").update(row).eq("id", v.id));
      else unwrap(await db.from("product_variants").insert(row), { conflictMessage: "That size and colour already exists." });
    }

    bump();
    return { id, slug };
  });
}

/** Owner only. */
export async function setStock(input: unknown) {
  return runAction(async () => {
    await requireRole("owner");
    const { variantId, stock } = parseInput(setStockSchema, input);
    const rows = unwrap(
      await createAdminClient().from("product_variants").update({ stock }).eq("id", variantId).select("id"),
    );
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError("NOT_FOUND");
    bump();
    return { variantId, stock };
  });
}

/** Owner only. */
export async function setProductPublished(input: unknown) {
  return runAction(async (): Promise<null> => {
    await requireRole("owner");
    const { productId, isPublished } = parseInput(setProductPublishedSchema, input);
    const rows = unwrap(
      await createAdminClient().from("products").update({ is_published: isPublished }).eq("id", productId).select("id"),
    );
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError("NOT_FOUND");
    bump();
    return null;
  });
}

/** Owner only. CONFLICT if any variant has orders (unpublish instead). */
export async function deleteProduct(input: unknown) {
  return runAction(async (): Promise<null> => {
    await requireRole("owner");
    const { productId } = parseInput(deleteProductSchema, input);
    const db = createAdminClient();
    const variants = (unwrap(await db.from("product_variants").select("id").eq("product_id", productId)) ?? []) as {
      id: string;
    }[];
    if (variants.length > 0) {
      const used = unwrap(
        await db.from("order_items").select("id").in("product_variant_id", variants.map((v) => v.id)).limit(1),
      );
      if (Array.isArray(used) && used.length > 0) {
        throw new AppError("CONFLICT", "This product has orders. Unpublish it instead.");
      }
    }
    const images = (unwrap(await db.from("product_images").select("path").eq("product_id", productId)) ?? []) as {
      path: string;
    }[];
    const rows = unwrap(await db.from("products").delete().eq("id", productId).select("id"), {
      conflictMessage: "This product has orders. Unpublish it instead.",
    });
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError("NOT_FOUND");
    for (const im of images) await removeImageGroup(db, im.path);
    bump();
    return null;
  });
}

/** Admin read helper: all products with exact stock. Owner only (stock is owner data). */
export async function getAdminProducts() {
  return runAction(async () => {
    await requireRole("owner");
    const db = createAdminClient();
    const [p, im, v] = await Promise.all([
      db.from("products").select("*").order("created_at"),
      db.from("product_images").select("*").order("sort_order"),
      // BUG-015: stable display order (supabase/README "Reading data"); physical order changes on every stock update.
      db.from("product_variants").select("*").order("colour").order("size_rank").order("size").order("id"),
    ]);
    const products = (unwrap(p) ?? []) as ProductRow[];
    const images = (unwrap(im) ?? []) as ProductImageRow[];
    const variants = (unwrap(v) ?? []) as ProductVariantRow[];
    return products.map((pr) => {
      const vs = imageVariantsFor;
      return {
        id: pr.id,
        slug: pr.slug,
        name: pr.name,
        description: pr.description,
        price: pr.price_paisa,
        isPublished: pr.is_published,
        details: pr.details,
        images: images
          .filter((i) => i.product_id === pr.id)
          .map((i) => {
            const variantsOf = vs(i.path, supabaseUrl());
            return {
              url: variantsOf.find((x) => x.widthPx === 960)?.url ?? "",
              alt: i.alt,
              variants: variantsOf,
              path: i.path,
            };
          }),
        variants: variants
          .filter((x) => x.product_id === pr.id)
          .map((x) => ({
            id: x.id,
            size: x.size,
            colour: x.colour,
            sku: x.sku,
            stock: x.stock,
            stockState: x.stock_state,
            price: x.price_override_paisa ?? pr.price_paisa,
          })),
      };
    });
  });
}

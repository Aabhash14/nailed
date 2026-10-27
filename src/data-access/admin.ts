"use client";

import { loadDb, mutateDb, onDbChange, resetDb } from "@/mocks/db";
import {
  mockBlock,
  mockCancelOrder,
  mockListOrders,
  mockUpdateStatus,
  sweepAutoCancel,
} from "@/mocks/engine";
import { stockStateFor } from "@/mocks/seed";
import { applyDetailsPatch } from "@/components/admin/product-form-logic";
import type { ForwardStatus } from "@/types/order-flow";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type ActionResult,
  type AdminMenuCategory,
  type AdminMenuItem,
  type AdminOrderRow,
  type AdminProduct,
  type AdminSettings,
  type BlockedContact,
  type CancelReason,
  type MenuItem,
  type OrderFilter,
  type OrderRules,
  type PublicSettings,
  type Role,
  type StaffMember,
  type UpsertMenuItemInput,
  type UpsertProductInput,
  type UpsertCategoryInput,
  type Uuid,
} from "@/types/contract";
import { translationsProblem } from "@/components/admin/translations-logic";
import type { GetStatsInput, LogDailySalesInput, StatsBundle } from "@/lib/stats/types";
import { liveAdminApi } from "./admin-live";
import { createMockTablesAdminApi, type TablesAdminApi } from "./tables-admin";
import { isMock } from "./mode";
import { mockGetDailySales, mockGetStats, mockLogDailySales, resetMockSales, type DailySalesView } from "./stats-mock";

export type { DailySalesView };

/**
 * ADMIN seam. `AdminApi` mirrors the server actions in api-contract.md section 4 one-to-one (same names, same inputs,
 * same ActionResult outputs), plus a few READ helpers the contract leaves to lib/data.
 *
 * Admin pages call only `adminApi` (bottom of this file): the real actions (./admin-live) by default, or the mock
 * below when NEXT_PUBLIC_DATA_MODE=mock (dev demos and e2e only; SEC-011). The mock enforces the owner/staff split so the UI can be tried in both roles (log in with an email containing
 * "staff" for the staff role). It has no security value: the real checks are requireRole + RLS on the server.
 */

export type AdminSession = { role: Role; displayName: string };
export type UploadTarget = { groupId: Uuid; path: string; uploadUrl: string; token: string };

export interface AdminApi extends TablesAdminApi {
  // session
  getSession(): Promise<AdminSession | null>;
  signIn(input: {
    email: string;
    password: string;
    turnstileToken: string;
  }): Promise<ActionResult<{ role: Role }>>;
  signOut(): Promise<ActionResult<null>>;
  // reads (lib/data in live mode)
  getMenu(): Promise<AdminMenuCategory[]>;
  getProducts(): Promise<AdminProduct[]>;
  getSettings(): Promise<AdminSettings>;
  /** One order by id (the Telegram alert links to /admin/orders/<id>). NOT_FOUND when it does not exist. */
  getOrder(i: { orderId: Uuid }): Promise<ActionResult<AdminOrderRow>>;
  // menu
  toggleSoldOut(i: {
    itemId: Uuid;
    isSoldOut: boolean;
  }): Promise<ActionResult<{ itemId: Uuid; isSoldOut: boolean }>>;
  toggleVariantSoldOut(i: {
    variantId: Uuid;
    isSoldOut: boolean;
  }): Promise<ActionResult<{ variantId: Uuid; isSoldOut: boolean }>>;
  upsertMenuItem(i: UpsertMenuItemInput): Promise<ActionResult<MenuItem>>;
  setItemPrice(i: {
    itemId: Uuid;
    price: number;
  }): Promise<ActionResult<{ itemId: Uuid; price: number }>>;
  deleteMenuItem(i: { itemId: Uuid }): Promise<ActionResult<null>>;
  /** `translations` (pending contract, decision 19): omitted = unchanged, a value replaces the whole set. */
  upsertCategory(i: UpsertCategoryInput): Promise<ActionResult<{ id: Uuid; slug: string }>>;
  // images
  createUploadUrl(i: {
    folder: "menu" | "products" | "site";
    groupId?: Uuid;
    widthPx: 480 | 960 | 1600;
    contentType: "image/webp";
    sizeBytes: number;
  }): Promise<ActionResult<UploadTarget>>;
  // shop
  upsertProduct(i: UpsertProductInput): Promise<ActionResult<{ id: Uuid; slug: string }>>;
  setStock(i: {
    variantId: Uuid;
    stock: number;
  }): Promise<ActionResult<{ variantId: Uuid; stock: number }>>;
  setProductPublished(i: { productId: Uuid; isPublished: boolean }): Promise<ActionResult<null>>;
  deleteProduct(i: { productId: Uuid }): Promise<ActionResult<null>>;
  // orders
  listOrders(f: OrderFilter): Promise<ActionResult<{ rows: AdminOrderRow[]; total: number }>>;
  updateOrderStatus(i: {
    orderId: Uuid;
    status: ForwardStatus;
  }): Promise<ActionResult<AdminOrderRow>>;
  cancelOrder(i: {
    orderId: Uuid;
    reason: CancelReason;
    restock: boolean;
    blockContact?: boolean;
  }): Promise<ActionResult<AdminOrderRow>>;
  /** Realtime on `orders` (staff session). Returns an unsubscribe function, or null when only polling is available. */
  subscribeOrders(onEvent: () => void): (() => void) | null;
  // blocklist
  listBlockedContacts(i: {
    page?: number;
    pageSize?: number;
  }): Promise<ActionResult<{ rows: BlockedContact[]; total: number }>>;
  blockContact(i: {
    kind: "phone" | "ip_hash";
    value: string;
    reason?: string;
  }): Promise<ActionResult<BlockedContact>>;
  unblockContact(i: { id: Uuid }): Promise<ActionResult<null>>;
  // settings
  updateSettings(
    // 2.0.0: `tableOrdering` is refused here (unknown key); use setTableOrdering
    i: Partial<Omit<PublicSettings, "vatPct" | "features" | "tableOrdering">> & Partial<OrderRules>,
  ): Promise<ActionResult<AdminSettings>>;
  setAnnouncement(i: { text: string | null }): Promise<ActionResult<null>>;
  // contract 1.3.0 additions
  /** Owner kill switch: stop / restart online shop orders (SEC-003). */
  setOrdersPaused(i: { paused: boolean }): Promise<ActionResult<{ paused: boolean }>>;
  /** Any signed-in staff member changes their own password (SEC-004). */
  changePassword(i: {
    currentPassword: string;
    newPassword: string;
    turnstileToken?: string;
  }): Promise<ActionResult<null>>;
  /** Owner: create a staff login with a temporary password (contract 1.1.0 inviteStaff; password min 12). */
  inviteStaff(i: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<ActionResult<{ userId: Uuid }>>;
  /** Owner: who can sign in to admin. */
  listStaff(): Promise<ActionResult<StaffMember[]>>;
  /** Owner: remove a staff member's access (offboarding). */
  deactivateStaff(i: { userId: Uuid }): Promise<ActionResult<null>>;
  // contract 1.5.0: statistics + daily food sales log (src/app/admin/_actions/stats.ts)
  /** Staff + owner. The log for one Kathmandu date, or null when nothing is logged. Staff: today/yesterday only. */
  getDailySales(i: { date: string }): Promise<ActionResult<DailySalesView | null>>;
  /** Staff + owner. Header replaced, lines MERGED (send qty 0 to zero a line). Staff: today/yesterday only. */
  logDailySales(i: LogDailySalesInput): Promise<ActionResult<DailySalesView>>;
  /** Owner only. Every dashboard block for one range (one RPC per key). */
  getStats(i: GetStatsInput): Promise<ActionResult<StatsBundle>>;
}

export type { AdminSettings };

const SESSION_KEY = "nc-mock-session-v1";

function readSession(): AdminSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as AdminSession) : null;
  } catch {
    return null;
  }
}

const denied = (msg = "Only the owner can do this."): ActionResult<never> => ({
  ok: false,
  error: { code: "FORBIDDEN", message: msg },
});
const notFound = (): ActionResult<never> => ({
  ok: false,
  error: { code: "NOT_FOUND", message: "Not found." },
});
const needLogin = (): ActionResult<never> => ({
  ok: false,
  error: { code: "UNAUTHENTICATED", message: "Please sign in again." },
});

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

/** Run a mutation after checking the session and (optionally) the owner role. */
function guarded<T>(
  ownerOnly: boolean,
  fn: (role: Role, db: ReturnType<typeof loadDb>) => ActionResult<T>,
): ActionResult<T> {
  const s = readSession();
  if (!s) return needLogin();
  if (ownerOnly && s.role !== "owner") return denied();
  return mutateDb((db) => fn(s.role, db));
}

export const mockAdminApi: AdminApi = {
  async getSession() {
    return readSession();
  },
  async signIn({ email, password }) {
    if (!email.includes("@") || password.length < 1) {
      // same generic message for any failure, like the real action
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Email or password is not right." },
      };
    }
    const role: Role = email.toLowerCase().includes("staff") ? "staff" : "owner";
    window.sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ role, displayName: email.split("@")[0] ?? "staff" } satisfies AdminSession),
    );
    return { ok: true, data: { role } };
  },
  async signOut() {
    window.sessionStorage.removeItem(SESSION_KEY);
    return { ok: true, data: null };
  },
  async getMenu() {
    return loadDb().menu;
  },
  async getProducts() {
    return loadDb().products;
  },
  async getSettings() {
    return loadDb().settings;
  },
  async getOrder({ orderId }) {
    if (!readSession()) return needLogin();
    const res = mutateDb((db) => {
      sweepAutoCancel(db);
      return mockListOrders(db, { pageSize: 100_000 });
    });
    if (!res.ok) return res;
    const row = res.data.rows.find((r) => r.id === orderId);
    return row ? { ok: true, data: row } : notFound();
  },
  async toggleSoldOut({ itemId, isSoldOut }) {
    return guarded(false, (_r, db) => {
      for (const c of db.menu) {
        const it = c.items.find((i) => i.id === itemId);
        if (it) {
          it.isSoldOut = isSoldOut;
          return { ok: true, data: { itemId, isSoldOut } };
        }
      }
      return notFound();
    });
  },
  async toggleVariantSoldOut({ variantId, isSoldOut }) {
    return guarded(false, (_r, db) => {
      for (const c of db.menu)
        for (const it of c.items) {
          const v = it.variants.find((x) => x.id === variantId);
          if (v) {
            v.isSoldOut = isSoldOut;
            return { ok: true, data: { variantId, isSoldOut } };
          }
        }
      return notFound();
    });
  },
  async upsertMenuItem(input) {
    return guarded(true, (_r, db) => {
      if (input.name.trim().length < 1 || input.name.length > 80) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Please check the form.",
            fieldErrors: { name: ["Name must be 1 to 80 characters"] },
          },
        };
      }
      if (input.price < 0 || input.price > 1_000_000) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Please check the form.",
            fieldErrors: { price: ["Price must be between Rs. 0 and Rs. 10,000"] },
          },
        };
      }
      // Same rules as the DB CHECK menu_items_translations_valid / menu_variants_translations_valid (decision 19)
      const trErr =
        (input.translations !== undefined
          ? translationsProblem(input.translations, "item")
          : null) ??
        input.variants
          .map((v) =>
            v.translations !== undefined ? translationsProblem(v.translations, "variant") : null,
          )
          .find(Boolean) ??
        null;
      if (trErr) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Please check the form.",
            fieldErrors: { translations: [trErr] },
          },
        };
      }
      const cat = db.menu.find((c) => c.id === input.categoryId);
      if (!cat) return notFound();
      // BUG-010: like the live action, an id that no longer exists is NOT_FOUND (it used to re-create a deleted item)
      if (input.id && !db.menu.some((c) => c.items.some((i) => i.id === input.id)))
        return notFound();
      for (const c of db.menu)
        c.items = c.items.filter((i) => i.id !== input.id || c.id === cat.id);
      const existing = cat.items.find((i) => i.id === input.id);
      const id = existing?.id ?? crypto.randomUUID();
      // contract: imagePath omitted = keep, null = remove, a new path = replace (the mock hosts no files, so a new
      // photo has no URL here and shows the "photo to come" placeholder)
      const imagePath =
        input.imagePath === undefined ? (existing?.imagePath ?? null) : input.imagePath;
      const samePhoto = imagePath !== null && imagePath === existing?.imagePath;
      const next: AdminMenuItem = {
        id,
        categoryId: cat.id,
        name: input.name.trim(),
        description: input.description?.trim() ? input.description.trim() : null,
        price: input.price,
        diet: input.diet,
        tags: input.tags,
        isSoldOut: existing?.isSoldOut ?? false,
        imageUrl: samePhoto ? (existing?.imageUrl ?? null) : null,
        imageVariants: samePhoto ? (existing?.imageVariants ?? []) : [],
        variants: input.variants.map((v) => {
          const stored = existing?.variants.find((x) => x.id === v.id);
          return {
            id: v.id ?? crypto.randomUUID(),
            kind: v.kind,
            label: v.label,
            priceDelta: v.priceDelta,
            isSoldOut: stored?.isSoldOut ?? false,
            // omitted = keep the stored translations (a new option starts with none); a value replaces the set
            translations: v.translations ?? stored?.translations ?? {},
          };
        }),
        translations: input.translations ?? existing?.translations ?? {},
        sortOrder: existing?.sortOrder ?? cat.items.length + 1,
        isVisible: input.isVisible,
        imagePath,
      };
      if (existing) cat.items = cat.items.map((i) => (i.id === id ? next : i));
      else cat.items.push(next);
      const { isVisible: _v, imagePath: _p, ...pub } = next;
      void _v;
      void _p;
      return { ok: true, data: pub };
    });
  },
  async setItemPrice({ itemId, price }) {
    return guarded(true, (_r, db) => {
      for (const c of db.menu) {
        const it = c.items.find((i) => i.id === itemId);
        if (it) {
          it.price = price;
          return { ok: true, data: { itemId, price } };
        }
      }
      return notFound();
    });
  },
  async deleteMenuItem({ itemId }) {
    return guarded(true, (_r, db) => {
      for (const c of db.menu) c.items = c.items.filter((i) => i.id !== itemId);
      return { ok: true, data: null };
    });
  },
  async upsertCategory({ id, name, slug, isVisible, translations }) {
    return guarded(true, (_r, db): ActionResult<{ id: Uuid; slug: string }> => {
      const trErr =
        translations !== undefined ? translationsProblem(translations, "category") : null;
      if (trErr) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Please check the form.",
            fieldErrors: { translations: [trErr] },
          },
        };
      }
      const existing = db.menu.find((c) => c.id === id);
      if (existing) {
        existing.name = name;
        existing.isVisible = isVisible;
        if (slug) existing.slug = slug;
        if (translations !== undefined) existing.translations = translations;
        return { ok: true, data: { id: existing.id, slug: existing.slug } };
      }
      const newCat: AdminMenuCategory = {
        id: crypto.randomUUID(),
        slug: slug ?? slugify(name),
        name,
        sortOrder: db.menu.length + 1,
        isVisible,
        translations: translations ?? {},
        items: [],
      };
      db.menu.push(newCat);
      return { ok: true, data: { id: newCat.id, slug: newCat.slug } };
    });
  },
  async createUploadUrl({ folder, groupId, widthPx }) {
    const s = readSession();
    if (!s) return needLogin();
    if (s.role !== "owner") return denied();
    const gid = groupId ?? crypto.randomUUID();
    return {
      ok: true,
      data: {
        groupId: gid,
        path: `${folder}/${gid}/${widthPx}.webp`,
        uploadUrl: "mock://upload",
        token: "mock",
      },
    };
  },
  async upsertProduct(input) {
    return guarded(true, (_r, db): ActionResult<{ id: Uuid; slug: string }> => {
      if (input.name.trim().length < 1) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Please check the form.",
            fieldErrors: { name: ["Enter a name"] },
          },
        };
      }
      const existing = db.products.find((p) => p.id === input.id);
      if (input.id && !existing) return notFound(); // like the live action: an id that no longer exists is not re-created
      const slug = input.slug ? slugify(input.slug) : (existing?.slug ?? slugify(input.name));
      if (db.products.some((p) => p.slug === slug && p.id !== existing?.id)) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "That web address is already used by another product.",
          },
        };
      }
      const variants = input.variants.map((v) => {
        const stock = Math.max(0, Math.min(9999, Math.trunc(v.stock)));
        const price = v.priceOverride ?? input.price;
        return {
          id: v.id ?? crypto.randomUUID(),
          size: v.size,
          colour: v.colour,
          stock,
          stockState: stockStateFor(stock),
          price,
          sku: v.sku ?? null,
        };
      });
      if (input.images && input.images.length > 10) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Please check the form.",
            fieldErrors: { images: ["Up to 10 photos"] },
          },
        };
      }
      // Contract 1.3.1: omitted `images` = stored images untouched. An explicit array (also []) is the FULL set, in
      // order: anything stored and not listed is removed (the real server also deletes its files). The mock hosts no
      // files, so a newly uploaded path has no URL and shows the placeholder.
      const stored = new Map((existing?.images ?? []).map((im) => [im.path, im]));
      const images: AdminProduct["images"] =
        input.images === undefined
          ? (existing?.images ?? [])
          : input.images.map((im) => {
              const prev = stored.get(im.path);
              return prev
                ? { ...prev, alt: im.alt }
                : { path: im.path, alt: im.alt, url: "", variants: [] };
            });
      const product: AdminProduct = {
        id: existing?.id ?? crypto.randomUUID(),
        slug,
        name: input.name.trim(),
        description: input.description?.trim() ? input.description.trim() : null,
        price: input.price,
        images,
        details: applyDetailsPatch(existing?.details, input.details), // 1.3.1: merged; null removes a key
        isPublished: input.isPublished,
        variants,
      };
      if (existing) db.products = db.products.map((p) => (p.id === existing.id ? product : p));
      else db.products.push(product);
      return { ok: true, data: { id: product.id, slug } };
    });
  },
  async setStock({ variantId, stock }) {
    return guarded(true, (_r, db) => {
      for (const p of db.products) {
        const v = p.variants.find((x) => x.id === variantId);
        if (v) {
          v.stock = stock;
          v.stockState = stockStateFor(stock);
          return { ok: true, data: { variantId, stock } };
        }
      }
      return notFound();
    });
  },
  async setProductPublished({ productId, isPublished }) {
    return guarded(true, (_r, db) => {
      const p = db.products.find((x) => x.id === productId);
      if (!p) return notFound();
      p.isPublished = isPublished;
      return { ok: true, data: null };
    });
  },
  async deleteProduct({ productId }) {
    return guarded(true, (_r, db) => {
      const hasOrders = db.orders.some((o) =>
        o.lines.some((l) =>
          db.products.find((p) => p.id === productId)?.variants.some((v) => v.id === l.variantId),
        ),
      );
      if (hasOrders)
        return {
          ok: false,
          error: { code: "CONFLICT", message: "This product has orders. Unpublish it instead." },
        };
      db.products = db.products.filter((p) => p.id !== productId);
      return { ok: true, data: null };
    });
  },
  async listOrders(f) {
    if (!readSession()) return needLogin();
    return mutateDb((db) => {
      sweepAutoCancel(db);
      return mockListOrders(db, f);
    });
  },
  async updateOrderStatus({ orderId, status }) {
    return guarded(false, (_r, db) => mockUpdateStatus(db, orderId, status));
  },
  async cancelOrder(input) {
    return guarded(false, (role, db) => mockCancelOrder(db, input, role));
  },
  subscribeOrders(onEvent) {
    return onDbChange(onEvent);
  },
  async listBlockedContacts({ page = 1, pageSize = 50 }) {
    if (!readSession()) return needLogin();
    const all = loadDb().blocked;
    return {
      ok: true,
      data: { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length },
    };
  },
  async blockContact(input) {
    return guarded(false, (_r, db) => mockBlock(db, input));
  },
  async unblockContact({ id }) {
    return guarded(true, (_r, db) => {
      db.blocked = db.blocked.filter((b) => b.id !== id);
      return { ok: true, data: null };
    });
  },
  async updateSettings(input) {
    return guarded(true, (_r, db): ActionResult<AdminSettings> => {
      const methods = input.paymentMethods;
      if (methods && (methods.length === 0 || methods.some((m) => m !== "cod" && m !== "pickup"))) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Please check the form.",
            fieldErrors: { paymentMethods: ["Choose cash on delivery and/or pay at pickup"] },
          },
        };
      }
      const nextMethods = methods ?? db.settings.paymentMethods;
      const nextAreas = input.deliveryAreas ?? db.settings.deliveryAreas;
      if (nextMethods.includes("cod") && nextAreas.length === 0) {
        // BUG-006: same rule as the settings form, so a direct call cannot silently hide delivery either
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Please check the form.",
            fieldErrors: {
              deliveryAreas: ["Add at least one delivery area, or turn delivery off"],
            },
          },
        };
      }
      db.settings = { ...db.settings, ...input };
      return { ok: true, data: db.settings };
    });
  },
  async setAnnouncement({ text }) {
    return guarded(false, (_r, db) => {
      db.settings.announcement = text && text.trim() ? text.trim() : null;
      return { ok: true, data: null };
    });
  },
  async setOrdersPaused({ paused }) {
    return guarded(true, (_r, db) => {
      db.settings.ordersPaused = paused;
      return { ok: true, data: { paused } };
    });
  },
  async changePassword({ currentPassword, newPassword }) {
    const s = readSession();
    if (!s) return needLogin();
    if (!currentPassword) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Please check the form.",
          fieldErrors: { currentPassword: ["Enter your current password"] },
        },
      };
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Please check the form.",
          fieldErrors: { newPassword: [`Use at least ${PASSWORD_MIN_LENGTH} characters`] },
        },
      };
    }
    // BUG-012: like the server, 72 characters and 72 bytes at most
    if (
      newPassword.length > PASSWORD_MAX_LENGTH ||
      new TextEncoder().encode(newPassword).length > PASSWORD_MAX_LENGTH
    ) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Please check the form.",
          fieldErrors: { newPassword: [`Use at most ${PASSWORD_MAX_LENGTH} characters`] },
        },
      };
    }
    if (newPassword === currentPassword) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Please check the form.",
          fieldErrors: {
            newPassword: ["Choose a password that is different from the current one"],
          },
        },
      };
    }
    return { ok: true, data: null }; // the mock has no real passwords: any non-empty current password is accepted
  },
  async inviteStaff({ email, displayName, password }) {
    return guarded(true, (_r, db) => {
      const fieldErrors: Record<string, string[]> = {};
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        fieldErrors.email = ["Enter an email address"];
      if (displayName.trim().length < 1 || displayName.length > 80)
        fieldErrors.displayName = ["Enter a name (up to 80 characters)"];
      if (password.length < PASSWORD_MIN_LENGTH)
        fieldErrors.password = [`Use at least ${PASSWORD_MIN_LENGTH} characters`];
      else if (
        password.length > PASSWORD_MAX_LENGTH ||
        new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH
      ) {
        fieldErrors.password = [`Use at most ${PASSWORD_MAX_LENGTH} characters`];
      }
      if (Object.keys(fieldErrors).length > 0)
        return {
          ok: false,
          error: { code: "VALIDATION", message: "Please check the form.", fieldErrors },
        };
      if (db.staff.some((m) => m.email?.toLowerCase() === email.trim().toLowerCase())) {
        return {
          ok: false,
          error: { code: "CONFLICT", message: "That email already has an account." },
        };
      }
      const userId = crypto.randomUUID();
      db.staff.push({
        userId,
        displayName: displayName.trim(),
        email: email.trim(),
        role: "staff",
        createdAt: new Date().toISOString(),
        lastSignInAt: null,
        isSelf: false,
        isActive: true,
      });
      return { ok: true, data: { userId } };
    });
  },
  async listStaff() {
    const s = readSession();
    if (!s) return needLogin();
    if (s.role !== "owner") return denied();
    return { ok: true, data: loadDb().staff };
  },
  async deactivateStaff({ userId }) {
    return guarded(true, (_r, db) => {
      const m = db.staff.find((x) => x.userId === userId);
      if (!m) return notFound();
      if (m.isSelf)
        return {
          ok: false,
          error: { code: "CONFLICT", message: "You cannot deactivate your own account." },
        };
      if (m.role === "owner")
        return {
          ok: false,
          error: { code: "CONFLICT", message: "Owner accounts cannot be deactivated here." },
        };
      db.staff = db.staff.filter((x) => x.userId !== userId); // contract 1.3.0: the account is deleted, not flagged
      return { ok: true, data: null };
    });
  },
  getDailySales: (i) => mockGetDailySales(readSession(), i),
  logDailySales: (i) => mockLogDailySales(readSession(), i),
  getStats: (i) => mockGetStats(readSession(), i),
  // contract 2.0.0 table ordering (./tables-admin.ts)
  ...createMockTablesAdminApi(readSession),
};

/**
 * Wraps every call: when a server action answers UNAUTHENTICATED the session has ended, so go to the login page
 * (the middleware does the same for page loads). signIn / getSession are exempt: they report it themselves.
 */
function withAuthRedirect(api: AdminApi): AdminApi {
  const out = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(api) as [string, (...a: unknown[]) => unknown][]) {
    if (name === "signIn" || name === "getSession" || name === "subscribeOrders") {
      out[name] = fn;
      continue;
    }
    out[name] = async (...args: unknown[]) => {
      const res = await fn(...args);
      if (res && typeof res === "object" && "ok" in res && (res as { ok: boolean }).ok === false) {
        const code = (res as { error?: { code?: string } }).error?.code;
        if (
          code === "UNAUTHENTICATED" &&
          typeof window !== "undefined" &&
          window.location.pathname !== "/admin/login"
        ) {
          window.location.assign("/admin/login");
        }
      }
      return res;
    };
  }
  return out as unknown as AdminApi;
}

/** The one object admin pages use: the real server actions, or mock data when NEXT_PUBLIC_DATA_MODE=mock. */
export const adminApi: AdminApi = withAuthRedirect(isMock ? mockAdminApi : liveAdminApi);
export const adminIsMock = isMock;
/** "Reset sample data": the mock db and any food logs saved in this browser. */
export function resetMockDb(): void {
  resetDb();
  resetMockSales();
}

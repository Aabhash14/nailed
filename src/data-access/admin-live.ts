"use client";

import { changePassword, inviteStaff, signIn, signOut, getSession } from "@/app/admin/_actions/auth";
import { blockContact, listBlockedContacts, unblockContact } from "@/app/admin/_actions/blocklist";
import { createUploadUrl } from "@/app/admin/_actions/images";
import {
  deleteMenuItem,
  getAdminMenu,
  setItemPrice,
  toggleSoldOut,
  toggleVariantSoldOut,
  upsertCategory,
  upsertMenuItem,
} from "@/app/admin/_actions/menu";
import { cancelOrder, getOrder, listOrders, updateOrderStatus } from "@/app/admin/_actions/orders";
import { deleteProduct, getAdminProducts, setProductPublished, setStock, upsertProduct } from "@/app/admin/_actions/products";
import { getSettings, setAnnouncement, setOrdersPaused, updateSettings } from "@/app/admin/_actions/settings";
import { deactivateStaff, listStaff } from "@/app/admin/_actions/staff";
import { getDailySales, getStats, logDailySales } from "@/app/admin/_actions/stats";
import type { ActionResult, StaffMember } from "@/types/contract";
import type { AdminApi } from "./admin";
import { liveTablesAdminApi } from "./tables-admin";

/**
 * The real admin API: backend-engineer's server actions (src/app/admin/_actions) behind the same AdminApi interface
 * the pages use. Every action takes `unknown` and validates with Zod on the server, so the casts below only
 * bridge our hand-written contract types to the actions' inferred return types (they follow the same contract).
 */
function unwrap<T>(res: ActionResult<T>, what: string): T {
  if (!res.ok) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

const c = <T>(p: Promise<unknown>) => p as Promise<ActionResult<T>>;

export const liveAdminApi: AdminApi = {
  async getSession() {
    const res = await getSession();
    return res.ok ? res.data : null; // UNAUTHENTICATED (or any failure) = signed out
  },
  signIn: (i) => c(signIn(i)),
  signOut: () => c(signOut()),
  async getMenu() {
    return unwrap(await getAdminMenu(), "menu") as unknown as Awaited<ReturnType<AdminApi["getMenu"]>>;
  },
  async getProducts() {
    const res = await getAdminProducts();
    if (!res.ok && res.error.code === "FORBIDDEN") return []; // stock is owner data; staff see an explanation instead
    return unwrap(res, "products") as unknown as Awaited<ReturnType<AdminApi["getProducts"]>>;
  },
  async getSettings() {
    return unwrap(await getSettings(), "settings") as unknown as Awaited<ReturnType<AdminApi["getSettings"]>>;
  },
  toggleSoldOut: (i) => c(toggleSoldOut(i)),
  toggleVariantSoldOut: (i) => c(toggleVariantSoldOut(i)),
  upsertMenuItem: (i) => c(upsertMenuItem(i)),
  setItemPrice: (i) => c(setItemPrice(i)),
  deleteMenuItem: (i) => c(deleteMenuItem(i)),
  upsertCategory: (i) => c(upsertCategory(i)),
  createUploadUrl: (i) => c(createUploadUrl(i)),
  upsertProduct: (i) => c(upsertProduct(i)),
  setStock: (i) => c(setStock(i)),
  setProductPublished: (i) => c(setProductPublished(i)),
  deleteProduct: (i) => c(deleteProduct(i)),
  listOrders: (f) => c(listOrders(f)),
  updateOrderStatus: (i) => c(updateOrderStatus(i)),
  cancelOrder: (i) => c(cancelOrder(i)),
  // Realtime on `orders` needs a staff-session browser client, which does not exist yet: the board polls every 30 s.
  subscribeOrders: () => null,
  listBlockedContacts: (i) => c(listBlockedContacts(i)),
  blockContact: (i) => c(blockContact(i)),
  unblockContact: (i) => c(unblockContact(i)),
  updateSettings: (i) => c(updateSettings(i)),
  setAnnouncement: (i) => c(setAnnouncement(i)),
  getOrder: (i) => c(getOrder(i)),
  inviteStaff: (i) => c(inviteStaff(i)),
  setOrdersPaused: (i) => c(setOrdersPaused(i)),
  changePassword: (i) => c(changePassword(i)),
  async listStaff() {
    // contract 1.3.0: ActionResult<{ rows: StaffMember[] }>
    const res = await c<{ rows: StaffMember[] }>(listStaff());
    return res.ok ? { ok: true, data: res.data.rows } : res;
  },
  deactivateStaff: (i) => c(deactivateStaff(i)),
  // contract 1.5.0 statistics
  getDailySales: (i) => c(getDailySales(i)),
  logDailySales: (i) => c(logDailySales(i)),
  getStats: (i) => c(getStats(i)),
  // contract 2.0.0 table ordering: see ./tables-admin.ts (live wiring waits for src/app/admin/_actions/tables.ts)
  ...liveTablesAdminApi,
};

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { AuthContext } from "@/lib/auth/roles";
import { getCurrentUser, requireRole } from "@/lib/auth/require-role";
import { fakeDb, ok, pgErr } from "./helpers/fake-db";

// ---- module mocks: no real Supabase, no Next runtime -------------------------------------------------------
const state = vi.hoisted(() => ({
  user: null as null | { userId: string; role: "owner" | "staff"; displayName: string },
  db: null as unknown,
  scheduled: [] as (() => Promise<unknown>)[],
}));

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/deps", () => ({
  scheduleAfter: (w: () => Promise<unknown>) => void state.scheduled.push(w),
  ipSalt: () => "s".repeat(32),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => undefined }) }));
vi.mock("@/lib/data/server-admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/auth/require-role", async () => {
  const { AppError } = await import("@/lib/errors");
  const { roleAllows } = await import("@/lib/auth/roles");
  return {
    getCurrentUser: async () => state.user,
    requireRole: async (need: "owner" | "staff") => {
      if (!state.user) throw new AppError("UNAUTHENTICATED");
      if (!roleAllows(state.user.role, need)) throw new AppError("FORBIDDEN");
      return state.user;
    },
  };
});

import { revalidateTag } from "next/cache";
import { blockContact, listBlockedContacts, unblockContact } from "@/app/admin/_actions/blocklist";
import { createUploadUrl } from "@/app/admin/_actions/images";
import { deleteMenuItem, setItemPrice, toggleSoldOut, upsertMenuItem } from "@/app/admin/_actions/menu";
import { cancelOrder, getOrder, listOrders, updateOrderStatus } from "@/app/admin/_actions/orders";
import { deleteProduct, getAdminProducts, setStock } from "@/app/admin/_actions/products";
import { getSettings, setAnnouncement, setOrdersPaused, updateSettings } from "@/app/admin/_actions/settings";
import { deactivateStaff, listStaff } from "@/app/admin/_actions/staff";

const ID = "3f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3b";
const ID2 = "4f2b8c1e-9d4a-4b6e-8a2f-1c5d7e9f0a3c";
const OWNER = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "owner", displayName: "Owner" } as const;
const STAFF = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "staff", displayName: "Staff" } as const;

const orderRow = {
  id: ID, number: "NC-1", public_token: ID2, status: "confirmed", fulfilment: "pickup", payment_method: "pickup", payment_status: "unpaid",
  subtotal_paisa: 100, delivery_fee_paisa: 0, vat_paisa: 0, total_paisa: 100, customer_name: "A B", customer_phone: "+9779841234567",
  customer_email: null, address: null, landmark: null, area: null, notes: null, cancel_reason: null, confirmed_at: null,
  completed_at: null, cancelled_at: null, created_at: new Date().toISOString(), order_items: [],
};

function use(user: AuthContext | null, f: ReturnType<typeof fakeDb>) {
  state.user = user;
  state.db = f.db;
  return f;
}

beforeEach(() => {
  vi.mocked(revalidateTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  state.user = null;
  state.db = fakeDb({}).db;
  state.scheduled = [];
});

describe("every admin action checks the session and role on the server", () => {
  const ownerOnly: [string, (i: unknown) => Promise<unknown>, unknown][] = [
    ["upsertMenuItem", upsertMenuItem, {}],
    ["setItemPrice", setItemPrice, { itemId: ID, price: 100 }],
    ["deleteMenuItem", deleteMenuItem, { itemId: ID }],
    ["createUploadUrl", createUploadUrl, {}],
    ["setStock", setStock, { variantId: ID, stock: 1 }],
    ["deleteProduct", deleteProduct, { productId: ID }],
    ["unblockContact", unblockContact, { id: ID }],
    ["updateSettings", updateSettings, { cafeName: "X" }],
    ["setOrdersPaused", setOrdersPaused, { paused: true }],
    ["listStaff", () => listStaff(), undefined],
    ["deactivateStaff", deactivateStaff, { userId: ID }],
  ];
  const staffOk: [string, (i: unknown) => Promise<unknown>, unknown][] = [
    ["toggleSoldOut", toggleSoldOut, { itemId: ID, isSoldOut: true }],
    ["listOrders", listOrders, {}],
    ["updateOrderStatus", updateOrderStatus, { orderId: ID, status: "confirmed" }],
    ["cancelOrder", cancelOrder, { orderId: ID, reason: "no_show", restock: true }],
    ["listBlockedContacts", listBlockedContacts, {}],
    ["blockContact", blockContact, { kind: "phone", value: "9841234567" }],
    ["setAnnouncement", setAnnouncement, { text: "Hi" }],
    ["getOrder", getOrder, { orderId: ID }],
  ];

  it.each([...ownerOnly, ...staffOk])("%s: no session -> UNAUTHENTICATED and the database is never touched", async (_n, action, input) => {
    const f = use(null, fakeDb({}));
    const r = (await action(input)) as { ok: boolean; error?: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("UNAUTHENTICATED");
    expect(f.rpcCalls).toHaveLength(0);
    expect(f.tableCalls).toHaveLength(0);
  });

  it.each(ownerOnly)("%s: staff role -> FORBIDDEN and the database is never touched", async (_n, action, input) => {
    const f = use(STAFF, fakeDb({}));
    const r = (await action(input)) as { ok: boolean; error?: { code: string } };
    expect(r.error?.code).toBe("FORBIDDEN");
    expect(f.tableCalls).toHaveLength(0);
    expect(f.rpcCalls).toHaveLength(0);
  });

  it("role is checked BEFORE validation (bad input from staff is FORBIDDEN, not VALIDATION)", async () => {
    use(STAFF, fakeDb({}));
    expect(((await setItemPrice({ itemId: "bad" })) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
});

describe("menu actions", () => {
  it("toggleSoldOut works for staff, updates the row and revalidates the menu tag", async () => {
    const f = use(STAFF, fakeDb({ tables: { menu_items: ok([{ id: ID }]) } }));
    const r = await toggleSoldOut({ itemId: ID, isSoldOut: true });
    expect(r).toEqual({ ok: true, data: { itemId: ID, isSoldOut: true } });
    expect(f.tableCalls[0]?.calls.find((c) => c.op === "update")?.args[0]).toEqual({ is_sold_out: true });
    expect(revalidateTag).toHaveBeenCalledWith("menu");
  });
  it("toggleSoldOut on a missing item -> NOT_FOUND and no revalidate", async () => {
    use(OWNER, fakeDb({ tables: { menu_items: ok([]) } }));
    expect(((await toggleSoldOut({ itemId: ID, isSoldOut: true })) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    expect(revalidateTag).not.toHaveBeenCalled();
  });
  it("setItemPrice validates the price range (max Rs. 10,000) and rejects floats", async () => {
    use(OWNER, fakeDb({ tables: { menu_items: ok([{ id: ID }]) } }));
    expect(((await setItemPrice({ itemId: ID, price: 1_000_001 })) as { error: { code: string } }).error.code).toBe("VALIDATION");
    expect(((await setItemPrice({ itemId: ID, price: 10.5 })) as { error: { code: string } }).error.code).toBe("VALIDATION");
    expect((await setItemPrice({ itemId: ID, price: 45000 })).ok).toBe(true);
  });
  it("deleteMenuItem is a soft delete", async () => {
    const f = use(OWNER, fakeDb({ tables: { menu_items: ok([{ id: ID }]) } }));
    await deleteMenuItem({ itemId: ID });
    const upd = f.tableCalls[0]?.calls.find((c) => c.op === "update")?.args[0] as Record<string, unknown>;
    expect(upd.is_visible).toBe(false);
    expect(typeof upd.deleted_at).toBe("string");
    expect(f.tableCalls[0]?.calls.some((c) => c.op === "delete")).toBe(false);
  });
  it("upsertMenuItem rejects an image path outside the menu folder, more than 12 variants and long text", async () => {
    use(OWNER, fakeDb({}));
    const base = { categoryId: ID, name: "Latte", price: 100, diet: "veg", tags: [], isVisible: true, variants: [] };
    const code = async (extra: object) => ((await upsertMenuItem({ ...base, ...extra })) as { error: { code: string } }).error.code;
    expect(await code({ imagePath: `products/${ID}` })).toBe("VALIDATION");
    expect(await code({ imagePath: "../../etc/passwd" })).toBe("VALIDATION");
    expect(await code({ variants: Array.from({ length: 13 }, () => ({ kind: "size", label: "L", priceDelta: 0 })) })).toBe("VALIDATION");
    expect(await code({ description: "x".repeat(241) })).toBe("VALIDATION");
  });
});

describe("order actions", () => {
  it("updateOrderStatus passes the VERIFIED session user as actor, never a client value", async () => {
    const f = use(STAFF, fakeDb({ rpc: { set_order_status: () => ok(orderRow) }, tables: { orders: ok(orderRow), blocked_contacts: ok([]) } }));
    const r = await updateOrderStatus({ orderId: ID, status: "ready_for_pickup", actor: "evil", p_actor: "evil" });
    expect(r.ok).toBe(true);
    expect(f.rpcCalls[0]).toEqual({ name: "set_order_status", args: { p_order_id: ID, p_status: "ready_for_pickup", p_actor: STAFF.userId } });
  });
  it("updateOrderStatus cannot ask for placed or cancelled (cancel needs a reason)", async () => {
    const f = use(STAFF, fakeDb({}));
    for (const status of ["placed", "cancelled"]) {
      expect(((await updateOrderStatus({ orderId: ID, status })) as { error: { code: string } }).error.code).toBe("VALIDATION");
    }
    expect(f.rpcCalls).toHaveLength(0);
  });
  it("illegal transition from the DB -> CONFLICT", async () => {
    use(STAFF, fakeDb({ rpc: { set_order_status: () => pgErr("P0001", "CONFLICT", "", "illegal status transition") } }));
    const r = (await updateOrderStatus({ orderId: ID, status: "completed" })) as { error: { code: string } };
    expect(r.error.code).toBe("CONFLICT");
  });
  it("cancelOrder requires a reason", async () => {
    const f = use(STAFF, fakeDb({}));
    const r = (await cancelOrder({ orderId: ID, restock: true })) as { error: { code: string; fieldErrors: Record<string, string[]> } };
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.fieldErrors).toHaveProperty("reason");
    expect(((await cancelOrder({ orderId: ID, restock: true, reason: "because" })) as { error: { code: string } }).error.code).toBe("VALIDATION");
    expect(f.rpcCalls).toHaveLength(0);
  });
  it("cancelOrder sends reason, restock and blockContact to the DB function in one call", async () => {
    const f = use(STAFF, fakeDb({ rpc: { cancel_order: () => ok(orderRow) }, tables: { orders: ok({ ...orderRow, status: "cancelled" }), blocked_contacts: ok([{ value: "+9779841234567" }]) } }));
    const r = (await cancelOrder({ orderId: ID, reason: "fake", restock: true, blockContact: true })) as { ok: true; data: { phoneIsBlocked: boolean } };
    expect(f.rpcCalls[0]?.args).toEqual({ p_order_id: ID, p_actor: STAFF.userId, p_reason: "fake", p_restock: true, p_block_contact: true });
    expect(r.data.phoneIsBlocked).toBe(true);
  });
  it("staff cancelling an out_for_delivery order -> FORBIDDEN from the database (owner only)", async () => {
    use(STAFF, fakeDb({ rpc: { cancel_order: () => pgErr("P0001", "FORBIDDEN") } }));
    const r = (await cancelOrder({ orderId: ID, reason: "refused", restock: false })) as { error: { code: string } };
    expect(r.error.code).toBe("FORBIDDEN");
  });
  it("listOrders: page size capped at 100, filters use builder calls, search text cannot inject filter syntax", async () => {
    const f = use(STAFF, fakeDb({ tables: { orders: { data: [orderRow], error: null }, blocked_contacts: ok([]) } }));
    expect(((await listOrders({ pageSize: 101 })) as { error: { code: string } }).error.code).toBe("VALIDATION");
    expect(((await listOrders({ q: "x),status.neq.(" })) as { error: { code: string } }).error.code).toBe("VALIDATION");
    const r = (await listOrders({ status: ["placed"], q: "NC-1042", page: 2, pageSize: 10 })) as { ok: boolean };
    expect(r.ok).toBe(true);
    const calls = f.tableCalls.find((c) => c.table === "orders")!.calls;
    expect(calls.find((c) => c.op === "range")?.args).toEqual([10, 19]);
    expect(calls.some((c) => c.op === "or")).toBe(false);
  });
});

describe("blocklist actions", () => {
  it("staff can add a phone (normalised) with an expiry, but cannot remove", async () => {
    const row = { id: ID, kind: "phone", value: "+9779841234567", reason: "fake orders", created_by: STAFF.userId, created_at: "2026-10-19T00:00:00Z", expires_at: "2027-10-19T00:00:00Z" };
    const f = use(STAFF, fakeDb({ rpc: { block_contact: () => ok([{ out_id: ID, out_created: true, out_expires_at: row.expires_at }]) }, tables: { blocked_contacts: ok(row) } }));
    const r = (await blockContact({ kind: "phone", value: "98 41234567", reason: "fake orders", createdBy: "evil" })) as { ok: true; data: Record<string, unknown> };
    expect(r.data).toMatchObject({ kind: "phone", value: "+9779841234567", createdBy: STAFF.userId });
    // insert-or-nothing RPC (SEC-008); the actor is the verified session user, never input
    expect(f.rpcCalls[0]).toEqual({ name: "block_contact", args: { p_kind: "phone", p_value: "+9779841234567", p_reason: "fake orders", p_actor: STAFF.userId } });
    expect(f.tableCalls.some((t) => t.calls.some((c) => c.op === "upsert" || c.op === "update"))).toBe(false);
    expect(((await unblockContact({ id: ID })) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
  it("an ip_hash that is not on any order is refused (it cannot be typed in)", async () => {
    use(STAFF, fakeDb({ tables: { orders: ok([]) } }));
    const r = (await blockContact({ kind: "ip_hash", value: "a".repeat(64) })) as { error: { code: string } };
    expect(r.error.code).toBe("VALIDATION");
    const r2 = (await blockContact({ kind: "ip_hash", value: "203.0.113.9" })) as { error: { code: string } };
    expect(r2.error.code).toBe("VALIDATION");
  });
  it("owner can unblock; unknown id -> NOT_FOUND", async () => {
    use(OWNER, fakeDb({ tables: { blocked_contacts: ok([{ id: ID }]) } }));
    expect((await unblockContact({ id: ID })).ok).toBe(true);
    use(OWNER, fakeDb({ tables: { blocked_contacts: ok([]) } }));
    expect(((await unblockContact({ id: ID })) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
  it("a bad phone is VALIDATION", async () => {
    use(STAFF, fakeDb({}));
    expect(((await blockContact({ kind: "phone", value: "12345" })) as { error: { code: string } }).error.code).toBe("VALIDATION");
  });
});

describe("images, products, settings", () => {
  it("createUploadUrl enforces WebP, per-width size caps and a random path", async () => {
    const signed = vi.fn(async (path: string) => ({ data: { signedUrl: `https://x/upload/${path}`, token: "tkn", path }, error: null }));
    state.user = OWNER;
    state.db = { storage: { from: () => ({ createSignedUploadUrl: signed }) } };
    const bad = async (extra: object) =>
      ((await createUploadUrl({ folder: "menu", widthPx: 480, contentType: "image/webp", sizeBytes: 1000, ...extra })) as { error: { code: string; fieldErrors?: Record<string, string[]> } }).error;
    expect((await bad({ contentType: "image/png" })).code).toBe("VALIDATION");
    expect((await bad({ widthPx: 700 })).code).toBe("VALIDATION");
    expect((await bad({ folder: "../x" })).code).toBe("VALIDATION");
    expect((await bad({ sizeBytes: 41 * 1024 })).fieldErrors).toHaveProperty("sizeBytes");
    expect((await bad({ widthPx: 960, sizeBytes: 121 * 1024 })).fieldErrors).toHaveProperty("sizeBytes");
    expect((await bad({ widthPx: 1600, sizeBytes: 301 * 1024 })).fieldErrors).toHaveProperty("sizeBytes");
    expect(signed).not.toHaveBeenCalled();

    const first = (await createUploadUrl({ folder: "menu", widthPx: 480, contentType: "image/webp", sizeBytes: 40 * 1024 })) as { ok: true; data: { groupId: string; path: string } };
    expect(first.data.path).toBe(`menu/${first.data.groupId}/480.webp`);
    const second = (await createUploadUrl({ folder: "menu", groupId: first.data.groupId, widthPx: 960, contentType: "image/webp", sizeBytes: 120 * 1024 })) as { ok: true; data: { groupId: string; path: string } };
    expect(second.data.groupId).toBe(first.data.groupId);
    expect(second.data.path).toBe(`menu/${first.data.groupId}/960.webp`);
  });
  it("setStock range 0..9999", async () => {
    use(OWNER, fakeDb({ tables: { product_variants: ok([{ id: ID }]) } }));
    expect(((await setStock({ variantId: ID, stock: 10000 })) as { error: { code: string } }).error.code).toBe("VALIDATION");
    expect(((await setStock({ variantId: ID, stock: -1 })) as { error: { code: string } }).error.code).toBe("VALIDATION");
    expect(await setStock({ variantId: ID, stock: 0 })).toEqual({ ok: true, data: { variantId: ID, stock: 0 } });
    expect(revalidateTag).toHaveBeenCalledWith("shop");
  });
  it("deleteProduct with orders -> CONFLICT (unpublish instead)", async () => {
    use(OWNER, fakeDb({ tables: { product_variants: ok([{ id: ID }]), order_items: ok([{ id: ID2 }]) } }));
    const r = (await deleteProduct({ productId: ID })) as { error: { code: string } };
    expect(r.error.code).toBe("CONFLICT");
  });
  it("updateSettings: only cod/pickup payment methods, rejects unknown keys, bounds order rules", async () => {
    use(OWNER, fakeDb({}));
    const code = async (i: object) => ((await updateSettings(i)) as { error: { code: string } }).error.code;
    expect(await code({ paymentMethods: ["esewa"] })).toBe("VALIDATION");
    expect(await code({ paymentMethods: ["cod", "khalti"] })).toBe("VALIDATION");
    expect(await code({ maxOpenOrdersPerPhone: 6 })).toBe("VALIDATION");
    expect(await code({ vatPct: 15 })).toBe("VALIDATION");
    expect(await code({ features: { lodge: true } })).toBe("VALIDATION");
    expect(await code({})).toBe("VALIDATION");
  });
  it("updateSettings writes site and order-rule columns and revalidates settings", async () => {
    const site = { cafe_name: "Nailed", hours: { weekly: {}, closures: [] }, announcement: null, phone: "01", whatsapp: null, email: null, address: null, landmark: null, map_url: null, prices_include_vat: true, service_charge_pct: 0, delivery_fee_paisa: 5000, delivery_areas: [], payment_methods_enabled: ["cod", "pickup"], min_order_delivery_paisa: 50000, min_order_pickup_paisa: 0, features: { lodge: false } };
    const rules = { cod_max_total_paisa: 500000, max_open_orders_per_phone: 3 };
    const f = use(OWNER, fakeDb({ tables: { site_settings: ok(site), order_rules: ok(rules) } }));
    const r = (await updateSettings({ minOrderDelivery: 50000, codMaxTotal: 500000, maxOpenOrdersPerPhone: 3 })) as { ok: true; data: Record<string, unknown> };
    expect(r.data).toMatchObject({ minOrderDelivery: 50000, codMaxTotal: 500000, maxOpenOrdersPerPhone: 3, vatPct: 13 });
    const upd = (t: string) => f.tableCalls.filter((c) => c.table === t).flatMap((c) => c.calls).find((c) => c.op === "update")?.args[0];
    expect(upd("site_settings")).toEqual({ min_order_delivery_paisa: 50000 });
    expect(upd("order_rules")).toEqual({ cod_max_total_paisa: 500000, max_open_orders_per_phone: 3 });
    expect(revalidateTag).toHaveBeenCalledWith("settings");
  });
  it("setAnnouncement: staff may set it; empty text clears it", async () => {
    const f = use(STAFF, fakeDb({ tables: { site_settings: ok(null) } }));
    expect(await setAnnouncement({ text: "  " })).toEqual({ ok: true, data: null });
    expect(f.tableCalls[0]?.calls.find((c) => c.op === "update")?.args[0]).toEqual({ announcement: null });
    expect(((await setAnnouncement({ text: "x".repeat(301) })) as { error: { code: string } }).error.code).toBe("VALIDATION");
  });
});

describe("requireRole (real implementation, injected session)", () => {
  // the vi.mock above replaces the module for the actions; load the real one explicitly
  it("reads the role from profiles, not from the caller", async () => {
    const real = await vi.importActual<{ requireRole: typeof requireRole; getCurrentUser: typeof getCurrentUser }>("@/lib/auth/require-role");
    const prof = (role: string | null) => fakeDb({ tables: { profiles: ok(role ? { id: ID, role, display_name: "N" } : null) } }).db;
    await expect(real.requireRole("staff", { getUserId: async () => null, admin: () => prof("owner") })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(real.requireRole("staff", { getUserId: async () => ID, admin: () => prof(null) })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(real.requireRole("owner", { getUserId: async () => ID, admin: () => prof("staff") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(real.requireRole("staff", { getUserId: async () => ID, admin: () => prof("staff") })).resolves.toMatchObject({ role: "staff", userId: ID });
    await expect(real.requireRole("owner", { getUserId: async () => ID, admin: () => prof("owner") })).resolves.toMatchObject({ role: "owner" });
  });
  it("an unexpected error is INTERNAL with a generic message", async () => {
    const f = use(OWNER, fakeDb({ tables: { menu_items: pgErr("XX000", "select * from secret_table failed") } }));
    void f;
    const r = (await toggleSoldOut({ itemId: ID, isSoldOut: true })) as { error: { code: string; message: string; requestId?: string } };
    expect(r.error.code).toBe("INTERNAL");
    expect(r.error.message).not.toMatch(/secret_table|select/);
    expect(r.error.requestId).toBeTruthy();
    expect(new AppError("INTERNAL").message).toBe(r.error.message);
  });
});

describe("fix pass 2026-10-21: settings (SEC-003, SEC-012, BUG-003, BUG-006)", () => {
  const site = { cafe_name: "Nailed", hours: { weekly: {}, closures: [] }, announcement: null, phone: "01", whatsapp: null, email: null, address: null, landmark: null, map_url: null, prices_include_vat: true, service_charge_pct: 0, delivery_fee_paisa: 5000, delivery_areas: [], payment_methods_enabled: ["cod", "pickup"], min_order_delivery_paisa: 0, min_order_pickup_paisa: 0, features: { lodge: false }, orders_paused: false };
  const rules = { cod_max_total_paisa: null, max_open_orders_per_phone: 2 };
  const upd = (f: ReturnType<typeof fakeDb>, t: string) => f.tableCalls.filter((c) => c.table === t).flatMap((c) => c.calls).find((c) => c.op === "update")?.args[0];
  const errOf = async (p: Promise<unknown>) => ((await p) as { error?: { code: string; fieldErrors?: Record<string, string[]> } }).error;

  it("updateSettings({ mapUrl: 'javascript:alert(1)' }) -> VALIDATION, nothing written (SEC-012)", async () => {
    const f = use(OWNER, fakeDb({ tables: { site_settings: ok(site), order_rules: ok(rules) } }));
    expect((await errOf(updateSettings({ mapUrl: "javascript:alert(1)" })))?.code).toBe("VALIDATION");
    expect((await errOf(updateSettings({ phone: "<img src=x>" })))?.code).toBe("VALIDATION");
    expect(upd(f, "site_settings")).toBeUndefined();
  });

  it("codMaxTotal 0 is accepted and written as null = no limit (BUG-003)", async () => {
    const f = use(OWNER, fakeDb({ tables: { site_settings: ok(site), order_rules: ok(rules) } }));
    const r = (await updateSettings({ codMaxTotal: 0 })) as { ok: true; data: { codMaxTotal: number | null } };
    expect(r.ok).toBe(true);
    expect(upd(f, "order_rules")).toEqual({ cod_max_total_paisa: null });
    expect(r.data.codMaxTotal).toBeNull();
  });

  it("turning delivery on while the STORED area list is empty -> VALIDATION on deliveryAreas (BUG-006)", async () => {
    const f = use(OWNER, fakeDb({ tables: { site_settings: ok(site), order_rules: ok(rules) } }));
    const e = await errOf(updateSettings({ paymentMethods: ["cod", "pickup"] }));
    expect(e?.code).toBe("VALIDATION");
    expect(e?.fieldErrors).toHaveProperty("deliveryAreas");
    expect(upd(f, "site_settings")).toBeUndefined();
    // clearing the areas while delivery stays on is refused too
    expect((await errOf(updateSettings({ deliveryAreas: [] })))?.code).toBe("VALIDATION");
    // pickup only with no areas is fine
    use(OWNER, fakeDb({ tables: { site_settings: ok(site), order_rules: ok(rules) } }));
    expect((await updateSettings({ paymentMethods: ["pickup"] })).ok).toBe(true);
  });

  it("reversed opening hours are refused (BUG-006)", async () => {
    use(OWNER, fakeDb({ tables: { site_settings: ok(site), order_rules: ok(rules) } }));
    const hours = { weekly: { "0": null, "1": [{ open: "18:00", close: "09:00" }], "2": null, "3": null, "4": null, "5": null, "6": null }, closures: [] };
    expect((await errOf(updateSettings({ hours })))?.code).toBe("VALIDATION");
  });

  it("getSettings exposes ordersPaused", async () => {
    use(OWNER, fakeDb({ tables: { site_settings: ok({ ...site, orders_paused: true }), order_rules: ok(rules) } }));
    const r = (await getSettings()) as { ok: true; data: { ordersPaused: boolean } };
    expect(r.data.ordersPaused).toBe(true);
  });

  it("setOrdersPaused (owner) writes site_settings.orders_paused, logs the event and revalidates (SEC-003)", async () => {
    const info = vi.mocked(console.info);
    const f = use(OWNER, fakeDb({ tables: { site_settings: ok([{ orders_paused: true }]) } }));
    expect(await setOrdersPaused({ paused: true })).toEqual({ ok: true, data: { paused: true } });
    expect(upd(f, "site_settings")).toEqual({ orders_paused: true });
    expect(revalidateTag).toHaveBeenCalledWith("settings");
    expect(info.mock.calls.some((c) => String(c[0]).includes('"event":"orders_paused"'))).toBe(true);
    expect(((await setOrdersPaused({ paused: "yes" })) as { error: { code: string } }).error.code).toBe("VALIDATION");
  });
});

describe("fix pass 2026-10-21: orders (SEC-017, SEC-013)", () => {
  const confirmed = { ...orderRow, status: "confirmed", customer_email: "sita@example.com", fulfilment: "delivery", total_paisa: 55000 };

  it("updateOrderStatus -> confirmed schedules the customer email (only now, after the call)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://cafe.test");
    vi.stubEnv("RESEND_API_KEY", "re_key");
    vi.stubEnv("RESEND_FROM_EMAIL", "Cafe <orders@example.com>");
    const fetchSpy = vi.fn(async (...a: unknown[]) => (void a, new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);
    use(STAFF, fakeDb({ rpc: { set_order_status: () => ok(confirmed) }, tables: { orders: ok(confirmed), blocked_contacts: ok([]) } }));
    const r = await updateOrderStatus({ orderId: ID, status: "confirmed" });
    expect(r.ok).toBe(true);
    expect(state.scheduled).toHaveLength(1);
    await state.scheduled[0]!();
    const mail = fetchSpy.mock.calls.find((c) => String(c[0]).includes("api.resend.com"));
    const sent = JSON.parse(String((mail![1] as RequestInit).body));
    expect(sent.to).toEqual(["sita@example.com"]);
    expect(sent.subject).toBe("Order NC-1 confirmed");
    expect(sent.text).toContain(`https://cafe.test/order/${ID2}`);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("no email for other transitions or when the order has no email", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://cafe.test");
    use(STAFF, fakeDb({ rpc: { set_order_status: () => ok(orderRow) }, tables: { orders: ok({ ...confirmed, status: "ready_for_pickup" }), blocked_contacts: ok([]) } }));
    await updateOrderStatus({ orderId: ID, status: "ready_for_pickup" });
    use(STAFF, fakeDb({ rpc: { set_order_status: () => ok(orderRow) }, tables: { orders: ok({ ...confirmed, customer_email: null }), blocked_contacts: ok([]) } }));
    await updateOrderStatus({ orderId: ID, status: "confirmed" });
    expect(state.scheduled).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("staff cannot pass the system-only cancel reason 'auto_unconfirmed'", async () => {
    const f = use(STAFF, fakeDb({}));
    expect(((await cancelOrder({ orderId: ID, reason: "auto_unconfirmed", restock: true })) as { error: { code: string } }).error.code).toBe("VALIDATION");
    expect(f.rpcCalls).toHaveLength(0);
  });

  it("getOrder returns one admin row by id (staff)", async () => {
    use(STAFF, fakeDb({ tables: { orders: ok(orderRow), blocked_contacts: ok([]) } }));
    const r = (await getOrder({ orderId: ID })) as { ok: true; data: { id: string; number: string } };
    expect(r.data).toMatchObject({ id: ID, number: "NC-1" });
    expect(((await getOrder({ orderId: "nope" })) as { error: { code: string } }).error.code).toBe("VALIDATION");
  });

  it("a staff user calling an owner action is logged as 'forbidden' with ids only", async () => {
    const real = await vi.importActual<{ requireRole: typeof requireRole }>("@/lib/auth/require-role");
    const warn = vi.mocked(console.warn);
    const prof = fakeDb({ tables: { profiles: ok({ id: STAFF.userId, role: "staff", display_name: "Asha Gurung" }) } }).db;
    await expect(real.requireRole("owner", { getUserId: async () => STAFF.userId, admin: () => prof })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"event":"forbidden"'))!;
    expect(JSON.parse(line)).toMatchObject({ userId: STAFF.userId, role: "staff", need: "owner" });
    expect(line).not.toContain("Asha");
  });
});

describe("fix pass 2026-10-21: staff management (SEC-004)", () => {
  const withAuth = (f: ReturnType<typeof fakeDb>, admin: Record<string, unknown>) => {
    (f.db as unknown as { auth: unknown }).auth = { admin };
    return f;
  };

  it("listStaff joins profiles with auth emails and marks the caller", async () => {
    const f = fakeDb({
      tables: {
        profiles: ok([
          { id: OWNER.userId, role: "owner", display_name: "Owner", created_at: "2026-10-01T00:00:00Z" },
          { id: STAFF.userId, role: "staff", display_name: "Staff", created_at: "2026-10-02T00:00:00Z" },
        ]),
      },
    });
    withAuth(f, { listUsers: async () => ({ data: { users: [{ id: STAFF.userId, email: "staff@example.com", last_sign_in_at: null }] }, error: null }) });
    use(OWNER, f);
    const r = (await listStaff()) as { ok: true; data: { rows: Record<string, unknown>[] } };
    expect(r.data.rows).toHaveLength(2);
    expect(r.data.rows[0]).toMatchObject({ userId: OWNER.userId, isSelf: true, email: null, isActive: true });
    expect(r.data.rows[1]).toMatchObject({ userId: STAFF.userId, role: "staff", email: "staff@example.com", isSelf: false });
  });

  it("deactivateStaff: owner cannot deactivate self or another owner; a staff member is deleted from Auth", async () => {
    const deleteUser = vi.fn(async (id: string) => (void id, { data: {}, error: null }));
    use(OWNER, withAuth(fakeDb({}), { deleteUser }));
    expect(((await deactivateStaff({ userId: OWNER.userId })) as { error: { code: string } }).error.code).toBe("CONFLICT");

    use(OWNER, withAuth(fakeDb({ tables: { profiles: ok({ id: ID, role: "owner" }) } }), { deleteUser }));
    expect(((await deactivateStaff({ userId: ID })) as { error: { code: string } }).error.code).toBe("CONFLICT");

    use(OWNER, withAuth(fakeDb({ tables: { profiles: ok(null) } }), { deleteUser }));
    expect(((await deactivateStaff({ userId: ID })) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    expect(deleteUser).not.toHaveBeenCalled();

    use(OWNER, withAuth(fakeDb({ tables: { profiles: ok({ id: STAFF.userId, role: "staff" }) } }), { deleteUser }));
    expect(await deactivateStaff({ userId: STAFF.userId })).toEqual({ ok: true, data: null });
    expect(deleteUser).toHaveBeenCalledWith(STAFF.userId);
  });
});

describe("BUG-015: product variants are read in a stable display order", () => {
  it("getAdminProducts orders product_variants by colour, size_rank, size, id (supabase/README 'Reading data')", async () => {
    const product = { id: ID, slug: "tee", name: "Tee", description: null, price_paisa: 150000, is_published: true, details: {}, created_at: "2026-10-23T00:00:00Z" };
    const v = (id: string, size: string, colour: string, rank: number) => ({ id, product_id: ID, size, colour, sku: null, stock: 3, price_override_paisa: null, stock_state: "in_stock", size_rank: rank });
    // What the database returns for that ORDER BY: Black S, M, L, XL, Cream M, L.
    const rows = [v("v1", "S", "Black", 30), v("v2", "M", "Black", 40), v("v3", "L", "Black", 50), v("v4", "XL", "Black", 60), v("v5", "M", "Cream", 40), v("v6", "L", "Cream", 50)];
    const f = use(OWNER, fakeDb({ tables: { products: ok([product]), product_images: ok([]), product_variants: ok(rows) } }));
    const r = (await getAdminProducts()) as { ok: true; data: { variants: { id: string; size: string; colour: string }[] }[] };
    expect(r.ok).toBe(true);
    const calls = f.tableCalls.filter((c) => c.table === "product_variants").flatMap((c) => c.calls);
    expect(calls.filter((c) => c.op === "order").map((c) => c.args[0])).toEqual(["colour", "size_rank", "size", "id"]);
    // ascending (no options) on every key
    expect(calls.filter((c) => c.op === "order").every((c) => c.args.length === 1)).toBe(true);
    // the action keeps the database order (no re-sort by created_at or in JS)
    expect(r.data[0]?.variants.map((x) => `${x.colour} ${x.size}`)).toEqual(["Black S", "Black M", "Black L", "Black XL", "Cream M", "Cream L"]);
  });
  it("getAdminProducts stays owner only", async () => {
    use(STAFF, fakeDb({}));
    expect(((await getAdminProducts()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
});

describe("createUploadUrl: Storage guard refusal (public-media: ..., AccessDenied) is VALIDATION, not INTERNAL", () => {
  const input = { folder: "menu", widthPx: 480, contentType: "image/webp", sizeBytes: 2000 };
  const withError = (error: object) => {
    state.user = OWNER;
    state.db = { storage: { from: () => ({ createSignedUploadUrl: async () => ({ data: null, error }) }) } };
  };
  it("maps the guard's message through", async () => {
    withError({ name: "StorageApiError", message: "public-media: only image/webp is accepted (got application/json)", status: 400, statusCode: "403", code: "AccessDenied" });
    const r = (await createUploadUrl(input)) as { ok: false; error: { code: string; message: string } };
    expect(r.error).toMatchObject({ code: "VALIDATION", message: "public-media: only image/webp is accepted (got application/json)" });
  });
  it("other Storage errors stay INTERNAL with the generic message", async () => {
    withError({ name: "StorageApiError", message: "new row violates row-level security policy", status: 400, statusCode: "403", code: "AccessDenied" });
    expect(((await createUploadUrl(input)) as { error: { code: string } }).error.code).toBe("INTERNAL");
    withError({ name: "StorageUnknownError", message: "database error, code: 23514", status: 500, statusCode: "500" });
    const r = (await createUploadUrl(input)) as { error: { code: string; message: string } };
    expect(r.error).toMatchObject({ code: "INTERNAL", message: "Something went wrong on our side. Please try again." });
  });
});

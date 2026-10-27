"use client";

import { loadDb, mutateDb, mutateTablesDb, onDbChange } from "@/mocks/db";
import { mockCheckout, mockCustomerCancel, mockOrderByToken, sweepAutoCancel, toMenuSnapshot } from "@/mocks/engine";
import { mockOccupancy } from "@/mocks/tables";
import type {
  ActionResult,
  CheckoutRequest,
  CheckoutResponse,
  MenuSnapshot,
  OrderView,
  PublicSettings,
} from "@/types/contract";
import { isMock } from "./mode";

/**
 * BROWSER-SIDE calls for public pages. Live mode calls the real contract endpoints; mock mode uses the
 * browser-stored mock database so the whole flow (checkout, order page, cancel) can be demonstrated.
 */

async function callApi<T>(path: string, init?: RequestInit): Promise<ActionResult<T>> {
  try {
    const res = await fetch(path, { ...init, cache: "no-store" });
    const body = (await res.json()) as ActionResult<T>;
    if (body && typeof body === "object" && "ok" in body) {
      if (!body.ok && res.status === 429) {
        const wait = res.headers.get("Retry-After");
        return {
          ok: false,
          error: { ...body.error, message: wait ? `${body.error.message} Try again in ${wait} seconds.` : body.error.message },
        };
      }
      return body;
    }
    return { ok: false, error: { code: "INTERNAL", message: "Something went wrong. Please try again." } };
  } catch {
    return { ok: false, error: { code: "INTERNAL", message: "We could not reach the server. Check your connection and try again." } };
  }
}

/** A failed menu read. `retryAfterMs` is set when the server said how long to wait (429 + Retry-After, contract 1.3.3). */
export class MenuFetchError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "MenuFetchError";
  }
}

/** Retry-After in seconds (the only form our server sends) -> ms; null when missing or not a sane number. */
export function parseRetryAfter(header: string | null): number | null {
  if (!header || !/^\d{1,5}$/.test(header.trim())) return null;
  return Number(header.trim()) * 1000;
}

export async function fetchMenuSnapshot(): Promise<MenuSnapshot> {
  // 2.0.0: occupancy rides on the menu poll (never in the server-rendered snapshot)
  if (isMock) return mutateTablesDb((db) => ({ ...toMenuSnapshot(db), tables: mockOccupancy(db) }));
  let res: Response;
  try {
    res = await fetch("/api/menu", { cache: "no-store" });
  } catch {
    throw new MenuFetchError("We could not reach the server.", null);
  }
  const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get("Retry-After")) : null;
  let body: ActionResult<MenuSnapshot> | null = null;
  try {
    body = (await res.json()) as ActionResult<MenuSnapshot>;
  } catch {
    /* not JSON (proxy error page): handled below */
  }
  if (body && typeof body === "object" && "ok" in body && body.ok) return body.data;
  const message = body && typeof body === "object" && "ok" in body && !body.ok ? body.error.message : "Something went wrong.";
  throw new MenuFetchError(message, retryAfterMs);
}

export type MenuSubscription = { close: () => void };

/**
 * Realtime seam (contract section 5). Returns null when no realtime channel is available, in which case
 * the caller polls GET /api/menu every 30 s while the tab is visible.
 * LIVE: needs @supabase/supabase-js (not installed; backend/devops decision). Open ONE multiplexed channel
 * here, call onEvent on any menu_items / menu_variants / menu_specials / site_settings change, and onStatus("error")
 * on CHANNEL_ERROR / CLOSED. MOCK: another tab's change to the mock db acts as the event.
 */
export function subscribeMenu(handlers: {
  onEvent: () => void;
  onStatus: (s: "subscribed" | "error") => void;
}): MenuSubscription | null {
  if (!isMock) return null;
  const off = onDbChange(handlers.onEvent);
  handlers.onStatus("subscribed");
  return { close: off };
}

export async function submitCheckout(req: CheckoutRequest): Promise<ActionResult<CheckoutResponse>> {
  if (isMock) return mutateDb((db) => mockCheckout(db, req));
  return callApi<CheckoutResponse>("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

export async function fetchOrder(token: string): Promise<ActionResult<OrderView>> {
  if (isMock) {
    return mutateDb((db) => {
      sweepAutoCancel(db);
      return mockOrderByToken(db, token);
    });
  }
  return callApi<OrderView>(`/api/orders/${encodeURIComponent(token)}`);
}

export async function cancelOrderByToken(token: string): Promise<ActionResult<OrderView>> {
  if (isMock) return mutateDb((db) => mockCustomerCancel(db, token));
  return callApi<OrderView>(`/api/orders/${encodeURIComponent(token)}/cancel`, { method: "POST" });
}

/** Settings for the browser (cart/checkout). Mock reads the browser db; live pages pass server-fetched settings instead. */
export function mockSettingsForBrowser(): PublicSettings {
  return loadDb().settings;
}

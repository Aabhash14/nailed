"use client";

import { loadDb, onDbChange } from "@/mocks/db";
import { isMock } from "./mode";

/**
 * The two public settings every admin page needs (design review T-048 fixes 6 and 7, BUG-011): whether online orders
 * are paused, and the notice banner text. Both are PUBLIC (`public_settings` view), so staff may read them too.
 *
 * LIVE: read on the server by `src/app/admin/(signed-in)/layout.tsx` (only behind the middleware sign-in check, so an
 * anonymous request never causes this read) and passed down; `router.refresh()` reads them again.
 * MOCK: the browser mock database (the server-side mock is only the seed, so its value is ignored here).
 */
export type AdminStatus = {
  ordersPaused: boolean;
  announcement: string | null;
  /** false when the read failed: the UI then says so instead of showing "not paused" / "no notice" as fact */
  known: boolean;
};

export const adminStatusFromBrowser = isMock;

export function readMockAdminStatus(): AdminStatus {
  const s = loadDb().settings;
  return { ordersPaused: s.ordersPaused === true, announcement: s.announcement ?? null, known: true };
}

/** Mock only: another tab changed the mock database. Returns an unsubscribe function. */
export function onMockAdminStatusChange(cb: () => void): () => void {
  return onDbChange(cb);
}

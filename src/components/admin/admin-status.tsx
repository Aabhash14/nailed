"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Banner } from "@/components/ui/feedback";
import { adminStatusFromBrowser, onMockAdminStatusChange, readMockAdminStatus, type AdminStatus } from "@/data-access/admin-status";
import { useAdminSession } from "./admin-shell";

type Ctx = AdminStatus & {
  setOrdersPaused: (paused: boolean) => void;
  setAnnouncement: (text: string | null) => void;
  /** Read the stored values again (live: router.refresh(); mock: the browser database). */
  refresh: () => void;
};

const StatusCtx = createContext<Ctx | null>(null);

export function useAdminStatus(): Ctx {
  const c = useContext(StatusCtx);
  if (!c) throw new Error("useAdminStatus outside AdminStatusProvider");
  return c;
}

export function AdminStatusProvider({ initial, children }: { initial: AdminStatus; children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<AdminStatus>(initial);
  // live: a router.refresh() re-renders the server layout with fresh values (a new `initial` object)
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    if (!adminStatusFromBrowser) setStatus(initial);
  }

  useEffect(() => {
    if (!adminStatusFromBrowser) return;
    setStatus(readMockAdminStatus());
    return onMockAdminStatusChange(() => setStatus(readMockAdminStatus()));
  }, []);

  const refresh = useCallback(() => {
    if (adminStatusFromBrowser) setStatus(readMockAdminStatus());
    else router.refresh();
  }, [router]);

  // someone else may have paused orders or changed the notice while this tab was in the background
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

  // stable setters, so pages can call them from effects without re-running those effects
  const setOrdersPaused = useCallback((paused: boolean) => setStatus((s) => ({ ...s, ordersPaused: paused, known: true })), []);
  const setAnnouncement = useCallback((text: string | null) => setStatus((s) => ({ ...s, announcement: text })), []);
  const value = useMemo<Ctx>(() => ({ ...status, setOrdersPaused, setAnnouncement, refresh }), [status, setOrdersPaused, setAnnouncement, refresh]);
  return <StatusCtx.Provider value={value}>{children}</StatusCtx.Provider>;
}

/**
 * Design review T-048 fix 6: while online orders are paused, every admin page says so (text and a badge, not colour
 * alone), so a forgotten pause cannot silently stop sales. Owner: a link to the switch. Staff: who can resume.
 * ASSUMPTION (open question in the review): only the owner can pause/resume. Copy is a working draft (T-052).
 */
export function PausedBanner() {
  const { ordersPaused } = useAdminStatus();
  const { role } = useAdminSession();
  const pathname = usePathname();
  if (!ordersPaused) return null;
  const linkClass = "text-primary min-h-tap inline-flex items-center font-semibold underline";
  return (
    <Banner tone="warning" title="Online orders are paused">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone="danger">Paused</Badge>
        <span>Customers cannot order online right now and are asked to call the cafe.</span>
        {role === "owner" ? (
          pathname === "/admin/settings" ? (
            <a href="#orders-pause" className={linkClass}>
              Resume with the switch below
            </a>
          ) : (
            <Link href="/admin/settings#orders-pause" className={linkClass}>
              Resume in Settings
            </Link>
          )
        ) : (
          <span className="font-semibold">Ask the owner to resume.</span>
        )}
      </span>
    </Banner>
  );
}

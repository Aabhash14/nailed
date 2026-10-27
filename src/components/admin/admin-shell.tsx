"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button, LinkButton } from "@/components/ui/button";
import { Banner, Skeleton } from "@/components/ui/feedback";
import { adminApi, adminIsMock, resetMockDb, type AdminSession } from "@/data-access/admin";
import { ALERTS_CHANGED_EVENT } from "./alerts/alerts-events";

const SessionCtx = createContext<AdminSession | null>(null);

/** The signed-in staff member. Only usable below the shell, on pages other than /admin/login. */
export function useAdminSession(): AdminSession {
  const s = useContext(SessionCtx);
  if (!s) throw new Error("useAdminSession outside a signed-in admin page");
  return s;
}

const NAV = [
  { href: "/admin", label: "Today", owner: false },
  { href: "/admin/tables", label: "Tables", owner: false },
  { href: "/admin/sales", label: "Sales", owner: false },
  { href: "/admin/menu", label: "Menu", owner: false },
  { href: "/admin/products", label: "Products", owner: false },
  { href: "/admin/stats", label: "Stats", owner: true },
  { href: "/admin/alerts", label: "Alerts", owner: true },
  { href: "/admin/blocklist", label: "Blocklist", owner: false },
  { href: "/admin/settings", label: "Settings", owner: false },
  { href: "/admin/staff", label: "Staff", owner: true },
  { href: "/admin/account", label: "Account", owner: false },
];

/**
 * Owner alerts unread count for the nav badge (api-contract 2.2.0 section 9.10): read once per owner page load (each
 * navigation), and updated by the Alerts page itself. No polling here. Staff never ask (getAlertCount is owner only).
 */
function useUnreadAlerts(isOwner: boolean, pathname: string): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!isOwner) return;
    let live = true;
    void adminApi.getAlertCount().then((res) => {
      if (live && res.ok) setUnread(res.data.unread);
    });
    return () => {
      live = false;
    };
  }, [isOwner, pathname]);
  useEffect(() => {
    const on = (e: Event) => setUnread((e as CustomEvent<number>).detail);
    window.addEventListener(ALERTS_CHANGED_EVENT, on);
    return () => window.removeEventListener(ALERTS_CHANGED_EVENT, on);
  }, []);
  return isOwner ? unread : 0;
}

/** Signed out: send the person to the login page, remembering where they were (validated again on the login side). */
function RedirectToLogin({ pathname }: { pathname: string }) {
  const router = useRouter();
  useEffect(() => {
    const next = pathname !== "/admin" ? `?next=${encodeURIComponent(pathname)}` : "";
    router.replace(`/admin/login${next}`);
  }, [router, pathname]);
  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-10">
      <Banner tone="warning" live="alert" title="Please sign in">
        Taking you to the sign in page.
      </Banner>
      <LinkButton href="/admin/login">Go to sign in</LinkButton>
    </div>
  );
}

/**
 * Admin chrome + session gate. The REAL protection is middleware, requireRole and RLS (backend-engineer);
 * this gate only decides what the UI shows.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // The shell stays mounted across admin navigations (layout), so remember WHICH path the session was read for.
  // BUG-002: after sign-in, /admin used to render with the stale `null` read on /admin/login and bounce back.
  const [checked, setChecked] = useState<{ path: string; session: AdminSession | null } | null>(null);
  const onLogin = pathname === "/admin/login";

  useEffect(() => {
    let alive = true;
    void adminApi.getSession().then((s) => {
      if (alive) setChecked({ path: pathname, session: s });
    });
    return () => {
      alive = false;
    };
  }, [pathname]);

  // A signed-in session stays valid while the new page re-checks it (no flash). A "signed out" answer only counts
  // for the path it was read on: anywhere else we wait for a fresh answer before redirecting.
  const session: AdminSession | null | undefined =
    checked === null ? undefined : checked.session !== null ? checked.session : checked.path === pathname ? null : undefined;
  const unreadAlerts = useUnreadAlerts(session?.role === "owner" && !onLogin, pathname);

  if (onLogin) {
    return (
      <div className="mx-auto max-w-md px-4 py-10 sm:py-16">
        <div className="border-line bg-surface-raised rounded-card shadow-card relative overflow-hidden border px-5 pt-8 pb-6 sm:px-8">
          <div aria-hidden="true" className="ornament-band-sm absolute inset-x-0 top-0" />
          {children}
        </div>
        {adminIsMock ? (
          <p className="text-ink-muted mt-6 text-sm">
            Development mode: any email and password signs in as the owner. Use an email containing &quot;staff&quot; to try the staff role.
          </p>
        ) : null}
      </div>
    );
  }

  if (session === undefined) {
    return (
      <div className="mx-auto max-w-5xl space-y-3 px-4 py-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (session === null) {
    return <RedirectToLogin pathname={pathname} />;
  }
  return (
    <SessionCtx.Provider value={session}>
      <a
        href="#admin-main"
        className="bg-primary text-on-primary sr-only z-50 px-4 py-2 focus:not-sr-only focus:absolute focus:left-2 focus:top-2"
      >
        Skip to content
      </a>
      <header className="surface-inverse">
        <div aria-hidden="true" className="ornament-band-sm" />
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 px-4">
          <p className="font-display py-2.5 text-lg tracking-[0.06em]">Admin</p>
          <nav aria-label="Admin" className="order-last -mx-1 w-full pb-2 md:order-none md:mx-0 md:w-auto md:pb-0">
            <ul className="flex flex-wrap gap-1">
              {NAV.filter((n) => !n.owner || session.role === "owner").map((n) => {
                const current = n.href === "/admin" ? pathname === "/admin" : pathname.startsWith(n.href);
                return (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      aria-current={current ? "page" : undefined}
                      className={`min-h-tap rounded-control inline-flex items-center px-3 font-semibold transition-colors duration-(--motion-base) ${current ? "bg-surface text-ink" : "text-on-inverse hover:bg-on-inverse/10"}`}
                    >
                      {n.label}
                      {n.href === "/admin/alerts" && unreadAlerts > 0 ? (
                        <span className="rounded-pill bg-accent text-on-accent ml-1.5 min-w-5 px-1.5 text-center text-xs leading-5 tabular-nums">
                          {unreadAlerts > 99 ? "99+" : unreadAlerts}
                          <span className="sr-only"> unread</span>
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-on-inverse-muted">
              {session.displayName} ({session.role})
            </span>
            <Button
              variant="inverse"
              onClick={async () => {
                await adminApi.signOut();
                router.push("/admin/login");
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main id="admin-main" tabIndex={-1} className="mx-auto max-w-5xl space-y-5 px-4 py-6 outline-none">
        {adminIsMock ? (
          <Banner tone="warning" title="Development mode">
            Sample data kept in this browser only.{" "}
            <button
              type="button"
              className="min-h-tap font-semibold underline"
              onClick={() => {
                resetMockDb();
                window.location.reload();
              }}
            >
              Reset sample data
            </button>
          </Banner>
        ) : null}
        {children}
      </main>
    </SessionCtx.Provider>
  );
}

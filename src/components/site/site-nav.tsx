"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV = [
  { href: "/menu", label: "Menu" },
  { href: "/shop", label: "Shop" },
  { href: "/story", label: "Our story" },
  { href: "/visit", label: "Visit" },
] as const;

/** Main navigation. Client only for aria-current (which page you are on); the links themselves are plain anchors. */
export function SiteNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav aria-label="Main">
      <ul className="flex flex-wrap items-center justify-center gap-x-1 sm:gap-x-4">
        {NAV.map((n) => {
          const current = pathname === n.href || pathname.startsWith(`${n.href}/`);
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                aria-current={current ? "page" : undefined}
                className={`min-h-tap font-display text-label tracking-label relative inline-flex flex-col items-center justify-center px-2.5 uppercase transition-colors duration-(--motion-base) ${current ? "text-primary" : "text-ink hover:text-primary"}`}
              >
                <span className="link-underline pb-1">
                  {n.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

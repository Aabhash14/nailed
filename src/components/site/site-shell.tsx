import Link from "next/link";
import type { ReactNode } from "react";
import { CartProvider } from "@/components/shop/cart-provider";
import { getPublicSettingsSafe } from "@/data-access/public-server";
import { ACCENT } from "./accents";
import { CartLink } from "./cart-link";
import { OpenStatusBadge } from "./open-status";
import { SiteNav } from "./site-nav";

export const CAFE_NAME = "Nailed Cafe & Lodge";

/** Name split for the wordmark: the first word large, the rest letter-spaced underneath. The space stays in the DOM. */
function Wordmark() {
  const [first, ...rest] = CAFE_NAME.split(" ");
  return (
    <Link href="/" className="group min-h-tap inline-flex flex-col justify-center leading-none">
      <span className="font-display text-primary group-hover:text-primary-strong text-[1.75rem] tracking-[0.06em] transition-colors duration-(--motion-base) md:text-[2rem]">
        {first}
      </span>{" "}
      <span className="font-display text-ink tracking-wordmark mt-1 text-[0.6875rem] uppercase">
        {rest.join(" ")}
      </span>
    </Link>
  );
}

const FOOTER_LINKS: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: "Visit",
    links: [
      { href: "/visit", label: "Opening hours and contact" },
      { href: "/story", label: "Our story" },
    ],
  },
  {
    heading: "Order",
    links: [
      { href: "/menu", label: "Menu" },
      { href: "/shop", label: "Shop" },
      { href: "/policies", label: "Order and privacy policies" },
    ],
  },
];

/** Public chrome: skip link, header, footer. Server markup; only the nav state and the cart badge are client-side. */
export async function SiteShell({ children }: { children: ReactNode }) {
  // Cached, tag-revalidated settings read; on failure the open/closed badge is simply hidden.
  const settings = await getPublicSettingsSafe();
  return (
    <CartProvider>
      <a
        href="#main"
        className="bg-primary text-on-primary rounded-control sr-only z-50 px-4 py-3 font-semibold focus:not-sr-only focus:absolute focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <div className="surface-paper flex min-h-dvh flex-col">
        <div className="ornament-band-sm" aria-hidden="true" />
        <header className="border-line/70 border-b">
          <div className="px-gutter max-w-page mx-auto grid grid-cols-[1fr_auto] items-center gap-x-4 pt-3 md:grid-cols-[1fr_auto_1fr] md:py-4">
            <div className="md:col-start-2 md:justify-self-center md:text-center">
              <Wordmark />
            </div>
            <div className="flex items-center gap-2 justify-self-end md:col-start-3 md:gap-4">
              <OpenStatusBadge hours={settings?.hours ?? null} />
              <CartLink />
            </div>
            <div className="col-span-2 -mx-2 py-1 md:col-span-1 md:col-start-1 md:row-start-1 md:mx-0 md:justify-self-start md:py-0">
              <SiteNav />
            </div>
          </div>
        </header>
        <div
          id="main"
          tabIndex={-1}
          className="pb-section-sm flex-1 outline-none has-[>main[data-flush-end]]:pb-0"
        >
          {children}
        </div>
        <footer>
          <div className="ornament-band-lg" aria-hidden="true" />
          <div className="surface-inverse">
            <div className="px-gutter max-w-page mx-auto grid grid-cols-2 gap-x-6 gap-y-8 py-8 md:grid-cols-[1.4fr_1fr_1fr] md:gap-10 md:py-10">
              <div className="col-span-2 space-y-2 md:col-span-1">
                <p className="font-display text-on-inverse text-2xl tracking-[0.04em]">
                  {CAFE_NAME}
                </p>
                <p className="text-on-inverse-muted">Uphar Marg, Baluwatar, Kathmandu</p>
                {ACCENT.thanks ? (
                  <p
                    aria-hidden="true"
                    lang="ne"
                    className="font-deva text-accent text-deva-accent"
                  >
                    {ACCENT.thanks}
                  </p>
                ) : null}
              </div>
              {FOOTER_LINKS.map((col) => (
                <nav key={col.heading} aria-label={`Footer: ${col.heading}`}>
                  <h2 className="font-display text-accent text-label tracking-label mb-2 uppercase">
                    {col.heading}
                  </h2>
                  <ul>
                    {col.links.map((l) => (
                      <li key={l.href}>
                        <Link
                          href={l.href}
                          className="min-h-tap text-on-inverse hover:text-accent inline-flex items-center underline decoration-1 underline-offset-4 transition-colors duration-(--motion-base)"
                        >
                          {l.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
              ))}
            </div>
            <div className="border-line-inverse border-t">
              <p className="px-gutter max-w-page text-on-inverse-muted mx-auto py-4 text-sm">
                {CAFE_NAME} · Kathmandu, Nepal
              </p>
            </div>
          </div>
        </footer>
      </div>
    </CartProvider>
  );
}

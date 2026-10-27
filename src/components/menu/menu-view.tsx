"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { agoLabel, minutesAgo } from "@/components/format";
import { ACCENT, devanagariNumeral } from "@/components/site/accents";
import { Accent } from "@/components/site/page-parts";
import { Banner, EmptyState } from "@/components/ui/feedback";
import { CheckField } from "@/components/ui/field";
import { tableOrderingOf, type MenuSnapshot } from "@/types/contract";
import { EN, footerText } from "./i18n";
import { MenuItemCard } from "./menu-parts";
import { MenuLangPicker } from "./lang-picker";
import { Sec } from "./secondary";
import { TableBadge } from "./table-badge";
import { TableOrderingLazy, useHintTable, useTableQr } from "./table/table-entry";
import type { TableBridge } from "./table/table-ordering";
import { useLiveMenu } from "./use-live-menu";
import { useMenuLang, useMenuSecondary } from "./use-menu-lang";

/** After this long without a successful refresh we tell the guest the prices may be old. */
const STALE_AFTER_MIN = 10;

function useNow(everyMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** After a tab click, observer updates are ignored this long (S25-8: on desktop the menu is two columns, and the
 * left-column category level with the clicked one would otherwise take the highlight back mid-scroll). */
const TAB_CLICK_HOLD_MS = 800;

/**
 * Which category is on screen, for the sticky tabs (aria-current + the brick underline). Null until a section enters
 * the band; MenuView then falls back to the first category. `slugKey` is the visible
 * category slugs joined by "|", so the observer is rebuilt only when the list really changes (veg filter, live update).
 * `pick(slug)` lights a tab at once (a tab click) and holds it for TAB_CLICK_HOLD_MS.
 */
function useActiveCategory(slugKey: string): [string | null, (slug: string) => void] {
  const [active, setActive] = useState<string | null>(null);
  const holdUntil = useRef(0);
  const pick = useCallback((slug: string) => {
    holdUntil.current = Date.now() + TAB_CLICK_HOLD_MS;
    setActive(slug);
  }, []);
  useEffect(() => {
    const slugs = slugKey ? slugKey.split("|") : [];
    const els = slugs
      .map((s) => document.getElementById(`cat-${s}`))
      .filter((e): e is HTMLElement => e !== null);
    if (els.length === 0 || typeof IntersectionObserver === "undefined") return;
    const inView = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) inView.set(e.target.id, e.isIntersecting);
        if (Date.now() < holdUntil.current) return;
        const first = els.find((el) => inView.get(el.id));
        if (first) setActive(first.id.slice(4));
      },
      // the band under the sticky tab bar, down to just above the middle of the screen
      { rootMargin: "-72px 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [slugKey]);
  return [active, pick];
}

export function MenuView({
  initial,
  fromFallback = false,
  showSampleBanner = false,
}: {
  initial: MenuSnapshot;
  /** True when the page is rendering the break-glass static menu (database unreachable and no cached copy). */
  fromFallback?: boolean;
  showSampleBanner?: boolean;
}) {
  // SEC-024: must run before useLiveMenu's first poll (layout effect), so the scanned code never reaches a request
  const qr = useTableQr();
  const { snapshot, state, lastOk } = useLiveMenu(initial);
  // English always; plus the guest's secondary language after hydration (null = English only, also on the server)
  const [mode, setMode] = useMenuLang();
  const sec = useMenuSecondary(mode);
  const L = sec?.bcp47;
  const [vegOnly, setVegOnly] = useState(false);
  const now = useNow(60_000);
  const tabsRef = useRef<HTMLUListElement>(null);

  const stale = now !== null && minutesAgo(lastOk, now) >= STALE_AFTER_MIN && state === "offline";
  const degraded = fromFallback || snapshot.degraded === true || stale;

  const categories = snapshot.categories
    .map((c, index) => ({
      ...c,
      index,
      items: vegOnly ? c.items.filter((i) => i.diet === "veg") : c.items,
    }))
    .filter((c) => c.items.length > 0);
  const totalItems = snapshot.categories.reduce((n, c) => n + c.items.length, 0);
  const shownItems = categories.reduce((n, c) => n + c.items.length, 0);
  const shownSoldOut = categories.reduce(
    (n, c) => n + c.items.filter((i) => i.isSoldOut).length,
    0,
  );
  const [active, pickCategory] = useActiveCategory(categories.map((c) => c.slug).join("|"));
  // R24-3: at the top of the page no section is in the observer band yet, so default to the first category (also when
  // the veg filter has just hidden the active one). Server and first client render agree: both use categories[0].
  const current =
    active !== null && categories.some((c) => c.slug === active)
      ? active
      : (categories[0]?.slug ?? null);

  // keep the current tab visible in the horizontally scrolling tab strip (phones)
  useEffect(() => {
    const list = tabsRef.current;
    if (!list || !current) return;
    const link = list.querySelector<HTMLElement>(`[data-slug="${CSS.escape(current)}"]`);
    if (!link) return;
    const left = link.offsetLeft - list.clientWidth / 2 + link.clientWidth / 2;
    list.scrollTo({ left: Math.max(0, left), behavior: reducedMotion() ? "auto" : "smooth" });
  }, [current]);

  const { pricesIncludeVat, serviceChargePct, vatPct } = snapshot.settings;

  // ---- table ordering (2.0.0). `tables` and the live mode come only from a poll, never from the ISR page.
  const polled = snapshot !== initial;
  const polledMode = polled ? tableOrderingOf(snapshot.settings) : null;
  const initialMode = fromFallback ? "off" : tableOrderingOf(initial.settings);
  const orderingDown = fromFallback || snapshot.degraded === true || state === "offline";
  const hintTable = useHintTable();
  const [bridge, setBridge] = useState<TableBridge | null>(null);
  // Load the table chunk only when it can matter: ordering is on/paused, or this guest joined / scanned a table code.
  const wantTables =
    qr.ready &&
    (polledMode === "on" ||
      polledMode === "paused" ||
      hintTable !== null ||
      qr.scannedCode !== null ||
      (qr.tableParam !== null && polledMode === null && initialMode !== "off"));
  // Contract 9.12: with the menu down, hide occupancy and ordering and say so, to guests at a table.
  const tableContext = hintTable !== null || qr.scannedCode !== null || (qr.tableParam !== null && (polledMode ?? initialMode) !== "off");
  const showOrderingDown = orderingDown && tableContext;
  const isLive = !fromFallback && state !== "offline" && now !== null;
  const secStatus = !sec
    ? null
    : fromFallback
      ? sec.t("status.saved_copy")
      : state === "offline"
        ? sec.t("status.offline")
        : now === null
          ? sec.t("status.loading")
          : sec.liveStatus(minutesAgo(lastOk, now));
  const secCount = sec
    ? [
        sec.t(shownItems === 1 ? "count.item" : "count.items", { n: shownItems }),
        shownSoldOut > 0 ? sec.t("count.sold_out", { n: shownSoldOut }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const secTitle = sec?.t("menu.title");

  return (
    <div className="space-y-5">
      {/* S25-8: the title, notices and specials stay a centred reading column; from lg the ledger below goes two-up */}
      <div className="max-w-reading mx-auto space-y-5">
        <header className="relative space-y-2 pt-2 text-center">
          <div className="absolute top-0 left-0">
            <Suspense fallback={null}>
              <TableBadge sec={sec} />
            </Suspense>
          </div>
          {/* Concept C: one craft detail per view. With a secondary title under the h1, the decorative accent gives way */}
          {secTitle ? null : <Accent>{ACCENT.menu}</Accent>}
          <h1 className="font-display text-title-1">Menu</h1>
          <Sec
            text={secTitle}
            lang={L}
            block
            className="text-ink-muted font-display text-title-3 -mt-1"
          />
          <p
            className="text-ink-muted inline-flex items-center justify-center gap-2 text-sm"
            aria-live="polite"
          >
            <span
              aria-hidden="true"
              className={`rounded-pill inline-block h-2 w-2 shrink-0 ${isLive ? "bg-success animate-live" : "bg-ink-muted"}`}
            />
            {fromFallback
              ? "Saved copy of the menu"
              : state === "offline"
                ? "Offline. Showing the last menu we loaded."
                : now === null
                  ? "Loading status"
                  : `Live. Updated ${agoLabel(lastOk, now)}.`}
          </p>
          {/* Secondary status sits outside the live region, so screen readers are not told everything twice a minute */}
          <Sec text={secStatus} lang={L} block className="text-ink-muted -mt-1.5 text-sm" />
          <div className="pt-1">
            <MenuLangPicker value={mode} onChange={setMode} />
          </div>
        </header>

        {showSampleBanner ? (
          <Banner
            tone="warning"
            title={
              <Bi en={EN["banner.sample.title"]} sec={sec?.t("banner.sample.title")} lang={L} />
            }
          >
            This menu is made-up development data, not the cafe&apos;s real menu or prices.
            <Sec text={sec?.t("banner.sample.body")} lang={L} block />
          </Banner>
        ) : null}

        {degraded ? (
          <Banner
            tone="warning"
            live="status"
            title={<Bi en={EN["banner.stale.title"]} sec={sec?.t("banner.stale.title")} lang={L} />}
          >
            {fromFallback ? EN["banner.stale.body_fallback"] : EN["banner.stale.body_cached"]}
            <Sec
              text={sec?.t(
                fromFallback ? "banner.stale.body_fallback" : "banner.stale.body_cached",
              )}
              lang={L}
              block
            />
          </Banner>
        ) : null}

        {showOrderingDown ? (
          <Banner tone="warning" live="status">
            {/* CONTRACT 9.12 wording; English only until the translator adds it (msg.unavailable) */}
            Ordering is not available right now. Please order with our staff.
          </Banner>
        ) : null}

        {wantTables ? (
          <TableOrderingLazy
            categories={snapshot.categories}
            occupancy={polled && !orderingDown ? snapshot.tables : undefined}
            mode={polledMode}
            down={orderingDown}
            tableParam={qr.tableParam}
            scannedCode={qr.scannedCode}
            langMode={mode}
            sec={sec}
            onBridge={setBridge}
          />
        ) : null}

        {/* The owner's announcement is free text: English (or whatever the owner typed) only, by design */}
        {snapshot.settings.announcement ? (
          <Banner
            tone="info"
            live="status"
            title={
              <Bi en={EN["banner.notice.title"]} sec={sec?.t("banner.notice.title")} lang={L} />
            }
          >
            {snapshot.settings.announcement}
          </Banner>
        ) : null}

        {snapshot.specials.length > 0 ? (
          <section
            aria-labelledby="specials"
            className="border-line bg-surface-raised rounded-card shadow-card relative overflow-hidden border px-5 pt-6 pb-5"
          >
            <div aria-hidden="true" className="ornament-band-sm absolute inset-x-0 top-0" />
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h2 id="specials" className="font-display text-title-3">
                Specials
              </h2>
              <Sec text={sec?.t("specials.heading")} lang={L} className="text-ink-muted" />
            </div>
            <ul className="mt-3 space-y-2">
              {snapshot.specials.map((s) => (
                <li key={s.id} className="flex gap-3">
                  <span aria-hidden="true" className="ornament-diamond text-accent mt-2" />
                  <span>
                    <span className="font-semibold">{s.title}</span>
                    {s.note ? <span className="text-ink-muted"> {s.note}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {totalItems === 0 ? (
        <EmptyState
          title={<Bi en={EN["empty.setup.title"]} sec={sec?.t("empty.setup.title")} lang={L} />}
        >
          Please ask at the counter for today&apos;s menu.
          <Sec text={sec?.t("empty.setup.body")} lang={L} block />
        </EmptyState>
      ) : (
        <>
          <div className="bg-surface-alt border-line shadow-tabbar -mx-gutter sticky top-0 z-10 border-t">
            <nav aria-label="Menu categories">
              <ul
                ref={tabsRef}
                className="px-gutter flex gap-1 overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {categories.map((c) => (
                  <li key={c.id} className="shrink-0">
                    <a
                      href={`#cat-${c.slug}`}
                      data-slug={c.slug}
                      onClick={() => pickCategory(c.slug)}
                      aria-current={current === c.slug ? "true" : undefined}
                      className="min-h-tab rounded-control text-ink-muted hover:text-ink aria-[current=true]:text-ink after:bg-primary relative inline-flex flex-col items-start justify-center px-3 pt-1.5 pb-3 leading-tight font-semibold whitespace-nowrap transition-colors duration-(--motion-base) after:absolute after:inset-x-3 after:bottom-1.5 after:h-[3px] after:origin-left after:scale-x-0 after:transition-transform after:duration-(--motion-base) aria-[current=true]:after:scale-x-100"
                    >
                      <span>{c.name}</span>
                      <Sec text={sec?.categoryName(c)} lang={L} className="text-xs font-normal" />
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          <div className="max-w-reading mx-auto flex flex-wrap items-center justify-between gap-x-6 gap-y-1 lg:max-w-none">
            <p className="text-ink-muted text-sm">
              {shownItems} {shownItems === 1 ? "item" : "items"}
              {shownSoldOut > 0 ? ` · ${shownSoldOut} sold out` : ""}
              <Sec text={secCount} lang={L} block />
            </p>
            <CheckField
              label={
                <>
                  Vegetarian only
                  <Sec
                    text={sec?.t("filter.veg_only.label")}
                    lang={L}
                    block
                    className="text-[0.9375rem]"
                  />
                </>
              }
              hint={
                <>
                  Hides items that contain meat or egg.
                  <Sec text={sec?.t("filter.veg_only.hint")} lang={L} block />
                </>
              }
              checked={vegOnly}
              onChange={(e) => setVegOnly(e.target.checked)}
            />
          </div>

          {categories.length === 0 ? (
            <EmptyState
              title={<Bi en={EN["empty.veg.title"]} sec={sec?.t("empty.veg.title")} lang={L} />}
            >
              Turn off the filter to see everything.
              <Sec text={sec?.t("empty.veg.body")} lang={L} block />
            </EmptyState>
          ) : (
            <div className="space-y-5 lg:columns-2 lg:gap-x-12">
              {categories.map((c) => (
                <section
                  key={c.id}
                  id={`cat-${c.slug}`}
                  aria-labelledby={`h-${c.slug}`}
                  className="scroll-mt-20 break-inside-avoid"
                >
                  <div className="border-primary flex items-center gap-4 border-b-2 pt-3 pb-2">
                    <span
                      aria-hidden="true"
                      lang="ne"
                      className="numeral-diamond font-deva ml-1 text-base"
                    >
                      <span>{devanagariNumeral(c.index + 1)}</span>
                    </span>
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                      <h2
                        id={`h-${c.slug}`}
                        className="font-display text-title-3 min-w-0 tracking-[0.03em] wrap-anywhere"
                      >
                        {c.name}
                      </h2>
                      <Sec
                        text={sec?.categoryName(c)}
                        lang={L}
                        className="text-ink-muted min-w-0 text-lg wrap-anywhere"
                      />
                    </div>
                  </div>
                  <ul>
                    {c.items.map((i) => (
                      <MenuItemCard
                        key={i.id}
                        item={i}
                        sec={sec}
                        action={
                          bridge
                            ? {
                                onAdd: () => bridge.add(i),
                                inCart: bridge.qty(i.id),
                                label: bridge.addLabel,
                                inCartText: bridge.qty(i.id) > 0 ? bridge.inCartLabel(bridge.qty(i.id)) : null,
                              }
                            : null
                        }
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <footer className="max-w-reading mx-auto space-y-3 pt-4 text-center">
        <div aria-hidden="true" className="ornament-rule">
          <i />
        </div>
        <p className="text-ink-muted text-sm">
          {footerText(EN, "en", { pricesIncludeVat, vatPct, serviceChargePct })}
          <Sec text={sec?.footer({ pricesIncludeVat, vatPct, serviceChargePct })} lang={L} block />
        </p>
      </footer>
    </div>
  );
}

/** A short English title with its secondary version after it (banner and empty-state titles). */
function Bi({
  en: english,
  sec,
  lang,
}: {
  en: string;
  sec: string | null | undefined;
  lang: string | undefined;
}) {
  return (
    <span>
      {english}
      {sec && lang ? (
        <>
          {" "}
          <span lang={lang} className="font-normal">
            {sec}
          </span>
        </>
      ) : null}
    </span>
  );
}

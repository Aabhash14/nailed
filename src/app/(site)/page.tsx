import { Banner, DraftNote, SampleDataBanner } from "@/components/ui/feedback";
import { buttonClass, LinkButton } from "@/components/ui/button";
import { Picture } from "@/components/ui/media";
import { LedgerLine } from "@/components/menu/menu-parts";
import { ProductCard } from "@/components/shop/product-parts";
import { TodayHours } from "@/components/site/today-hours";
import { Container, SectionHeading } from "@/components/site/page-parts";
import { hoursRows, safeHttpsUrl } from "@/components/format";
import { isMock } from "@/data-access/mode";
import { getMenuSnapshot, getPublicSettingsSafe, listProducts } from "@/data-access/public-server";
import type { MenuCategory, MenuItem, MenuSnapshot, MenuTag } from "@/types/contract";

export const revalidate = 3600;

const ADDRESS = "Uphar Marg, Baluwatar, Kathmandu";
const FAVOURITE: ReadonlySet<MenuTag> = new Set<MenuTag>(["bestseller", "chef_pick"]);

/**
 * Home "from the menu" teaser: the first two categories that have something available, up to `perPage` items each,
 * house favourites first. Sold-out items are left out (the live menu is where sold-out is shown).
 */
function menuHighlights(
  snapshot: MenuSnapshot | null,
  perPage = 4,
): { category: MenuCategory; items: MenuItem[] }[] {
  if (!snapshot) return [];
  return snapshot.categories
    .map((category) => {
      const available = category.items.filter((i) => !i.isSoldOut);
      const fav = available.filter((i) => i.tags.some((t) => FAVOURITE.has(t)));
      const rest = available.filter((i) => !i.tags.some((t) => FAVOURITE.has(t)));
      return { category, items: [...fav, ...rest].slice(0, perPage) };
    })
    .filter((p) => p.items.length > 0)
    .slice(0, 2);
}

/** The teasers are extras: if the menu or the shop cannot be read, the home page still renders without them. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/** Large outlined dhaka diamond behind the hero, very faint. Decoration only. */
function HeroMotif() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 200 200"
      className="text-primary pointer-events-none absolute top-1/2 -right-40 hidden h-[44rem] w-[44rem] -translate-y-1/2 opacity-[0.06] md:block"
    >
      <path d="M100 4 196 100 100 196 4 100z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M100 30 170 100 100 170 30 100z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M100 62 138 100 100 138 62 100z" fill="currentColor" />
    </svg>
  );
}

export default async function HomePage() {
  const [settings, snapshot, products] = await Promise.all([
    getPublicSettingsSafe(),
    orNull(getMenuSnapshot()),
    orNull(listProducts()),
  ]);
  const pages = menuHighlights(snapshot);
  const shopItems = (products ?? []).slice(0, 4);
  const mapHref = safeHttpsUrl(settings?.mapUrl); // SEC-012
  const vat = snapshot?.settings;

  return (
    // S25-1: Home ends on the Visit band, which sits right on the footer band, so the shell adds no bottom padding.
    <main data-flush-end>
      {/* S25-5: the announcement and the page-level notice share one wrapper.
          R24-9: one placeholder notice per page, at the top and never inside the hero. Mock mode says "sample data"
          (which covers the menu and shop teasers too); otherwise the draft-copy note. */}
      <Container className="space-y-3 pt-4">
        {settings?.announcement ? (
          <Banner tone="info" live="status" title="Notice">
            {settings.announcement}
          </Banner>
        ) : null}
        {isMock ? (
          <SampleDataBanner />
        ) : (
          <DraftNote>
            the headline and welcome line wait for the content writer and the chosen design.
          </DraftNote>
        )}
      </Container>

      {/* Hero: name, address, two calls to action, and the photo in a carved-window frame (4:3, shot H-01). */}
      <section aria-labelledby="home-title" className="relative overflow-hidden">
        <HeroMotif />
        <Container className="py-section-sm relative grid items-center gap-x-12 gap-y-8 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <div className="rise-stagger space-y-4">
            <h1 id="home-title" className="font-display text-display">
              <span className="text-primary">Nailed</span> Cafe &amp; Lodge
            </h1>
            <p className="text-lead text-ink-muted flex items-center gap-3">
              <span aria-hidden="true" className="ornament-diamond text-primary" />
              {ADDRESS}
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <LinkButton href="/menu" size="lg">
                See the menu
              </LinkButton>
              <LinkButton href="/shop" variant="secondary" size="lg">
                Visit the shop
              </LinkButton>
            </div>
          </div>
          <div className="animate-fade px-2 md:px-8">
            <div className="frame-window">
              <Picture
                url={null}
                variants={[]}
                alt=""
                sizes="(min-width: 768px) 520px, 100vw"
                shotId="H-01"
                placeholderLabel="the room with a signature drink"
                ratio="aspect-[4/3]"
                priority
              />
            </div>
          </div>
        </Container>
      </section>

      {pages.length > 0 ? (
        <section aria-labelledby="home-menu" className="py-section">
          <Container className="space-y-stack">
            <SectionHeading
              id="home-menu"
              align="center"
              eyebrow="Menu"
              title="From the menu"
              intro="Drinks and food, with what is sold out right now."
            />
            {/* Bahi-khata ledger: brick binding around ruled paper pages. */}
            <div
              className={`bg-primary rounded-card shadow-lift mx-auto grid gap-1 p-2.5 sm:p-3.5 ${pages.length > 1 ? "max-w-5xl md:grid-cols-2" : "max-w-2xl"}`}
            >
              {pages.map((p) => (
                <div
                  key={p.category.id}
                  className="surface-paper rounded-control px-4 py-5 sm:px-6 sm:py-6"
                >
                  <h3 className="font-display text-title-3 border-primary border-b-2 pb-2 tracking-[0.06em] uppercase">
                    {p.category.name}
                  </h3>
                  <ul>
                    {p.items.map((i) => (
                      <LedgerLine key={i.id} item={i} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="flex flex-col items-center gap-3 text-center">
              {vat ? (
                <p className="text-ink-muted text-sm">
                  {vat.pricesIncludeVat
                    ? `Prices include ${vat.vatPct}% VAT.`
                    : `Prices do not include ${vat.vatPct}% VAT.`}
                </p>
              ) : null}
              <LinkButton href="/menu" size="lg">
                Open the full menu
              </LinkButton>
            </div>
          </Container>
        </section>
      ) : null}

      {/* Story teaser on the deodar-green feature ground. Copy waits for the cafe's own story. */}
      <section aria-labelledby="home-story" className="surface-feature">
        <Container className="py-section gap-stack grid items-center md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] md:gap-12">
          <div className="space-y-5">
            <SectionHeading
              id="home-story"
              inverse
              eyebrow="Our story"
              title="The people and the place"
              intro="The cafe's own story is on its way, in its own words."
            />
            <LinkButton href="/story" variant="inverse" size="lg">
              Read our story
            </LinkButton>
          </div>
          <div className="border-on-feature/30 rounded-card border p-2">
            <Picture
              url={null}
              variants={[]}
              alt=""
              sizes="(min-width: 768px) 45vw, 100vw"
              shotId="H-03"
              placeholderLabel="the room, wide"
              ratio="aspect-[3/2]"
            />
          </div>
        </Container>
      </section>

      {shopItems.length > 0 ? (
        <section aria-labelledby="home-shop" className="py-section">
          <Container className="space-y-stack">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <SectionHeading
                id="home-shop"
                eyebrow="Shop"
                title="From the shop"
                intro="Merch. Order online, pay in cash on delivery or at pickup."
              />
              <LinkButton href="/shop" variant="secondary" size="lg">
                Visit the shop
              </LinkButton>
            </div>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-4 md:gap-x-6">
              {shopItems.map((p) => (
                <ProductCard key={p.id} product={p} headingLevel={3} />
              ))}
            </ul>
          </Container>
        </section>
      ) : null}

      <section
        aria-labelledby="home-visit"
        className={`bg-surface-alt border-line border-y ${shopItems.length > 0 ? "" : "mt-section"}`}
      >
        <Container className="py-section gap-stack grid items-center md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] md:gap-12">
          <div className="space-y-4">
            <SectionHeading
              id="home-visit"
              eyebrow="Visit"
              title="Find us"
              intro="Address, opening hours and how to reach us."
            />
            <address className="text-lead not-italic">
              {settings?.address ?? ADDRESS}
              {settings?.landmark ? (
                <span className="text-ink-muted block text-base">
                  Landmark: {settings.landmark}
                </span>
              ) : null}
            </address>
            {/* Manager decision 2026-10-25: today's hours only; the full week stays on the Visit page (the button below). */}
            {settings && hoursRows(settings.hours) ? <TodayHours hours={settings.hours} /> : null}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <LinkButton href="/visit" size="lg">
                Opening hours and contact
              </LinkButton>
              {mapHref ? (
                <a
                  href={mapHref}
                  className={buttonClass("secondary", "", "lg")}
                  rel="noopener noreferrer"
                >
                  Open in maps
                </a>
              ) : null}
            </div>
          </div>
          <div className="border-line bg-surface rounded-card shadow-card border p-2">
            <Picture
              url={null}
              variants={[]}
              alt=""
              sizes="(min-width: 768px) 50vw, 100vw"
              shotId="E-01"
              placeholderLabel="the entrance from Uphar Marg"
              ratio="aspect-[3/2]"
            />
          </div>
        </Container>
      </section>
    </main>
  );
}

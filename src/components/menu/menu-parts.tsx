import { formatNpr } from "@/lib/money";
import { ACCENT } from "@/components/site/accents";
import { Badge, Stamp } from "@/components/ui/feedback";
import { Picture } from "@/components/ui/media";
import type { Diet, MenuItem, MenuTag } from "@/types/contract";
import type { MenuSecondary, MenuUiKey } from "./i18n";
import { Sec } from "./secondary";

const DIET: Record<Diet, { label: string; colour: string; key: MenuUiKey }> = {
  veg: { label: "Vegetarian", colour: "text-veg", key: "diet.veg" },
  non_veg: { label: "Non-vegetarian", colour: "text-non-veg", key: "diet.non_veg" },
  egg: { label: "Contains egg", colour: "text-egg", key: "diet.egg" },
};

/**
 * Shape (square frame + dot / triangle / ring) + colour + screen-reader text, never colour alone. With a secondary
 * language the screen-reader text is bilingual too (the secondary part in its own lang run).
 */
export function DietMark({ diet, sec = null }: { diet: Diet; sec?: MenuSecondary | null }) {
  const d = DIET[diet];
  return (
    <span className={`inline-flex shrink-0 items-center ${d.colour}`}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <rect
          x="1"
          y="1"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {diet === "veg" ? <circle cx="8" cy="8" r="3.5" fill="currentColor" /> : null}
        {diet === "non_veg" ? <path d="M8 3.5 12.5 12H3.5z" fill="currentColor" /> : null}
        {diet === "egg" ? (
          <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        ) : null}
      </svg>
      <span className="sr-only">
        {d.label}
        {sec?.t(d.key) ? (
          <>
            {" "}
            <Sec text={sec.t(d.key)} lang={sec.bcp47} />
          </>
        ) : null}
      </span>
    </span>
  );
}

const TAG_LABEL: Record<MenuTag, string> = {
  spicy: "Spicy",
  new: "New",
  bestseller: "Bestseller",
  chef_pick: "Chef's pick",
};

const TAG_KEY: Record<MenuTag, MenuUiKey> = {
  spicy: "tag.spicy",
  new: "tag.new",
  bestseller: "tag.bestseller",
  chef_pick: "tag.chef_pick",
};

/** Secondary text inside an uppercase, tracked badge or stamp: no case change or tracking for other scripts. */
const IN_BADGE = "font-normal tracking-normal normal-case";

function TagBadge({ tag, sec }: { tag: MenuTag; sec: MenuSecondary | null }) {
  const label = (
    <>
      <span>{TAG_LABEL[tag]}</span>
      <Sec text={sec?.t(TAG_KEY[tag])} lang={sec?.bcp47} className={IN_BADGE} />
    </>
  );
  if (tag === "spicy") return <Badge tone="danger">{label}</Badge>;
  if (tag === "new") return <Badge tone="accent">{label}</Badge>;
  // house favourites: soot tag with a marigold diamond (concept C "tag-fav")
  return (
    <Badge tone="ink">
      <span aria-hidden="true" className="ornament-diamond text-accent h-1.5 w-1.5" />
      {label}
    </Badge>
  );
}

/**
 * Sold-out stamp: English label (matched by tests and read by screen readers). English only: a decorative, hidden
 * Devanagari echo (concept C). With a secondary language the echo makes way for that language's word, as real text.
 */
export function SoldOutStamp({ sec = null }: { sec?: MenuSecondary | null }) {
  return (
    <Stamp>
      <span>Sold out</span>
      {sec ? (
        <Sec
          text={sec.t("item.sold_out")}
          lang={sec.bcp47}
          className={`text-[0.875rem] ${IN_BADGE}`}
        />
      ) : ACCENT.soldOut ? (
        <span
          aria-hidden="true"
          lang="ne"
          className="font-deva text-[0.875rem] font-normal tracking-normal normal-case"
        >
          {ACCENT.soldOut}
        </span>
      ) : null}
    </Stamp>
  );
}

/**
 * One menu row, ledger style: diet mark, name, dotted leader, price; details underneath. `sec` = the guest's secondary
 * language (null = English only): its name sits under the English one, smaller and muted, and every other line gets
 * its own secondary run. The h3 stays English, so the row's accessible name and the tests do not change.
 */
export type MenuItemAction = {
  onAdd: () => void;
  /** How many of this item are in the table cart. */
  inCart: number;
  label: { en: string; sec: string | null; lang: string | undefined };
  inCartText: { en: string; sec: string | null } | null;
};

export function MenuItemCard({
  item,
  sec = null,
  action = null,
}: {
  item: MenuItem;
  sec?: MenuSecondary | null;
  /** Table ordering (2.0.0): an "Add" button, only while the guest has joined a table and can order. */
  action?: MenuItemAction | null;
}) {
  const out = item.isSoldOut;
  const secName = sec?.itemName(item) ?? null;
  const say = sec?.pronunciation(item) ?? null;
  const secDescription = sec?.itemDescription(item) ?? null;
  return (
    <li
      className={`border-line/80 flex gap-4 border-b px-1 py-3 last:border-b-0 ${out ? "hatch-soldout" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h3
            className={`flex min-w-0 items-center gap-2 text-[1.0625rem] leading-snug font-semibold ${out ? "text-ink-muted" : ""}`}
          >
            <DietMark diet={item.diet} sec={sec} />
            {/* BUG-017: min-w-0 + wrap-anywhere let a long unbroken name wrap inside the row; the price keeps its width */}
            <span className="min-w-0 wrap-anywhere">{item.name}</span>
          </h3>
          <span aria-hidden="true" className="leader" />
          <p className="price shrink-0 text-[1.1875rem]">
            {out ? (
              <>
                <span className="sr-only">Price </span>
                <s className="text-ink-muted">{formatNpr(item.price)}</s>
              </>
            ) : (
              formatNpr(item.price)
            )}
          </p>
        </div>
        {sec && secName ? (
          <p className="text-ink-muted mt-0.5 pl-6 text-[0.9375rem] leading-snug wrap-anywhere">
            <span lang={sec.bcp47}>{secName}</span>
            {/* Nepali mode only: the romanised "Say it" aid (romanised Nepali, so lang="ne-Latn"). An inline-block capped
                at the line width: it moves to its own line as a unit, and only a run longer than the line wraps inside */}
            {say ? (
              <>
                {" "}
                <span className="inline-block max-w-full text-xs">
                  {"· "}Say it: <span lang="ne-Latn">{say}</span>
                </span>
              </>
            ) : null}
          </p>
        ) : null}
        {item.description ? (
          <p className="text-ink-muted mt-1 pl-6 text-sm leading-relaxed wrap-break-word">
            {item.description}
          </p>
        ) : null}
        {sec && secDescription ? (
          <p
            lang={sec.bcp47}
            className="text-ink-muted mt-0.5 pl-6 text-sm leading-relaxed wrap-break-word"
          >
            {secDescription}
          </p>
        ) : null}
        {out || item.tags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-6">
            {out ? <SoldOutStamp sec={sec} /> : null}
            {item.tags.map((t) => (
              <TagBadge key={t} tag={t} sec={sec} />
            ))}
          </div>
        ) : null}
        {out ? (
          <p className="text-ink-muted mt-1.5 pl-6 text-sm">
            Not available right now. Ask staff when it will be back.
            <Sec text={sec?.t("item.sold_out_line")} lang={sec?.bcp47} block />
          </p>
        ) : null}
        {item.variants.length > 0 && !out ? (
          <ul
            className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-6 text-sm"
            aria-label={`Options for ${item.name}`}
          >
            {item.variants.map((v) => {
              const secLabel = sec?.variantLabel(v) ?? null;
              return (
                <li key={v.id} className={v.isSoldOut ? "text-ink-muted" : ""}>
                  {v.isSoldOut ? (
                    <>
                      <s>{v.label}</s>
                      {sec && secLabel ? (
                        <>
                          {" "}
                          <s lang={sec.bcp47}>{secLabel}</s>
                        </>
                      ) : null}{" "}
                      <span className="font-semibold">(sold out)</span>
                      <Sec
                        text={sec?.t("variant.sold_out_suffix")}
                        lang={sec?.bcp47}
                        className="ml-1 font-semibold"
                      />
                    </>
                  ) : (
                    <>
                      {v.label}
                      {sec && secLabel ? (
                        <>
                          {" "}
                          <span lang={sec.bcp47}>{secLabel}</span>
                        </>
                      ) : null}
                      {v.priceDelta > 0 ? ` +${formatNpr(v.priceDelta)}` : ""}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {action && !out ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 pl-6">
            <button
              type="button"
              onClick={action.onAdd}
              aria-haspopup={item.variants.length > 0 ? "dialog" : undefined}
              className="min-h-tap rounded-control border-primary text-primary hover:bg-surface-alt inline-flex items-center gap-1.5 border px-4 font-semibold transition-colors duration-(--motion-base)"
            >
              <span aria-hidden="true">+</span>
              {action.label.en}
              {action.label.sec && action.label.lang ? (
                <span lang={action.label.lang} className="font-normal">
                  {action.label.sec}
                </span>
              ) : null}
              <span className="sr-only"> {item.name}</span>
            </button>
            {action.inCart > 0 && action.inCartText ? (
              <span className="text-ink-muted text-sm tabular-nums">
                {action.inCartText.en}
                {action.inCartText.sec && action.label.lang ? (
                  <span lang={action.label.lang}> · {action.inCartText.sec}</span>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {item.imageUrl ? (
        <div
          className={`rounded-card w-24 shrink-0 self-start overflow-hidden sm:w-32 ${out ? "opacity-70" : ""}`}
        >
          <Picture
            url={item.imageUrl}
            variants={item.imageVariants}
            alt=""
            sizes="(min-width: 640px) 128px, 96px"
            ratio="aspect-square"
            placeholderLabel={item.name}
            compact
          />
        </div>
      ) : null}
    </li>
  );
}

/** Compact ledger line for teasers (home page): name, leader, price, short description. No sold-out state. */
export function LedgerLine({ item }: { item: MenuItem }) {
  return (
    <li className="border-primary/25 border-b py-3 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="flex min-w-0 items-center gap-2 text-[1.0625rem] leading-snug font-semibold">
          <DietMark diet={item.diet} />
          <span className="min-w-0 wrap-anywhere">{item.name}</span>
        </span>
        <span aria-hidden="true" className="leader" />
        <span className="price shrink-0 text-[1.1875rem]">{formatNpr(item.price)}</span>
      </div>
      {item.description ? (
        <p className="text-ink-muted mt-0.5 pl-6 text-sm leading-relaxed">{item.description}</p>
      ) : null}
    </li>
  );
}

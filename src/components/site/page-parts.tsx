import type { ReactNode } from "react";

/** Shared layout pieces for the public pages. Server-safe (no hooks), so client views can use them too. */

const WIDTH = {
  page: "max-w-page",
  reading: "max-w-reading",
  narrow: "max-w-narrow",
} as const;

export function Container({
  width = "page",
  className = "",
  children,
}: {
  width?: keyof typeof WIDTH;
  className?: string;
  children: ReactNode;
}) {
  return <div className={`px-gutter mx-auto w-full ${WIDTH[width]} ${className}`}>{children}</div>;
}

/** Small uppercase label above a heading, with a diamond. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`text-eyebrow text-primary flex items-center gap-2.5 font-semibold uppercase ${className}`}
    >
      <span aria-hidden="true" className="ornament-diamond" />
      {children}
    </p>
  );
}

/** Decorative Devanagari accent that repeats the heading next to it (hidden from screen readers). */
export function Accent({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p
      aria-hidden="true"
      lang="ne"
      className={`font-deva text-deva-accent text-primary ${className}`}
    >
      {children}
    </p>
  );
}

/**
 * Page title block: optional Devanagari accent, the one h1, an optional intro, and the centred ornament rule.
 * `align="start"` for working pages (cart, checkout, order), centred for editorial ones.
 */
export function PageHeader({
  title,
  accent,
  eyebrow,
  intro,
  align = "center",
  children,
  className = "",
}: {
  title: ReactNode;
  accent?: string;
  eyebrow?: ReactNode;
  intro?: ReactNode;
  align?: "center" | "start";
  children?: ReactNode;
  className?: string;
}) {
  const centred = align === "center";
  return (
    <header className={`rise-stagger space-y-2 ${centred ? "text-center" : ""} ${className}`}>
      {accent ? <Accent>{accent}</Accent> : null}
      {eyebrow ? <Eyebrow className={centred ? "justify-center" : ""}>{eyebrow}</Eyebrow> : null}
      <h1 className="font-display text-title-1 text-ink">{title}</h1>
      {intro ? (
        <div
          className={`text-ink-muted text-lead ${centred ? "max-w-reading mx-auto" : "max-w-reading"}`}
        >
          {intro}
        </div>
      ) : null}
      {children}
      {centred ? (
        <div aria-hidden="true" className="ornament-rule pt-1">
          <i />
        </div>
      ) : null}
    </header>
  );
}

/** Section heading used inside pages (h2), with an optional eyebrow and intro line. */
export function SectionHeading({
  id,
  title,
  eyebrow,
  intro,
  align = "start",
  inverse = false,
}: {
  id: string;
  title: ReactNode;
  eyebrow?: ReactNode;
  intro?: ReactNode;
  align?: "center" | "start";
  inverse?: boolean;
}) {
  const centred = align === "center";
  return (
    <div className={`space-y-2 ${centred ? "text-center" : ""}`}>
      {eyebrow ? (
        inverse ? (
          <p
            className={`text-eyebrow text-on-feature flex items-center gap-2.5 font-semibold uppercase ${centred ? "justify-center" : ""}`}
          >
            <span aria-hidden="true" className="ornament-diamond text-accent" />
            {eyebrow}
          </p>
        ) : (
          <Eyebrow className={centred ? "justify-center" : ""}>{eyebrow}</Eyebrow>
        )
      ) : null}
      <h2 id={id} className="font-display text-title-2">
        {title}
      </h2>
      {intro ? (
        <p
          className={`text-lead ${inverse ? "text-on-feature-muted" : "text-ink-muted"} ${centred ? "max-w-reading mx-auto" : "max-w-reading"}`}
        >
          {intro}
        </p>
      ) : null}
    </div>
  );
}

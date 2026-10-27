import type { ReactNode } from "react";

type Tone = "info" | "warning" | "danger" | "success";

const tones: Record<Tone, { box: string; mark: string }> = {
  info: { box: "border-line border-l-primary", mark: "text-primary" },
  warning: { box: "border-accent", mark: "text-accent" },
  danger: { box: "border-danger", mark: "text-danger" },
  success: { box: "border-success", mark: "text-success" },
};

/** Inline message. `alert` interrupts screen readers, `status` is polite. Tone is shown by the left rule AND the words. */
export function Banner({
  tone = "info",
  title,
  children,
  live,
  className = "",
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  live?: "status" | "alert";
  className?: string;
}) {
  const t = tones[tone];
  return (
    <div
      role={live}
      className={`bg-surface-raised text-ink rounded-card shadow-hairline border border-l-4 px-4 py-3 ${t.box} ${className}`}
    >
      {title ? (
        <p className="flex items-center gap-2.5 font-semibold">
          <span aria-hidden="true" className={`ornament-diamond ${t.mark}`} />
          {title}
        </p>
      ) : null}
      {children ? (
        <div className={`text-sm leading-relaxed ${title ? "mt-0.5 pl-[1.1rem]" : ""}`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Clearly marks placeholder copy / sample data so nobody mistakes it for real content. */
export function DraftNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-accent bg-surface-alt text-ink rounded-card inline-block border border-dashed px-3 py-1.5 text-sm">
      <span className="font-semibold">Placeholder:</span> {children}
    </p>
  );
}

export function SampleDataBanner() {
  return (
    <Banner tone="warning" title="Sample data">
      Everything shown here is made-up development data. The real menu, products and prices will
      come from the cafe.
    </Banner>
  );
}

const badgeTones = {
  neutral: "border-line bg-surface-raised text-ink",
  accent: "border-transparent bg-accent text-on-accent",
  danger: "border-danger bg-surface-raised text-danger",
  success: "border-transparent bg-success text-on-success",
  primary: "border-transparent bg-primary text-on-primary",
  ink: "border-transparent bg-surface-inverse text-on-inverse",
} as const;

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof badgeTones;
  children: ReactNode;
}) {
  return (
    <span
      className={`rounded-control inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs leading-5 font-semibold tracking-[0.08em] uppercase ${badgeTones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Rubber-stamp status label (sold out). Text, so it is never colour alone. */
export function Stamp({ children }: { children: ReactNode }) {
  return <span className="stamp">{children}</span>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`skeleton-shimmer animate-shimmer rounded-control ${className}`}
    />
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="border-line bg-surface-raised rounded-card shadow-card border px-6 py-10 text-center">
      <div aria-hidden="true" className="ornament-rule mb-5">
        <i />
      </div>
      <p className="font-display text-title-3">{title}</p>
      {children ? <p className="text-ink-muted mx-auto mt-2 max-w-md">{children}</p> : null}
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}

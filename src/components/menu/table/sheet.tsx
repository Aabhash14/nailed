"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Modal sheet on the native <dialog> (showModal): focus moves in and is kept inside, Escape closes, the page behind
 * is inert, and focus returns to the opener on close. Phones: a bottom sheet over the full width; from `sm`: a centred
 * card. Used by the guest table UI and the staff tables board (admin passes `plain` for no paper styling).
 * ASSUMPTION (ux-ui-designer): the design system has no modal yet; this follows the card tokens (surface-raised,
 * rounded-card, shadow-card, line border) with a soot backdrop.
 */
export function Sheet({
  open,
  onClose,
  title,
  titleExtra,
  children,
  footer,
  closeLabel = "Close",
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** A second line under the title (the guest's secondary language). */
  titleExtra?: ReactNode;
  children: ReactNode;
  /** Sticky actions at the bottom (stay visible while the body scrolls). */
  footer?: ReactNode;
  closeLabel?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", ""); // very old browsers: at least show it
      }
    } else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const handler = () => onCloseRef.current();
    d.addEventListener("close", handler);
    return () => d.removeEventListener("close", handler);
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-t`}
      className={`bg-surface-raised text-ink border-line rounded-card shadow-card backdrop:bg-surface-inverse/60 fixed inset-x-0 bottom-0 mx-auto mt-auto mb-0 max-h-[92dvh] w-full max-w-none border p-0 sm:inset-y-0 sm:m-auto sm:max-h-[85dvh] ${wide ? "sm:max-w-2xl" : "sm:max-w-lg"}`}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close(); // a tap on the backdrop
      }}
    >
      {open ? (
        <div className="flex max-h-[inherit] flex-col">
          <header className="border-line flex items-start justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <h2 id={`${id}-t`} className="font-display text-title-3 wrap-break-word">
                {title}
              </h2>
              {titleExtra}
            </div>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="min-h-tap text-primary rounded-control shrink-0 px-2 font-semibold underline underline-offset-4"
            >
              {closeLabel}
            </button>
          </header>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">{children}</div>
          {footer ? <div className="border-line bg-surface-raised border-t px-4 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** English text with the secondary language after it (or on its own line with `block`). */
export function Both({
  en,
  sec,
  lang,
  block = false,
  secClassName = "",
}: {
  en: ReactNode;
  sec: string | null | undefined;
  lang: string | undefined;
  block?: boolean;
  secClassName?: string;
}) {
  return (
    <>
      {en}
      {sec && lang ? (
        <>
          {block ? null : " "}
          <span lang={lang} className={`wrap-break-word font-normal ${block ? "block" : ""} ${secClassName}`.trim()}>
            {sec}
          </span>
        </>
      ) : null}
    </>
  );
}

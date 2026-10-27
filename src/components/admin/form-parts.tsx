"use client";

import { useEffect, useId, useRef, type RefObject } from "react";
import { Button } from "@/components/ui/button";

/** Shared behaviour for the admin edit forms (products, menu items, settings). */

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Focus an element without the browser's jump, then scroll it into view (smooth unless reduced motion is on). */
export function focusAndReveal(el: HTMLElement | null | undefined, block: ScrollLogicalPosition = "start"): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/**
 * BUG-008 / design review T-048 fix 4: a form opened by Edit or Add renders at the top of the page, so on a phone it
 * used to open off-screen. On mount, move focus to the form heading (`tabIndex={-1}`) and scroll it into view.
 */
export function useRevealOnMount(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    focusAndReveal(ref.current);
  }, [ref]);
}

/**
 * Remembers the button that opened a form, and gives focus back to it when the form closes (Save or Cancel). If that
 * button is gone (its item was deleted), focus goes to `fallback` (the page heading) instead.
 */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    remember(el: HTMLElement | null) {
      opener.current = el;
    },
    restore(fallback?: HTMLElement | null) {
      const el = opener.current;
      opener.current = null;
      // after React has removed the form and re-rendered the list
      requestAnimationFrame(() => focusAndReveal(el && el.isConnected ? el : fallback, "center"));
    },
  };
}

/**
 * Design review T-048 fix 14 (Cancel part): with unsaved changes, Cancel asks first. Inline, not a modal, so it works
 * one-handed and never traps focus. Focus starts on "Keep editing" (the safe choice).
 * Copy is a working draft (placeholder until content-writer T-052).
 */
export function DiscardConfirm({ onDiscard, onKeep }: { onDiscard: () => void; onKeep: () => void }) {
  const id = useId();
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => keepRef.current?.focus(), []);
  return (
    <div role="alertdialog" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} className="border-danger rounded-control w-full space-y-2 border-2 p-3">
      <p id={`${id}-t`} className="font-semibold">
        Discard your changes?
      </p>
      <p id={`${id}-d`} className="text-sm">
        Nothing you changed in this form has been saved yet.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button variant="danger" onClick={onDiscard}>
          Discard
        </Button>
        <Button ref={keepRef} variant="secondary" onClick={onKeep}>
          Keep editing
        </Button>
      </div>
    </div>
  );
}

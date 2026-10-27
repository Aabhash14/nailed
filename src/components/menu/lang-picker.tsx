"use client";

import { useEffect, useRef } from "react";
import type { MenuLang } from "./i18n";
import { MENU_LANG_OPTIONS, parseMenuLang } from "./i18n";

/**
 * Menu language picker (concept C controls: raised paper, stone border, brick focus ring). A native <select> with a
 * visible label: accessible, keyboard-friendly, and the phone's own picker on mobile. 44 px tall, 16 px text so iOS
 * does not zoom. Each option is labelled in its own script and carries that language's lang="".
 *
 * BUG-018: the page is server-rendered, so the select is usable before React has hydrated. A choice made then never
 * reaches onChange, and the next render would put the controlled value back. Hydration itself leaves a select's DOM
 * value alone, so on mount we read it: if it differs from what was rendered, the guest picked something early and we
 * adopt it. (Child effects run before the parent's, so this happens before MenuView's first re-render.)
 * Known limit: picking "English only" early while another language is stored cannot be told apart from no pick.
 */
export function MenuLangPicker({
  value,
  onChange,
  id = "menu-lang",
}: {
  value: MenuLang;
  onChange: (v: MenuLang) => void;
  id?: string;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  const firstRender = useRef({ value, onChange });
  useEffect(() => {
    const el = ref.current;
    const { value: rendered, onChange: change } = firstRender.current;
    if (el && el.value !== rendered) change(parseMenuLang(el.value));
  }, []);

  return (
    <div className="inline-flex items-center gap-2">
      <label htmlFor={id} className="text-ink-muted text-sm font-semibold">
        Language
      </label>
      <span className="relative inline-flex">
        <select
          ref={ref}
          id={id}
          value={value}
          onChange={(e) => onChange(parseMenuLang(e.target.value))}
          className="min-h-tap rounded-control border-line-strong bg-surface-raised text-ink hover:border-ink focus-visible:border-primary ease-soft cursor-pointer appearance-none border py-2 pr-9 pl-3 text-base transition-[border-color] duration-(--motion-fast)"
        >
          {MENU_LANG_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} lang={o.lang}>
              {o.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          className="text-ink-muted pointer-events-none absolute top-1/2 right-3 -translate-y-1/2"
        >
          <path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" strokeWidth="1.75" />
        </svg>
      </span>
    </div>
  );
}

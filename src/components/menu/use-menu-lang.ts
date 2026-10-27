"use client";
// Owner: frontend-engineer. Menu language mode (same pattern as projects/aduwa src/hooks/use-menu-lang.ts).
// English is always shown; the mode adds one secondary language. localStorage['nailed.menuLang'] =
// 'none' | 'ne' | 'zh' | 'ja' | 'ko' | 'pt', default 'none'. Strict values only: anything else reads as the default.
// Not a cookie, never sent to the server, so the ISR page stays one static English render. The server snapshot is
// the default; useSyncExternalStore swaps to the stored mode right after hydration, with no hydration mismatch.
import { useCallback, useEffect, useReducer, useSyncExternalStore } from "react";
import {
  DEFAULT_MENU_LANG,
  MENU_LANG_STORAGE_KEY,
  getMenuSecondary,
  loadMenuSecondary,
  parseMenuLang,
  type MenuLang,
  type MenuSecondary,
} from "./i18n";

const listeners = new Set<() => void>();

function read(): MenuLang {
  try {
    return parseMenuLang(window.localStorage.getItem(MENU_LANG_STORAGE_KEY));
  } catch {
    return DEFAULT_MENU_LANG; // storage blocked
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === MENU_LANG_STORAGE_KEY || e.key === null) l(); // another tab changed it (or cleared storage)
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

const serverSnapshot = () => DEFAULT_MENU_LANG;

export function useMenuLang(): [MenuLang, (next: MenuLang) => void] {
  const mode = useSyncExternalStore(subscribe, read, serverSnapshot);
  const setMode = useCallback((next: MenuLang) => {
    try {
      window.localStorage.setItem(MENU_LANG_STORAGE_KEY, parseMenuLang(next));
    } catch {
      /* private mode / storage full: the choice just is not remembered */
    }
    listeners.forEach((l) => l());
  }, []);
  return [mode, setMode];
}

/**
 * The secondary-language helper for a mode, or null (English only). Its pack loads on first use; until it arrives
 * (or if it fails offline) the menu shows English only, then re-renders with the secondary text.
 */
export function useMenuSecondary(mode: MenuLang): MenuSecondary | null {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const sec = getMenuSecondary(mode);
  useEffect(() => {
    if (sec !== undefined || mode === "none") return;
    let live = true;
    loadMenuSecondary(mode).then(
      () => {
        if (live) rerender();
      },
      () => {
        /* chunk failed (offline): stay English only; the next mode change retries */
      },
    );
    return () => {
      live = false;
    };
  }, [mode, sec]);
  return sec ?? null;
}

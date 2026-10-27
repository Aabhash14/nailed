"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  addLine,
  itemCount,
  parseStoredCart,
  removeLine,
  setQty,
  subtotal,
  type CartLine,
} from "./cart-logic";

const KEY = "nc-cart-v1";

type CartApi = {
  lines: CartLine[];
  ready: boolean;
  count: number;
  subtotal: number;
  add: (line: Omit<CartLine, "qty">, qty?: number) => void;
  setQty: (variantId: string, qty: number) => void;
  remove: (variantId: string) => void;
  clear: () => void;
};

const Ctx = createContext<CartApi | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setLines(parseStoredCart(window.localStorage.getItem(KEY)));
    setReady(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setLines(parseStoredCart(e.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const commit = useCallback((next: CartLine[]) => {
    setLines(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* private mode: cart lives for this page only */
    }
  }, []);

  const api = useMemo<CartApi>(
    () => ({
      lines,
      ready,
      count: itemCount(lines),
      subtotal: subtotal(lines),
      add: (line, qty) => commit(addLine(lines, line, qty)),
      setQty: (id, qty) => commit(setQty(lines, id, qty)),
      remove: (id) => commit(removeLine(lines, id)),
      clear: () => commit([]),
    }),
    [lines, ready, commit],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useCart(): CartApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCart must be used inside CartProvider");
  return v;
}

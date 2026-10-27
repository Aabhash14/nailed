"use client";

import dynamic from "next/dynamic";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { HINT_EVENT, parseTableParam, readHint, TABLE_HINT_KEY, takeScannedCode } from "./hint";
import type { TableOrderingProps } from "./table-ordering";

/**
 * EAGER part of table ordering (ships with /menu, so it stays tiny). The real UI (occupancy, join, cart, rounds,
 * Turnstile) is the lazy chunk below, fetched only when the guest can use it. No server render: ssr false.
 */
const TableOrdering = dynamic(() => import("./table-ordering"), { ssr: false, loading: () => null });

export function TableOrderingLazy(props: TableOrderingProps) {
  return <TableOrdering {...props} />;
}

/**
 * SEC-024 / F1: on FIRST MOUNT read `?t=` and the scanned code (`#c=`, or a legacy `?code=`), then replace the address
 * at once so the code is gone before any fetch, the join sheet or Turnstile. A layout effect runs before the menu's
 * own polling effect. The code is kept in memory only.
 */
export function useTableQr(): { tableParam: number | null; scannedCode: string | null; ready: boolean } {
  const [qr, setQr] = useState<{ tableParam: number | null; scannedCode: string | null; ready: boolean }>({
    tableParam: null,
    scannedCode: null,
    ready: false,
  });
  useLayoutEffect(() => {
    const href = window.location.href;
    const { code, cleanUrl } = takeScannedCode(href);
    if (cleanUrl !== null) window.history.replaceState(null, "", cleanUrl);
    setQr({ tableParam: parseTableParam(new URL(href).searchParams.get("t")), scannedCode: code, ready: true });
  }, []);
  return qr;
}

function subscribeHint(cb: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === TABLE_HINT_KEY || e.key === null) cb();
  };
  window.addEventListener(HINT_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(HINT_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** The table number in the local join hint (under 12 h old), or null. Null on the server and before hydration. */
export function useHintTable(): number | null {
  return useSyncExternalStore(
    subscribeHint,
    () => readHint()?.tableNumber ?? null,
    () => null,
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminApi } from "@/data-access/admin";
import type { TableBoard } from "@/types/contract";
import { mergeBoard, newRoundIds } from "./board-logic";

export const BOARD_POLL_MS = 30_000;

export function beep() {
  try {
    const ctx = new window.AudioContext();
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 660;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    osc.onended = () => void ctx.close();
  } catch {
    /* audio not available: the badge still shows */
  }
}

/**
 * The staff Tables board feed (api-contract 2.0.0 section 5, ADR 0002 decision 5 and free-tier rules 1 and 3):
 *  - getTableBoard({ since: cursor }) every 30 s, ONLY while the tab is visible; at once on return to the tab and
 *    right after every staff action (`reload`). The board is rendered here in the browser; no server render per poll;
 *  - `{ changed: false }` keeps the board (only the server clock moves); the full board only after a change;
 *  - a failed poll keeps the last board on screen, marked old, and records "offline since" (contract 9.12).
 */
export function useTableBoard(sound: boolean) {
  const [board, setBoard] = useState<TableBoard | null>(null);
  const [clock, setClock] = useState<{ serverTime: string; receivedAt: number } | null>(null);
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<string | null>(null);
  const boardRef = useRef<TableBoard | null>(null);
  const cursor = useRef<string | undefined>(undefined);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const inFlight = useRef<Promise<void> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (inFlight.current) return inFlight.current; // never two polls at once
    const run = (async () => {
      let res = await adminApi.getTableBoard(cursor.current !== undefined ? { since: cursor.current } : {});
      // `changed: false` with no board to keep: ask once without `since` (the contract's only other full read)
      if (res.ok && !res.data.changed && !boardRef.current) res = await adminApi.getTableBoard({});
      if (!res.ok) {
        setOfflineSince((s) => s ?? new Date().toISOString());
        setLastError(res.error.message);
        return;
      }
      const merged = mergeBoard(boardRef.current, res.data);
      if (merged.board && merged.board !== boardRef.current) {
        if (soundRef.current && newRoundIds(boardRef.current, merged.board).length > 0) beep();
        boardRef.current = merged.board;
        setBoard(merged.board);
      }
      cursor.current = merged.needFull ? undefined : merged.cursor;
      setClock({ serverTime: merged.serverTime, receivedAt: Date.now() });
      setOfflineSince(null);
      setLastError(null);
      setLastOkAt(new Date().toISOString());
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) timer = setInterval(() => void load(), BOARD_POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") {
      void load();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    // Mock mode only: another tab (a guest sending a round) changed the browser db. Live: null (no staff Realtime).
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const off = adminApi.subscribeOrders(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (document.visibilityState === "visible") void load();
      }, 500);
    });
    return () => {
      stop();
      if (debounce) clearTimeout(debounce);
      off?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  return { board, clock, offlineSince, lastError, lastOkAt, reload: load };
}

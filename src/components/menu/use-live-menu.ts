"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MenuFetchError,
  fetchMenuSnapshot,
  subscribeMenu,
  type MenuSubscription,
} from "@/data-access/public-client";
import type { MenuSnapshot } from "@/types/contract";

/**
 * Live menu hook, following api-contract.md section 5:
 *  - runs ONLY while the tab is visible; closes after 10 min hidden and refetches once on return
 *  - one multiplexed subscription (see subscribeMenu); events trigger a debounced (500 ms) refetch
 *  - when there is no subscription or it errors, polls every 30 s while visible (never faster)
 */
export const POLL_MS = 30_000;
export const HIDDEN_CLOSE_MS = 10 * 60_000;
export const DEBOUNCE_MS = 500;
export const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * After a failed read, how long to leave the server alone (contract 1.3.3: /api/menu can answer 429 with Retry-After).
 * The server's Retry-After wins (capped at MAX_BACKOFF_MS); otherwise 30 s, 60 s, 120 s... up to MAX_BACKOFF_MS.
 * The last good menu stays on screen the whole time.
 */
export function backoffMs(failures: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(Math.max(retryAfterMs, 0), MAX_BACKOFF_MS);
  return Math.min(POLL_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

export type LiveState = "live" | "polling" | "offline";

export function useLiveMenu(initial: MenuSnapshot) {
  const [snapshot, setSnapshot] = useState(initial);
  const [state, setState] = useState<LiveState>("polling");
  const [lastOk, setLastOk] = useState<string>(initial.updatedAt);

  const failures = useRef(0);
  const quietUntil = useRef(0);

  const refetch = useCallback(async () => {
    if (Date.now() < quietUntil.current) return; // backing off: keep the last snapshot, ask again later
    try {
      const next = await fetchMenuSnapshot();
      failures.current = 0;
      quietUntil.current = 0;
      setSnapshot(next);
      setLastOk(new Date().toISOString());
      setState((s) => (s === "offline" ? "polling" : s));
    } catch (e) {
      failures.current += 1;
      quietUntil.current =
        Date.now() +
        backoffMs(failures.current, e instanceof MenuFetchError ? e.retryAfterMs : null);
      setState("offline");
    }
  }, []);

  useEffect(() => {
    let sub: MenuSubscription | null = null;
    let subscribed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    let active = false;

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
    const startPolling = () => {
      if (!pollTimer) pollTimer = setInterval(() => void refetch(), POLL_MS);
    };

    const stop = () => {
      active = false;
      stopPolling();
      if (debounce) clearTimeout(debounce);
      sub?.close();
      sub = null;
      subscribed = false;
    };

    const start = () => {
      if (active) return;
      active = true;
      void refetch();
      sub = subscribeMenu({
        onEvent: () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void refetch(), DEBOUNCE_MS);
        },
        onStatus: (s) => {
          subscribed = s === "subscribed";
          setState(subscribed ? "live" : "polling");
          if (subscribed) stopPolling();
          else startPolling();
        },
      });
      if (!sub && !subscribed) {
        setState("polling");
        startPolling();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (hiddenTimer) clearTimeout(hiddenTimer);
        hiddenTimer = null;
        if (!active) start();
        else {
          void refetch();
          if (!subscribed) startPolling();
        }
      } else {
        stopPolling(); // polling stops while hidden; subscription lives until the 10 minute mark
        hiddenTimer = setTimeout(stop, HIDDEN_CLOSE_MS);
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (hiddenTimer) clearTimeout(hiddenTimer);
      stop();
    };
  }, [refetch]);

  return { snapshot, state, lastOk };
}

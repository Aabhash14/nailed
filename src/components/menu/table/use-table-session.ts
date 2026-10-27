"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTableSession } from "@/data-access/tables-client";
import type { TableSessionView } from "@/types/contract";
import { clearHint, readHint, writeHint } from "./hint";
import { GUEST_POLL_MS, guestPollDelay, hasLiveRound } from "./table-logic";

/**
 * The guest's own table session (api-contract 2.0.0 sections 5 and 9.4, ADR 0002 free-tier rule 3):
 *  - on mount, GET /api/table/session ONLY if the local join hint exists and is under 12 h old;
 *  - then poll with `since=<rev>` every 30 s (never under 15 s), only while the tab is visible AND a round is
 *    `new` or `preparing`; once more on return to the tab; never otherwise;
 *  - "none" or "closed" deletes the hint. Errors keep the last view on screen and try again later.
 */
export type GuestSession =
  | { status: "checking" }
  | { status: "none"; ended: boolean }
  | { status: "closed"; tableNumber: number }
  | { status: "open"; view: TableSessionView };

export function useTableSession() {
  const [session, setSession] = useState<GuestSession>({ status: "checking" });
  const [pollFailed, setPollFailed] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const retryAfter = useRef<number | null>(null);

  const read = useCallback(async (useSince: boolean) => {
    const current = sessionRef.current;
    const since = useSince && current.status === "open" ? current.view.rev : undefined;
    const res = await fetchTableSession(since);
    if (!res.ok) {
      retryAfter.current = res.retryAfterMs;
      setPollFailed(true);
      // never joined before this read: nothing to show, ask again on the next trigger
      if (sessionRef.current.status === "checking") setSession({ status: "none", ended: false });
      return;
    }
    retryAfter.current = null;
    setPollFailed(false);
    const s = res.data;
    if (s.state === "unchanged") return;
    if (s.state === "open") {
      setSession({ status: "open", view: s.session });
      return;
    }
    clearHint();
    if (s.state === "closed") setSession({ status: "closed", tableNumber: s.tableNumber });
    else setSession({ status: "none", ended: sessionRef.current.status === "open" });
  }, []);

  // First read: only with a fresh hint (guests who never joined cost no request).
  useEffect(() => {
    if (readHint()) void read(false);
    else setSession({ status: "none", ended: false });
  }, [read]);

  const live = session.status === "open" && hasLiveRound(session.view);

  // Poll only while visible and a round is waiting or being prepared.
  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const schedule = () => {
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(async () => {
        await read(true);
        schedule();
      }, guestPollDelay(retryAfter.current));
    };
    const onVisibility = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.visibilityState === "visible") schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, read]);

  // Once on return to the tab while joined (rounds may have moved, or the table closed).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && sessionRef.current.status === "open") void read(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [read]);

  /** After a successful join (the hint is written here) or a send (the response carries the session). */
  const applyView = useCallback((view: TableSessionView, joined = false) => {
    if (joined) writeHint(view.tableNumber);
    setPollFailed(false);
    setSession({ status: "open", view });
  }, []);

  /** TABLE_SESSION_INVALID: forget the join (the cart stays). */
  const forget = useCallback(() => {
    clearHint();
    setSession({ status: "none", ended: true });
  }, []);

  const refresh = useCallback(() => read(true), [read]);

  return { session, pollFailed, applyView, forget, refresh, pollMs: GUEST_POLL_MS };
}

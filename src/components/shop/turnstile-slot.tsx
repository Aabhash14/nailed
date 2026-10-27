"use client";

import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { telHref } from "@/components/format";
import { isMock, turnstileSiteKey } from "@/data-access/mode";
import {
  BOT_CHECK_FAILED_HELP,
  BOT_CHECK_FAILED_LEAD,
  MOCK_TURNSTILE_KEY,
  mockTurnstileOutcome,
  noTokenReason,
  parseMockTurnstile,
  type NoTokenReason,
  type TurnstileStatus,
} from "./turnstile-logic";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      "timeout-callback"?: () => void;
      "unsupported-callback"?: () => void;
      "before-interactive-callback"?: () => void;
      "after-interactive-callback"?: () => void;
      appearance?: "always" | "execute" | "interaction-only";
      action?: string;
      size?: "normal" | "flexible" | "compact";
    },
  ) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** Mock mode: how long the fake check "runs" before it fails, so the failure arrives after the page, like the real one. */
const MOCK_FAIL_DELAY_MS = 800;

/** What a form can ask of the slot. */
export type TurnstileHandle = {
  status: () => TurnstileStatus;
  /** The form gave up waiting (no token, no widget): show the failure, and with `focus` move focus to "Try again". */
  fail: (opts?: { focus?: boolean }) => void;
};

function readMockMode() {
  try {
    return parseMockTurnstile(window.localStorage.getItem(MOCK_TURNSTILE_KEY));
  } catch {
    return null;
  }
}

/**
 * Cloudflare Turnstile slot (required on checkout by the contract, and on staff sign-in).
 * Live mode with NEXT_PUBLIC_TURNSTILE_SITE_KEY: loads Cloudflare's script and renders the widget (the one deliberate external call).
 * Mock mode: no external call; it supplies a fixed fake token so the flow can be tried.
 *
 * BUG-019: when the check cannot run (Cloudflare error, interactive timeout, unsupported browser, script blocked, or the
 * form gave up waiting) the widget is invisible (`interaction-only`), so the slot shows a plain message with a
 * "Try again" button in its place. "Try again" removes the widget and renders a fresh one (re-adding the script if it
 * failed to load). The token requirement and the server's verification do not change.
 */
export function TurnstileSlot({
  onToken,
  onFail,
  onRetry,
  phone,
  action,
  ref,
}: {
  onToken: (token: string | null) => void;
  /** The check failed (so a waiting submit can stop waiting). */
  onFail?: () => void;
  /** The person pressed "Try again" (so the form can clear its old error). */
  onRetry?: () => void;
  /** Checkout passes the cafe's phone for the "call us" line; staff sign-in passes none. */
  phone?: string | null;
  /** Turnstile `action` the server checks (table join: "table-join", contract 2.1.0 SEC-028). Optional; others omit it. */
  action?: string;
  ref?: Ref<TurnstileHandle>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const msgId = useId();
  const [status, setStatusState] = useState<TurnstileStatus>("loading");
  const statusRef = useRef<TurnstileStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const [focusTick, setFocusTick] = useState(0);

  // Latest callbacks, so a parent re-render never re-mounts the widget.
  const cb = useRef({ onToken, onFail, onRetry });
  useEffect(() => {
    cb.current = { onToken, onFail, onRetry };
  });

  const setStatus = useCallback((s: TurnstileStatus) => {
    statusRef.current = s;
    setStatusState(s);
  }, []);

  const markFailed = useCallback(() => {
    cb.current.onToken(null);
    if (statusRef.current !== "failed") setStatus("failed");
    cb.current.onFail?.();
  }, [setStatus]);

  useImperativeHandle(
    ref,
    () => ({
      status: () => statusRef.current,
      fail: (opts) => {
        if (statusRef.current !== "failed") setStatus("failed");
        if (opts?.focus) setFocusTick((n) => n + 1);
      },
    }),
    [setStatus],
  );

  // Focus "Try again" once it is on screen (after a submit found the check failed).
  useEffect(() => {
    if (focusTick > 0) retryButton.current?.focus();
  }, [focusTick]);

  useEffect(() => {
    if (!turnstileSiteKey) {
      const outcome = isMock ? mockTurnstileOutcome(readMockMode(), attempt) : "token";
      if (outcome === "fail") {
        const t = window.setTimeout(markFailed, MOCK_FAIL_DELAY_MS);
        return () => window.clearTimeout(t);
      }
      if (outcome === "token") {
        setStatus("ok");
        cb.current.onToken("mock-turnstile-token");
      }
      return; // "hang": no token and no error
    }
    const sitekey = turnstileSiteKey;
    let widgetId: string | undefined;
    let cancelled = false;
    const fail = () => {
      if (!cancelled) markFailed();
    };
    const mount = () => {
      if (cancelled || !box.current) return;
      const ts = window.turnstile;
      if (!ts) return fail(); // the script ran but did not set up Turnstile
      try {
        widgetId = ts.render(box.current, {
          sitekey,
          callback: (t) => {
            if (cancelled) return;
            setStatus("ok");
            cb.current.onToken(t);
          },
          // Cloudflare refreshes an expired token by itself (refresh-expired: auto); a submit waits for the new one,
          // and if none comes the form shows the failure then.
          "expired-callback": () => {
            if (cancelled) return;
            setStatus("loading");
            cb.current.onToken(null);
          },
          "error-callback": fail,
          "timeout-callback": fail,
          "unsupported-callback": fail,
          "before-interactive-callback": () => {
            if (!cancelled) setStatus("interactive");
          },
          "after-interactive-callback": () => {
            if (!cancelled && statusRef.current === "interactive") setStatus("loading");
          },
          // S25-2 (R24-14): no empty box above "Place order". The widget only shows when Cloudflare needs the guest to
          // interact; it still runs and hands back a token in the background, and the form waits for it as before.
          appearance: "interaction-only",
          size: "flexible",
          ...(action ? { action } : {}),
        });
      } catch {
        fail();
      }
    };

    let script: HTMLScriptElement | null = null;
    if (window.turnstile) mount();
    else {
      script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
      if (script?.dataset.state === "error") {
        script.remove(); // a failed load is not retried by the browser: add a fresh tag
        script = null;
      }
      if (script?.dataset.state === "loaded") {
        mount(); // loaded earlier but window.turnstile is missing: mount() reports the failure
        script = null;
      } else {
        if (!script) {
          const s = document.createElement("script");
          s.src = SCRIPT_SRC;
          s.async = true;
          // Recorded on the tag so a later mount (or Try again) knows how the load went.
          s.addEventListener("load", () => {
            s.dataset.state = "loaded";
          });
          s.addEventListener("error", () => {
            s.dataset.state = "error";
          });
          document.head.appendChild(s);
          script = s;
        }
        script.addEventListener("load", mount);
        script.addEventListener("error", fail);
      }
    }
    return () => {
      cancelled = true;
      script?.removeEventListener("load", mount);
      script?.removeEventListener("error", fail);
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          /* already gone */
        }
      }
    };
  }, [attempt, markFailed, setStatus, action]);

  function retry() {
    setStatus("loading");
    cb.current.onToken(null);
    cb.current.onRetry?.();
    setAttempt((n) => n + 1);
  }

  const failed = status === "failed";
  const p = phone?.trim();

  return (
    <div>
      <div ref={box} />
      <div
        className={
          failed
            ? "bg-surface-raised text-ink rounded-card shadow-hairline border-danger space-y-3 border border-l-4 px-4 py-3"
            : ""
        }
      >
        {/* Always mounted, so screen readers announce the message when it appears */}
        <div role="status" id={msgId} className="text-sm leading-relaxed">
          {failed ? (
            <p>
              <span className="font-semibold">{BOT_CHECK_FAILED_LEAD}</span> {BOT_CHECK_FAILED_HELP}
              {p ? (
                <>
                  {" "}
                  If it keeps failing, call us on{" "}
                  <a href={telHref(p)} className="font-semibold underline">
                    {p}
                  </a>{" "}
                  to order.
                </>
              ) : null}
            </p>
          ) : status === "loading" && attempt > 0 ? (
            <p className="text-ink-muted">Running the security check again...</p>
          ) : null}
        </div>
        {failed ? (
          <Button ref={retryButton} variant="secondary" onClick={retry} aria-describedby={msgId}>
            Try again
          </Button>
        ) : null}
      </div>
      {!turnstileSiteKey && status === "ok" ? (
        <p className="text-ink-muted text-sm">
          Bot check placeholder (development). The real check appears here once it is switched on.
        </p>
      ) : null}
    </div>
  );
}

type Waiters = { current: ((t: string | null) => void)[] };
function flushWaiters(waiters: Waiters, t: string | null) {
  const waiting = waiters.current;
  waiters.current = [];
  waiting.forEach((resolve) => resolve(t));
}

export type TokenResult = { token: string } | { token: null; reason: NoTokenReason };

/**
 * The form side of the bot check: holds the token, lets a submit wait for it, and tells a failed check apart from a
 * widget that is waiting for a tick. `onRecover` runs when a token arrives or the person presses "Try again".
 */
export function useTurnstileGate(onRecover?: () => void) {
  const slot = useRef<TurnstileHandle>(null);
  const token = useRef<string | null>(null);
  const waiters = useRef<((t: string | null) => void)[]>([]);
  const recover = useRef(onRecover);
  useEffect(() => {
    recover.current = onRecover;
  });

  const onToken = useCallback((t: string | null) => {
    token.current = t;
    if (t) {
      flushWaiters(waiters, t);
      recover.current?.();
    }
  }, []);
  const onFail = useCallback(() => {
    token.current = null;
    flushWaiters(waiters, null); // a submit waiting for the token stops waiting now
  }, []);
  const onRetry = useCallback(() => recover.current?.(), []);

  /** The current token, or the next one within `ms`. Without one, says why; a failure is shown in the slot. */
  const getToken = useCallback(async (ms: number): Promise<TokenResult> => {
    let t = token.current;
    if (!t && slot.current?.status() !== "failed") {
      t = await new Promise<string | null>((resolve) => {
        const done = (v: string | null) => {
          window.clearTimeout(timer);
          waiters.current = waiters.current.filter((w) => w !== done);
          resolve(v);
        };
        const timer = window.setTimeout(() => done(null), ms);
        waiters.current.push(done);
      });
    }
    if (t) return { token: t };
    const reason = noTokenReason(slot.current?.status());
    if (reason === "failed") slot.current?.fail({ focus: true });
    return { token: null, reason };
  }, []);

  return { slot, onToken, onFail, onRetry, getToken };
}

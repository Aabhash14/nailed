/**
 * BUG-019: pure helpers for the Turnstile bot check (no React, no DOM), shared by checkout and staff sign-in.
 */

/** Where the bot check stands. `interactive`: Cloudflare is showing its widget and needs the person to tick it. */
export type TurnstileStatus = "loading" | "interactive" | "ok" | "failed";

/** Why a submit ended up without a token. */
export type NoTokenReason = "interactive" | "failed";

/** Checkout copy when the widget is on screen but not ticked yet (unchanged from S25-2). */
export const CHECKOUT_TICK_MESSAGE = "Please complete the check below";
/** Staff sign-in copy for the same case (unchanged). */
export const LOGIN_TICK_MESSAGE = "Please complete the check below.";

/** First sentence of the failure message (shown in bold in the slot). */
export const BOT_CHECK_FAILED_LEAD = "We couldn't run the security check.";
export const BOT_CHECK_FAILED_HELP = "Check your connection and tap Try again.";

/**
 * BUG-019 failure copy (draft from the Manager; content-writer to confirm). With a phone (checkout) it adds the
 * "call us" line; staff sign-in passes no phone. The slot shows the same words with the phone as a link.
 */
export function botCheckFailedMessage(phone?: string | null): string {
  const p = phone?.trim();
  return `${BOT_CHECK_FAILED_LEAD} ${BOT_CHECK_FAILED_HELP}${p ? ` If it keeps failing, call us on ${p} to order.` : ""}`;
}

/**
 * A submit waited and got no token. If Cloudflare is showing its widget, the person still has to tick it; in every
 * other case (error, timeout, script blocked, nothing back in time) the check has failed and there is nothing to tick.
 */
export function noTokenReason(status: TurnstileStatus | undefined): NoTokenReason {
  return status === "interactive" ? "interactive" : "failed";
}

/**
 * MOCK builds only (NEXT_PUBLIC_DATA_MODE=mock): lets the e2e suite and demos act out a failing bot check without
 * Cloudflare. Set localStorage `nc-mock-turnstile` to:
 *   "fail"      every attempt errors (Try again fails again)
 *   "fail-once" the first attempt errors, Try again then gets a token
 *   "hang"      no token and no error (the submit's wait runs out)
 * Anything else (or nothing): the fixed fake token, as before. Live builds never read it.
 */
export const MOCK_TURNSTILE_KEY = "nc-mock-turnstile";
export type MockTurnstileMode = "fail" | "fail-once" | "hang" | null;

export function parseMockTurnstile(raw: string | null | undefined): MockTurnstileMode {
  return raw === "fail" || raw === "fail-once" || raw === "hang" ? raw : null;
}

/** What the mock bot check does on a given attempt (0 = first render, 1+ = after Try again). */
export function mockTurnstileOutcome(mode: MockTurnstileMode, attempt: number): "token" | "fail" | "hang" {
  if (mode === "fail") return "fail";
  if (mode === "fail-once") return attempt === 0 ? "fail" : "token";
  if (mode === "hang") return "hang";
  return "token";
}

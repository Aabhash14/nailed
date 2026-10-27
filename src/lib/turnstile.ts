import { AppError } from "@/lib/errors";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileOptions = {
  secret?: string;
  fetchImpl?: typeof fetch;
  /**
   * SEC-028: when set, siteverify's `action` must equal it exactly (the widget's `action`). The table join uses
   * "table-join". Checkout and login do not pass it (their widgets set no action yet), so they behave as before.
   */
  expectedAction?: string;
  /**
   * SEC-028: when set, siteverify's `hostname` must equal it (case-insensitive), e.g. the host of
   * NEXT_PUBLIC_SITE_URL. A token solved on another hostname allowed for the same site key is refused.
   */
  expectedHostname?: string;
};

type SiteverifyAnswer = {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
  metadata?: { result_with_testing_key?: unknown };
};

/**
 * Verify a Turnstile token server-side. Throws BOT_CHECK_FAILED when it is rejected, or when an expected action or
 * hostname does not match. If Cloudflare cannot be reached we fail CLOSED with BOT_CHECK_FAILED (the user can retry);
 * a missing secret is a server misconfiguration and is INTERNAL.
 */
export async function verifyTurnstile(token: string, remoteIp: string | null, opts: TurnstileOptions = {}): Promise<void> {
  const secret = opts.secret ?? process.env.TURNSTILE_SECRET_KEY;
  if (!secret) throw new AppError("INTERNAL", undefined, { logDetail: "TURNSTILE_SECRET_KEY not set" });
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  let ok = false;
  try {
    const res = await (opts.fetchImpl ?? fetch)(VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = (await res.json()) as SiteverifyAnswer;
      ok = json.success === true;
      // Cloudflare's dummy TEST secrets (1x000...AA, used locally and on staging per ops/env.md) answer with
      // hostname "example.com", no action, and metadata.result_with_testing_key = true (observed 2026-10-26). A
      // testing key passes every (dummy) token anyway, so the action / hostname comparison adds nothing there and
      // would only break joins. A real secret never sets the flag, so production keeps the full check (SEC-028).
      const testingKey = json.metadata?.result_with_testing_key === true;
      if (ok && !testingKey && opts.expectedAction !== undefined) ok = json.action === opts.expectedAction;
      if (ok && !testingKey && opts.expectedHostname !== undefined) {
        ok = typeof json.hostname === "string" && json.hostname.toLowerCase() === opts.expectedHostname.toLowerCase();
      }
    }
  } catch {
    ok = false;
  }
  if (!ok) throw new AppError("BOT_CHECK_FAILED");
}

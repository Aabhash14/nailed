import type { Db } from "@/lib/data/types";
import { optionalEnv } from "@/lib/env";
import {
  ALERT_KINDS,
  ALERT_MAX_PER_WINDOW,
  ALERT_WINDOW_SECONDS,
  alertKey,
  plural,
  sendTelegram,
  telegramConfigured,
  type AlertKind,
} from "@/lib/notify/telegram";
import type { RateLimitInfoRow } from "@/types/db";

/**
 * Staff digest (SEC-019). Closes the two ways a real order could go unannounced:
 *  1. Alerts held back by the flood gate (more than 5 of a kind in a minute) when no later alert of that kind
 *     comes to report them. The digest reports the held-back count and how many orders are waiting for a call.
 *  2. Orders cancelled by the database auto-cancel job (`auto_cancel_unconfirmed_orders`, pg_cron every 5 min),
 *     which sends nothing itself. The digest lists them by order number.
 *
 * Trigger: post-response work of GET /api/health, which the `cafe-cron` Worker calls every 5 minutes. Any caller
 * can trigger it, and that is safe: it needs no secret, it runs at most once per 5-minute window (global gate),
 * each range is reported once, and it sends nothing when there is nothing to report.
 *
 * Bookkeeping uses public.rate_limits only (no schema change; service role):
 *  - Gate `alert:digest` (rate_limit_hit_info, 5-minute windows, max 1). Its row for the current window also
 *    gives the window start S in DATABASE time, the same clock as orders.cancelled_at and the alert windows.
 *  - Cursor `alert:digest-cursor`: one row per completed digest, window_start = the S it covered up to. Written
 *    only after a successful run, so a failed read or a failed Telegram send leaves the cursor where it was and
 *    the next run reports the same range again (nothing is lost). Old cursor rows go with the daily purge (2 days).
 * Range reported by the run in window S: auto-cancels with cancelled_at in [C - settle, S - settle), C = newest
 * cursor. Consecutive ranges touch and never overlap. The settle margin (60 s) covers an auto-cancel transaction
 * that started before a boundary and committed after it (cancelled_at is the transaction start time).
 * No PII: order numbers and counts only.
 */

export const DIGEST_KEY = "alert:digest";
export const DIGEST_CURSOR_KEY = "alert:digest-cursor";
export const DIGEST_WINDOW_SECONDS = 5 * 60;
export const DIGEST_SETTLE_SECONDS = 60;
/**
 * A range never starts more than 24 h back (cron down for a day). With no cursor at all (first run, or the rows were
 * purged after 2 days without any digest) the range is the previous window only.
 */
export const DIGEST_MAX_LOOKBACK_SECONDS = 24 * 60 * 60;
export const DIGEST_MAX_LISTED = 15;

type WindowRow = { key?: string; window_start: string; count: number };

export type DigestFacts = {
  autoCancelled: { count: number; numbers: string[] };
  heldBack: Record<AlertKind, number>;
  /** Only filled when new-order alerts were held back. */
  waiting: { count: number; oldestMinutes: number } | null;
};

export type DigestOutcome =
  | { ran: false; reason: "not_configured" | "not_due" | "db_error" }
  | { ran: true; sent: boolean; facts: DigestFacts; range: { from: string; to: string } };

export type DigestOptions = { fetchImpl?: typeof fetch; siteUrl?: string; now?: () => number };

const first = <T>(data: unknown) => (Array.isArray(data) ? data[0] : data) as T | undefined;
const iso = (t: number) => new Date(t).toISOString();

async function newestWindow(db: Db, key: string): Promise<{ ok: boolean; start: number | null }> {
  const { data, error } = await db
    .from("rate_limits")
    .select("window_start, count")
    .eq("key", key)
    .order("window_start", { ascending: false })
    .limit(1);
  if (error) return { ok: false, start: null };
  const row = first<WindowRow>(data);
  const t = row ? Date.parse(row.window_start) : NaN;
  return { ok: true, start: Number.isFinite(t) ? t : null };
}

/** Move the cursor to `upTo`. A duplicate (23505) is fine; any other failure means the range is reported again. */
async function advanceCursor(db: Db, upTo: number): Promise<void> {
  try {
    await db.from("rate_limits").insert({ key: DIGEST_CURSOR_KEY, window_start: iso(upTo), count: 1 });
  } catch {
    // a repeated digest is better than a missed one
  }
}

export function hasNews(f: DigestFacts): boolean {
  return f.autoCancelled.count > 0 || ALERT_KINDS.some((k) => f.heldBack[k] > 0);
}

/** One Telegram message. Order numbers and counts only: no name, phone or address (architecture.md section 7). */
export function formatStaffDigest(f: DigestFacts, siteUrl: string | undefined): string {
  const lines: string[] = [];
  const ac = f.autoCancelled;
  if (ac.count > 0) {
    const listed = ac.numbers.slice(0, DIGEST_MAX_LISTED).join(", ");
    const more = ac.count > ac.numbers.length ? ` and ${ac.count - ac.numbers.length} more` : "";
    lines.push(
      `${plural(ac.count, "unconfirmed order was", "unconfirmed orders were")} cancelled automatically because nobody confirmed ${ac.count === 1 ? "it" : "them"} in time: ${listed}${more}. Stock was put back. Call the customer if you still want the order.`,
    );
  }
  const n = f.heldBack["new-order"];
  if (n > 0) {
    let s = `${plural(n, "new order was", "new orders were")} not announced one by one (more than ${ALERT_MAX_PER_WINDOW} a minute).`;
    if (f.waiting && f.waiting.count > 0) {
      s += ` ${plural(f.waiting.count, "order is", "orders are")} waiting for a call now; the oldest has waited ${f.waiting.oldestMinutes} min.`;
    }
    lines.push(s);
  }
  const cc = f.heldBack["customer-cancel"];
  if (cc > 0) lines.push(`${plural(cc, "customer cancellation was", "customer cancellations were")} not announced one by one.`);
  const ie = f.heldBack["internal-error"];
  if (ie > 0) lines.push(`${plural(ie, "server error was", "server errors were")} not announced one by one.`);
  const link = siteUrl ? `\n${siteUrl.replace(/\/$/, "")}/admin/orders` : "";
  return `Order update:\n${lines.map((l) => `- ${l}`).join("\n")}${link}`;
}

/**
 * Run the digest once if this 5-minute window has not had one yet. Never throws. A database read failure sends
 * nothing and leaves the cursor, so the next window reports the range. (Real-time alerts stay fail-open.)
 */
export async function runStaffDigest(db: Db, opts: DigestOptions = {}): Promise<DigestOutcome> {
  if (!telegramConfigured()) return { ran: false, reason: "not_configured" };
  const now = opts.now ?? Date.now;
  const windowMs = DIGEST_WINDOW_SECONDS * 1000;
  try {
    // 1. Global gate: the first caller of a 5-minute window runs the digest; everyone else stops after one RPC.
    const { data, error } = await db.rpc("rate_limit_hit_info", {
      p_key: DIGEST_KEY,
      p_window_seconds: DIGEST_WINDOW_SECONDS,
      p_max: 1,
    });
    if (error) return { ran: false, reason: "db_error" };
    const hit = first<RateLimitInfoRow>(data);
    if (!hit?.allowed) return { ran: false, reason: "not_due" };

    // 2. This window's start in database time, and the cursor (end of the last reported range).
    const [gate, cursor] = await Promise.all([newestWindow(db, DIGEST_KEY), newestWindow(db, DIGEST_CURSOR_KEY)]);
    if (!cursor.ok) return { ran: false, reason: "db_error" };
    const cur = gate.ok && gate.start !== null ? gate.start : Math.floor(now() / windowMs) * windowMs;
    if (cursor.start !== null && cursor.start >= cur) return { ran: false, reason: "not_due" }; // already covered
    const previous = cursor.start ?? cur - windowMs;
    const settle = DIGEST_SETTLE_SECONDS * 1000;
    const from = Math.max(previous, cur - DIGEST_MAX_LOOKBACK_SECONDS * 1000) - settle;
    const to = cur - settle;

    // 3. What happened in the range.
    const [cancelled, windows] = await Promise.all([
      db
        .from("orders")
        .select("number", { count: "exact" })
        .eq("status", "cancelled")
        .eq("cancel_reason", "auto_unconfirmed")
        .gte("cancelled_at", iso(from))
        .lt("cancelled_at", iso(to))
        .order("cancelled_at", { ascending: true })
        .limit(DIGEST_MAX_LISTED),
      db
        .from("rate_limits")
        .select("key, window_start, count")
        .in("key", ALERT_KINDS.map((k) => alertKey(k))),
    ]);
    if (cancelled.error || windows.error) return { ran: false, reason: "db_error" };

    const numbers = ((cancelled.data ?? []) as { number: string }[]).map((r) => r.number).filter((x) => typeof x === "string");
    const facts: DigestFacts = {
      autoCancelled: { count: Math.max(cancelled.count ?? 0, numbers.length), numbers },
      heldBack: { "new-order": 0, "customer-cancel": 0, "internal-error": 0 },
      waiting: null,
    };

    // Held-back alerts: only the NEWEST window of each kind can still be unreported (an earlier window was
    // reported by the first alert of the window after it). A 60 s window counts once it has closed at least
    // `settle` before S, so the shifted range [from - 60 s, to - 60 s) keeps consecutive digests disjoint.
    const alertWin = ALERT_WINDOW_SECONDS * 1000;
    const reported: WindowRow[] = [];
    const rows = (windows.data ?? []) as WindowRow[];
    for (const kind of ALERT_KINDS) {
      const newest = rows
        .filter((r) => r.key === alertKey(kind))
        .sort((a, b) => Date.parse(b.window_start) - Date.parse(a.window_start))[0];
      if (!newest || typeof newest.count !== "number") continue;
      const start = Date.parse(newest.window_start);
      if (newest.count > ALERT_MAX_PER_WINDOW && start >= from - alertWin && start < to - alertWin) {
        facts.heldBack[kind] = newest.count - ALERT_MAX_PER_WINDOW;
        reported.push(newest);
      }
    }

    if (facts.heldBack["new-order"] > 0) {
      const w = await db
        .from("orders")
        .select("created_at", { count: "exact" })
        .eq("status", "placed")
        .order("created_at", { ascending: true })
        .limit(1);
      if (!w.error) {
        const oldest = first<{ created_at: string }>(w.data);
        const age = oldest ? now() - Date.parse(oldest.created_at) : 0;
        facts.waiting = { count: w.count ?? (oldest ? 1 : 0), oldestMinutes: Number.isFinite(age) ? Math.max(0, Math.floor(age / 60_000)) : 0 };
      }
    }

    const range = { from: iso(from), to: iso(to) };
    if (!hasNews(facts)) {
      await advanceCursor(db, cur);
      return { ran: true, sent: false, facts, range };
    }

    const sent = await sendTelegram(formatStaffDigest(facts, opts.siteUrl ?? optionalEnv("NEXT_PUBLIC_SITE_URL")), opts.fetchImpl);
    if (!sent) return { ran: true, sent: false, facts, range }; // cursor stays: the next window reports it again

    await advanceCursor(db, cur);
    // The reported overflow window (and any older window of that kind, all already reported) is deleted, so the
    // next real alert does not report it again ("+N more"). These windows are closed, so no hit can be lost.
    // Best effort: a failure only means a repeated count.
    for (const r of reported) {
      try {
        await db.from("rate_limits").delete().eq("key", r.key ?? "").lte("window_start", r.window_start);
      } catch {
        // ignore
      }
    }
    return { ran: true, sent: true, facts, range };
  } catch {
    return { ran: false, reason: "db_error" };
  }
}

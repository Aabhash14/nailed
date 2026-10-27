import type { Db } from "@/lib/data/types";
import type { AlertChannel } from "@/lib/tables/types";
import type { ClaimedAlert, RateLimitInfoRow } from "@/types/db";

/**
 * Owner-alert notifier (api-contract 2.3.0 section 9.10): channel-neutral delivery of `admin_alerts` rows.
 *
 * Alerts are written by Postgres in the same transaction as the event (void, cancel after accept, expiry with a bill)
 * or by the backend through record_admin_alert (failed-join burst). The in-app Alerts view (/admin/alerts) is the v1
 * surface. This module only DELIVERS them to optional channels:
 *
 *   for each ENABLED channel:  claim (claim_alert_deliveries) -> send -> finish (finish_alert_delivery)
 *
 * Rules (9.10):
 * - flood control: at most NOTIFY_LIMITS.maxSends messages per channel per 10 minutes (key `alert:<channel>` in
 *   rate_limits). Above that, ONE summary per window ("<N> more alerts. Open Admin > Alerts."), and the alerts it
 *   covers are finished as delivered. If the summary of this window was already used, they are finished as failed
 *   ("held") and retried in a later window.
 * - at most 3 attempts per alert and nothing older than 24 h: enforced by claim_alert_deliveries / finish (the database
 *   never claims an alert over 24 h old, and stops after 3 attempts); checked here too before sending.
 * - never throws, never changes a response: it runs in post-response work (`after()`) of closeTable, cancelTableRound,
 *   a failed join, and GET /api/health (the 5-minute cron, which also delivers alerts written by pg_cron).
 *
 * 2.3.0 (Aabhash, 2026-10-26): NO channel is enabled. WhatsApp (paid) was rejected and must not be built; Telegram is
 * not used for tables; the free channel (Web Push with email as backup, recommended) is pending his choice. With no
 * enabled channel `runNotifier` returns immediately WITHOUT a database call. To add the chosen channel: implement
 * `AlertChannelAdapter`, add it to `ALERT_CHANNELS`, and widen the database CHECK on alert_deliveries.channel and
 * claim_alert_deliveries (both accept 'whatsapp' only today) by migration. That is a contract change (tech-lead).
 */

export const NOTIFY_LIMITS = {
  windowSeconds: 10 * 60,
  maxSends: 5,
  claimBatch: 20,
  maxAttempts: 3, // enforced by the database; listed for documentation and the age check below
  maxAgeMs: 24 * 60 * 60 * 1000,
} as const;

export type SendResult = { ok: true } | { ok: false; error: string };

/** One delivery channel. `send` must not throw for an ordinary failure; it returns a short error code instead. */
export interface AlertChannelAdapter {
  readonly channel: AlertChannel;
  /** Configured and switched on (env present). Checked before any database call. */
  enabled(): boolean;
  /** Deliver one alert's text (one English line, no personal data). Error = HTTP status / provider code only. */
  send(alert: ClaimedAlert): Promise<SendResult>;
  /** Deliver the flood summary line. */
  sendSummary(text: string): Promise<SendResult>;
}

/** The registered channels. EMPTY on purpose in v1 (2.3.0). */
export const ALERT_CHANNELS: readonly AlertChannelAdapter[] = [];

export function enabledChannels(channels: readonly AlertChannelAdapter[] = ALERT_CHANNELS): AlertChannelAdapter[] {
  return channels.filter((c) => {
    try {
      return c.enabled();
    } catch {
      return false;
    }
  });
}

export const floodKey = (channel: AlertChannel) => `alert:${channel}`;
export const summaryKey = (channel: AlertChannel) => `alert:${channel}:summary`;
export const summaryText = (n: number) => `${n} more alert${n === 1 ? "" : "s"}. Open Admin > Alerts.`;

export type ChannelOutcome = {
  channel: AlertChannel;
  claimed: number;
  sent: number;
  failed: number;
  summarised: number;
  held: number;
  error?: "claim_failed";
};
export type NotifierOutcome = { ran: false; reason: "no_channel" | "no_db" } | { ran: true; channels: ChannelOutcome[] };

/** Record one hit on a gate; null when the database cannot answer (callers then hold back: fail closed on sends). */
async function gate(db: Db, key: string, max: number): Promise<boolean | null> {
  try {
    const { data, error } = await db.rpc("rate_limit_hit_info", {
      p_key: key,
      p_window_seconds: NOTIFY_LIMITS.windowSeconds,
      p_max: max,
    });
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as RateLimitInfoRow | undefined;
    return row ? row.allowed === true : null;
  } catch {
    return null;
  }
}

async function finish(db: Db, alertId: string, channel: AlertChannel, ok: boolean, error: string | null): Promise<void> {
  try {
    await db.rpc("finish_alert_delivery", {
      p_alert_id: alertId,
      p_channel: channel,
      p_ok: ok,
      p_error: ok ? null : (error ?? "failed").slice(0, 100),
    });
  } catch {
    // the row stays 'sending'; claim_alert_deliveries retries it after 5 minutes
  }
}

function logFailure(channel: AlertChannel, what: string, code: string) {
  console.error(JSON.stringify({ level: "error", event: "alert_delivery_failed", channel, what, code: code.slice(0, 40) }));
}

async function claim(db: Db, channel: AlertChannel): Promise<ClaimedAlert[] | null> {
  try {
    const { data, error } = await db.rpc("claim_alert_deliveries", { p_channel: channel, p_limit: NOTIFY_LIMITS.claimBatch });
    if (error) {
      logFailure(channel, "claim", String(error.code ?? "?"));
      return null;
    }
    const rows = (Array.isArray(data) ? data : data ? [data] : []) as ClaimedAlert[];
    return rows.filter((r) => r && typeof r.alertId === "string" && typeof r.text === "string");
  } catch {
    return null;
  }
}

async function runChannel(db: Db, adapter: AlertChannelAdapter, now: () => number): Promise<ChannelOutcome> {
  const channel = adapter.channel;
  const out: ChannelOutcome = { channel, claimed: 0, sent: 0, failed: 0, summarised: 0, held: 0 };
  const claimed = await claim(db, channel);
  if (claimed === null) return { ...out, error: "claim_failed" };
  out.claimed = claimed.length;

  const queue = [...claimed].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (let i = 0; i < queue.length; i++) {
    const alert = queue[i]!;
    const created = Date.parse(alert.createdAt);
    if (!Number.isFinite(created) || now() - created > NOTIFY_LIMITS.maxAgeMs) {
      await finish(db, alert.alertId, channel, false, "expired");
      out.failed++;
      continue;
    }
    const allowed = await gate(db, floodKey(channel), NOTIFY_LIMITS.maxSends);
    if (allowed === true) {
      let res: SendResult;
      try {
        res = await adapter.send(alert);
      } catch {
        res = { ok: false, error: "exception" };
      }
      await finish(db, alert.alertId, channel, res.ok, res.ok ? null : res.error);
      if (res.ok) out.sent++;
      else {
        out.failed++;
        logFailure(channel, "send", res.error);
      }
      continue;
    }
    // Over the flood limit (or the gate cannot answer): this alert and every later one in the batch.
    const rest = queue.slice(i);
    const summaryAllowed = allowed === false ? await gate(db, summaryKey(channel), 1) : null;
    let covered = false;
    if (summaryAllowed === true) {
      try {
        covered = (await adapter.sendSummary(summaryText(rest.length))).ok;
      } catch {
        covered = false;
      }
    }
    for (const a of rest) await finish(db, a.alertId, channel, covered, covered ? null : "held");
    if (covered) out.summarised += rest.length;
    else out.held += rest.length;
    break;
  }
  return out;
}

/**
 * Deliver pending owner alerts on every enabled channel. No enabled channel = no database call (v1). Never throws.
 */
export async function runNotifier(
  db: Db | null,
  opts: { channels?: readonly AlertChannelAdapter[]; now?: () => number } = {},
): Promise<NotifierOutcome> {
  const channels = enabledChannels(opts.channels ?? ALERT_CHANNELS);
  if (channels.length === 0) return { ran: false, reason: "no_channel" };
  if (!db) return { ran: false, reason: "no_db" };
  const now = opts.now ?? (() => Date.now());
  const results: ChannelOutcome[] = [];
  for (const c of channels) {
    try {
      results.push(await runChannel(db, c, now));
    } catch {
      results.push({ channel: c.channel, claimed: 0, sent: 0, failed: 0, summarised: 0, held: 0, error: "claim_failed" });
    }
  }
  return { ran: true, channels: results };
}

/**
 * Schedule the notifier in post-response work. The database client is created lazily and only when a channel is
 * enabled, so in v1 this costs nothing.
 */
export function scheduleNotifier(
  schedule: (work: () => Promise<unknown>) => void,
  db: () => Db,
  channels: readonly AlertChannelAdapter[] = ALERT_CHANNELS,
): void {
  if (enabledChannels(channels).length === 0) return;
  schedule(async () => {
    let client: Db | null = null;
    try {
      client = db();
    } catch {
      client = null;
    }
    return runNotifier(client, { channels });
  });
}

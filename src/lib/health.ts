import type { Db } from "@/lib/data/types";
import { newRequestId } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { scheduleNotifier, type AlertChannelAdapter } from "@/lib/notify/notifier";
import { runStaffDigest } from "@/lib/notify/staff-digest";
import { enforceLimit, ipKey, LIMITS } from "@/lib/ratelimit";
import type { HealthData } from "@/lib/validation/api";
import { AppError } from "@/lib/errors";

export type HealthDeps = {
  db: () => Db;
  salt: () => string;
  now?: () => Date;
  /**
   * Post-response work (Next `after`). When given and the database is up, the staff digest (SEC-019) runs after
   * the response: at most once per 5-minute window across all callers, so the cron's 5-minute call drives it.
   */
  schedule?: (work: () => Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
  /** Owner-alert delivery channels (tests). Default: the notifier registry, which is EMPTY in v1 (api-contract 2.3.0). */
  alertChannels?: readonly AlertChannelAdapter[];
};

/**
 * GET /api/health (api-contract 2): keep-alive target. One cheap RPC (`health_ping`). Always HTTP 200
 * (`db: "down"` signals pause or outage) except when the caller exceeds 30/min/IP. No version, key or config details.
 * The limiter needs the database too, so if THAT call fails we skip the limit and let the ping report "down".
 * The staff digest and the owner-alert notifier never change the response and never run for a rate-limited caller.
 */
export async function handleHealth(req: Request, deps: HealthDeps): Promise<Response> {
  const requestId = newRequestId();
  const now = deps.now ?? (() => new Date());
  let db: Db | null = null;
  try {
    db = deps.db();
  } catch {
    db = null; // missing env or client failure: report down, reveal nothing
  }
  if (db) {
    try {
      const ipk = await ipKey("health", req.headers, deps.salt());
      await enforceLimit(db, ipk.key, LIMITS.healthIp);
    } catch (e) {
      if (e instanceof AppError && e.code === "RATE_LIMITED") return jsonError(e, requestId);
      // INTERNAL from the limiter or a missing salt: fall through to the real ping
    }
  }
  let up = false;
  if (db) {
    try {
      const { error } = await db.rpc("health_ping");
      up = !error;
    } catch {
      up = false;
    }
  }
  if (up && db && deps.schedule) {
    const digestDb = db;
    deps.schedule(() => runStaffDigest(digestDb, { fetchImpl: deps.fetchImpl }));
    // Owner alerts (9.10): delivers alerts written by pg_cron (expiry) and retries failures. With no channel enabled
    // (v1) nothing is scheduled and the database is not read.
    scheduleNotifier(deps.schedule, () => digestDb, deps.alertChannels);
  }
  return jsonOk<HealthData>({ db: up ? "up" : "down", time: now().toISOString() });
}

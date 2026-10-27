import { mapRpcError } from "@/lib/data/db-errors";
import type { Db } from "@/lib/data/types";
import { AppError, newRequestId } from "@/lib/errors";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { securityEvent } from "@/lib/log";
import { scheduleNotifier, type AlertChannelAdapter } from "@/lib/notify/notifier";
import { clientIp, enforceLimit, ipKey, LIMITS, recordHit, type Limit } from "@/lib/ratelimit";
import { verifyTurnstile, type TurnstileOptions } from "@/lib/turnstile";
import { parseInput } from "@/lib/validation/common";
import type { CreateTableOrderResult, JoinTableResult, TableGuestState } from "@/types/db";
import {
  clearTableCookieHeader,
  readCookieValues,
  readTableCookie,
  signTableCookie,
  tableCookieHeader,
  tableCookieName,
  type TableCookieKeys,
} from "./cookie";
import { assertTableOrigin, siteHostname } from "./origin";
import { joinTableRequestSchema, parseSince, tableOrderRequestSchema } from "./validation";

/**
 * Guest route handlers for table ordering (api-contract 2.3.0 sections 9.2 to 9.5). Pure functions of (Request, deps)
 * so the unit tests run them with fakes; the files under src/app/api/table/ only wire the real dependencies.
 *
 * Rules every handler keeps (threat model checklist B1 to B8):
 * - POST: Origin first, before the body is read (B1). No CORS headers anywhere.
 * - The session id comes ONLY from the verified cookie; any table / session in the query or body is ignored (B3).
 * - Never log the typed code, the cookie value or the request body (B4). Logs carry the table number, an IP-hash
 *   prefix or a session-id prefix only.
 * - `Cache-Control: no-store` on every answer, errors included (B8): jsonOk / jsonError set it.
 * - No ISR tag or path revalidation of any kind (ADR 0002 rule 2).
 */

type EnvLike = Record<string, string | undefined>;

export type TableRouteDeps = {
  /** Service-role client: every table RPC and the rate limiter are service-role only. */
  db: () => Db;
  salt: () => string;
  siteUrl: () => string | undefined;
  cookieKeys: () => Promise<TableCookieKeys>;
  /** Post-response work (Next `after`): failed-join counting, the owner alert and the notifier. */
  schedule: (work: () => Promise<unknown>) => void;
  turnstile?: (token: string, ip: string | null, opts: TurnstileOptions) => Promise<void>;
  env?: EnvLike;
  now?: () => Date;
  /** Delivery channels for the notifier (tests); default = the registry in src/lib/notify/notifier.ts (empty in v1). */
  channels?: readonly AlertChannelAdapter[];
};

export const TABLE_JOIN_ACTION = "table-join";

/** Add a Set-Cookie to a Response built by jsonOk / jsonError (their headers are mutable). */
function withCookie(res: Response, setCookie: string | null): Response {
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}

const nowSeconds = (deps: TableRouteDeps) => Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);

// ---- POST /api/table/join (9.3) -------------------------------------------------------------------------------

/**
 * SEC-028 failed-join monitoring. Counts (never refuses) in rate_limits, globally and per table, per hour. The first
 * failure over a threshold in a window records ONE owner alert through record_admin_alert: a second 1-per-window gate
 * (`...:alerted`, same window) decides "first", because rate_limit_hit_info reports no count. Best effort.
 */
export async function countFailedJoin(db: Db, table: number): Promise<{ alerted: "table" | "global" | null }> {
  const over = async (key: string, limit: Limit) => {
    const row = await recordHit(db, key, limit);
    if (row.allowed) return false;
    const first = await recordHit(db, `${key}:alerted`, { window: limit.window, max: 1 });
    return first.allowed;
  };
  const [tableOver, globalOver] = await Promise.all([
    over(`table-join-fail:table:${table}`, LIMITS.tableJoinFailTable),
    over("table-join-fail:global", LIMITS.tableJoinFailGlobal),
  ]);
  if (!tableOver && !globalOver) return { alerted: null };
  const failures = (tableOver ? LIMITS.tableJoinFailTable.max : LIMITS.tableJoinFailGlobal.max) + 1;
  const { error } = await db.rpc("record_admin_alert", {
    p_kind: "table_join_fail",
    p_data: { tableNumber: tableOver ? table : null, failures },
  });
  if (error) throw new AppError("INTERNAL", undefined, { logDetail: `record_admin_alert: ${error.code ?? "?"}` });
  return { alerted: tableOver ? "table" : "global" };
}

export async function handleTableJoin(req: Request, deps: TableRouteDeps): Promise<Response> {
  const requestId = newRequestId();
  const env = deps.env ?? process.env;
  try {
    assertTableOrigin(req, deps.siteUrl(), env);
    const body = await readJson(req, { requireJsonContentType: true });
    const input = parseInput(joinTableRequestSchema, body);

    const host = siteHostname(deps.siteUrl());
    if (!host) throw new AppError("INTERNAL", undefined, { logDetail: "NEXT_PUBLIC_SITE_URL not set (table join)" });
    const ip = clientIp(req.headers, env);
    await (deps.turnstile ?? verifyTurnstile)(input.turnstileToken, ip, {
      expectedAction: TABLE_JOIN_ACTION,
      expectedHostname: host,
    });

    const db = deps.db();
    const ipk = await ipKey("table-join", req.headers, deps.salt());
    // SEC-026: per (IP bucket, table) first, then the per-IP ceiling. Both fail closed (like checkout).
    await enforceLimit(db, `table-join:iptable:${ipk.hash}:${input.table}`, LIMITS.tableJoinIpTable);
    await enforceLimit(db, ipk.key, LIMITS.tableJoinIp);

    const keys = await deps.cookieKeys(); // before the RPC: a missing key must not look like a wrong code
    const { data, error } = await db.rpc("join_table_session", { p_table_number: input.table, p_code: input.code });
    if (error) {
      const mapped = mapRpcError(error);
      if (mapped.code === "VALIDATION") {
        // Wrong code, free / unknown / inactive table, or an old code: one answer for all (9.3 step 7).
        securityEvent("table_join_failed", { requestId, tableNumber: input.table, ipHashPrefix: ipk.hash });
        const table = input.table;
        deps.schedule(async () => {
          await countFailedJoin(db, table);
        });
        scheduleNotifier(deps.schedule, deps.db, deps.channels);
      }
      throw mapped;
    }
    const joined = data as JoinTableResult | null;
    if (!joined || typeof joined.sessionId !== "string" || typeof joined.epoch !== "number" || !joined.view) {
      throw new AppError("INTERNAL", undefined, { logDetail: "join_table_session: unexpected result" });
    }
    const value = await signTableCookie(keys, { sessionId: joined.sessionId, epoch: joined.epoch, issuedAt: nowSeconds(deps) });
    return withCookie(jsonOk(joined.view), tableCookieHeader(value, env));
  } catch (e) {
    return jsonError(e, requestId);
  }
}

// ---- GET /api/table/session (9.4) -----------------------------------------------------------------------------

export async function handleTableSession(req: Request, deps: TableRouteDeps): Promise<Response> {
  const requestId = newRequestId();
  const env = deps.env ?? process.env;
  try {
    // Nothing sent at all (the usual first call): answer at once, without even needing the key.
    if (readCookieValues(req.headers.get("cookie"), tableCookieName(env)).length === 0) {
      return jsonOk<TableGuestState>({ state: "none" });
    }
    const keys = await deps.cookieKeys();
    const cookie = await readTableCookie(req.headers, keys, { env, nowSeconds: nowSeconds(deps) });
    if (!cookie.payload) {
      // No valid cookie: no database call; clear whatever was sent.
      return withCookie(jsonOk<TableGuestState>({ state: "none" }), cookie.present ? clearTableCookieHeader(env) : null);
    }

    const db = deps.db();
    try {
      const ipk = await ipKey("table-view", req.headers, deps.salt());
      await enforceLimit(db, ipk.key, LIMITS.tableViewIp);
    } catch (e) {
      if (e instanceof AppError && e.code === "RATE_LIMITED") throw e;
      // limiter unavailable: fail open (9.4)
    }

    // Only `since` is read from the query; any table / session parameter is ignored (B3).
    const since = parseSince(new URL(req.url).searchParams.get("since"));
    const { data, error } = await db.rpc("table_session_guest_view", {
      p_session_id: cookie.payload.sessionId,
      p_epoch: cookie.payload.epoch,
      p_since: since ?? null,
    });
    if (error) throw mapRpcError(error);
    const state = data as TableGuestState | null;
    if (!state || typeof state !== "object" || !("state" in state)) {
      throw new AppError("INTERNAL", undefined, { logDetail: "table_session_guest_view: unexpected result" });
    }
    const clear = state.state === "none" || state.state === "closed";
    return withCookie(jsonOk(state), clear ? clearTableCookieHeader(env) : null);
  } catch (e) {
    return jsonError(e, requestId);
  }
}

// ---- POST /api/table/orders (9.5) -----------------------------------------------------------------------------

export async function handleTableOrders(req: Request, deps: TableRouteDeps): Promise<Response> {
  const requestId = newRequestId();
  const env = deps.env ?? process.env;
  try {
    assertTableOrigin(req, deps.siteUrl(), env);
    const body = await readJson(req, { requireJsonContentType: true });

    const keys = await deps.cookieKeys();
    const cookie = await readTableCookie(req.headers, keys, { env, nowSeconds: nowSeconds(deps) });
    if (!cookie.payload) {
      return withCookie(jsonError(new AppError("TABLE_SESSION_INVALID"), requestId), clearTableCookieHeader(env));
    }
    const session = cookie.payload;
    const input = parseInput(tableOrderRequestSchema, body);

    const db = deps.db();
    // SEC-026: per session first, then the per-IP ceiling. Both fail closed.
    await enforceLimit(db, `table-order:session:${session.sessionId}`, LIMITS.tableOrderSession);
    const ipk = await ipKey("table-order", req.headers, deps.salt());
    await enforceLimit(db, ipk.key, LIMITS.tableOrderIp);

    const { data, error } = await db.rpc("create_table_order", {
      p_session_id: session.sessionId,
      p_epoch: session.epoch,
      p_client_request_id: input.clientRequestId,
      p_items: input.items.map((l) => ({ menuItemId: l.menuItemId, variantIds: l.variantIds, qty: l.qty })),
      p_note: input.note ?? null,
    });
    if (error) {
      const mapped = mapRpcError(error);
      if (mapped.code === "TABLE_SESSION_INVALID") return withCookie(jsonError(mapped, requestId), clearTableCookieHeader(env));
      if (mapped.code === "RATE_LIMITED") {
        securityEvent("rate_limited", { requestId, scope: "table-order-db", sessionPrefix: session.sessionId });
      }
      throw mapped;
    }
    const result = data as CreateTableOrderResult | null;
    if (!result || typeof result.round !== "number" || !result.session) {
      throw new AppError("INTERNAL", undefined, { logDetail: "create_table_order: unexpected result" });
    }
    return jsonOk(
      { round: result.round, replayed: result.replayed === true, session: result.session },
      { status: result.replayed === true ? 200 : 201 },
    );
  } catch (e) {
    return jsonError(e, requestId);
  }
}

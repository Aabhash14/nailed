"use client";

import { mutateTablesDb } from "@/mocks/db";
import { mockCreateTableRound, mockGuestState, mockJoinTable, type MockTableCookie } from "@/mocks/tables";
import type {
  JoinTableRequest,
  ApiError,
  TableGuestState,
  TableOrderRequest,
  TableOrderResponse,
  TableSessionView,
} from "@/types/contract";
import { isMock } from "./mode";
import { parseRetryAfter } from "./public-client";

/**
 * BROWSER-SIDE guest table calls (api-contract 2.0.0 sections 9.3 to 9.5). Live mode calls the route handlers; the
 * HttpOnly `nc_table` cookie (Path=/api/table) is sent by the browser on these same-origin requests and is never
 * readable here. Mock mode uses the browser mock db and keeps a stand-in "cookie" (the session id) in localStorage.
 *
 * Every failure says whether the server answered (`network: false`) or not (`network: true`): a send whose outcome is
 * unknown must keep its clientRequestId for "Send again" (section 9.12).
 */

export type TableCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError; network: boolean; retryAfterMs: number | null };

const NETWORK_MESSAGE = "We could not reach the server. Check your connection and try again.";

async function call<T>(path: string, init?: RequestInit): Promise<TableCallResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  } catch {
    return { ok: false, error: { code: "INTERNAL", message: NETWORK_MESSAGE }, network: true, retryAfterMs: null };
  }
  const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get("Retry-After")) : null;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: a proxy or Worker error page */
  }
  if (body && typeof body === "object" && "ok" in body) {
    const b = body as { ok: boolean; data?: T; error?: ApiError };
    if (b.ok) return { ok: true, data: b.data as T };
    if (b.error) return { ok: false, error: b.error, network: false, retryAfterMs };
  }
  // A 5xx without our envelope: the outcome is unknown, treat it like a network failure.
  return {
    ok: false,
    error: { code: "INTERNAL", message: "Something went wrong. Please try again." },
    network: res.status >= 500 || res.status === 0,
    retryAfterMs,
  };
}

// ---- mock cookie ------------------------------------------------------------------------------------------------

const MOCK_COOKIE_KEY = "nc-mock-table-cookie";
const MOCK_COOKIE_MS = 12 * 3_600_000;

function readMockCookie(now = Date.now()): MockTableCookie | null {
  try {
    const raw = window.localStorage.getItem(MOCK_COOKIE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { sessionId?: unknown; epoch?: unknown; issuedAt?: unknown };
    if (typeof v.sessionId !== "string" || typeof v.epoch !== "number" || typeof v.issuedAt !== "number") return null;
    if (now - v.issuedAt > MOCK_COOKIE_MS) return null;
    return { sessionId: v.sessionId, epoch: v.epoch };
  } catch {
    return null;
  }
}
/** Mock only: session id + epoch (SEC-023), the same facts the real signed cookie carries. Never the table code (F4). */
function writeMockCookie(c: MockTableCookie | null) {
  try {
    if (c) window.localStorage.setItem(MOCK_COOKIE_KEY, JSON.stringify({ ...c, issuedAt: Date.now() }));
    else window.localStorage.removeItem(MOCK_COOKIE_KEY);
  } catch {
    /* ignore */
  }
}

const mockErr = <T>(r: { ok: false; error: ApiError }): TableCallResult<T> => ({
  ok: false,
  error: r.error,
  network: false,
  retryAfterMs: null,
});

// ---- calls ------------------------------------------------------------------------------------------------------

/** POST /api/table/join. Success sets the cookie (server side) and returns the session view. */
export async function joinTable(req: JoinTableRequest): Promise<TableCallResult<TableSessionView>> {
  if (isMock) {
    const r = mutateTablesDb((db) => mockJoinTable(db, req));
    if (!r.ok) return mockErr(r);
    writeMockCookie({ sessionId: r.data.sessionId, epoch: r.data.epoch });
    return { ok: true, data: r.data.view };
  }
  return call<TableSessionView>("/api/table/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

/** GET /api/table/session[?since=rev]. Change-only: `unchanged` when `since` equals the current rev. */
export async function fetchTableSession(since?: number): Promise<TableCallResult<TableGuestState>> {
  if (isMock) {
    const state = mutateTablesDb((db) => mockGuestState(db, readMockCookie(), since));
    if (state.state === "none" || state.state === "closed") writeMockCookie(null);
    return { ok: true, data: state };
  }
  const q = since !== undefined && Number.isInteger(since) && since >= 0 ? `?since=${since}` : "";
  return call<TableGuestState>(`/api/table/session${q}`);
}

/** POST /api/table/orders. 201 = new round, 200 + replayed = the same clientRequestId was already sent. */
export async function sendTableRound(req: TableOrderRequest): Promise<TableCallResult<TableOrderResponse>> {
  if (isMock) {
    const r = mutateTablesDb((db) => mockCreateTableRound(db, readMockCookie(), req));
    if (!r.ok) {
      if (r.error.code === "TABLE_SESSION_INVALID") writeMockCookie(null);
      return mockErr(r);
    }
    return { ok: true, data: r.data };
  }
  return call<TableOrderResponse>("/api/table/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

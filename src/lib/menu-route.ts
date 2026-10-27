import type { Db } from "@/lib/data/types";
import { AppError, newRequestId } from "@/lib/errors";
import { jsonError } from "@/lib/http";
import { cachedMenu, getPublicMenu, rememberMenu, type MenuPayload } from "@/lib/data/menu";
import { enforceLimit, ipKey, LIMITS } from "@/lib/ratelimit";
import { readTableOccupancy } from "@/lib/tables/occupancy";
import { ok } from "@/lib/validation/api";

export type MenuDeps = {
  /** Anon client for the menu reads. */
  db: () => Db;
  supabaseUrl: () => string;
  /** Service client for the per-IP limiter (rate_limit_hit_info is service-role only). */
  limiterDb: () => Db;
  /**
   * Service client for table occupancy (view table_occupancy is service-role only; ADR 0002 option 4C). Omitted =
   * `limiterDb`, which is the service client in production.
   */
  occupancyDb?: () => Db;
  salt: () => string;
};

/**
 * GET /api/menu (api-contract 2). Per-IP limit first (SEC-021: LIMITS.menuIp, 180 / min / IP, ESTIMATE): over it is
 * RATE_LIMITED 429 with Retry-After; the open menu keeps its last copy and polls again. The limiter fails OPEN
 * (like /api/health): if it cannot reach the database, the read is attempted anyway and degrades as below.
 * Fresh data when the database answers (and the copy is remembered). If the database fails: the last good copy
 * with `degraded: true`; with no copy at all: INTERNAL, and the page falls back to the static break-glass menu.
 */
export async function handleMenu(req: Request, deps: MenuDeps): Promise<Response> {
  const requestId = newRequestId();
  try {
    const ipk = await ipKey("menu", req.headers, deps.salt());
    await enforceLimit(deps.limiterDb(), ipk.key, LIMITS.menuIp);
  } catch (e) {
    if (e instanceof AppError && e.code === "RATE_LIMITED") return jsonError(e, requestId);
    // limiter unavailable (database, env): fail open
  }
  try {
    // Occupancy is read in parallel with the menu, fresh on every answer, and never fails the menu (null instead).
    const occupancy = (async () => {
      try {
        return await readTableOccupancy((deps.occupancyDb ?? deps.limiterDb)());
      } catch {
        return null; // client creation failed (env)
      }
    })();
    const payload = await getPublicMenu(deps.db(), deps.supabaseUrl());
    rememberMenu(payload); // without occupancy (B6)
    const tables = payload.settings.tableOrdering === "off" ? null : await occupancy;
    return Response.json(ok<MenuPayload>({ ...payload, tables }), {
      headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" },
    });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "menu_read_failed", requestId }));
    const copy = cachedMenu();
    if (copy) {
      return Response.json(ok<MenuPayload>({ ...copy, degraded: true, tables: null }), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    return jsonError(e instanceof AppError ? e : new AppError("INTERNAL"), requestId);
  }
}

import { handleTableSession } from "@/lib/tables/handlers";
import { tableRouteDeps } from "../_deps";

export const dynamic = "force-dynamic";

/** GET /api/table/session[?since=<rev>] (api-contract 9.4): the guest's own table, change-only. */
export function GET(req: Request) {
  return handleTableSession(req, tableRouteDeps());
}

import { handleTableJoin } from "@/lib/tables/handlers";
import { tableRouteDeps } from "../_deps";

export const dynamic = "force-dynamic";

/** POST /api/table/join (api-contract 9.3): Origin, body, Zod, Turnstile ("table-join"), limits, join_table_session. */
export function POST(req: Request) {
  return handleTableJoin(req, tableRouteDeps());
}

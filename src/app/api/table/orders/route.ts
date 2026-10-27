import { handleTableOrders } from "@/lib/tables/handlers";
import { tableRouteDeps } from "../_deps";

export const dynamic = "force-dynamic";

/** POST /api/table/orders (api-contract 9.5): one round from the guest's table (cookie), re-priced by the database. */
export function POST(req: Request) {
  return handleTableOrders(req, tableRouteDeps());
}

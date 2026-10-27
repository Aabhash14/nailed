import { handleMenu } from "@/lib/menu-route";
import { realDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleMenu(req, {
    db: realDeps.publicDb,
    supabaseUrl: realDeps.supabaseUrl,
    limiterDb: realDeps.adminDb, // SEC-021 per-IP limit (service-role RPC)
    salt: realDeps.salt,
  });
}

import { handleHealth } from "@/lib/health";
import { realDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  // schedule: the staff digest (SEC-019) runs after the response, at most once per 5 minutes across all callers.
  return handleHealth(req, { db: realDeps.adminDb, salt: realDeps.salt, schedule: realDeps.schedule });
}

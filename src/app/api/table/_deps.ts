import { realDeps } from "@/lib/deps";
import type { TableRouteDeps } from "@/lib/tables/handlers";

/**
 * Real dependencies for the /api/table/* route handlers (api-contract 9.3 to 9.5). Service-role client: every table
 * RPC and the rate limiter are service-role only; the guest's signed cookie is the credential.
 */
export function tableRouteDeps(): TableRouteDeps {
  return {
    db: realDeps.adminDb,
    salt: realDeps.salt,
    siteUrl: realDeps.siteUrl,
    cookieKeys: realDeps.tableCookieKeys,
    schedule: realDeps.schedule,
  };
}

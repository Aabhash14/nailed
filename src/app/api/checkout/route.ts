import { handleCheckout } from "@/lib/orders/checkout";
import { realDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleCheckout(req, {
    db: realDeps.adminDb,
    salt: realDeps.salt,
    siteUrl: realDeps.siteUrl,
    schedule: realDeps.schedule,
    revalidateShop: realDeps.revalidateShop,
  });
}

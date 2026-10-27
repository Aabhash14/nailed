import { handleOrderCancel } from "@/lib/orders/public";
import { realDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return handleOrderCancel(req, token, {
    db: realDeps.adminDb,
    salt: realDeps.salt,
    schedule: realDeps.schedule,
    revalidateShop: realDeps.revalidateShop,
  });
}

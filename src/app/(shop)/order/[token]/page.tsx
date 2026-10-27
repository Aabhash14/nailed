import type { Metadata } from "next";
import { OrderStatusView } from "@/components/order/order-status-view";
import { Container } from "@/components/site/page-parts";
import { getPublicSettingsSafe } from "@/data-access/public-server";

// The URL token is the credential: keep it out of search engines and out of Referer headers.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your order",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ placed?: string }>;
}) {
  const { token } = await params;
  const { placed } = await searchParams;
  const settings = await getPublicSettingsSafe();
  return (
    <main className="pt-section-sm">
      <Container>
        <OrderStatusView token={token} justPlaced={placed === "1"} cafePhone={settings?.phone ?? null} />
      </Container>
    </main>
  );
}

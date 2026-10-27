import type { Metadata } from "next";
import { CartView } from "@/components/shop/cart-view";
import { Container, PageHeader } from "@/components/site/page-parts";
import { ordersArePaused } from "@/types/contract";
import { getPublicSettingsSafe } from "@/data-access/public-server";

export const metadata: Metadata = { title: "Your cart", robots: { index: false } };

// Per request, so the "online orders are paused" notice appears and disappears as soon as the owner switches it.
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const settings = await getPublicSettingsSafe(); // null on failure: the cart still works, checkout re-checks
  return (
    <main className="pt-section-sm">
      <Container className="space-y-stack">
        <PageHeader align="start" title="Your cart" />
        <CartView ordersPaused={ordersArePaused(settings)} cafePhone={settings?.phone ?? null} />
      </Container>
    </main>
  );
}

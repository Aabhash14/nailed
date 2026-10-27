import type { Metadata } from "next";
import { CheckoutForm } from "@/components/shop/checkout-form";
import { Container, PageHeader } from "@/components/site/page-parts";
import { getPublicSettings } from "@/data-access/public-server";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };

// Rendered per request (not ISR) so the owner's "pause online orders" switch, delivery areas and fees are always current.
// Checkout traffic is small: one public settings read per view. (ISR + revalidateTag("settings") would need a tag cache
// in the OpenNext config, which does not exist yet.)
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const settings = await getPublicSettings(); // throws -> checkout/error.tsx
  return (
    <main className="pt-section-sm">
      <Container className="space-y-stack">
        <PageHeader
          align="start"
          title="Checkout"
          intro="Cash on delivery or pay at pickup. There is no online payment."
        />
        <CheckoutForm settings={settings} />
      </Container>
    </main>
  );
}

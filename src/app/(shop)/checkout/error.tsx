"use client";

import { Banner } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { Container, PageHeader } from "@/components/site/page-parts";

export default function CheckoutError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="pt-section-sm">
      <Container width="narrow" className="space-y-6">
        <PageHeader align="start" title="Checkout" />
        <Banner tone="danger" live="alert" title="Checkout is not available right now">
          Your cart is safe. Please try again in a moment, or call us to order.
        </Banner>
        <Button onClick={reset}>Try again</Button>
      </Container>
    </main>
  );
}

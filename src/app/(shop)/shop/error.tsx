"use client";

import { Banner } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { Container, PageHeader } from "@/components/site/page-parts";

export default function ShopError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="pt-section-sm">
      <Container width="narrow" className="space-y-6">
        <PageHeader title="Shop" />
        <Banner tone="danger" live="alert" title="We could not load the shop">
          Something went wrong on our side. Please try again in a moment.
        </Banner>
        <Button onClick={reset}>Try again</Button>
      </Container>
    </main>
  );
}

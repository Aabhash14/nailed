import type { Metadata } from "next";
import { EmptyState, SampleDataBanner } from "@/components/ui/feedback";
import { ProductCard } from "@/components/shop/product-parts";
import { ACCENT } from "@/components/site/accents";
import { Container, PageHeader } from "@/components/site/page-parts";
import { isMock } from "@/data-access/mode";
import { listProducts } from "@/data-access/public-server";

export const metadata: Metadata = { title: "Shop", description: "Merch from Nailed Cafe & Lodge." };
export const revalidate = 3600;

export default async function ShopPage() {
  const products = await listProducts(); // throws -> shop/error.tsx
  return (
    <main className="pt-section-sm">
      <Container className="space-y-stack">
        <PageHeader
          title="Shop"
          accent={ACCENT.shop}
          intro="Pay in cash on delivery or at pickup. We call you to confirm every order."
        />
        {isMock ? <SampleDataBanner /> : null}
        {products.length === 0 ? (
          <EmptyState title="Nothing in the shop yet">
            Check back soon, or visit us at the cafe.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 md:gap-x-6 lg:grid-cols-4">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </ul>
        )}
      </Container>
    </main>
  );
}

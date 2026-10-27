import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductDetail } from "@/components/shop/product-detail";
import { Container } from "@/components/site/page-parts";
import { SampleDataBanner } from "@/components/ui/feedback";
import { isMock } from "@/data-access/mode";
import { getProductBySlug } from "@/data-access/public-server";

/**
 * SEC-021: rendered per request instead of ISR with dynamicParams. With ISR, every new /shop/<random> path was rendered
 * on demand and its 404 stored as a cache entry (a KV write on Cloudflare), so anyone could use up the free KV quota.
 * Now a badly shaped slug is refused before any data read, and a well-shaped one is looked up in ONE cached product
 * list (getProductBySlug), so unknown slugs cause no database reads and no cache writes.
 * This also ends BUG-001's reopened part: the duplicate robots meta came from regenerated 404 cache entries.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  try {
    const p = await getProductBySlug(slug);
    return p ? { title: p.name, description: p.description ?? undefined } : { title: "Product not found" };
  } catch {
    return { title: "Shop" };
  }
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();
  return (
    <main className="pt-6">
      <Container className="space-y-6">
        <p>
          <Link href="/shop" className="text-primary min-h-tap group inline-flex items-center gap-2 font-semibold">
            <span aria-hidden="true" className="transition-transform duration-(--motion-base) group-hover:-translate-x-0.5">
              ←
            </span>
            <span className="link-underline">Back to the shop</span>
          </Link>
        </p>
        {isMock ? <SampleDataBanner /> : null}
        <ProductDetail product={product} />
      </Container>
    </main>
  );
}

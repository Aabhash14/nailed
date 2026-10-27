import { Container } from "@/components/site/page-parts";
import { Skeleton } from "@/components/ui/feedback";

// Lives in the (list) route group on purpose: a loading.tsx above /shop/[slug] would stream the page shell before
// notFound() runs and turn unknown products into HTTP 200 soft 404s (BUG-001).

export default function ShopLoading() {
  return (
    <main aria-busy="true" aria-label="Loading the shop" className="pt-section-sm">
      <Container className="space-y-stack">
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="h-6 w-14" />
          <Skeleton className="h-11 w-32" />
          <Skeleton className="h-5 w-full max-w-md" />
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 md:gap-x-6 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="aspect-square w-full" />
              <Skeleton className="h-5 w-3/4" />
            </div>
          ))}
        </div>
      </Container>
    </main>
  );
}

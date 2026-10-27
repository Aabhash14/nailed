import { Container } from "@/components/site/page-parts";
import { Skeleton } from "@/components/ui/feedback";

export default function MenuLoading() {
  return (
    <main aria-busy="true" aria-label="Loading the menu" className="pt-4">
      <Container width="reading" className="space-y-5">
        <div className="flex flex-col items-center gap-3 pt-2">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-11 w-40" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-8 w-1/2" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="border-line/80 space-y-2 border-b py-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 flex-1" />
              <Skeleton className="h-5 w-16" />
            </div>
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </Container>
    </main>
  );
}

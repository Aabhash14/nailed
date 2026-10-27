import Link from "next/link";
import { formatNpr } from "@/lib/money";
import { Badge } from "@/components/ui/feedback";
import { Picture } from "@/components/ui/media";
import type { Product, StockState } from "@/types/contract";
import { orderSizes } from "./size-order";

export { orderChartColumns, orderSizes, orderVariants } from "./size-order";

export function productStock(p: Product): StockState {
  if (p.variants.length === 0 || p.variants.every((v) => v.stockState === "sold_out"))
    return "sold_out";
  if (p.variants.some((v) => v.stockState === "in_stock")) return "in_stock";
  return "few_left";
}

export function fromPrice(p: Product): number {
  return p.variants.length > 0 ? Math.min(...p.variants.map((v) => v.price)) : p.price;
}

export function StockBadge({ state }: { state: StockState }) {
  if (state === "sold_out") return <Badge tone="danger">Sold out</Badge>;
  if (state === "few_left") return <Badge tone="accent">Only a few left</Badge>;
  return null;
}

/** Sizes on offer in size order, e.g. "S–XL" for a run or "One size". Display only. */
function sizeSummary(p: Product): string | null {
  const sizes = orderSizes(
    [...new Set(p.variants.map((v) => v.size))],
    p.variants.map((v) => v.size),
  );
  if (sizes.length === 0) return null;
  if (sizes.length === 1) return sizes[0] ?? null;
  return `${sizes[0]}–${sizes[sizes.length - 1]}`;
}

export function ProductCard({
  product,
  headingLevel = 2,
}: {
  product: Product;
  headingLevel?: 2 | 3;
}) {
  const stock = productStock(product);
  const img = product.images[0];
  const varied = new Set(product.variants.map((v) => v.price)).size > 1;
  const sizes = sizeSummary(product);
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <li>
      <Link href={`/shop/${product.slug}`} className="group rounded-card block h-full">
        <div className="photo-ground border-line rounded-card shadow-card group-hover:shadow-lift relative overflow-hidden border transition-shadow duration-(--motion-base)">
          <div
            className={`ease-soft transition-transform duration-(--motion-slow) group-hover:scale-[1.03] ${stock === "sold_out" ? "opacity-75 grayscale-[35%]" : ""}`}
          >
            <Picture
              url={img?.url ?? null}
              variants={img?.variants ?? []}
              alt={img?.alt ?? ""}
              sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
              ratio="aspect-square"
              placeholderLabel={product.name}
              compact
            />
          </div>
          {stock === "sold_out" ? (
            <div aria-hidden="true" className="hatch-soldout absolute inset-0" />
          ) : null}
          {stock !== "in_stock" ? (
            <div className="absolute top-3 left-3">
              <StockBadge state={stock} />
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-1 px-0.5 pt-3 xl:flex-row xl:items-start xl:justify-between xl:gap-3">
          <div className="min-w-0">
            <Heading className="font-display group-hover:text-primary text-lg leading-snug transition-colors duration-(--motion-base)">
              {product.name}
            </Heading>
            {sizes ? <p className="text-ink-muted text-sm">{sizes}</p> : null}
          </div>
          <p className="price shrink-0 text-lg xl:pt-0.5">
            {varied ? <span className="text-ink-muted text-sm">From </span> : null}
            {formatNpr(fromPrice(product))}
          </p>
        </div>
      </Link>
    </li>
  );
}

"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { formatNpr } from "@/lib/money";
import { Button, LinkButton } from "@/components/ui/button";
import { Banner } from "@/components/ui/feedback";
import { Picture } from "@/components/ui/media";
import type { Product } from "@/types/contract";
import { useCart } from "./cart-provider";
import {
  orderChartColumns,
  orderSizes,
  orderVariants,
  productStock,
  StockBadge,
} from "./product-parts";

/** Main photo + tappable thumbnails (design review T-048 fix 33). One photo: no thumbnail row. */
function Gallery({ product, soldOut }: { product: Product; soldOut: boolean }) {
  const [shown, setShown] = useState(0);
  const images = product.images;
  const img = images[shown] ?? images[0];
  return (
    <div className="space-y-3">
      <div className="photo-ground border-line rounded-card shadow-card relative overflow-hidden border">
        <div className={soldOut ? "opacity-80 grayscale-[30%]" : ""}>
          <Picture
            key={img?.url ?? "none"}
            url={img?.url ?? null}
            variants={img?.variants ?? []}
            alt={img?.alt ?? ""}
            sizes="(min-width: 1024px) 560px, (min-width: 768px) 50vw, 100vw"
            ratio="aspect-square"
            placeholderLabel={product.name}
            className="animate-fade"
            priority
          />
        </div>
      </div>
      {images.length > 1 ? (
        <ul className="grid grid-cols-5 gap-2" aria-label="Product photos">
          {images.map((im, i) => (
            <li key={im.url}>
              <button
                type="button"
                aria-label={`Show photo ${i + 1} of ${images.length}`}
                aria-pressed={i === shown}
                onClick={() => setShown(i)}
                className="rounded-control border-line aria-pressed:border-primary aria-pressed:ring-primary hover:border-ink block w-full overflow-hidden border transition-[border-color,box-shadow] duration-(--motion-fast) aria-pressed:ring-2"
              >
                <Picture
                  url={im.url}
                  variants={im.variants}
                  alt=""
                  sizes="120px"
                  ratio="aspect-square"
                  placeholderLabel={product.name}
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ProductDetail({ product }: { product: Product }) {
  const cart = useCart();
  const groupId = useId();
  const variants = useMemo(() => orderVariants(product.variants), [product.variants]);
  const firstAvailable = variants.find((v) => v.stockState !== "sold_out") ?? variants[0];
  const [variantId, setVariantId] = useState<string | undefined>(firstAvailable?.id);
  const [added, setAdded] = useState(false);

  const variant = useMemo(
    () => product.variants.find((v) => v.id === variantId),
    [product.variants, variantId],
  );
  const productState = productStock(product);
  const d = product.details;
  const chart = d.sizeChartCm;
  const hasChart = !!chart && Object.keys(chart).length > 0;
  const chartColumns = chart ? orderChartColumns(Object.keys(Object.values(chart)[0] ?? {})) : [];

  const canAdd = variant !== undefined && variant.stockState !== "sold_out";

  return (
    <article className="grid gap-8 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-12">
      <div className="md:sticky md:top-6 md:self-start">
        <Gallery product={product} soldOut={productState === "sold_out"} />
      </div>

      <div className="space-y-6">
        <header className="rise-stagger space-y-3">
          <h1 className="font-display text-title-1">{product.name}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <p className="price text-3xl" aria-live="polite">
              {formatNpr(variant?.price ?? product.price)}
            </p>
            <StockBadge state={variant?.stockState ?? productState} />
          </div>
        </header>

        {product.description ? (
          <p className="text-lead max-w-reading">{product.description}</p>
        ) : null}

        {product.variants.length === 0 ? (
          <Banner tone="warning">This product has no sizes available yet.</Banner>
        ) : (
          <fieldset className="space-y-3">
            <legend className="font-display text-label tracking-label py-1 uppercase">
              Size and colour
            </legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {variants.map((v) => {
                const out = v.stockState === "sold_out";
                const id = `${groupId}-${v.id}`;
                return (
                  <div key={v.id}>
                    <input
                      type="radio"
                      id={id}
                      name={`${groupId}-variant`}
                      value={v.id}
                      checked={variantId === v.id}
                      disabled={out}
                      onChange={() => {
                        setVariantId(v.id);
                        setAdded(false);
                      }}
                      className="peer sr-only"
                    />
                    <label
                      htmlFor={id}
                      className="border-line-strong bg-surface-raised peer-checked:border-primary peer-checked:ring-primary peer-focus-visible:outline-primary rounded-control min-h-tap peer-disabled:text-ink-muted peer-disabled:hatch-soldout hover:border-ink peer-disabled:hover:border-line-strong flex h-full cursor-pointer flex-col justify-center border px-3 py-2 transition-[border-color,box-shadow] duration-(--motion-fast) peer-checked:ring-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-disabled:cursor-not-allowed"
                    >
                      <span className="font-semibold">
                        {v.size}, {v.colour}
                      </span>
                      <span className="text-sm">
                        {out
                          ? "Sold out"
                          : v.stockState === "few_left"
                            ? "Only a few left"
                            : formatNpr(v.price)}
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>
            {hasChart ? (
              <a
                href="#pd-size"
                className="text-primary min-h-tap link-underline inline-flex items-center text-sm font-semibold"
              >
                Size chart
              </a>
            ) : null}
          </fieldset>
        )}

        <div className="space-y-3">
          <Button
            size="lg"
            className="w-full sm:w-auto sm:min-w-64"
            disabled={!canAdd}
            onClick={() => {
              if (!variant) return;
              cart.add({
                variantId: variant.id,
                productSlug: product.slug,
                productName: product.name,
                size: variant.size,
                colour: variant.colour,
                unitPrice: variant.price,
              });
              setAdded(true);
            }}
          >
            {canAdd ? "Add to cart" : "Sold out"}
          </Button>
          <div role="status" aria-live="polite">
            {added ? (
              <Banner tone="success" className="animate-rise">
                Added to your cart.{" "}
                <Link href="/cart" className="font-semibold underline">
                  View cart
                </Link>
              </Banner>
            ) : null}
          </div>
          <p className="text-ink-muted text-sm">
            Pay in cash on delivery or at pickup. We will call you to confirm.
          </p>
        </div>

        {d.fabric || d.gsm || d.printMethod || d.credit ? (
          <section aria-labelledby="pd-details" className="space-y-3">
            <h2 id="pd-details" className="font-display text-title-3">
              Details
            </h2>
            <dl className="border-ink border-t-2">
              {d.fabric ? (
                <div className="border-line flex justify-between gap-4 border-b py-2.5">
                  <dt className="font-semibold">Fabric</dt>
                  <dd className="text-right">{d.fabric}</dd>
                </div>
              ) : null}
              {d.gsm ? (
                <div className="border-line flex justify-between gap-4 border-b py-2.5">
                  <dt className="font-semibold">Weight</dt>
                  <dd className="text-right">{d.gsm} gsm</dd>
                </div>
              ) : null}
              {d.printMethod ? (
                <div className="border-line flex justify-between gap-4 border-b py-2.5">
                  <dt className="font-semibold">Print</dt>
                  <dd className="text-right">{d.printMethod}</dd>
                </div>
              ) : null}
              {d.credit ? (
                <div className="border-line flex justify-between gap-4 border-b py-2.5">
                  <dt className="font-semibold">Design by</dt>
                  <dd className="text-right">{d.credit}</dd>
                </div>
              ) : null}
            </dl>
          </section>
        ) : null}

        {hasChart && chart ? (
          <section aria-labelledby="pd-size" className="space-y-3">
            <h2 id="pd-size" className="font-display text-title-3 scroll-mt-6">
              Size chart (cm)
            </h2>
            <div className="border-line rounded-card bg-surface-raised overflow-x-auto border">
              <table className="w-full text-left text-sm tabular-nums">
                <caption className="sr-only">Measurements in centimetres by size</caption>
                <thead className="bg-surface-alt">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Size
                    </th>
                    {chartColumns.map((k) => (
                      <th key={k} scope="col" className="px-3 py-2 font-semibold capitalize">
                        {k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orderSizes(
                    Object.keys(chart),
                    product.variants.map((v) => v.size),
                  ).map((size) => (
                    <tr key={size} className="border-line border-t">
                      <th scope="row" className="px-3 py-2 font-semibold">
                        {size}
                      </th>
                      {chartColumns.map((k) => (
                        <td key={k} className="px-3 py-2">
                          {chart[size]?.[k] ?? "–"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {cart.count > 0 ? (
          <LinkButton href="/cart" variant="secondary">
            Go to cart ({cart.count})
          </LinkButton>
        ) : null}
      </div>
    </article>
  );
}

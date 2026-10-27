"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatNpr } from "@/lib/money";
import { Button, LinkButton } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { ordersArePaused } from "@/types/contract";
import { isMock } from "@/data-access/mode";
import { mockSettingsForBrowser } from "@/data-access/public-client";
import { MAX_QTY } from "./cart-logic";
import { useCart } from "./cart-provider";
import { OrdersPausedNotice } from "./orders-paused";

export function CartView({ ordersPaused, cafePhone }: { ordersPaused: boolean; cafePhone: string | null }) {
  const cart = useCart();
  const [paused, setPaused] = useState(ordersPaused);
  const [phone, setPhone] = useState(cafePhone);

  // Mock mode: the demo settings (incl. the pause switch in /admin/settings) live in this browser.
  useEffect(() => {
    if (!isMock) return;
    const s = mockSettingsForBrowser();
    setPaused(ordersArePaused(s));
    setPhone(s.phone);
  }, []);

  if (!cart.ready) {
    return (
      <div aria-busy="true" aria-label="Loading your cart" className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <EmptyState title="Your cart is empty" action={<LinkButton href="/shop">Browse the shop</LinkButton>}>
        Add something from the shop and it will show up here.
      </EmptyState>
    );
  }

  const stepper =
    "grid h-11 w-11 place-items-center text-xl leading-none text-primary transition-colors duration-(--motion-fast) hover:bg-surface-alt disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-50 disabled:hover:bg-transparent";

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="space-y-5">
        {paused ? <OrdersPausedNotice phone={phone} /> : null}
        <ul className="divide-line border-ink divide-y border-y-2 border-b-0">
          {cart.lines.map((l) => (
            <li key={l.variantId} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3 py-5">
              <div className="min-w-0">
                <p className="font-display text-lg leading-snug">{l.productName}</p>
                <p className="text-ink-muted text-sm">
                  {l.size}, {l.colour} &middot; {formatNpr(l.unitPrice)} each
                </p>
              </div>
              <p className="price pt-0.5 text-right text-lg">{formatNpr(l.unitPrice * l.qty)}</p>
              <div className="col-span-2 flex flex-wrap items-center justify-between gap-3">
                <div
                  role="group"
                  aria-label={`Quantity for ${l.productName}, ${l.size}, ${l.colour}`}
                  className="border-line-strong bg-surface-raised rounded-control inline-flex items-center overflow-hidden border"
                >
                  {/* Design review T-048 fix 24: at 1, "−" is disabled (Remove is the way to take the line out). */}
                  <button
                    type="button"
                    className={stepper}
                    aria-label="Fewer"
                    disabled={l.qty <= 1}
                    onClick={() => cart.setQty(l.variantId, l.qty - 1)}
                  >
                    −
                  </button>
                  <span className="border-line min-w-11 border-x text-center leading-[2.75rem] font-semibold tabular-nums" aria-live="polite">
                    {l.qty}
                  </span>
                  <button
                    type="button"
                    className={stepper}
                    aria-label="More"
                    disabled={l.qty >= MAX_QTY}
                    onClick={() => cart.setQty(l.variantId, l.qty + 1)}
                  >
                    +
                  </button>
                </div>
                <Button variant="ghost" className="px-2" onClick={() => cart.remove(l.variantId)} aria-label={`Remove ${l.productName}, ${l.size}, ${l.colour}`}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <Link href="/shop" className="text-primary min-h-tap link-underline inline-flex items-center font-semibold">
          Keep shopping
        </Link>
      </div>

      <aside aria-labelledby="cart-summary" className="border-line bg-surface-raised rounded-card shadow-card relative space-y-4 overflow-hidden border p-5 pt-6 lg:sticky lg:top-6">
        <div aria-hidden="true" className="ornament-band-sm absolute inset-x-0 top-0" />
        <h2 id="cart-summary" className="font-display text-title-3">
          Your order
        </h2>
        <p className="border-line flex items-baseline justify-between gap-3 border-t pt-4 text-lg">
          Subtotal <span className="price text-xl">{formatNpr(cart.subtotal)}</span>
        </p>
        {paused ? null : (
          <>
            <LinkButton href="/checkout" size="lg" className="w-full">
              Checkout
            </LinkButton>
            <p className="text-ink-muted text-sm">Delivery fee and the total are shown at checkout. You pay in cash. We call you to confirm.</p>
          </>
        )}
      </aside>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatNpr } from "@/lib/money";
import { Button, LinkButton } from "@/components/ui/button";
import { Banner, Skeleton } from "@/components/ui/feedback";
import { cancelOrderByToken, fetchOrder } from "@/data-access/public-client";
import { formatDateTime, telHref } from "@/components/format";
import type { ApiError, OrderStatus, OrderView } from "@/types/contract";
import { payLine } from "@/components/shop/checkout-logic";
import { isActive } from "@/types/order-flow";

const POLL_MS = 30_000;

const HEADLINE: Record<OrderStatus, string> = {
  placed: "We have your order",
  confirmed: "Your order is confirmed",
  out_for_delivery: "Your order is on its way",
  ready_for_pickup: "Your order is ready for pickup",
  completed: "Order complete. Thank you",
  cancelled: "This order was cancelled",
};

function steps(fulfilment: OrderView["fulfilment"]): { status: OrderStatus; label: string }[] {
  return [
    { status: "placed", label: "Order placed" },
    { status: "confirmed", label: "Confirmed by phone" },
    fulfilment === "delivery"
      ? { status: "out_for_delivery", label: "Out for delivery" }
      : { status: "ready_for_pickup", label: "Ready for pickup" },
    { status: "completed", label: "Completed" },
  ];
}

/** The order page address without the one-off `placed=1` marker (that is what the customer should keep). */
export function keepableOrderUrl(href: string): string {
  const u = new URL(href);
  u.searchParams.delete("placed");
  u.hash = "";
  return u.toString();
}

/**
 * Design review T-048 fix 9: the customer has no account, so this page's address is the only way back to the order.
 * Wording is a working draft and depends on T-049 (does the link expire?); placeholder until content-writer T-052.
 */
function KeepThisLink() {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(keepableOrderUrl(window.location.href));
      setCopied("done");
    } catch {
      setCopied("failed"); // clipboard blocked (permissions, older browser): say how to do it by hand
    }
  }
  return (
    <section
      aria-labelledby="keep-link-h"
      className="border-accent bg-surface-raised rounded-card animate-rise space-y-3 border-2 border-dashed p-5"
    >
      <h2 id="keep-link-h" className="font-display text-title-3">
        Keep this link
      </h2>
      <p>This page is how you check your order. Bookmark it or take a screenshot.</p>
      <Button variant="secondary" onClick={() => void copy()}>
        {copied === "done" ? "Link copied" : "Copy link"}
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {copied === "done"
          ? "Link copied."
          : copied === "failed"
            ? "Could not copy. Copy the address from your browser's address bar instead."
            : ""}
      </p>
    </section>
  );
}

export function OrderStatusView({
  token,
  justPlaced,
  cafePhone,
}: {
  token: string;
  justPlaced: boolean;
  cafePhone: string | null;
}) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const statusRef = useRef<OrderStatus | null>(null);

  const load = useCallback(async () => {
    const res = await fetchOrder(token);
    if (res.ok) {
      setOrder(res.data);
      statusRef.current = res.data.status;
      setError(null);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    void load();
    // Poll every 30 s only while the tab is visible and the order is still active. No Realtime on this page.
    const t = setInterval(() => {
      const s = statusRef.current;
      if (document.visibilityState === "visible" && (s === null || isActive(s))) void load();
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  async function doCancel() {
    setCancelling(true);
    setCancelError(null);
    const res = await cancelOrderByToken(token);
    setCancelling(false);
    if (res.ok) {
      setOrder(res.data);
      statusRef.current = res.data.status;
      setConfirming(false);
    } else {
      setCancelError(res.error.message);
      void load();
    }
  }

  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading your order" className="max-w-reading space-y-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-11 w-72 max-w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!order) {
    const notFound = error?.code === "NOT_FOUND";
    return (
      <div className="max-w-reading space-y-4">
        <Banner
          tone={notFound ? "warning" : "danger"}
          live="alert"
          title={notFound ? "We could not find that order" : "We could not load your order"}
        >
          {notFound
            ? "Check the link we gave you, or call us."
            : (error?.message ?? "Please try again.")}
        </Banner>
        {!notFound ? <Button onClick={() => void load()}>Try again</Button> : null}
        {cafePhone ? (
          <p>
            Call us on{" "}
            <a className="text-primary font-semibold underline" href={telHref(cafePhone)}>
              {cafePhone}
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  const active = isActive(order.status);
  // QA 2026-10-23: with VAT-inclusive prices the VAT is part of the total, so it is shown under the total as
  // "includes VAT Rs. X", not as a line that reads as added on top. Inclusive = the total has no separate VAT added.
  const vatInTotal = order.total === order.subtotal + order.deliveryFee;
  const flow = steps(order.fulfilment);
  const currentIdx = flow.findIndex((s) => s.status === order.status);

  return (
    // S25-9: from lg the order summary sits on the right, as on checkout. Phones keep the single column, same order.
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-12">
      <div className="max-w-reading space-y-6">
        <header className="rise-stagger space-y-2">
          <p className="text-eyebrow text-primary flex items-center gap-2.5 font-semibold uppercase">
            <span aria-hidden="true" className="ornament-diamond" />
            Order {order.number}
          </p>
          <h1 className="font-display text-title-1 outline-none" tabIndex={-1}>
            {justPlaced && order.status === "placed"
              ? "Thank you, we have your order"
              : HEADLINE[order.status]}
          </h1>
        </header>

        {justPlaced ? <KeepThisLink /> : null}

        {/* BUG-005: outside the cancel section, which disappears when the refresh shows the order can no longer be cancelled. */}
        {cancelError && order.status !== "cancelled" ? (
          <Banner tone="danger" live="alert" title="Your order was NOT cancelled">
            {cancelError}
            {cafePhone ? (
              <>
                {" "}
                <a className="font-semibold underline" href={telHref(cafePhone)}>
                  Call {cafePhone}
                </a>
              </>
            ) : null}
          </Banner>
        ) : null}

        <div role="status" aria-live="polite" className="space-y-3">
          {order.status === "placed" ? (
            <Banner tone="info" title="We will call you to confirm">
              Please keep your phone nearby. Your order is not confirmed until we have spoken to
              you.
            </Banner>
          ) : null}
          {order.status === "cancelled" && order.cancelReason === "auto_unconfirmed" ? (
            <Banner tone="warning" title="Cancelled: not confirmed in time">
              We could not confirm this order with you by phone in time, so it was cancelled. Please
              call us
              {cafePhone ? (
                <>
                  {" "}
                  on{" "}
                  <a className="font-semibold underline" href={telHref(cafePhone)}>
                    {cafePhone}
                  </a>
                </>
              ) : null}{" "}
              if you still want it.
            </Banner>
          ) : order.status === "cancelled" ? (
            <Banner tone="warning">
              This order has been cancelled. If this is a surprise, please call us
              {cafePhone ? ` on ${cafePhone}` : ""}.
            </Banner>
          ) : null}
          {active ? (
            <p className="text-title-3 font-semibold tabular-nums">
              {payLine(order.total, order.fulfilment)}
            </p>
          ) : null}
          {order.status === "completed" ? <p>Paid in cash: {formatNpr(order.total)}.</p> : null}
        </div>

        {order.status !== "cancelled" ? (
          <ol aria-label="Order progress" className="grid gap-3 sm:grid-cols-4 sm:gap-2">
            {flow.map((s, i) => {
              const done = i < currentIdx || order.status === "completed";
              const current = i === currentIdx && order.status !== "completed";
              return (
                <li
                  key={s.status}
                  aria-current={current ? "step" : undefined}
                  className={`relative flex items-center gap-3 sm:flex-col sm:items-start sm:gap-2 sm:border-t-[3px] sm:pt-3 ${done ? "sm:border-success" : current ? "sm:border-primary" : "text-ink-muted sm:border-line"}`}
                >
                  {i > 0 ? (
                    <span
                      aria-hidden="true"
                      className={`absolute -top-3 left-[0.9rem] h-3 w-0.5 sm:hidden ${done || current ? "bg-success" : "bg-line"}`}
                    />
                  ) : null}
                  <span
                    aria-hidden="true"
                    className={`rounded-pill flex h-8 w-8 shrink-0 items-center justify-center border text-sm font-semibold ${done ? "bg-success text-on-success border-transparent" : current ? "bg-primary text-on-primary animate-rise border-transparent" : "border-line-strong bg-surface-raised"}`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span className={`text-sm leading-snug ${current ? "font-semibold" : ""}`}>
                    {s.label}
                    <span className="sr-only">
                      {done ? " (done)" : current ? " (now)" : " (not yet)"}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>

      <div className="space-y-6 lg:sticky lg:top-6">
        <section
          aria-labelledby="oi"
          className="border-line bg-surface-raised rounded-card shadow-card relative overflow-hidden border p-5 pt-6"
        >
          <div aria-hidden="true" className="ornament-band-sm absolute inset-x-0 top-0" />
          <h2 id="oi" className="font-display text-title-3">
            What you ordered
          </h2>
          <ul className="mt-3 space-y-1.5">
            {order.items.map((it, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span>
                  {it.qty} x {it.name}
                </span>
                <span aria-hidden="true" className="leader" />
                <span className="price">{formatNpr(it.unitPrice * it.qty)}</span>
              </li>
            ))}
          </ul>
          <dl className="border-line mt-4 space-y-1 border-t pt-3 tabular-nums">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd>{formatNpr(order.subtotal)}</dd>
            </div>
            {order.deliveryFee > 0 ? (
              <div className="flex justify-between">
                <dt>Delivery fee</dt>
                <dd>{formatNpr(order.deliveryFee)}</dd>
              </div>
            ) : null}
            {order.vat > 0 && !vatInTotal ? (
              <div className="flex justify-between">
                <dt>VAT</dt>
                <dd>{formatNpr(order.vat)}</dd>
              </div>
            ) : null}
            <div className="border-ink mt-2 flex items-baseline justify-between border-t-2 pt-2 text-lg font-semibold">
              <dt>Total</dt>
              <dd className="price text-2xl">{formatNpr(order.total)}</dd>
            </div>
            {order.vat > 0 && vatInTotal ? (
              <div className="text-ink-muted flex justify-end text-sm">
                <dt className="sr-only">VAT</dt>
                <dd>includes VAT {formatNpr(order.vat)}</dd>
              </div>
            ) : null}
          </dl>
          <p className="text-ink-muted mt-2 text-sm">
            {order.fulfilment === "delivery" ? "Delivery" : "Pickup"} for {order.customerName}.
            Placed {formatDateTime(order.createdAt)}.
          </p>
        </section>

        {order.canCancel ? (
          <section aria-labelledby="oc" className="space-y-3">
            <h2 id="oc" className="font-display text-title-3">
              Changed your mind?
            </h2>
            {!confirming ? (
              <Button variant="secondary" onClick={() => setConfirming(true)}>
                Cancel this order
              </Button>
            ) : (
              <div className="border-danger bg-surface-raised rounded-card animate-rise space-y-3 border p-4">
                <p className="font-semibold">Cancel order {order.number}? This cannot be undone.</p>
                <div className="flex flex-wrap gap-3">
                  <Button variant="danger" disabled={cancelling} onClick={() => void doCancel()}>
                    {cancelling ? "Cancelling..." : "Yes, cancel my order"}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirming(false)}>
                    Keep my order
                  </Button>
                </div>
              </div>
            )}
          </section>
        ) : active ? (
          <p className="text-sm">
            To change this order, please call us
            {cafePhone ? (
              <>
                {" "}
                on{" "}
                <a className="text-primary font-semibold underline" href={telHref(cafePhone)}>
                  {cafePhone}
                </a>
              </>
            ) : null}
            .
          </p>
        ) : null}

        {/* -ml-5 cancels the ghost button's padding, so its text lines up with the content above */}
        <LinkButton href="/shop" variant="ghost" className="-ml-5">
          Back to the shop
        </LinkButton>
      </div>
    </div>
  );
}

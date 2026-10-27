"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { adminApi } from "@/data-access/admin";
import { formatDateTime } from "@/components/format";
import type { AdminOrderRow } from "@/types/contract";
import { isActive } from "@/types/order-flow";
import { OrderCard } from "./orders-board";

const POLL_MS = 30_000;

/** /admin/orders/[id]: the target of the Telegram "new order" link. Same actions as the card on Today's orders. */
export function OrderDetail({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<AdminOrderRow | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_found" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await adminApi.getOrder({ orderId });
    if (res.ok) {
      setOrder(res.data);
      setState("ready");
      setError(null);
    } else if (res.error.code === "NOT_FOUND" || res.error.code === "VALIDATION") {
      setState("not_found");
    } else {
      setError(res.error.message);
      setState((s) => (s === "ready" ? s : "error"));
    }
  }, [orderId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const off = adminApi.subscribeOrders(() => void load());
    return () => {
      clearInterval(t);
      off?.();
    };
  }, [load]);

  const back = (
    <p>
      <Link href="/admin" className="text-primary min-h-tap inline-flex items-center underline">
        Back to Today&apos;s orders
      </Link>
    </p>
  );

  if (state === "loading") {
    return (
      <div className="space-y-4">
        {back}
        <div aria-busy="true" aria-label="Loading the order" className="space-y-3">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (state === "not_found") {
    return (
      <div className="space-y-4">
        {back}
        <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Order not found</h1>
        <EmptyState title="We could not find this order">
          The link may be wrong, or the order is too old to show here. Check Today&apos;s orders instead.
        </EmptyState>
      </div>
    );
  }

  if (state === "error" || !order) {
    return (
      <div className="space-y-4">
        {back}
        <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Order</h1>
        <Banner tone="danger" live="alert" title="Could not load this order">
          {error ?? "Please try again."}
        </Banner>
        <Button onClick={() => void load()}>Try again</Button>
      </div>
    );
  }

  const times: [string, string | null][] = [
    ["Placed", order.createdAt],
    ["Confirmed", order.confirmedAt],
    ["Completed", order.completedAt],
    ["Cancelled", order.cancelledAt],
  ];

  return (
    <div className="space-y-5">
      {back}
      {error ? (
        <Banner tone="warning" live="status" title="Could not refresh">
          {error}
        </Banner>
      ) : null}
      <OrderCard order={order} onChanged={load} detailLink={false} headingLevel={1} />
      <section aria-labelledby="od-more" className="border-line bg-surface-raised rounded-card shadow-card space-y-2 border p-4">
        <h2 id="od-more" className="font-display text-xl">
          Details
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {times
            .filter(([, t]) => t)
            .map(([label, t]) => (
              <div key={label} className="contents">
                <dt className="font-semibold">{label}</dt>
                <dd>{formatDateTime(t!)}</dd>
              </div>
            ))}
          {order.customerEmail ? (
            <div className="contents">
              <dt className="font-semibold">Email</dt>
              <dd className="break-all">{order.customerEmail}</dd>
            </div>
          ) : null}
          <div className="contents">
            <dt className="font-semibold">Payment</dt>
            <dd>
              {order.paymentStatus === "paid" ? "Cash received" : "Cash, not yet paid"} (
              {order.fulfilment === "delivery" ? "on delivery" : "at pickup"})
            </dd>
          </div>
        </dl>
        {isActive(order.status) ? null : (
          <p className="text-ink-muted text-sm">This order is finished. It no longer appears under Needs action.</p>
        )}
      </section>
    </div>
  );
}

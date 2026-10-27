"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatNpr } from "@/lib/money";
import { Button, buttonClass } from "@/components/ui/button";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { CheckField, SelectField } from "@/components/ui/field";
import { adminApi } from "@/data-access/admin";
import { agoLabel, formatClock, telHref } from "@/components/format";
import { splitBoard } from "./orders-logic";
import type { AdminOrderRow, CancelReason } from "@/types/contract";
import {
  CANCEL_REASON_LABEL,
  FORWARD_ACTION_LABEL,
  STAFF_CANCEL_REASONS,
  STATUS_LABEL,
  canCancelAs,
  isActive,
  nextForwardStatus,
} from "@/types/order-flow";
import { useAdminSession } from "./admin-shell";

const POLL_MS = 30_000;

function beep() {
  try {
    const Ctx = window.AudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => void ctx.close();
  } catch {
    /* audio not available: the visual alert still shows */
  }
}

export function OrdersBoard() {
  const [rows, setRows] = useState<AdminOrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "done">("open");
  const [sound, setSound] = useState(false);
  const knownPlaced = useRef<Set<string> | null>(null);
  const soundRef = useRef(false);
  soundRef.current = sound;

  const load = useCallback(async () => {
    const res = await adminApi.listOrders({ pageSize: 100 });
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setError(null);
    const placedIds = new Set(res.data.rows.filter((r) => r.status === "placed").map((r) => r.id));
    if (knownPlaced.current && soundRef.current) {
      for (const id of placedIds) {
        if (!knownPlaced.current.has(id)) {
          beep();
          break;
        }
      }
    }
    knownPlaced.current = placedIds;
    setRows(res.data.rows);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const off = adminApi.subscribeOrders(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void load(), 500);
    });
    return () => {
      clearInterval(t);
      if (debounce) clearTimeout(debounce);
      off?.();
    };
  }, [load]);

  // BUG-013: "Finished today" is by finish time; design review fix 5: oldest waiting orders first
  const { open, done } = splitBoard(rows ?? [], new Date());
  const shown = tab === "open" ? open : done;
  const staleCount = open.filter((r) => r.isStale).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Today&apos;s orders</h1>
        <CheckField
          label="Sound for new orders"
          hint="Plays a beep when a new order arrives. Keep this page open."
          checked={sound}
          onChange={(e) => {
            setSound(e.target.checked);
            if (e.target.checked) beep();
          }}
        />
      </div>

      {error ? (
        <Banner tone="danger" live="alert" title="Could not load orders">
          {error} <Button variant="ghost" onClick={() => void load()}>Try again</Button>
        </Banner>
      ) : null}

      {staleCount > 0 ? (
        <Banner tone="warning" live="status" title={`${staleCount} order${staleCount === 1 ? "" : "s"} waiting over 30 minutes`}>
          Call these customers now.
        </Banner>
      ) : null}

      <div role="tablist" aria-label="Order groups" className="flex gap-2">
        {(
          [
            ["open", `Needs action (${open.length})`],
            ["done", `Finished today (${done.length})`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            aria-controls="orders-panel"
            onClick={() => setTab(k)}
            className={`min-h-tap rounded-control border px-4 font-semibold ${tab === k ? "bg-primary text-on-primary border-transparent" : "border-primary text-primary"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div id="orders-panel" role="tabpanel" className="space-y-4">
        {rows === null && !error ? (
          <div aria-busy="true" aria-label="Loading orders" className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState title={tab === "open" ? "No open orders" : "Nothing finished yet today"}>
            {tab === "open" ? "New orders appear here by themselves." : "Completed and cancelled orders from today show here."}
          </EmptyState>
        ) : (
          shown.map((r) => <OrderCard key={r.id} order={r} onChanged={load} />)
        )}
      </div>
    </div>
  );
}

/** One order with its actions. Used on Today's orders and on /admin/orders/[id] (`headingLevel` 1 there). */
export function OrderCard({
  order,
  onChanged,
  detailLink = true,
  headingLevel = 2,
}: {
  order: AdminOrderRow;
  onChanged: () => Promise<void>;
  detailLink?: boolean;
  headingLevel?: 1 | 2;
}) {
  const { role } = useAdminSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState<CancelReason | "">("");
  const [restock, setRestock] = useState(true);
  const [block, setBlock] = useState(false);
  // SEC-002: blocking a phone is a second, explicit step that shows the number and the reason.
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const Heading = headingLevel === 1 ? "h1" : "h2";

  const next = nextForwardStatus(order.status, order.fulfilment);
  const mayCancel = isActive(order.status) && canCancelAs(order.status, role);

  async function advance() {
    if (!next) return;
    setBusy(true);
    setError(null);
    const res = await adminApi.updateOrderStatus({ orderId: order.id, status: next });
    setBusy(false);
    if (!res.ok) setError(res.error.message);
    await onChanged();
  }

  function closeCancel() {
    setCancelling(false);
    setConfirmBlock(false);
    setBlock(false);
  }

  /** First click: validate; if "block" is ticked, ask again before doing anything. */
  function requestCancel() {
    if (!reason) {
      setReasonError("Choose a reason");
      return;
    }
    if (block) setConfirmBlock(true);
    else void doCancel(false);
  }

  async function doCancel(blockContact: boolean) {
    if (!reason) return;
    setBusy(true);
    setError(null);
    const res = await adminApi.cancelOrder({ orderId: order.id, reason, restock, blockContact });
    setBusy(false);
    if (!res.ok) setError(res.error.message);
    else closeCancel();
    await onChanged();
  }

  return (
    <article
      aria-labelledby={`o-${order.id}`}
      className={`bg-surface-raised rounded-card shadow-card space-y-3 border p-4 ${order.isStale ? "border-danger border-2" : "border-line"}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Heading id={`o-${order.id}`} className={`font-display ${headingLevel === 1 ? "text-primary text-3xl" : "text-xl"}`}>
            {order.number}{" "}
            <span className="text-ink-muted text-base">
              {formatClock(order.createdAt)} &middot; {order.fulfilment === "delivery" ? "Delivery" : "Pickup"}
            </span>
          </Heading>
          <p className="font-semibold">{order.customerName}</p>
          {/* how long a new order has been waiting (stale ones also get the badge and sort to the top) */}
          {order.status === "placed" ? <p className="text-ink-muted text-sm">Placed {agoLabel(order.createdAt, Date.now())}</p> : null}
          {order.status === "completed" && order.completedAt ? (
            <p className="text-ink-muted text-sm">Finished {formatClock(order.completedAt)}</p>
          ) : order.status === "cancelled" && order.cancelledAt ? (
            <p className="text-ink-muted text-sm">Cancelled {formatClock(order.cancelledAt)}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {order.isStale ? <Badge tone="danger">Waiting over 30 min</Badge> : null}
          {order.phoneIsBlocked ? <Badge tone="danger">Phone blocked</Badge> : null}
          <Badge tone={order.status === "completed" ? "success" : order.status === "cancelled" ? "neutral" : "primary"}>{STATUS_LABEL[order.status]}</Badge>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <a href={telHref(order.customerPhone)} className={buttonClass(order.status === "placed" ? "primary" : "secondary")}>
          Call {order.customerPhone}
        </a>
        <p className="text-lg font-semibold">
          {order.status === "completed" ? "Cash received" : "Collect"} <span className="price">{formatNpr(order.total)}</span>
        </p>
      </div>

      {order.fulfilment === "delivery" ? (
        <p className="text-sm">
          {order.address}, {order.landmark}, {order.area}
        </p>
      ) : null}
      {order.notes ? <p className="text-sm">Note: {order.notes}</p> : null}
      {order.cancelReason ? <p className="text-sm">Cancelled: {CANCEL_REASON_LABEL[order.cancelReason]}</p> : null}
      <ul className="text-sm">
        {order.items.map((i, k) => (
          <li key={k}>
            {i.qty} x {i.name}
          </li>
        ))}
      </ul>
      {detailLink ? (
        <p className="text-sm">
          <Link href={`/admin/orders/${order.id}`} className="text-primary min-h-tap inline-flex items-center underline">
            Open order {order.number}
          </Link>
        </p>
      ) : null}

      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}

      {isActive(order.status) ? (
        <div className="flex flex-wrap gap-3">
          {next ? (
            <Button disabled={busy} onClick={() => void advance()}>
              {FORWARD_ACTION_LABEL[next]}
            </Button>
          ) : null}
          {mayCancel ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => (cancelling ? closeCancel() : setCancelling(true))}
              aria-expanded={cancelling}
            >
              Cancel order
            </Button>
          ) : (
            <p className="text-ink-muted self-center text-sm">Only the owner can cancel an order that is already on its way or ready.</p>
          )}
        </div>
      ) : null}

      {cancelling && confirmBlock && reason ? (
        <div role="alertdialog" aria-labelledby={`cb-${order.id}`} aria-describedby={`cbd-${order.id}`} className="border-danger rounded-control space-y-3 border-2 p-3">
          <p id={`cb-${order.id}`} className="font-semibold">
            Block {order.customerPhone}?
          </p>
          <div id={`cbd-${order.id}`} className="space-y-2 text-sm">
            <p>
              Reason: {CANCEL_REASON_LABEL[reason]}. This number will not be able to order online until the owner removes
              the block.
            </p>
            {reason === "fake" ? (
              <p className="font-semibold">
                Fake orders often use someone else&apos;s number. If the person who answered said they did not order,
                do not block them.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" disabled={busy} onClick={() => void doCancel(true)}>
              Yes, cancel and block
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void doCancel(false)}>
              Cancel without blocking
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmBlock(false)}>
              Go back
            </Button>
          </div>
        </div>
      ) : cancelling ? (
        <div className="border-danger rounded-control space-y-3 border p-3">
          <SelectField
            label="Reason for cancelling"
            required
            value={reason}
            error={reasonError ?? undefined}
            onChange={(e) => {
              const r = e.target.value as CancelReason;
              setReason(r);
              setReasonError(null);
              if (r === "fake") setBlock(false); // SEC-002: never pre-ticked for a fake order
            }}
          >
            <option value="">Choose a reason</option>
            {STAFF_CANCEL_REASONS.map((k) => (
              <option key={k} value={k}>
                {CANCEL_REASON_LABEL[k]}
              </option>
            ))}
          </SelectField>
          <CheckField label="Put the items back in stock" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
          {reason === "fake" ? (
            <p className="text-sm">
              Someone may have used another person&apos;s number. Only block it if you are sure the owner of this number
              placed the order.
            </p>
          ) : null}
          <CheckField
            label="Also block this phone number"
            hint={order.phoneIsBlocked ? "This number is already blocked." : "You will be asked to confirm. The owner can undo this."}
            checked={block}
            disabled={order.phoneIsBlocked}
            onChange={(e) => setBlock(e.target.checked)}
          />
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" disabled={busy} onClick={requestCancel}>
              Confirm cancel
            </Button>
            <Button variant="secondary" onClick={closeCancel}>
              Keep the order
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

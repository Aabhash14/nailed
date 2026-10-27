"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/feedback";
import { sendTableRound } from "@/data-access/tables-client";
import { formatNpr } from "@/lib/money";
import {
  TABLE_STOPPED_MESSAGE,
  type MenuCategory,
  type MenuItem,
  type TableOccupancy,
  type TableOrderingMode,
  type TableSessionView,
} from "@/types/contract";
import type { MenuLang, MenuSecondary } from "../i18n";
import { useTableText, type TableText, type TableUiKey } from "./i18n";
import { ItemSheet } from "./item-sheet";
import { JoinSheet } from "./join-sheet";
import { Both } from "./sheet";
import {
  addToCart,
  cartCount,
  cartEstimate,
  CART_STORAGE_KEY,
  classifySendError,
  describeCart,
  EMPTY_CART,
  itemQtyInCart,
  lineErrorsFrom,
  newRequestId,
  parseStoredCart,
  prepareSend,
  setLineQty,
  waitingRounds,
  type TableCart,
} from "./table-logic";
import { TableSheet, type SendState } from "./table-sheet";
import { useTableSession } from "./use-table-session";

/** What the menu rows need from the (lazy) table UI: an Add action and how many are in the cart. */
export type TableBridge = {
  add: (item: MenuItem) => void;
  qty: (itemId: string) => number;
  addLabel: { en: string; sec: string | null; lang: string | undefined };
  inCartLabel: (n: number) => { en: string; sec: string | null };
};

export type TableOrderingProps = {
  categories: MenuCategory[];
  /** Occupancy from the latest successful /api/menu poll (undefined before the first poll). */
  occupancy: TableOccupancy | null | undefined;
  /** The polled mode; null until the first poll answered. */
  mode: TableOrderingMode | null;
  /** /api/menu degraded, failed or unreachable, or the break-glass menu (contract 9.12). */
  down: boolean;
  tableParam: number | null;
  /** A code read from the scanned QR, in memory only (SEC-024). */
  scannedCode: string | null;
  langMode: MenuLang;
  sec: MenuSecondary | null;
  onBridge: (b: TableBridge | null) => void;
};

function readCart(): TableCart {
  try {
    return parseStoredCart(window.sessionStorage.getItem(CART_STORAGE_KEY));
  } catch {
    return EMPTY_CART;
  }
}

/**
 * Guest table ordering on /menu (api-contract 2.0.0 section 9). Loaded lazily by the menu (next/dynamic, client
 * only), so the static menu stays light. The cart lives in sessionStorage (it survives a failed send, a lost table
 * cookie and reloads); the join credential is the HttpOnly cookie; the code is never stored (F4).
 */
export default function TableOrdering({
  categories,
  occupancy,
  mode,
  down,
  tableParam,
  scannedCode,
  langMode,
  sec,
  onBridge,
}: TableOrderingProps) {
  const t = useTableText(langMode);
  const { session, pollFailed, applyView, forget, refresh } = useTableSession();
  const [cart, setCartState] = useState<TableCart>(readCart);
  const [code, setCode] = useState<string | null>(scannedCode);
  const [joinOpen, setJoinOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [itemFor, setItemFor] = useState<MenuItem | null>(null);
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState("");

  const setCart = useCallback((next: TableCart | ((c: TableCart) => TableCart)) => {
    setCartState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      try {
        window.sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(value));
      } catch {
        /* storage blocked: the cart lives for this page only */
      }
      return value;
    });
  }, []);

  const view: TableSessionView | null = session.status === "open" ? session.view : null;
  const joined = view !== null;
  const effectiveMode: TableOrderingMode | null = mode ?? (view ? (view.ordering === "paused" ? "paused" : "on") : null);
  const paused = effectiveMode === "paused" || view?.ordering === "paused";
  // 2.1.0: staff stopped app orders for this table (bill requested)
  const locked = view?.ordering === "stopped";
  const off = effectiveMode === "off";
  const canOrder = joined && !down && !off && !paused && !locked;

  // A scanned code opens the join sheet once ordering is known to be possible (not while the menu is down).
  useEffect(() => {
    if (!code || down || off || session.status === "checking") return;
    if (view && view.tableNumber === (tableParam ?? view.tableNumber)) {
      setCode(null); // already joined to this table: the code is not needed
      return;
    }
    setJoinOpen(true);
  }, [code, down, off, session.status, view, tableParam]);

  const clearRetryState = useCallback(() => {
    setSend((s) => (s.kind === "message" && s.retry ? { kind: "idle" } : s.kind === "sent" ? { kind: "idle" } : s));
  }, []);

  const cartRef = useRef(cart);
  cartRef.current = cart;

  const addLines = useCallback(
    (item: MenuItem, variantIds: string[], qty: number) => {
      const c = cartRef.current;
      const r = addToCart(c, item.id, variantIds, qty);
      setAnnounce(r.tooManyLines ? t.en("cart.too_many") : t.en("add.added", { name: item.name }));
      if (!r.tooManyLines) setCart({ ...r.cart, tableNumber: view?.tableNumber ?? c.tableNumber });
      clearRetryState();
      setItemFor(null);
    },
    [setCart, t, view?.tableNumber, clearRetryState],
  );

  // The menu's Add buttons exist only while this guest can order.
  const bridge = useMemo<TableBridge>(
    () => ({
      add: (item) => {
        if (item.variants.length > 0) setItemFor(item);
        else addLines(item, [], 1);
      },
      qty: (id) => itemQtyInCart(cartRef.current, id),
      addLabel: { en: t.en("add.button"), sec: t.sec("add.button"), lang: t.lang },
      inCartLabel: (n) => ({ en: t.en("add.in_cart", { n }), sec: t.sec("add.in_cart", { n }) }),
    }),
    // cart in the deps: a new object makes the menu rows show the new counts
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addLines, t, cart],
  );
  useEffect(() => {
    onBridge(canOrder ? bridge : null);
  }, [canOrder, bridge, onBridge]);
  useEffect(() => () => onBridge(null), [onBridge]);

  const lines = useMemo(() => describeCart(cart, categories), [cart, categories]);

  async function doSend() {
    if (!view || send.kind === "sending") return;
    const sentLines = cart.lines;
    const { request, cart: pendingCart } = prepareSend(cart, newRequestId());
    setCart(pendingCart);
    setSend({ kind: "sending" });
    setLineErrors({});
    const res = await sendTableRound(request);
    if (res.ok) {
      setCart({ ...EMPTY_CART, tableNumber: view.tableNumber });
      applyView(res.data.session);
      setSend({ kind: "sent", round: res.data.round });
      setAnnounce(t.en("cart.sent", { r: res.data.round }));
      return;
    }
    const kind = classifySendError(res.error, res.network);
    if (kind !== "retry") setCart((c) => ({ ...c, pending: null })); // a definite answer: the next send is a new request
    const msg = (key: TableUiKey | null, text: string, retry = false, tone: "warning" | "danger" = "warning") =>
      setSend({ kind: "message", key, text, retry, tone });
    switch (kind) {
      case "retry":
        msg("msg.unavailable", "", true);
        break;
      case "session":
        forget();
        setSheetOpen(false);
        setJoinOpen(true);
        msg("msg.session_invalid", "");
        break;
      case "paused":
        void refresh();
        msg(res.error.message === TABLE_STOPPED_MESSAGE || /this table/i.test(res.error.message) ? "msg.locked" : "msg.paused", "");
        break;
      case "fix":
        setLineErrors(lineErrorsFrom(res.error.fieldErrors, sentLines));
        msg(null, res.error.message, false, "danger");
        break;
      case "off":
        msg("msg.off", "");
        break;
      default:
        msg(null, res.error.message);
    }
  }

  const count = cartCount(cart);
  const waiting = waitingRounds(view);
  const blockedKey: TableUiKey | null = down ? "msg.unavailable" : off ? "msg.off" : locked ? "msg.locked" : paused ? "msg.paused" : null;
  const showOccupancy = !down && occupancy && occupancy.total > 0 && (effectiveMode === "on" || effectiveMode === "paused");
  const canJoin = !down && !off && !joined && (effectiveMode === "on" || effectiveMode === "paused");

  return (
    <div className="space-y-3">
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>

      {session.status === "closed" ? (
        <Banner tone="info" live="status">
          <Msg t={t} k="msg.closed" vars={{ n: session.tableNumber }} />
        </Banner>
      ) : null}
      {session.status === "none" && session.ended && !down ? (
        <Banner tone="warning" live="status">
          <Msg t={t} k="msg.session_invalid" />
        </Banner>
      ) : null}
      {joined && !down && locked ? (
        <Banner tone="warning" live="status" title={<Both en={t.en("bar.table", { n: view.tableNumber })} sec={t.sec("bar.table", { n: view.tableNumber })} lang={t.lang} />}>
          <Msg t={t} k="msg.locked" />
        </Banner>
      ) : joined && !down && paused ? (
        <Banner tone="warning" live="status">
          <Msg t={t} k="msg.paused" />
        </Banner>
      ) : null}
      {code && off && !down ? (
        <Banner tone="info">
          <Msg t={t} k="msg.off" />
        </Banner>
      ) : null}

      {canJoin && tableParam ? (
        <section
          aria-labelledby="tj-h"
          className="border-line bg-surface-raised rounded-card shadow-card space-y-2 border p-4"
        >
          <h2 id="tj-h" className="font-display text-title-3">
            <Both en={t.en("join.cta_title")} sec={t.sec("join.cta_title")} lang={t.lang} block secClassName="text-ink-muted text-base" />
          </h2>
          <p className="text-ink-muted text-sm">
            <Both en={t.en("join.cta_body")} sec={t.sec("join.cta_body")} lang={t.lang} block />
          </p>
          <Button onClick={() => setJoinOpen(true)}>
            <Both en={t.en("join.open")} sec={t.sec("join.open")} lang={t.lang} />
          </Button>
        </section>
      ) : null}

      {showOccupancy ? (
        <Occupancy
          occupancy={occupancy}
          yours={view?.tableNumber ?? null}
          t={t}
          onJoin={canJoin && !tableParam ? () => setJoinOpen(true) : null}
        />
      ) : null}

      {joined ? (
        <>
          {/* keeps the fixed bar from covering the end of the menu */}
          <div aria-hidden="true" className="h-20" />
          <div className="bg-surface-raised border-line shadow-tabbar fixed inset-x-0 bottom-0 z-20 border-t pb-[env(safe-area-inset-bottom)]">
            <div className="max-w-reading px-gutter mx-auto flex items-center justify-between gap-3 py-2">
              <p className="min-w-0 text-sm leading-tight">
                <span className="font-semibold">
                  <Both en={t.en("bar.table", { n: view.tableNumber })} sec={t.sec("bar.table", { n: view.tableNumber })} lang={t.lang} />
                </span>
                {waiting > 0 ? (
                  <span className="text-ink-muted block">
                    <Both en={t.en("status.new")} sec={t.sec("status.new")} lang={t.lang} />: {waiting}
                  </span>
                ) : null}
                {pollFailed ? <span className="text-ink-muted block">{t.en("msg.poll_failed")}</span> : null}
              </p>
              <Button onClick={() => setSheetOpen(true)} aria-haspopup="dialog">
                <Both en={t.en("bar.view")} sec={t.sec("bar.view")} lang={t.lang} />
                {count > 0 ? (
                  <span className="rounded-pill bg-on-primary text-primary px-2 text-sm tabular-nums">
                    {count}
                    <span className="sr-only"> · {formatNpr(cartEstimate(lines))}</span>
                  </span>
                ) : null}
              </Button>
            </div>
          </div>
          <TableSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            view={view}
            cart={cart}
            lines={lines}
            lineErrors={lineErrors}
            canSend={!blockedKey}
            blockedKey={blockedKey}
            send={send}
            onSend={() => void doSend()}
            onQty={(key, qty) => {
              setCart((c) => setLineQty(c, key, qty));
              clearRetryState();
            }}
            onNote={(note) => {
              setCart((c) => ({ ...c, note }));
              clearRetryState();
            }}
            categories={categories}
            sec={sec}
            t={t}
          />
        </>
      ) : null}

      <JoinSheet
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        defaultTable={tableParam ?? cart.tableNumber}
        scannedCode={code}
        occupancy={occupancy}
        t={t}
        onJoined={(v) => {
          setCode(null); // used: forget it (it was only ever in memory)
          setJoinOpen(false);
          applyView(v, true);
          setCart((c) => ({ ...c, tableNumber: v.tableNumber }));
          setSend({ kind: "idle" });
          setAnnounce(t.en("join.joined", { n: v.tableNumber }));
        }}
      />
      <ItemSheet item={itemFor} onClose={() => setItemFor(null)} onAdd={addLines} sec={sec} t={t} />
    </div>
  );
}

function Msg({ t, k, vars }: { t: TableText; k: TableUiKey; vars?: Record<string, string | number> }) {
  return <Both en={t.en(k, vars)} sec={t.sec(k, vars)} lang={t.lang} block />;
}

/** "X of N free" plus a per-table free/busy grid (from the menu poll). Busy = text + filled tile, never colour only. */
function Occupancy({
  occupancy,
  yours,
  t,
  onJoin,
}: {
  occupancy: TableOccupancy;
  yours: number | null;
  t: TableText;
  onJoin: (() => void) | null;
}) {
  return (
    <section aria-labelledby="occ-h" className="border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="occ-h" className="font-display text-title-3">
          <Both en={t.en("occupancy.title")} sec={t.sec("occupancy.title")} lang={t.lang} secClassName="text-ink-muted text-base" />
        </h2>
        <p className="font-semibold tabular-nums">
          <Both
            en={t.en("occupancy.summary", { free: occupancy.free, total: occupancy.total })}
            sec={t.sec("occupancy.summary", { free: occupancy.free, total: occupancy.total })}
            lang={t.lang}
            block
            secClassName="text-ink-muted text-sm"
          />
        </p>
      </div>
      <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6" aria-label={t.en("occupancy.title")}>
        {occupancy.tables.map((x) => {
          const mine = yours === x.number;
          const state = x.occupied ? "occupancy.busy" : "occupancy.free";
          return (
            <li
              key={x.number}
              className={`rounded-control flex min-h-14 flex-col items-center justify-center border px-1 py-1.5 text-center leading-tight ${
                mine
                  ? "border-primary bg-primary text-on-primary border-2"
                  : x.occupied
                    ? "bg-surface-alt border-line-strong text-ink"
                    : "border-success bg-surface text-ink border-dashed"
              }`}
            >
              <span className="text-lg font-semibold tabular-nums">{x.number}</span>
              <span className="text-xs">
                {mine ? t.en("occupancy.yours") : t.en(state)}
                {x.label ? <span className="sr-only">, {x.label}</span> : null}
              </span>
              {t.sec(mine ? "occupancy.yours" : state) ? (
                <span lang={t.lang} className="text-xs">
                  {t.sec(mine ? "occupancy.yours" : state)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {onJoin ? (
        <Button variant="secondary" onClick={onJoin}>
          <Both en={t.en("join.open")} sec={t.sec("join.open")} lang={t.lang} />
        </Button>
      ) : null}
    </section>
  );
}

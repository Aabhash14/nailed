"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatClock } from "@/components/format";
import { formatTableCode } from "@/components/menu/table/table-logic";
import { Button, LinkButton } from "@/components/ui/button";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { CheckField } from "@/components/ui/field";
import { adminApi } from "@/data-access/admin";
import { formatNpr } from "@/lib/money";
import type { AdminTableCard, AdminTableRound, Role, TableBoard, TablePaidVia } from "@/types/contract";
import { useAdminSession } from "../admin-shell";
import {
  cancelState,
  forwardMoves,
  isIdle,
  offlineText,
  OUTCOME_LABEL,
  PAID_VIA_LABEL,
  ROUND_STATUS_LABEL,
  serverNow,
  stillOpenText,
  TABLE_CANCEL_REASON_LABEL,
} from "./board-logic";
import { CancelRoundDialog, CloseTableDialog, OpenTableDialog, QrDialog, RotateCodeDialog } from "./table-dialogs";
import { beep, useTableBoard } from "./use-table-board";

const ROUND_TONE = { new: "accent", preparing: "primary", served: "success", cancelled: "neutral" } as const;

/**
 * Staff "Tables" board (api-contract 2.2.0 section 9.7, ADR 0002): a client component fed by the change-only
 * getTableBoard feed, polled every 30 s while visible. No server render per poll, no revalidation. When a poll fails
 * the last board stays on screen, marked old, under the contract's paper-fallback banner.
 */
export function TablesBoard() {
  const { role } = useAdminSession();
  const [sound, setSound] = useState(false);
  const { board, clock, offlineSince, lastError, lastOkAt, reload } = useTableBoard(sound);
  const [tick, setTick] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<AdminTableCard | null>(null);
  const [qrFor, setQrFor] = useState<AdminTableCard | null>(null);
  const [rotateFor, setRotateFor] = useState<AdminTableCard | null>(null);
  const [closeFor, setCloseFor] = useState<AdminTableCard | null>(null);
  const [cancelFor, setCancelFor] = useState<{ tableNumber: number; round: AdminTableRound } | null>(null);
  const [modeBusy, setModeBusy] = useState(false);

  // Local clock for "idle" and the cancel countdown: no fetch, just a re-render every 30 s.
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const now = clock ? serverNow(clock.serverTime, clock.receivedAt, tick) : tick;

  // Dialogs follow the latest board (a refetch after an action updates the open dialog too).
  const fresh = (c: AdminTableCard | null) => (c && board ? (board.tables.find((x) => x.tableId === c.tableId) ?? null) : c);

  async function after(message?: string) {
    if (message) setNotice(message);
    await reload(); // an immediate refetch after every staff action (contract section 5)
  }

  async function setMode(mode: "on" | "paused") {
    setModeBusy(true);
    const res = await adminApi.setTableOrdering({ mode });
    setModeBusy(false);
    setNotice(res.ok ? (mode === "paused" ? "Table orders paused. Guests see that the kitchen is not taking app orders." : "Table orders are on again.") : res.error.message);
    await reload();
  }

  const open = board?.tables.filter((c) => c.session) ?? [];
  const newRounds = open.reduce((n, c) => n + (c.session?.waiting.new ?? 0), 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Tables</h1>
          {board ? (
            <p className="text-ink-muted">
              {open.length} of {board.tables.length} tables open
              {newRounds > 0 ? ` · ${newRounds} new order${newRounds === 1 ? "" : "s"} to accept` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {role === "owner" ? (
            <LinkButton href="/admin/tables/setup" variant="secondary">
              Tables setup
            </LinkButton>
          ) : null}
          <CheckField
            label="Sound for new orders"
            hint="A beep when a table sends an order. Keep this page open."
            checked={sound}
            onChange={(e) => {
              setSound(e.target.checked);
              if (e.target.checked) beep();
            }}
          />
        </div>
      </div>

      {offlineSince ? (
        <Banner tone="danger" live="alert" title={offlineText(offlineSince)}>
          {board ? `What you see below is from ${lastOkAt ? formatClock(lastOkAt) : "earlier"} and may be out of date. ` : ""}
          Orders that reached the system will be here when it is back; ask the tables about anything else.
          {lastError ? <span className="text-ink-muted block">({lastError})</span> : null}{" "}
          <Button variant="ghost" onClick={() => void reload()}>
            Try again
          </Button>
        </Banner>
      ) : null}

      <div aria-live="polite">
        {notice ? (
          <Banner tone="info">
            {notice}{" "}
            <button type="button" className="min-h-tap font-semibold underline" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </Banner>
        ) : null}
      </div>

      {!board && !offlineSince ? (
        <div aria-busy="true" aria-label="Loading tables" className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}

      {board ? (
        <div className={`space-y-5 ${offlineSince ? "opacity-70" : ""}`}>
          <ModeBar board={board} role={role} busy={modeBusy} onMode={setMode} />
          {board.mode === "off" ? null : board.tables.length === 0 ? (
            <EmptyState
              title="No tables yet"
              action={role === "owner" ? <LinkButton href="/admin/tables/setup">Set up tables</LinkButton> : undefined}
            >
              {role === "owner" ? "Add your tables in Tables setup." : "Ask the owner to add the tables."}
            </EmptyState>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2">
              {board.tables.map((c) => (
                <li key={c.tableId}>
                  <TableCard
                    card={c}
                    role={role}
                    now={now}
                    paused={board.mode === "paused"}
                    onOpen={() => setOpenFor(c)}
                    onQr={() => setQrFor(c)}
                    onRotate={() => setRotateFor(c)}
                    onClose={() => setCloseFor(c)}
                    onCancel={(r) => setCancelFor({ tableNumber: c.number, round: r })}
                    onDone={after}
                  />
                </li>
              ))}
            </ul>
          )}
          <ClosedToday board={board} />
        </div>
      ) : null}

      <OpenTableDialog card={openFor} onClose={() => setOpenFor(null)} onDone={after} />
      <QrDialog card={fresh(qrFor)} onClose={() => setQrFor(null)} />
      <RotateCodeDialog card={rotateFor} onClose={() => setRotateFor(null)} onDone={after} />
      <CloseTableDialog card={fresh(closeFor)} role={role} onClose={() => setCloseFor(null)} onDone={after} />
      <CancelRoundDialog target={cancelFor} onClose={() => setCancelFor(null)} onDone={after} />
    </div>
  );
}

function ModeBar({
  board,
  role,
  busy,
  onMode,
}: {
  board: TableBoard;
  role: Role;
  busy: boolean;
  onMode: (m: "on" | "paused") => void;
}) {
  if (board.mode === "off") {
    return (
      <EmptyState
        title="Table ordering is off"
        action={role === "owner" ? <LinkButton href="/admin/tables/setup">Turn it on in Tables setup</LinkButton> : undefined}
      >
        Guests can see the menu but cannot order from their table. {role === "owner" ? "" : "Ask the owner to turn it on."}
      </EmptyState>
    );
  }
  return (
    <div className="border-line bg-surface-raised rounded-card flex flex-wrap items-center justify-between gap-3 border p-3">
      <p className="flex items-center gap-2">
        <Badge tone={board.mode === "on" ? "success" : "accent"}>{board.mode === "on" ? "Taking orders" : "Paused"}</Badge>
        <span className="text-sm">
          {board.mode === "on"
            ? "Guests at open tables can send orders."
            : "Guests cannot send new orders. You can still accept, serve and close."}
        </span>
      </p>
      <Button variant={board.mode === "on" ? "secondary" : "primary"} disabled={busy} onClick={() => onMode(board.mode === "on" ? "paused" : "on")}>
        {board.mode === "on" ? "Pause table orders" : "Take table orders again"}
      </Button>
    </div>
  );
}

function TableCard({
  card,
  role,
  now,
  paused,
  onOpen,
  onQr,
  onRotate,
  onClose,
  onCancel,
  onDone,
}: {
  card: AdminTableCard;
  role: Role;
  now: number;
  paused: boolean;
  onOpen: () => void;
  onQr: () => void;
  onRotate: () => void;
  onClose: () => void;
  onCancel: (r: AdminTableRound) => void;
  onDone: (message?: string) => Promise<void>;
}) {
  const s = card.session;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = `Table ${card.number}`;

  if (!s) {
    return (
      <article aria-label={title} className="border-line bg-surface-raised rounded-card shadow-card flex items-center justify-between gap-3 border p-4">
        <div>
          <h2 className="text-xl font-semibold">
            {title}
            {card.label ? <span className="text-ink-muted text-base font-normal">, {card.label}</span> : null}
          </h2>
          <p className="text-ink-muted text-sm">Free</p>
        </div>
        <Button variant="secondary" onClick={onOpen} aria-haspopup="dialog">
          Open table<span className="sr-only"> {card.number}</span>
        </Button>
      </article>
    );
  }

  const idle = isIdle(s, now);
  async function run(p: Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(true);
    setError(null);
    const res = await p;
    setBusy(false);
    if (!res.ok) setError(res.error?.message ?? "Something went wrong.");
    await onDone();
  }

  return (
    <article
      aria-label={title}
      className={`bg-surface-raised rounded-card shadow-card space-y-3 border p-4 ${s.waiting.new > 0 ? "border-accent border-2" : idle ? "border-danger border-2" : "border-line"}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold">
            {title}
            {card.label ? <span className="text-ink-muted text-base font-normal">, {card.label}</span> : null}
          </h2>
          <p className="text-ink-muted text-sm">
            Open since {formatClock(s.openedAt)}
            {s.openedByName ? `, by ${s.openedByName}` : ""}
            {s.codeChanges > 0 ? ` · code changed ${s.codeChanges}x` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {s.waiting.new > 0 ? <Badge tone="accent">{s.waiting.new} new</Badge> : null}
          {s.waiting.preparing > 0 ? <Badge tone="primary">{s.waiting.preparing} preparing</Badge> : null}
          {s.ordersLocked ? <Badge tone="danger">App orders stopped</Badge> : null}
          {idle ? <Badge tone="danger">Idle 2 h+</Badge> : null}
        </div>
      </header>

      {idle ? <p className="text-danger text-sm font-semibold">{stillOpenText(s.openedAt)}</p> : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p>
          <span className="text-ink-muted text-sm">Code </span>
          <span className="text-2xl font-semibold tracking-[0.15em] tabular-nums">{formatTableCode(s.code)}</span>
        </p>
        <Button variant="secondary" onClick={onQr} aria-haspopup="dialog">
          Show QR
        </Button>
        <Button variant="ghost" onClick={onRotate} aria-haspopup="dialog">
          New code
        </Button>
      </div>

      {s.rounds.length === 0 ? (
        <p className="text-ink-muted text-sm">No orders from this table yet.</p>
      ) : (
        <ol className="space-y-2">
          {s.rounds.map((r) => (
            <RoundRow key={r.id} r={r} role={role} now={now} busy={busy} onMove={(st) => void run(adminApi.setTableRoundStatus({ roundId: r.id, status: st }))} onCancel={() => onCancel(r)} />
          ))}
        </ol>
      )}

      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}

      <div className="border-line flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <p className="text-lg font-semibold tabular-nums">
          {formatNpr(s.bill.total)}
          <span className="text-ink-muted text-sm font-normal"> so far</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            aria-pressed={s.ordersLocked}
            onClick={() => void run(adminApi.setTableOrdersLocked({ sessionId: s.id, locked: !s.ordersLocked }))}
          >
            {s.ordersLocked ? "Allow app orders" : "Stop app orders"}
          </Button>
          <Button onClick={onClose} aria-haspopup="dialog">
            Close table
          </Button>
        </div>
      </div>
      {paused ? <p className="text-ink-muted text-xs">Table orders are paused for every table.</p> : null}
    </article>
  );
}

function RoundRow({
  r,
  role,
  now,
  busy,
  onMove,
  onCancel,
}: {
  r: AdminTableRound;
  role: Role;
  now: number;
  busy: boolean;
  onMove: (s: "preparing" | "served") => void;
  onCancel: () => void;
}) {
  const moves = forwardMoves(r);
  const c = cancelState(r, role, now);
  const cancelled = r.status === "cancelled";
  return (
    <li className={`border-line rounded-control space-y-2 border p-3 ${r.status === "new" ? "bg-surface" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          Round {r.round} <span className="text-ink-muted font-normal tabular-nums">· {formatClock(r.createdAt)}</span>
        </p>
        <Badge tone={ROUND_TONE[r.status]}>{ROUND_STATUS_LABEL[r.status]}</Badge>
      </div>
      <ul className={`text-sm ${cancelled ? "text-ink-muted line-through" : ""}`}>
        {r.items.map((l, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span className="min-w-0 font-semibold wrap-break-word">
              {l.qty} x {l.name}
              {l.options ? <span className="font-normal"> ({l.options})</span> : null}
            </span>
            <span className="shrink-0 tabular-nums">{formatNpr(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      {/* F5: guest notes are plain text (React escapes them) */}
      {r.note ? <p className="bg-surface-alt rounded-control px-2 py-1 text-sm wrap-break-word">Note: {r.note}</p> : null}
      {cancelled ? (
        <p className="text-ink-muted text-sm">
          Cancelled{r.cancelReason ? `: ${TABLE_CANCEL_REASON_LABEL[r.cancelReason]}` : ""}
          {r.cancelledByName ? `, by ${r.cancelledByName}` : ""}
        </p>
      ) : null}
      {!cancelled ? (
        <div className="flex flex-wrap items-center gap-2">
          {moves.includes("preparing") ? (
            <Button disabled={busy} onClick={() => onMove("preparing")}>
              Accept<span className="sr-only"> round {r.round}</span>
            </Button>
          ) : null}
          {moves.includes("served") ? (
            <Button variant={moves.includes("preparing") ? "secondary" : "primary"} disabled={busy} onClick={() => onMove("served")}>
              Served<span className="sr-only"> round {r.round}</span>
            </Button>
          ) : null}
          {c.kind === "allowed" || c.kind === "window" ? (
            <Button variant="ghost" disabled={busy} onClick={onCancel} aria-haspopup="dialog">
              Cancel<span className="sr-only"> round {r.round}</span>
            </Button>
          ) : null}
          {c.kind === "window" ? (
            <span className="text-ink-muted text-xs">
              Cancel available for {c.minutesLeft} min. The owner will be notified.
            </span>
          ) : null}
          {c.kind === "owner_only" ? (
            <span className="text-ink-muted text-xs">Only the owner can cancel this order now.</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ClosedToday({ board }: { board: TableBoard }) {
  const t = board.closedTodayTotals;
  return (
    <details className="border-line bg-surface-raised rounded-card border p-4">
      <summary className="min-h-tap cursor-pointer font-semibold">
        Closed today: {t.tables} table{t.tables === 1 ? "" : "s"}, {formatNpr(t.paid)} paid
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm tabular-nums">
          {(Object.keys(PAID_VIA_LABEL) as TablePaidVia[]).map((k) => `${PAID_VIA_LABEL[k]} ${formatNpr(t.byPaidVia[k])}`).join(" · ")}
          {` · Voided ${t.voided} · Expired ${t.expired}`}
        </p>
        <p className="text-ink-muted text-xs">Check these against the till. The app summary is not the bill.</p>
        {board.closedToday.length === 0 ? (
          <p className="text-ink-muted text-sm">No tables closed yet today.</p>
        ) : (
          <ul className="divide-line divide-y text-sm">
            {board.closedToday.map((c) => (
              <li key={c.sessionId} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  Table {c.tableNumber} · {formatClock(c.openedAt)} to {formatClock(c.closedAt)} · {c.rounds} round
                  {c.rounds === 1 ? "" : "s"}
                  {c.closedByName ? ` · ${c.closedByName}` : ""}
                </span>
                <span className="font-semibold tabular-nums">
                  {OUTCOME_LABEL[c.outcome]}
                  {c.paidVia ? ` (${PAID_VIA_LABEL[c.paidVia]})` : ""} {formatNpr(c.total)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm">
          <Link href="/admin/stats" className="text-primary underline">
            Table stats (owner)
          </Link>
        </p>
      </div>
    </details>
  );
}

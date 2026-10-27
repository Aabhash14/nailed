"use client";

import { useEffect, useRef, useState } from "react";
import { Sheet } from "@/components/menu/table/sheet";
import { billRows, formatTableCode } from "@/components/menu/table/table-logic";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { adminApi } from "@/data-access/admin";
import { formatNpr } from "@/lib/money";
import type { AdminTableCard, AdminTableRound, AdminTableSession, Role, TableCancelReason, TablePaidVia } from "@/types/contract";
import {
  closeChoices,
  joinUrl,
  PAID_VIA_LABEL,
  STAFF_TABLE_CANCEL_REASONS,
  TABLE_CANCEL_REASON_LABEL,
} from "./board-logic";
import { QrCode } from "./qr-code";

type Done = (message?: string) => Promise<void> | void;

/** Big code + QR, drawn in the browser. Staff turn the phone to the guest, or read the code out. */
export function CodeView({ tableNumber, session }: { tableNumber: number; session: AdminTableSession }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const url = origin ? joinUrl(origin, tableNumber, session.code) : "";
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="text-ink-muted text-sm">Table code</p>
      <p className="text-5xl font-semibold tracking-[0.18em] tabular-nums sm:text-6xl" aria-label={`Code ${session.code.split("").join(" ")}`}>
        {formatTableCode(session.code)}
      </p>
      {url ? <QrCode text={url} label={`QR code to join table ${tableNumber}`} size={232} /> : null}
      <p className="text-ink-muted max-w-xs text-sm">
        The guest scans the QR or types the code on the menu. The code works until the table is closed or you press New code.
      </p>
    </div>
  );
}

export function OpenTableDialog({ card, onClose, onDone }: { card: AdminTableCard | null; onClose: () => void; onDone: Done }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<AdminTableSession | null>(null);
  const cardId = card?.tableId;
  useEffect(() => {
    setOpened(null);
    setError(null);
  }, [cardId]);
  return (
    <Sheet open={card !== null} onClose={onClose} title={card ? `Open table ${card.number}` : ""}>
      {card && !opened ? (
        <div className="space-y-4">
          <p>Open this table when the guests sit down. You get a code and a QR for them; they can then order from their phones.</p>
          {error ? (
            <Banner tone="danger" live="alert">
              {error}
            </Banner>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const res = await adminApi.openTable({ tableId: card.tableId });
                setBusy(false);
                if (!res.ok) {
                  setError(res.error.message);
                  await onDone();
                  return;
                }
                setOpened(res.data);
                await onDone();
              }}
            >
              {busy ? "Opening..." : `Open table ${card.number}`}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Not now
            </Button>
          </div>
        </div>
      ) : null}
      {card && opened ? <CodeView tableNumber={card.number} session={opened} /> : null}
    </Sheet>
  );
}

export function QrDialog({ card, onClose }: { card: AdminTableCard | null; onClose: () => void }) {
  return (
    <Sheet open={card !== null && card.session !== null} onClose={onClose} title={card ? `Table ${card.number}: code and QR` : ""}>
      {card?.session ? <CodeView tableNumber={card.number} session={card.session} /> : null}
    </Sheet>
  );
}

/** SEC-023 "New code": same session, rounds and bill kept; phones that joined must join again. */
export function RotateCodeDialog({ card, onClose, onDone }: { card: AdminTableCard | null; onClose: () => void; onDone: Done }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<AdminTableSession | null>(null);
  const cardId = card?.tableId;
  useEffect(() => {
    setRotated(null);
    setError(null);
  }, [cardId]);
  return (
    <Sheet open={card !== null && card.session !== null} onClose={onClose} title={card ? `New code for table ${card.number}` : ""}>
      {card?.session && !rotated ? (
        <div className="space-y-4">
          <Banner tone="warning" title="Phones already joined must join again">
            Use this if the code got out (a photo, a forwarded link) or a new party sits at a table you forgot to close. The orders and
            the bill stay. Every phone that joined with the old code stops working and needs the new one.
          </Banner>
          {error ? (
            <Banner tone="danger" live="alert">
              {error}
            </Banner>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const res = await adminApi.rotateTableCode({ sessionId: card.session!.id });
                setBusy(false);
                if (!res.ok) setError(res.error.message);
                else setRotated(res.data);
                await onDone();
              }}
            >
              {busy ? "Making a new code..." : "Make a new code"}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Keep the current code
            </Button>
          </div>
        </div>
      ) : null}
      {card && rotated ? (
        <div className="space-y-4">
          <Banner tone="success" live="status">
            New code ready. Show it to the guests at this table: their phones must join again.
          </Banner>
          <CodeView tableNumber={card.number} session={rotated} />
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * Close the table: paid (cash / Fonepay / other) or void. Opening this dialog stops app orders for the table
 * (SEC-023: bill requested, no last-second round can change the total while the cashier closes).
 */
export function CloseTableDialog({
  card,
  role,
  onClose,
  onDone,
}: {
  card: AdminTableCard | null;
  role: Role;
  onClose: () => void;
  onDone: Done;
}) {
  const s = card?.session ?? null;
  const [outcome, setOutcome] = useState<"paid" | "void">("paid");
  const [paidVia, setPaidVia] = useState<TablePaidVia | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The session this dialog stopped app orders for (so a cancelled dialog turns the stop off again, 9.0). */
  const lockedByUs = useRef<string | null>(null);
  const closedIt = useRef(false);
  const sessionId = s?.id ?? null;

  useEffect(() => {
    setOutcome("paid");
    setPaidVia("");
    setError(null);
    closedIt.current = false;
    if (sessionId && s && !s.ordersLocked) {
      lockedByUs.current = sessionId;
      void adminApi.setTableOrdersLocked({ sessionId, locked: true }).then(() => onDone());
    } else lockedByUs.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opened session
  }, [sessionId]);

  function dismiss() {
    const id = lockedByUs.current;
    lockedByUs.current = null;
    if (id && !closedIt.current) void adminApi.setTableOrdersLocked({ sessionId: id, locked: false }).then(() => onDone());
    onClose();
  }

  if (!card || !s) return <Sheet open={false} onClose={onClose} title="">{null}</Sheet>;
  const choices = closeChoices(s, role);
  const rows = billRows(s.bill);
  const label = (k: string, pct?: number) =>
    k === "subtotal" ? "Subtotal" : k === "service" ? `Service charge (${pct}%)` : k === "vat_included" ? `Includes VAT (${pct}%)` : k === "vat_added" ? `VAT (${pct}%)` : "Total";

  async function confirm() {
    if (!s) return;
    if (outcome === "paid" && !paidVia) {
      setError("Choose how the table paid.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await adminApi.closeTable({
      sessionId: s.id,
      outcome,
      ...(outcome === "paid" ? { paidVia: paidVia as TablePaidVia } : {}),
      expectedTotal: s.bill.total,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      await onDone(); // e.g. "The total changed": the new total shows after this refetch
      return;
    }
    closedIt.current = true;
    lockedByUs.current = null;
    await onDone(`Table ${card!.number} closed: ${res.data.outcome === "paid" ? `paid ${formatNpr(res.data.total)}` : "voided"}.`);
    onClose();
  }

  return (
    <Sheet open onClose={dismiss} title={`Close table ${card.number}`}>
      <div className="space-y-4">
        <p className="text-ink-muted text-sm" role="status">
          App orders are stopped for this table while this window is open. If you keep the table open, they start again.
        </p>
        <dl className="border-line bg-surface rounded-card space-y-1 border p-3 tabular-nums">
          {rows.map((r) => (
            <div key={r.key} className={`flex justify-between gap-3 ${r.key === "total" ? "border-ink mt-1 border-t-2 pt-1 text-lg font-semibold" : ""}`}>
              <dt>{label(r.key, r.pct)}</dt>
              <dd>{formatNpr(r.amount)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-ink-muted text-xs">Order summary, not a bill or tax invoice. Print the bill from the till as usual.</p>

        <fieldset className="space-y-2">
          <legend className="font-semibold">How did the table end?</legend>
          <Radio name="outcome" checked={outcome === "paid"} disabled={choices.paidBlocked !== null} onChange={() => setOutcome("paid")}>
            Paid at the counter
          </Radio>
          {choices.paidBlocked ? <p className="text-danger pl-8 text-sm font-semibold">{choices.paidBlocked}</p> : null}
          <Radio name="outcome" checked={outcome === "void"} disabled={!choices.voidAllowed} onChange={() => setOutcome("void")}>
            Void (nothing to pay)
          </Radio>
          {choices.voidNote ? <p className="text-ink-muted pl-8 text-sm">{choices.voidNote}</p> : null}
        </fieldset>

        {outcome === "paid" ? (
          <fieldset className="space-y-2">
            <legend className="font-semibold">Paid with</legend>
            {(Object.keys(PAID_VIA_LABEL) as TablePaidVia[]).map((k) => (
              <Radio key={k} name="paidVia" checked={paidVia === k} onChange={() => setPaidVia(k)}>
                {PAID_VIA_LABEL[k]}
              </Radio>
            ))}
          </fieldset>
        ) : (
          <p className="text-sm">Orders still waiting are cancelled. The owner is notified of every void.</p>
        )}

        {error ? (
          <Banner tone="danger" live="alert">
            {error}
          </Banner>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button
            variant={outcome === "void" ? "danger" : "primary"}
            disabled={busy || (outcome === "paid" && choices.paidBlocked !== null) || (outcome === "void" && !choices.voidAllowed)}
            onClick={() => void confirm()}
          >
            {busy ? "Closing..." : outcome === "paid" ? `Close as paid, ${formatNpr(s.bill.total)}` : "Void the table"}
          </Button>
          <Button variant="secondary" onClick={dismiss}>
            Keep it open
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

export function CancelRoundDialog({
  target,
  onClose,
  onDone,
}: {
  target: { tableNumber: number; round: AdminTableRound } | null;
  onClose: () => void;
  onDone: Done;
}) {
  const [reason, setReason] = useState<Exclude<TableCancelReason, "session_closed"> | "">("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = target?.round.id;
  useEffect(() => {
    setReason("");
    setReasonError(null);
    setError(null);
  }, [id]);
  return (
    <Sheet open={target !== null} onClose={onClose} title={target ? `Cancel round ${target.round.round}, table ${target.tableNumber}` : ""}>
      {target ? (
        <div className="space-y-4">
          <ul className="text-sm">
            {target.round.items.map((l, i) => (
              <li key={i}>
                {l.qty} x {l.name}
                {l.options ? ` (${l.options})` : ""}
              </li>
            ))}
          </ul>
          {target.round.acceptedAt ? (
            <p className="text-sm font-semibold">The kitchen already accepted this order. The owner will be notified.</p>
          ) : null}
          <SelectField
            label="Reason"
            required
            value={reason}
            error={reasonError ?? undefined}
            onChange={(e) => {
              setReason(e.target.value as typeof reason);
              setReasonError(null);
            }}
          >
            <option value="">Choose a reason</option>
            {STAFF_TABLE_CANCEL_REASONS.map((k) => (
              <option key={k} value={k}>
                {TABLE_CANCEL_REASON_LABEL[k]}
              </option>
            ))}
          </SelectField>
          {error ? (
            <Banner tone="danger" live="alert">
              {error}
            </Banner>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                if (!reason) {
                  setReasonError("Choose a reason");
                  return;
                }
                setBusy(true);
                const res = await adminApi.cancelTableRound({ roundId: target.round.id, reason });
                setBusy(false);
                if (!res.ok) {
                  setError(res.error.message);
                  await onDone();
                  return;
                }
                await onDone(`Round ${target.round.round} at table ${target.tableNumber} cancelled.`);
                onClose();
              }}
            >
              {busy ? "Cancelling..." : "Cancel this round"}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

function Radio({
  name,
  checked,
  disabled,
  onChange,
  children,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={`min-h-tap rounded-control flex items-center gap-3 border px-3 py-2 ${checked ? "border-primary border-2" : "border-line-strong"} ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} className="accent-primary h-5 w-5" />
      <span>{children}</span>
    </label>
  );
}

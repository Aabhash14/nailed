"use client";

import { Badge, Banner } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/field";
import { formatClock } from "@/components/format";
import { formatNpr } from "@/lib/money";
import { TABLE_LIMITS, type GuestTableRound, type MenuCategory, type TableRoundStatus, type TableSessionView } from "@/types/contract";
import type { MenuSecondary } from "../i18n";
import type { TableText, TableUiKey } from "./i18n";
import { Stepper } from "./item-sheet";
import { Both, Sheet } from "./sheet";
import { billRows, cartEstimate, type DescribedLine, type TableCart } from "./table-logic";

export type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; round: number }
  /** A message to show; `retry` = the outcome is unknown and "Send again" reuses the same request id. */
  | { kind: "message"; key: TableUiKey | null; text: string; retry: boolean; tone: "warning" | "danger" };

const STATUS_KEY: Record<TableRoundStatus, TableUiKey> = {
  new: "status.new",
  preparing: "status.preparing",
  served: "status.served",
  cancelled: "status.cancelled",
};
const STATUS_TONE: Record<TableRoundStatus, "accent" | "primary" | "success" | "neutral"> = {
  new: "accent",
  preparing: "primary",
  served: "success",
  cancelled: "neutral",
};

/**
 * The guest's table sheet: cart (with options, qty, note, "Send to kitchen"), the rounds already sent, and the order
 * summary labelled "Order summary, not a bill or tax invoice". Every message is English first, then the guest's
 * secondary language.
 */
export function TableSheet({
  open,
  onClose,
  view,
  cart,
  lines,
  lineErrors,
  canSend,
  blockedKey,
  send,
  onSend,
  onQty,
  onNote,
  categories,
  sec,
  t,
}: {
  open: boolean;
  onClose: () => void;
  view: TableSessionView;
  cart: TableCart;
  lines: DescribedLine[];
  lineErrors: Record<string, string>;
  /** False while ordering is paused, locked for this table, or unavailable. */
  canSend: boolean;
  /** Why sending is not possible right now (shown above the button). */
  blockedKey: TableUiKey | null;
  send: SendState;
  onSend: () => void;
  onQty: (key: string, qty: number) => void;
  onNote: (note: string) => void;
  categories: MenuCategory[];
  sec: MenuSecondary | null;
  t: TableText;
}) {
  const estimate = cartEstimate(lines);
  const problems = lines.some((l) => l.problem !== null);
  const retry = send.kind === "message" && send.retry;
  const sendLabel: TableUiKey = send.kind === "sending" ? "cart.sending" : retry ? "cart.send_again" : "cart.send";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={
        <>
          {t.en("sheet.title", { n: view.tableNumber })}
          {view.tableLabel ? <span className="text-ink-muted text-base">, {view.tableLabel}</span> : null}
        </>
      }
      titleExtra={<Both en={null} sec={t.sec("sheet.title", { n: view.tableNumber })} lang={t.lang} block secClassName="text-ink-muted text-sm" />}
      closeLabel={<Both en={t.en("sheet.close")} sec={t.sec("sheet.close")} lang={t.lang} />}
      footer={
        cart.lines.length > 0 ? (
          <div className="space-y-2">
            {blockedKey ? (
              <p className="text-sm font-semibold" role="status">
                <Both en={t.en(blockedKey)} sec={t.sec(blockedKey)} lang={t.lang} block />
              </p>
            ) : null}
            <Button
              className="w-full"
              disabled={!canSend || problems || send.kind === "sending"}
              onClick={onSend}
            >
              <Both en={t.en(sendLabel)} sec={t.sec(sendLabel)} lang={t.lang} />
              <span className="tabular-nums">· {formatNpr(estimate)}</span>
            </Button>
          </div>
        ) : null
      }
    >
      <div aria-live="polite" className="space-y-2">
        {send.kind === "sent" ? (
          <Banner tone="success">
            <Both en={t.en("cart.sent", { r: send.round })} sec={t.sec("cart.sent", { r: send.round })} lang={t.lang} block />
          </Banner>
        ) : null}
        {send.kind === "message" ? (
          <Banner tone={send.tone} live={send.tone === "danger" ? "alert" : undefined}>
            {send.key ? <Both en={t.en(send.key)} sec={t.sec(send.key)} lang={t.lang} block /> : send.text}
          </Banner>
        ) : null}
      </div>

      <section aria-labelledby="tc-h" className="space-y-3">
        <h3 id="tc-h" className="font-display text-xl">
          <Both en={t.en("cart.heading")} sec={t.sec("cart.heading")} lang={t.lang} secClassName="text-ink-muted text-base" />
        </h3>
        {cart.lines.length === 0 ? (
          <p className="text-ink-muted">
            <Both en={t.en("cart.empty")} sec={t.sec("cart.empty")} lang={t.lang} block />
          </p>
        ) : (
          <>
            <ul className="divide-line divide-y">
              {lines.map((d) => (
                <CartRow key={d.line.key} d={d} error={lineErrors[d.line.key]} onQty={onQty} sec={sec} t={t} />
              ))}
            </ul>
            <p className="text-ink-muted text-sm">
              <Both
                en={t.en("cart.estimate", { total: formatNpr(estimate) })}
                sec={t.sec("cart.estimate", { total: formatNpr(estimate) })}
                lang={t.lang}
                block
              />
            </p>
            <TextArea
              label={<Both en={t.en("cart.note_label")} sec={t.sec("cart.note_label")} lang={t.lang} />}
              hint={t.en("cart.note_hint")}
              maxLength={TABLE_LIMITS.maxNoteLength}
              rows={2}
              value={cart.note}
              onChange={(e) => onNote(e.target.value)}
            />
          </>
        )}
      </section>

      <section aria-labelledby="tr-h" className="space-y-3">
        <h3 id="tr-h" className="font-display text-xl">
          <Both en={t.en("rounds.heading")} sec={t.sec("rounds.heading")} lang={t.lang} secClassName="text-ink-muted text-base" />
        </h3>
        {view.rounds.length === 0 ? (
          <p className="text-ink-muted">
            <Both en={t.en("rounds.empty")} sec={t.sec("rounds.empty")} lang={t.lang} />
          </p>
        ) : (
          <ol className="space-y-2">
            {[...view.rounds].reverse().map((r) => (
              <RoundRow key={r.round} r={r} categories={categories} sec={sec} t={t} />
            ))}
          </ol>
        )}
      </section>

      <Summary view={view} t={t} />
    </Sheet>
  );
}

function CartRow({
  d,
  error,
  onQty,
  sec,
  t,
}: {
  d: DescribedLine;
  error: string | undefined;
  onQty: (key: string, qty: number) => void;
  sec: MenuSecondary | null;
  t: TableText;
}) {
  const name = d.item?.name ?? "Item";
  const secName = d.item ? sec?.itemName(d.item) : null;
  const problemKey: TableUiKey | null =
    d.problem === "sold_out" ? "cart.line_sold_out" : d.problem ? "cart.line_gone" : null;
  return (
    <li className={`space-y-1.5 py-3 ${d.problem ? "hatch-soldout" : ""}`}>
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 font-semibold wrap-break-word">
          {name}
          {secName && sec ? (
            <span lang={sec.bcp47} className="text-ink-muted block text-sm font-normal">
              {secName}
            </span>
          ) : null}
          {d.options.length > 0 ? (
            <span className="text-ink-muted block text-sm font-normal">
              {d.options.map((o) => o.label).join(", ")}
            </span>
          ) : null}
        </p>
        <p className="shrink-0 font-semibold tabular-nums">{formatNpr(d.lineTotal)}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Stepper
          value={d.line.qty}
          onChange={(n) => onQty(d.line.key, n)}
          lessLabel={t.en("cart.less")}
          moreLabel={t.en("cart.more")}
          itemName={name}
        />
        <button
          type="button"
          className="min-h-tap text-primary px-2 font-semibold underline underline-offset-4"
          onClick={() => onQty(d.line.key, 0)}
        >
          <Both en={t.en("cart.remove")} sec={t.sec("cart.remove")} lang={t.lang} />
          <span className="sr-only"> {name}</span>
        </button>
      </div>
      {problemKey ? (
        <p className="text-danger text-sm font-semibold">
          <Both en={t.en(problemKey)} sec={t.sec(problemKey)} lang={t.lang} block />
        </p>
      ) : null}
      {error ? <p className="text-danger text-sm font-semibold">{error}</p> : null}
    </li>
  );
}

function RoundRow({
  r,
  categories,
  sec,
  t,
}: {
  r: GuestTableRound;
  categories: MenuCategory[];
  sec: MenuSecondary | null;
  t: TableText;
}) {
  const cancelled = r.status === "cancelled";
  const find = (id: string) => {
    for (const c of categories) {
      const it = c.items.find((i) => i.id === id);
      if (it) return it;
    }
    return null;
  };
  return (
    <li className="border-line rounded-control space-y-1.5 border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          <Both en={t.en("rounds.round", { r: r.round })} sec={t.sec("rounds.round", { r: r.round })} lang={t.lang} />
          <span className="text-ink-muted font-normal tabular-nums"> · {formatClock(r.createdAt)}</span>
        </p>
        <Badge tone={STATUS_TONE[r.status]}>
          <Both en={t.en(STATUS_KEY[r.status])} sec={t.sec(STATUS_KEY[r.status])} lang={t.lang} secClassName="tracking-normal normal-case" />
        </Badge>
      </div>
      <ul className={`text-sm ${cancelled ? "text-ink-muted line-through" : ""}`}>
        {r.items.map((l, i) => {
          const item = find(l.menuItemId);
          const secName = item ? sec?.itemName(item) : null;
          return (
            <li key={i} className="flex justify-between gap-2">
              <span className="min-w-0 wrap-break-word">
                {l.qty} x {l.name}
                {l.options ? ` (${l.options})` : ""}
                {secName && sec ? (
                  <span lang={sec.bcp47} className="text-ink-muted">
                    {" "}
                    {secName}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums">{formatNpr(l.lineTotal)}</span>
            </li>
          );
        })}
      </ul>
      {/* F5: a note is plain text (React escapes it); never HTML */}
      {r.note ? <p className="text-ink-muted text-sm wrap-break-word">&ldquo;{r.note}&rdquo;</p> : null}
    </li>
  );
}

function Summary({ view, t }: { view: TableSessionView; t: TableText }) {
  const rows = billRows(view.bill);
  return (
    <section
      aria-labelledby="ts-h"
      className="border-line bg-surface rounded-card relative space-y-2 overflow-hidden border px-4 pt-5 pb-4"
    >
      <div aria-hidden="true" className="ornament-band-sm absolute inset-x-0 top-0" />
      <h3 id="ts-h" className="font-semibold">
        <Both en={t.en("summary.title")} sec={t.sec("summary.title")} lang={t.lang} block secClassName="text-ink-muted text-sm" />
      </h3>
      <dl className="space-y-1 tabular-nums">
        {rows.map((row) => {
          const key: TableUiKey = `summary.${row.key}` as TableUiKey;
          const vars = row.pct !== undefined ? { pct: row.pct } : undefined;
          const total = row.key === "total";
          return (
            <div
              key={row.key}
              className={`flex items-baseline justify-between gap-3 ${total ? "border-ink mt-2 border-t-2 pt-2 text-lg font-semibold" : ""}`}
            >
              <dt>
                <Both en={t.en(key, vars)} sec={t.sec(key, vars)} lang={t.lang} />
              </dt>
              <dd className={total ? "price text-xl" : ""}>{formatNpr(row.amount)}</dd>
            </div>
          );
        })}
      </dl>
      <p className="text-sm">
        <Both en={t.en("summary.pay")} sec={t.sec("summary.pay")} lang={t.lang} block />
      </p>
    </section>
  );
}

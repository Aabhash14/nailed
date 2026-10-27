"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { TurnstileSlot, useTurnstileGate } from "@/components/shop/turnstile-slot";
import { joinTable } from "@/data-access/tables-client";
import { TABLE_JOIN_TURNSTILE_ACTION, type TableOccupancy, type TableSessionView } from "@/types/contract";
import type { TableText } from "./i18n";
import { Both, Sheet } from "./sheet";
import { formatTableCode, isTableCodeShape, normaliseTableCode } from "./table-logic";

/**
 * Join sheet (api-contract 9.3). The Turnstile script loads only when this sheet is open (TurnstileSlot mounts with
 * it), so the menu itself never loads it. A code read from a scanned QR (the `#c=` fragment, SEC-024) arrives in
 * memory only and is sent once automatically as soon as the bot check has a token.
 */
export function JoinSheet({
  open,
  onClose,
  defaultTable,
  scannedCode,
  occupancy,
  t,
  onJoined,
}: {
  open: boolean;
  onClose: () => void;
  defaultTable: number | null;
  scannedCode: string | null;
  occupancy: TableOccupancy | null | undefined;
  t: TableText;
  onJoined: (view: TableSessionView) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t.en("join.title")}
      titleExtra={<Both en={null} sec={t.sec("join.title")} lang={t.lang} block secClassName="text-ink-muted text-sm" />}
      closeLabel={<Both en={t.en("sheet.close")} sec={t.sec("sheet.close")} lang={t.lang} />}
    >
      {open ? (
        <JoinForm defaultTable={defaultTable} scannedCode={scannedCode} occupancy={occupancy} t={t} onJoined={onJoined} />
      ) : null}
    </Sheet>
  );
}

function JoinForm({
  defaultTable,
  scannedCode,
  occupancy,
  t,
  onJoined,
}: {
  defaultTable: number | null;
  scannedCode: string | null;
  occupancy: TableOccupancy | null | undefined;
  t: TableText;
  onJoined: (view: TableSessionView) => void;
}) {
  const [table, setTable] = useState(defaultTable ? String(defaultTable) : "");
  const [code, setCode] = useState(scannedCode ? formatTableCode(scannedCode) : "");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A Turnstile token is single use: after every attempt the slot is re-mounted for a fresh one.
  const [slotKey, setSlotKey] = useState(0);
  const gate = useTurnstileGate(() => setMessage(null));
  const autoTried = useRef(false);

  const tableNumber = Number(table);
  const listed = occupancy?.tables ?? [];
  const chosen = listed.find((x) => x.number === tableNumber);

  const focusCode = () => document.querySelector<HTMLInputElement>("[data-join-code]")?.focus();

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setMessage(null);
    let bad = false;
    if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 99) {
      setTableError("Choose your table number.");
      bad = true;
    } else setTableError(null);
    if (!isTableCodeShape(code)) {
      setCodeError(t.en("join.code_invalid"));
      bad = true;
    } else setCodeError(null);
    if (bad) {
      focusCode();
      return;
    }
    setBusy(true);
    const tok = await gate.getToken(10_000);
    if (!tok.token) {
      setBusy(false);
      if (tok.token === null && tok.reason === "interactive") setMessage("Please complete the check below.");
      return; // a failed check is shown in the slot with its own "Try again"
    }
    const res = await joinTable({ table: tableNumber, code: normaliseTableCode(code), turnstileToken: tok.token });
    setBusy(false);
    setSlotKey((k) => k + 1);
    if (res.ok) {
      onJoined(res.data);
      return;
    }
    if (res.network) setMessage(t.en("msg.unavailable"));
    else if (res.error.code === "VALIDATION") {
      const fe = res.error.fieldErrors ?? {};
      if (fe.table?.[0]) setTableError(fe.table[0]);
      setCodeError(fe.code?.[0] ?? (fe.table ? null : res.error.message));
      focusCode();
    } else if (res.error.code === "NOT_FOUND") setMessage(t.en("msg.off"));
    else setMessage(res.error.message);
  }

  // Scanned QR: join by itself once, as soon as the bot check is ready.
  useEffect(() => {
    if (!scannedCode || !defaultTable || autoTried.current) return;
    autoTried.current = true;
    void submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on open, with the scanned values
  }, []);

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <p className="text-ink-muted text-sm">
        <Both en={t.en("join.cta_body")} sec={t.sec("join.cta_body")} lang={t.lang} block />
      </p>
      {listed.length > 0 ? (
        <SelectField
          label={<Both en={t.en("join.table_label")} sec={t.sec("join.table_label")} lang={t.lang} />}
          required
          value={table}
          error={tableError ?? undefined}
          onChange={(e) => setTable(e.target.value)}
        >
          <option value="">Choose</option>
          {listed.map((x) => (
            <option key={x.number} value={String(x.number)}>
              {t.en("occupancy.table", { n: x.number })}
              {x.label ? `, ${x.label}` : ""}
            </option>
          ))}
        </SelectField>
      ) : (
        <TextField
          label={<Both en={t.en("join.table_label")} sec={t.sec("join.table_label")} lang={t.lang} />}
          required
          inputMode="numeric"
          autoComplete="off"
          value={table}
          error={tableError ?? undefined}
          onChange={(e) => setTable(e.target.value.replace(/\D/g, "").slice(0, 2))}
        />
      )}
      {chosen && !chosen.occupied ? (
        <p className="text-ink-muted text-sm" role="status">
          <Both en={t.en("join.free_note")} sec={t.sec("join.free_note")} lang={t.lang} block />
        </p>
      ) : null}
      <TextField
        data-join-code=""
        label={<Both en={t.en("join.code_label")} sec={t.sec("join.code_label")} lang={t.lang} />}
        hint={t.en("join.code_hint")}
        required
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={20}
        className="font-semibold tracking-[0.2em] uppercase tabular-nums"
        value={code}
        error={codeError ?? undefined}
        onChange={(e) => setCode(e.target.value)}
      />
      <TurnstileSlot
        key={slotKey}
        ref={gate.slot}
        action={TABLE_JOIN_TURNSTILE_ACTION}
        onToken={gate.onToken}
        onFail={gate.onFail}
        onRetry={gate.onRetry}
      />
      {message ? (
        <Banner tone="warning" live="alert">
          {message}
        </Banner>
      ) : null}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? t.en("join.busy") : <Both en={t.en("join.submit")} sec={t.sec("join.submit")} lang={t.lang} />}
      </Button>
    </form>
  );
}

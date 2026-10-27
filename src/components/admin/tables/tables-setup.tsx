"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, LinkButton } from "@/components/ui/button";
import { Banner, Skeleton } from "@/components/ui/feedback";
import { adminApi } from "@/data-access/admin";
import { TABLE_LIMITS, type TableOrderingMode } from "@/types/contract";
import { useAdminSession } from "../admin-shell";
import { retiredNumberText, rowsForCount, rowsFromTables, setupProblems, toSaveInput, type SetupRow } from "./board-logic";

const MODES: { value: TableOrderingMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "No table ordering. The menu shows no tables. Needs every table closed." },
  { value: "on", label: "On", hint: "Guests at an open table can order from the menu." },
  { value: "paused", label: "Paused", hint: "Tables stay open, but guests cannot send new orders (a busy kitchen)." },
];

/**
 * Owner-only Tables setup (api-contract 9.7): the ordering mode, a "number of tables" helper, labels and active flags.
 * `saveCafeTables` takes the FULL set. No revalidation anywhere: open menus see changes on their next poll.
 * No Telegram toggle (2.2.0: table ordering sends nothing to Telegram).
 */
export function TablesSetup() {
  const { role } = useAdminSession();
  if (role !== "owner") {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Tables setup</h1>
        <Banner tone="info" title="Owner only">
          Only the owner can change the tables. You can still open, close and pause tables on the board.
        </Banner>
        <LinkButton href="/admin/tables" variant="secondary">
          Back to the tables
        </LinkButton>
      </div>
    );
  }
  return <OwnerSetup />;
}

function OwnerSetup() {
  const [rows, setRows] = useState<SetupRow[] | null>(null);
  /** Tables with history removed from the list in this edit: the server keeps them, inactive, under their number. */
  const [retired, setRetired] = useState<SetupRow[]>([]);
  const [mode, setMode] = useState<TableOrderingMode>("off");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [count, setCount] = useState("");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await adminApi.listCafeTables();
    if (!res.ok) {
      setLoadError(res.error.message);
      return;
    }
    setLoadError(null);
    setRows(rowsFromTables(res.data.rows));
    setRetired([]);
    setMode(res.data.mode);
    setCount(String(res.data.rows.filter((r) => r.isActive).length));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function changeMode(next: TableOrderingMode) {
    setBusy(true);
    setMessage(null);
    const res = await adminApi.setTableOrdering({ mode: next });
    setBusy(false);
    if (!res.ok) setMessage({ tone: "danger", text: res.error.message });
    else {
      setMode(res.data.mode);
      setMessage({ tone: "success", text: `Table ordering is now ${res.data.mode}. Open menus pick this up within about a minute.` });
    }
  }

  function applyCount() {
    if (!rows) return;
    const n = Number(count);
    if (!Number.isInteger(n) || n < 0 || n > TABLE_LIMITS.maxTable) {
      setProblems({ count: "Enter a number from 0 to 99." });
      return;
    }
    const r = rowsForCount(rows, n, retired);
    setRows(r.rows);
    setRetired((old) => [
      ...old.filter((x) => !r.rows.some((k) => k.id === x.id)),
      ...rows.filter((x) => x.hasHistory && !r.rows.some((k) => k.id === x.id) && !old.some((o) => o.id === x.id)),
    ]);
    setProblems({});
    setMessage(
      r.openAbove.length
        ? { tone: "warning", text: `Table ${r.openAbove.join(", ")} is open. Close it on the board before you save, or the save is refused.` }
        : { tone: "success", text: `Tables 1 to ${n} are listed. Press Save tables to keep them.` },
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!rows) return;
    const p = setupProblems(rows, retired);
    setProblems(p);
    if (Object.keys(p).length > 0) {
      setMessage({ tone: "danger", text: "Please check the highlighted tables." });
      return;
    }
    setBusy(true);
    setMessage(null);
    const res = await adminApi.saveCafeTables(toSaveInput(rows));
    setBusy(false);
    if (!res.ok) {
      const fe = res.error.fieldErrors ?? {};
      setProblems(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v[0] ?? ""])));
      setMessage({ tone: "danger", text: res.error.message });
      return;
    }
    setRows(rowsFromTables(res.data.rows));
    setRetired([]);
    setMessage({ tone: "success", text: "Tables saved." });
  }

  const update = (i: number, patch: Partial<SetupRow>) => setRows((rs) => (rs ? rs.map((r, k) => (k === i ? { ...r, ...patch } : r)) : rs));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Tables setup</h1>
        <LinkButton href="/admin/tables" variant="secondary">
          Back to the tables
        </LinkButton>
      </div>

      <div aria-live="polite">
        {message ? (
          <Banner tone={message.tone === "danger" ? "danger" : message.tone === "warning" ? "warning" : "success"}>{message.text}</Banner>
        ) : null}
      </div>
      {loadError ? (
        <Banner tone="danger" live="alert" title="Could not load the tables">
          {loadError}{" "}
          <Button variant="ghost" onClick={() => void load()}>
            Try again
          </Button>
        </Banner>
      ) : null}

      <fieldset className="border-line bg-surface-raised rounded-card space-y-2 border p-4" disabled={busy || rows === null}>
        <legend className="px-1 text-xl font-semibold">Table ordering</legend>
        {MODES.map((m) => (
          <label
            key={m.value}
            className={`min-h-tap rounded-control flex items-start gap-3 border px-3 py-2 ${mode === m.value ? "border-primary border-2" : "border-line-strong"} cursor-pointer`}
          >
            <input type="radio" name="mode" checked={mode === m.value} onChange={() => void changeMode(m.value)} className="accent-primary mt-1 h-5 w-5" />
            <span>
              <span className="font-semibold">{m.label}</span>
              <span className="text-ink-muted block text-sm">{m.hint}</span>
            </span>
          </label>
        ))}
        <p className="text-ink-muted text-sm">
          Owner alerts (voids, cancelled accepted orders, tables never closed, wrong codes) appear under Alerts. Phone alerts are not set up
          yet.
        </p>
      </fieldset>

      {rows === null && !loadError ? <Skeleton className="h-60 w-full" /> : null}
      {rows ? (
        <form onSubmit={save} noValidate className="border-line bg-surface-raised rounded-card space-y-4 border p-4">
          <h2 className="text-xl font-semibold">Your tables</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label htmlFor="table-count" className="block text-sm font-semibold">
                Number of tables
              </label>
              <input
                id="table-count"
                inputMode="numeric"
                className="min-h-tap rounded-control border-line-strong bg-surface-raised w-28 border px-3 py-2 text-base"
                value={count}
                aria-invalid={problems.count ? true : undefined}
                aria-describedby="table-count-hint"
                onChange={(e) => setCount(e.target.value.replace(/\D/g, "").slice(0, 2))}
              />
            </div>
            <Button variant="secondary" onClick={applyCount}>
              Set tables 1 to {count || "N"}
            </Button>
          </div>
          <p id="table-count-hint" className="text-ink-muted text-sm">
            Lists tables 1 to N and keeps the names you already gave them. Tables above N are removed (or kept as not in use if they
            were ever used).
          </p>
          {problems.count ? <p className="text-danger text-sm font-semibold">{problems.count}</p> : null}
          <p className="text-sm font-semibold">Labels are shown to everyone. Don&apos;t use names.</p>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-ink-muted text-sm">
                <tr>
                  <th scope="col" className="py-2 pr-3">Number</th>
                  <th scope="col" className="py-2 pr-3">Label (optional)</th>
                  <th scope="col" className="py-2 pr-3">In use</th>
                  <th scope="col" className="py-2">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id ?? `new-${i}`} className="border-line border-t align-top">
                    <td className="py-2 pr-3">
                      <input
                        aria-label={`Table number, row ${i + 1}`}
                        inputMode="numeric"
                        disabled={r.isOpen}
                        className="min-h-tap rounded-control border-line-strong bg-surface-raised w-20 border px-3 py-2 text-base disabled:opacity-60"
                        value={Number.isFinite(r.number) && r.number > 0 ? String(r.number) : ""}
                        aria-invalid={problems[`tables.${i}.number`] ? true : undefined}
                        onChange={(e) => {
                          const num = Number(e.target.value.replace(/\D/g, "").slice(0, 2)) || 0;
                          update(i, { number: num });
                          // 2.3.0: say it at once when a new row takes a retired table's number
                          if (!r.id && retired.some((x) => x.number === num))
                            setProblems((p) => ({ ...p, [`tables.${i}.number`]: retiredNumberText(num) }));
                          else
                            setProblems((p) => {
                              const { [`tables.${i}.number`]: _drop, ...rest } = p;
                              void _drop;
                              return rest;
                            });
                        }}
                      />
                      {problems[`tables.${i}.number`] ? <p className="text-danger text-sm font-semibold">{problems[`tables.${i}.number`]}</p> : null}
                      {r.isOpen ? <p className="text-ink-muted text-xs">Open now</p> : null}
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        aria-label={`Label for table ${r.number || i + 1}`}
                        maxLength={TABLE_LIMITS.maxLabelLength}
                        placeholder="Window, Garden..."
                        className="min-h-tap rounded-control border-line-strong bg-surface-raised w-full min-w-40 border px-3 py-2 text-base"
                        value={r.label}
                        aria-invalid={problems[`tables.${i}.label`] ? true : undefined}
                        onChange={(e) => update(i, { label: e.target.value })}
                      />
                      {problems[`tables.${i}.label`] ? <p className="text-danger text-sm font-semibold">{problems[`tables.${i}.label`]}</p> : null}
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        type="checkbox"
                        aria-label={`Table ${r.number || i + 1} in use`}
                        disabled={r.isOpen}
                        checked={r.isActive}
                        onChange={(e) => update(i, { isActive: e.target.checked })}
                        className="accent-primary mt-3 h-5 w-5"
                      />
                    </td>
                    <td className="py-2">
                      <Button
                        variant="ghost"
                        disabled={r.isOpen}
                        onClick={() => {
                          if (r.hasHistory) setRetired((old) => [...old, { ...r, isActive: false }]);
                          setRows((rs) => (rs ? rs.filter((_, k) => k !== i) : rs));
                        }}
                      >
                        Remove<span className="sr-only"> table {r.number}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 ? <p className="text-ink-muted">No tables. Set a number above or add one.</p> : null}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              disabled={rows.length >= TABLE_LIMITS.maxTable}
              onClick={() => {
                const used = (n: number) => rows.some((r) => r.number === n) || retired.some((r) => r.number === n);
                let next = 1;
                while (next < 99 && used(next)) next++;
                setRows([...rows, { number: next, label: "", isActive: true, isOpen: false, hasHistory: false }]);
              }}
            >
              Add a table
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving..." : "Save tables"}
            </Button>
          </div>
          <p className="text-ink-muted text-sm">
            A table that was ever used is kept as &ldquo;not in use&rdquo; when you remove it, so its history stays; to use its number again,
            turn that table back on. An open table cannot be renumbered or removed: close it first.
          </p>
        </form>
      ) : null}
    </div>
  );
}

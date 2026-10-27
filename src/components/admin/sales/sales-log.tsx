"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { TextArea, TextField } from "@/components/ui/field";
import { formatClock, paisaToRupees, rupeesToPaisa } from "@/components/format";
import { adminApi, type DailySalesView } from "@/data-access/admin";
import { formatNpr } from "@/lib/money";
import { addDays, kathmanduToday } from "@/lib/stats/dates";
import type { AdminMenuCategory } from "@/types/contract";
import { useAdminSession } from "../admin-shell";
import { longDate, shortDate } from "../stats/stats-logic";
import {
  allRows,
  buildGroups,
  changedLines,
  cleanQtyInput,
  liveTotal,
  loadedLogStatus,
  mapSaveErrors,
  matchesFilter,
  orphanLines,
  parseQty,
  qtyFromLog,
  QTY_MAX,
  step,
  type SalesRow,
  type SaveErrors,
} from "./sales-logic";

type Loaded = { state: "loading" } | { state: "error"; message: string; forbidden?: boolean } | { state: "ok"; log: DailySalesView | null };

/** Closing-time food sales log for one Kathmandu date (staff: today or yesterday; owner: any past date). */
export function SalesLog() {
  const { role, displayName } = useAdminSession();
  const owner = role === "owner";
  const [today, setToday] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [menu, setMenu] = useState<AdminMenuCategory[] | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [till, setTill] = useState("");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ at: string; by: string } | null>(null);
  const [errors, setErrors] = useState<SaveErrors | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const reqId = useRef(0);
  const id = useId();

  // "Today" is a Kathmandu date, read in the browser after mount (the page is client-rendered).
  useEffect(() => {
    const t = kathmanduToday();
    setToday(t);
    setDate(t);
  }, []);

  const loadMenu = useCallback(async () => {
    setMenuError(null);
    try {
      setMenu(await adminApi.getMenu());
    } catch {
      setMenuError("Could not load the menu. Check the connection and try again.");
    }
  }, []);
  useEffect(() => {
    void loadMenu();
  }, [loadMenu]);

  const groups = useMemo(() => (menu ? buildGroups(menu) : []), [menu]);
  const rows = useMemo(() => allRows(groups), [groups]);
  const log = loaded.state === "ok" ? loaded.log : null;
  const orphans = useMemo(() => orphanLines(log, groups), [log, groups]);
  const savedQty = useMemo(() => qtyFromLog(log), [log]);

  const loadDay = useCallback(async (d: string) => {
    const rid = ++reqId.current;
    setLoaded({ state: "loading" });
    setSaved(null);
    setErrors(null);
    setSaveError(null);
    try {
      const res = await adminApi.getDailySales({ date: d });
      if (rid !== reqId.current) return;
      if (!res.ok) {
        setLoaded({ state: "error", message: res.error.message, forbidden: res.error.code === "FORBIDDEN" });
        return;
      }
      setLoaded({ state: "ok", log: res.data });
      setQty(Object.fromEntries(Object.entries(qtyFromLog(res.data)).map(([k, v]) => [k, v > 0 ? String(v) : ""])));
      setTill(res.data?.tillTotalPaisa != null ? paisaToRupees(res.data.tillTotalPaisa) : "");
      setNote(res.data?.note ?? "");
    } catch {
      if (rid === reqId.current) setLoaded({ state: "error", message: "Could not load this day. Check the connection and try again." });
    }
  }, []);
  useEffect(() => {
    if (date) void loadDay(date);
  }, [date, loadDay]);

  const qtyNum = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(qty)) out[k] = parseQty(v) ?? 0;
    return out;
  }, [qty]);
  const total = liveTotal(qtyNum, rows, log, orphans);
  const lineChanges = changedLines(savedQty, qtyNum, rows);
  const tillPaisa = till.trim() === "" ? null : rupeesToPaisa(till);
  const headerChanged = (log?.tillTotalPaisa ?? null) !== tillPaisa || (log?.note ?? "") !== note.trim();
  const dirty = loaded.state === "ok" && (lineChanges.length > 0 || headerChanged);

  // Leaving the page with unsaved counts asks first (closing time is a bad time to lose them).
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  function changeDate(d: string) {
    if (d === date) return;
    if (dirty && !window.confirm("You have counts that are not saved. Switch the day and lose them?")) return;
    setDate(d);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!date || loaded.state !== "ok") return;
    setErrors(null);
    setSaveError(null);
    setSaved(null);
    if (till.trim() !== "" && tillPaisa === null) {
      setErrors({ lines: [], other: [], tillTotal: "Enter rupees, like 45000 or 45,000.50" });
      return;
    }
    const sent = lineChanges;
    setSaving(true);
    try {
      const res = await adminApi.logDailySales({ date, lines: sent, tillTotalPaisa: tillPaisa, note: note.trim() || null });
      if (!res.ok) {
        if (res.error.code === "VALIDATION") setErrors(mapSaveErrors(res.error.fieldErrors, sent, rows));
        setSaveError(res.error.message);
        return;
      }
      setLoaded({ state: "ok", log: res.data });
      setQty(Object.fromEntries(Object.entries(qtyFromLog(res.data)).map(([k, v]) => [k, v > 0 ? String(v) : ""])));
      setTill(res.data.tillTotalPaisa != null ? paisaToRupees(res.data.tillTotalPaisa) : "");
      setNote(res.data.note ?? "");
      setSaved({ at: res.data.updatedAt, by: res.data.updatedByName ?? displayName });
    } catch {
      setSaveError("Could not save. Check the connection and press Save again: your counts are still here.");
    } finally {
      setSaving(false);
    }
  }

  const yesterday = today ? addDays(today, -1) : null;
  const heading = date && date === today ? "Log today's sales" : "Log sales";

  return (
    <form onSubmit={save} noValidate className="space-y-5 pb-4" aria-labelledby={`${id}-h`}>
      <div className="space-y-1">
        <h1 id={`${id}-h`} className="font-display text-ink text-3xl tracking-[0.02em]">
          {heading}
        </h1>
        <p className="text-ink-muted">Count what was sold at closing. Type a number or use + and −. Prices come from the menu.</p>
      </div>

      {/* day picker */}
      <fieldset className="border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4">
        <legend className="sr-only">Which day</legend>
        <p aria-hidden="true" className="text-sm font-semibold">
          Which day
        </p>
        {today && yesterday ? (
          <div className="flex flex-wrap items-end gap-2">
            <DayChip name={`${id}-day`} checked={date === today} onChange={() => changeDate(today)} label="Today" sub={shortDate(today)} />
            <DayChip name={`${id}-day`} checked={date === yesterday} onChange={() => changeDate(yesterday)} label="Yesterday" sub={shortDate(yesterday)} />
            {owner ? (
              <div className="space-y-1">
                <label htmlFor={`${id}-date`} className="block text-sm font-semibold">
                  Another day
                </label>
                <input
                  id={`${id}-date`}
                  type="date"
                  max={today}
                  min="2020-01-01"
                  value={date ?? ""}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= today) changeDate(v);
                  }}
                  className="min-h-tap rounded-control border-line-strong bg-surface text-ink hover:border-ink focus-visible:border-primary border px-3 py-2 text-base tabular-nums"
                />
              </div>
            ) : null}
          </div>
        ) : (
          <Skeleton className="h-12 w-64" />
        )}
        {!owner ? <p className="text-ink-muted text-sm">Staff can log today and yesterday. Ask the owner to change older days.</p> : null}
        {date ? (
          <p className="text-sm">
            <span className="font-semibold">{longDate(date)}</span>
            <LogStatus loaded={loaded} saved={saved} />
          </p>
        ) : null}
      </fieldset>

      <div role="status" aria-live="polite">
        {saved ? (
          <Banner tone="success" title={`Saved at ${formatClock(saved.at)} by ${saved.by}`}>
            {formatNpr(log?.linesTotalPaisa ?? 0)} of food, {log?.itemsSold ?? 0} items, for {longDate(date ?? "")}.
          </Banner>
        ) : null}
      </div>
      {saveError ? (
        <Banner tone="danger" live="alert" title="Not saved">
          {saveError}
          {errors && (errors.lines.length > 0 || errors.other.length > 0 || errors.date) ? (
            <ul className="mt-1 list-disc pl-5">
              {[...errors.lines, ...errors.other, ...(errors.date ? [errors.date] : [])].map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}

      {menuError ? (
        <Banner tone="danger" live="alert" title="Could not load the menu">
          {menuError}{" "}
          <Button variant="ghost" onClick={() => void loadMenu()}>
            Try again
          </Button>
        </Banner>
      ) : null}

      {loaded.state === "error" ? (
        <Banner tone={loaded.forbidden ? "warning" : "danger"} live="alert" title={loaded.forbidden ? "You cannot open this day" : "Could not load this day"}>
          {loaded.message}{" "}
          {!loaded.forbidden && date ? (
            <Button variant="ghost" onClick={() => void loadDay(date)}>
              Try again
            </Button>
          ) : null}
        </Banner>
      ) : null}

      {loaded.state === "loading" || (!menu && !menuError) ? (
        <div aria-busy="true" aria-label="Loading the menu and this day's counts" className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : null}

      {loaded.state === "ok" && menu ? (
        <>
          {log?.note?.trim().toUpperCase() === "DEMO DATA" ? (
            <Banner tone="warning" title="Demo data">
              This day holds made-up sample counts (note &ldquo;DEMO DATA&rdquo;). Saving here changes them.
            </Banner>
          ) : null}

          {groups.length === 0 ? (
            <EmptyState title="The menu is empty">Add items under Menu first, then log their sales here.</EmptyState>
          ) : (
            <>
              <TextField label="Find an item" type="search" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} autoComplete="off" />
              {groups.map((g) => {
                const items = g.items.filter((i) => matchesFilter(i, filter));
                if (items.length === 0) return null;
                return (
                  <section key={g.id} aria-labelledby={`${id}-g-${g.id}`} className="space-y-2">
                    <h2 id={`${id}-g-${g.id}`} className="font-display text-xl">
                      {g.name}
                    </h2>
                    <ul className="border-line bg-surface-raised rounded-card shadow-card divide-line divide-y border">
                      {items.map((it) => (
                        <li key={it.item.key} className="px-3 py-2 sm:px-4">
                          <QtyRow row={it.item} value={qty[it.item.key] ?? ""} setValue={(v) => setQty((q) => ({ ...q, [it.item.key]: v }))} log={log} />
                          {it.options.length > 0 ? (
                            <ul aria-label={`${it.item.name} options`} className="border-line mt-1 ml-1 space-y-1 border-l-2 pl-3">
                              {it.options.map((o) => (
                                <li key={o.key}>
                                  <QtyRow row={o} value={qty[o.key] ?? ""} setValue={(v) => setQty((q) => ({ ...q, [o.key]: v }))} log={log} option />
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {filter && groups.every((g) => g.items.every((i) => !matchesFilter(i, filter))) ? <p className="text-ink-muted">No item matches &ldquo;{filter}&rdquo;.</p> : null}
            </>
          )}

          {orphans.length > 0 ? (
            <section aria-labelledby={`${id}-orph`} className="space-y-2">
              <h2 id={`${id}-orph`} className="font-display text-xl">
                No longer on the menu
              </h2>
              <p className="text-ink-muted text-sm">Logged earlier for this day. They count in the total but can no longer be changed here.</p>
              <ul className="border-line bg-surface-raised rounded-card divide-line divide-y border">
                {orphans.map((o) => (
                  <li key={o.id} className="flex justify-between gap-3 px-4 py-3 tabular-nums">
                    <span>
                      {o.name}
                      {o.variantLabel ? `, ${o.variantLabel}` : ""}
                    </span>
                    <span>
                      {o.qty} × {formatNpr(o.unitPricePaisa)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby={`${id}-close`} className="border-line bg-surface-raised rounded-card shadow-card space-y-4 border p-4">
            <h2 id={`${id}-close`} className="font-display text-xl">
              Till and note
            </h2>
            <TextField
              label="Till total for food (Rs.)"
              inputMode="decimal"
              autoComplete="off"
              value={till}
              onChange={(e) => setTill(e.currentTarget.value)}
              hint="The cash and QR total for food from the till, if you have it. Kept separate from the counts above."
              error={errors?.tillTotal}
              className="tabular-nums sm:max-w-xs"
            />
            <TextArea label="Note" value={note} maxLength={500} onChange={(e) => setNote(e.currentTarget.value)} hint="Anything unusual today (power cut, private party). Up to 500 characters." error={errors?.note} />
          </section>

          {/* sticky total + save: always within thumb reach on a phone */}
          <div className="border-line bg-surface-raised shadow-tabbar sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <p className="tabular-nums">
              <span className="block text-sm text-ink-muted">{dirty ? "Not saved yet" : log ? "All saved" : "Nothing saved yet"}</span>
              <span className="text-lg font-semibold">
                {total.items} {total.items === 1 ? "item" : "items"}, {formatNpr(total.paisa)}
              </span>
            </p>
            <Button type="submit" disabled={saving} className="min-w-32">
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      ) : null}
    </form>
  );
}

function LogStatus({ loaded, saved }: { loaded: Loaded; saved: { at: string; by: string } | null }) {
  if (loaded.state !== "ok" || saved) return null;
  const l = loaded.log;
  if (!l) return <span className="text-ink-muted">: nothing logged yet.</span>;
  const st = loadedLogStatus(l);
  return <span className={`text-ink-muted ${st.ownLine ? "block" : ""}`}>{st.text}</span>;
}

function DayChip({ name, checked, onChange, label, sub }: { name: string; checked: boolean; onChange: () => void; label: string; sub: string }) {
  return (
    <label className="cursor-pointer">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="peer sr-only" />
      <span className="min-h-tap rounded-control border-line-strong peer-checked:bg-primary peer-checked:text-on-primary peer-checked:border-primary peer-focus-visible:outline-primary inline-flex flex-col justify-center border px-4 py-1.5 leading-tight peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 hover:border-ink">
        <span className="font-semibold">{label}</span>
        <span className="text-sm tabular-nums">{sub}</span>
      </span>
    </label>
  );
}

function QtyRow({ row, value, setValue, log, option = false }: { row: SalesRow; value: string; setValue: (v: string) => void; log: DailySalesView | null; option?: boolean }) {
  const inputId = useId();
  const n = parseQty(value) ?? 0;
  const snap = log?.lines.find((l) => l.menuItemId === row.menuItemId && l.variantId === row.variantId)?.unitPricePaisa;
  const price = snap ?? row.pricePaisa;
  const full = option ? `${row.name}, ${row.label}` : row.name;
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 py-1">
      <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
        <span className={`block break-words ${option ? "" : "text-lg"} font-semibold`}>
          {row.label}
          {option ? <span className="sr-only"> ({row.name})</span> : null}
        </span>
        <span className="text-ink-muted flex flex-wrap items-center gap-x-2 text-sm tabular-nums">
          {formatNpr(price)}
          {snap !== undefined && snap !== row.pricePaisa ? <span>(price when first logged)</span> : null}
          {row.hidden && !option ? <Badge>Hidden</Badge> : null}
        </span>
      </label>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setValue(String(step(n, -1) || ""))}
          disabled={n <= 0}
          aria-label={`One less ${full}`}
          className="rounded-control border-line-strong text-primary hover:bg-surface-alt grid h-12 w-12 place-items-center border text-2xl font-semibold disabled:opacity-40"
        >
          <span aria-hidden="true">−</span>
        </button>
        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          enterKeyHint="next"
          placeholder="0"
          aria-label={`Quantity of ${full}`}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(cleanQtyInput(e.currentTarget.value))}
          className={`rounded-control bg-surface h-12 w-16 border text-center text-lg font-semibold tabular-nums ${n > 0 ? "border-primary border-2" : "border-line-strong"}`}
        />
        <button
          type="button"
          onClick={() => setValue(String(step(n, 1)))}
          disabled={n >= QTY_MAX}
          aria-label={`One more ${full}`}
          className="rounded-control bg-primary text-on-primary hover:bg-primary-strong grid h-12 w-12 place-items-center text-2xl font-semibold disabled:opacity-40"
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
    </div>
  );
}

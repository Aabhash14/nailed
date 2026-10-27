"use client";

import { useId } from "react";
import { formatNpr } from "@/lib/money";
import type { StatsBundle } from "@/lib/stats/types";
import { BarList } from "./charts";
import { busiestHours, tableOrdersOf } from "./table-orders-logic";

/**
 * Owner stats card for table orders. A SEPARATE block (ADR 0002 option 6C): never added into the daily-log food
 * figures above it, and labelled so. Shows the two weekly checks from SEC-022: rounds cancelled after the kitchen
 * accepted them, and tables the system closed with food on the bill ("never closed").
 */
export function TableOrdersCard({ data }: { data: StatsBundle }) {
  const id = useId();
  const t = tableOrdersOf(data);
  if (!t) return null;
  const hours = busiestHours(t.byHour);
  const nothing = t.rounds === 0 && t.paidTables === 0 && t.cancelledRounds === 0 && t.expiredTables === 0 && t.voidedTables === 0;
  return (
    <section aria-labelledby={`${id}-h`} className="border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4 md:p-5">
      <h2 id={`${id}-h`} className="font-display text-xl">
        Ordered from the table
      </h2>
      <p className="text-ink-muted text-sm">These are also counted in your daily log. They are shown here on their own, never added to the food figures above.</p>
      {nothing ? (
        <p className="text-ink-muted py-2">No table orders in these dates.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 tabular-nums sm:grid-cols-3">
            <Fact term="Orders sent (rounds)" value={String(t.rounds)} />
            <Fact term="Tables paid" value={String(t.paidTables)} />
            <Fact term="Paid at those tables" value={formatNpr(t.paidTotalPaisa)} />
            <Fact term="Rounds cancelled" value={String(t.cancelledRounds)} />
            <Fact term="Voided tables" value={String(t.voidedTables)} />
            <Fact term="Busiest hours" value={hours.length ? hours.join(", ") : "None"} />
          </dl>
          <div className="border-line space-y-1 border-t pt-3">
            <h3 className="font-semibold">Weekly checks</h3>
            <p className={`text-sm ${t.cancelledAfterAccept > 0 ? "text-danger font-semibold" : ""}`}>
              Cancelled after the kitchen accepted: {t.cancelledAfterAccept}
            </p>
            <p className={`text-sm ${t.expiredWithOrdersPaisa > 0 ? "text-danger font-semibold" : ""}`}>
              Never closed (closed by the system after 12 h): {t.expiredTables} table{t.expiredTables === 1 ? "" : "s"},{" "}
              {formatNpr(t.expiredWithOrdersPaisa)} on their bills
            </p>
            <p className="text-ink-muted text-xs">Compare these with the till. Details are under Alerts.</p>
          </div>
          {t.topItems.length > 0 ? (
            <>
              <h3 className="pt-1 font-semibold">Most ordered at the table</h3>
              <BarList
                label="Most ordered at the table"
                rows={t.topItems.map((r, i) => ({
                  key: r.menuItemId,
                  label: (
                    <>
                      <span className="text-ink-muted mr-1.5 tabular-nums">{i + 1}.</span>
                      {r.name}
                    </>
                  ),
                  value: r.qty,
                  valueText: `${r.qty} ordered`,
                  detail: formatNpr(r.revenuePaisa),
                }))}
              />
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="bg-surface rounded-control px-3 py-2">
      <dt className="text-ink-muted text-sm">{term}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}

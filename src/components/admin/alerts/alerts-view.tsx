"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "@/components/format";
import { Button, LinkButton } from "@/components/ui/button";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { CheckField } from "@/components/ui/field";
import { adminApi } from "@/data-access/admin";
import type { AdminAlert } from "@/types/contract";
import { useAdminSession } from "../admin-shell";
import { ALERT_TITLE, ALERTS_POLL_MS, deliveryLabels, NO_CHANNEL_TEXT } from "../tables/board-logic";
import { announceUnread } from "./alerts-events";


/**
 * Owner-only Alerts (api-contract 2.2.0 section 9.10): voids, accepted orders cancelled, tables never closed and bursts
 * of wrong table codes. Stored by the database with the event, so nothing is lost while no messaging channel is set
 * up. Polls listAlerts every 60 s while visible; no Realtime, no Telegram. 2.3.0: no delivery channel in v1.
 */
export function AlertsView() {
  const { role } = useAdminSession();
  if (role !== "owner") {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Alerts</h1>
        <Banner tone="info" title="Owner only">
          Alerts are for the owner.
        </Banner>
      </div>
    );
  }
  return <OwnerAlerts />;
}

function OwnerAlerts() {
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [data, setData] = useState<{ rows: AdminAlert[]; total: number; unread: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await adminApi.listAlerts({ unreadOnly, pageSize: 100 });
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setError(null);
    setData(res.data);
    announceUnread(res.data.unread);
  }, [unreadOnly]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ALERTS_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  async function markRead(input: { ids: string[] } | { all: true }) {
    setBusy(true);
    const res = await adminApi.markAlertsRead(input);
    setBusy(false);
    if (!res.ok) setError(res.error.message);
    else announceUnread(res.data.unread);
    await load();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Alerts</h1>
          <p className="text-ink-muted">Things the owner should check: voided tables, cancelled accepted orders, tables never closed, wrong codes.</p>
        </div>
        <LinkButton href="/admin/tables" variant="secondary">
          Tables
        </LinkButton>
      </div>

      <Banner tone="info" title={NO_CHANNEL_TEXT}>
        Nothing is sent to a phone yet, so check this page at the end of each shift.
      </Banner>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <CheckField label="Unread only" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
        {data && data.unread > 0 ? (
          <Button variant="secondary" disabled={busy} onClick={() => void markRead({ all: true })}>
            Mark all {data.unread} as read
          </Button>
        ) : null}
      </div>

      {error ? (
        <Banner tone="danger" live="alert" title="Could not load the alerts">
          {error}{" "}
          <Button variant="ghost" onClick={() => void load()}>
            Try again
          </Button>
        </Banner>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {data ? `${data.unread} unread alert${data.unread === 1 ? "" : "s"}` : ""}
      </p>

      {!data && !error ? <Skeleton className="h-40 w-full" /> : null}
      {data && data.rows.length === 0 ? (
        <EmptyState title={unreadOnly ? "Nothing unread" : "No alerts yet"}>
          {unreadOnly ? "You have read every alert. Untick Unread only to see older ones." : "Alerts appear here when something needs the owner's eye."}
        </EmptyState>
      ) : null}
      {data && data.rows.length > 0 ? (
        <ul className="space-y-3">
          {data.rows.map((a) => (
            <li
              key={a.id}
              className={`bg-surface-raised rounded-card shadow-card space-y-2 border p-4 ${a.readAt ? "border-line" : "border-accent border-l-4"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">
                  {ALERT_TITLE[a.kind]}
                  {a.data.tableNumber !== undefined ? <span className="text-ink-muted font-normal">, table {a.data.tableNumber}</span> : null}
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  {a.readAt ? <Badge>Read</Badge> : <Badge tone="accent">Unread</Badge>}
                  {deliveryLabels(a.delivery).map((d) => (
                    <Badge key={d}>{d}</Badge>
                  ))}
                </div>
              </div>
              <p>{a.text}</p>
              <p className="text-ink-muted text-sm">
                {formatDateTime(a.createdAt)}
                {a.readAt ? ` · read ${formatDateTime(a.readAt)}${a.readByName ? ` by ${a.readByName}` : ""}` : ""}
              </p>
              {!a.readAt ? (
                <Button variant="secondary" disabled={busy} onClick={() => void markRead({ ids: [a.id] })}>
                  Mark as read<span className="sr-only"> for {ALERT_TITLE[a.kind]}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data && data.total > data.rows.length ? (
        <p className="text-ink-muted text-sm">Showing the newest {data.rows.length} of {data.total}.</p>
      ) : null}
    </div>
  );
}

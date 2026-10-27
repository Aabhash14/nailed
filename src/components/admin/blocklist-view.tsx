"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { adminApi } from "@/data-access/admin";
import { formatDateTime } from "@/components/format";
import type { BlockedContact } from "@/types/contract";
import { useAdminSession } from "./admin-shell";

/** An ip_hash is only ever shown truncated; the raw IP is never stored (contract, Blocklist). */
function shown(b: BlockedContact): string {
  return b.kind === "ip_hash" ? `${b.value.slice(0, 8)}...` : b.value;
}

export function BlocklistView() {
  const { role } = useAdminSession();
  const owner = role === "owner";
  const [rows, setRows] = useState<BlockedContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await adminApi.listBlockedContacts({ pageSize: 100 });
    if (res.ok) {
      setRows(res.data.rows);
      setError(null);
    } else setError(res.error.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setPhoneError(undefined);
    setNotice(null);
    const known = new Set((rows ?? []).map((b) => b.id));
    const res = await adminApi.blockContact({ kind: "phone", value: phone, reason: reason.trim() || undefined });
    if (!res.ok) {
      setPhoneError(res.error.fieldErrors?.value?.[0] ?? res.error.message);
      return;
    }
    // Blocking is insert-or-nothing: an existing entry comes back unchanged (its reason and date are kept).
    const already = known.has(res.data.id) || Date.now() - new Date(res.data.createdAt).getTime() > 60_000;
    setNotice(already ? `Already blocked: ${res.data.value}. The existing entry was kept.` : `Blocked ${res.data.value}.`);
    setPhone("");
    setReason("");
    await load();
  }

  return (
    <div className="space-y-6">
      <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Blocklist</h1>
      <p className="text-ink-muted">
        People on this list cannot order online. They see a general message asking them to call. To block someone from an order, use
        Cancel order on the Today page and tick &quot;Also block this phone number&quot;.
      </p>
      {!owner ? <Banner tone="info">Staff can add to the list. Only the owner can remove someone.</Banner> : null}
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}

      <div role="status" aria-live="polite">
        {notice ? <Banner tone={notice.startsWith("Already") ? "info" : "success"}>{notice}</Banner> : null}
      </div>

      <form onSubmit={add} className="border-line rounded-control grid gap-3 border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <TextField label="Phone number to block" required type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={phoneError} />
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button type="submit">Block</Button>
      </form>

      {rows === null && !error ? (
        <div aria-busy="true" aria-label="Loading the blocklist">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (rows ?? []).length === 0 ? (
        <EmptyState title="Nobody is blocked" />
      ) : (
        <ul className="space-y-2">
          {(rows ?? []).map((b) => (
            <li key={b.id} className="bg-surface-raised border-line rounded-card shadow-card flex flex-wrap items-center justify-between gap-3 border p-3">
              <div>
                <p className="font-semibold">
                  <span>{shown(b)}</span> <Badge>{b.kind === "phone" ? "Phone" : "Device"}</Badge>
                </p>
                <p className="text-ink-muted text-sm">
                  {b.reason ?? "No reason given"} &middot; {formatDateTime(b.createdAt)}
                </p>
              </div>
              {owner ? (
                <Button
                  variant="secondary"
                  aria-label={`Unblock ${shown(b)}`}
                  onClick={async () => {
                    const res = await adminApi.unblockContact({ id: b.id });
                    if (!res.ok) setError(res.error.message);
                    await load();
                  }}
                >
                  Unblock
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

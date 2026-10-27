"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { adminApi } from "@/data-access/admin";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type StaffMember } from "@/types/contract";
import { formatDateTime } from "@/components/format";
import { useAdminSession } from "./admin-shell";

/** Owner page: who can sign in to admin, add a staff login, remove a person's access (SEC-004 offboarding). */
export function StaffView() {
  const { role } = useAdminSession();
  const [rows, setRows] = useState<StaffMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    const res = await adminApi.listStaff();
    if (res.ok) {
      setRows(res.data);
      setError(null);
    } else setError(res.error.message);
  }, []);

  useEffect(() => {
    if (role === "owner") void load();
  }, [role, load]);

  if (role !== "owner") {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Staff</h1>
        <Banner tone="info">Only the owner can see and change who has access to admin.</Banner>
      </div>
    );
  }

  // contract 1.3.0: removed staff are deleted, so every listed row has access
  const active = rows ?? [];

  return (
    <div className="space-y-6">
      <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Staff</h1>
      <p className="text-ink-muted">
        People who can sign in to admin. Remove access as soon as someone leaves, and ask each person to change their
        password under Account after their first sign in.
      </p>
      <div role="status" aria-live="polite">
        {notice ? <Banner tone={notice.ok ? "success" : "danger"}>{notice.text}</Banner> : null}
      </div>

      {error ? (
        <Banner tone="danger" live="alert" title="Could not load staff">
          {error} <Button variant="ghost" onClick={() => void load()}>Try again</Button>
        </Banner>
      ) : null}

      <section aria-labelledby="staff-active" className="space-y-3">
        <h2 id="staff-active" ref={listHeading} tabIndex={-1} className="font-display text-xl">
          Has access
        </h2>
        {rows === null && !error ? (
          <div aria-busy="true" aria-label="Loading staff" className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState title="Nobody yet">Add a staff login below.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {active.map((m) => (
              <StaffRow
                key={m.userId}
                member={m}
                onRemoved={async (name) => {
                  setNotice({ ok: true, text: `${name} can no longer sign in.` });
                  await load();
                  // BUG-009: the row (and the focused button) is gone; continue from the list heading
                  requestAnimationFrame(() => listHeading.current?.focus());
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <AddStaff
        onAdded={async (name) => {
          setNotice({ ok: true, text: `${name} can now sign in with the temporary password you chose.` });
          await load();
        }}
      />
    </div>
  );
}

function StaffRow({ member, onRemoved }: { member: StaffMember; onRemoved: (name: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = member.role === "owner";
  const removable = !isOwner && !member.isSelf;
  // BUG-009: the pressed button is replaced by the confirmation (and back), so move focus with it
  const yesRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const returnToRemove = useRef(false);
  useEffect(() => {
    if (confirming) yesRef.current?.focus();
    else if (returnToRemove.current) {
      returnToRemove.current = false;
      removeRef.current?.focus();
    }
  }, [confirming]);

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await adminApi.deactivateStaff({ userId: member.userId });
    setBusy(false);
    if (res.ok) {
      setConfirming(false);
      await onRemoved(member.displayName);
    } else setError(res.error.message);
  }

  return (
    <li className="border-line bg-surface-raised rounded-card shadow-card space-y-2 border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold">
            {member.displayName} <Badge tone={isOwner ? "primary" : "neutral"}>{member.role}</Badge>
          </p>
          <p className="text-ink-muted text-sm break-all">
            {member.email ?? "No email shown"}
            {` · added ${formatDateTime(member.createdAt)}`}
            {` · ${member.lastSignInAt ? `last signed in ${formatDateTime(member.lastSignInAt)}` : "has not signed in yet"}`}
          </p>
        </div>
        {!removable ? (
          <p className="text-ink-muted text-sm">
            {member.isSelf ? "This is you. " : ""}The owner account cannot be removed here.
          </p>
        ) : !confirming ? (
          <Button ref={removeRef} variant="secondary" onClick={() => setConfirming(true)}>
            Remove access
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <div role="alertdialog" aria-label={`Remove access for ${member.displayName}`} className="border-danger rounded-control space-y-2 border p-3">
          <p className="font-semibold">Remove access for {member.displayName}?</p>
          <p className="text-sm">They are signed out and cannot sign in to admin again. Orders they handled are not changed. To give access again, add a new staff login.</p>
          <div className="flex flex-wrap gap-3">
            <Button ref={yesRef} variant="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? "Removing..." : "Yes, remove access"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                returnToRemove.current = true;
                setConfirming(false);
              }}
            >
              Keep access
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
    </li>
  );
}

function AddStaff({ onAdded }: { onAdded: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Partial<Record<"displayName" | "email" | "password", string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const errs: typeof errors = {};
    if (!name.trim()) errs.displayName = "Enter their name";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = "Enter their email address";
    if (password.length < PASSWORD_MIN_LENGTH) errs.password = `Use at least ${PASSWORD_MIN_LENGTH} characters`;
    // same cap as the server (Supabase Auth / bcrypt): 72 characters and 72 bytes (some letters take 2 to 4 bytes)
    else if (password.length > PASSWORD_MAX_LENGTH || new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH) {
      errs.password = `Use at most ${PASSWORD_MAX_LENGTH} characters (fewer if you use Nepali letters or emoji)`;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    const res = await adminApi.inviteStaff({ email: email.trim(), displayName: name.trim(), password });
    setBusy(false);
    if (res.ok) {
      const added = name.trim();
      setName("");
      setEmail("");
      setPassword("");
      await onAdded(added);
    } else {
      const fe = res.error.fieldErrors ?? {};
      setErrors({ displayName: fe.displayName?.join(", "), email: fe.email?.join(", "), password: fe.password?.join(", ") });
      setError(res.error.message);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby="staff-add" className="border-line rounded-control max-w-xl space-y-4 border p-4">
      <h2 id="staff-add" className="font-display text-xl">
        Add a staff login
      </h2>
      <p className="text-ink-muted text-sm">
        Staff can manage orders, mark items sold out and change the notice banner. Tell them the temporary password in
        person, not by message.
      </p>
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
      <TextField label="Name" required autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} error={errors.displayName} />
      <TextField label="Email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
      <TextField
        label="Temporary password"
        type="password"
        required
        autoComplete="new-password"
        hint={`${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`}
        maxLength={PASSWORD_MAX_LENGTH}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
      />
      <Button type="submit" disabled={busy}>
        {busy ? "Adding..." : "Add staff login"}
      </Button>
    </form>
  );
}

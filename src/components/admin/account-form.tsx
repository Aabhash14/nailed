"use client";

import { useCallback, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { TurnstileSlot } from "@/components/shop/turnstile-slot";
import { adminApi } from "@/data-access/admin";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/types/contract";
import { useAdminSession } from "./admin-shell";

type Errors = Partial<Record<"currentPassword" | "newPassword" | "confirm", string>>;

/** Change your own password (SEC-004). Any signed-in staff member or the owner. */
export function AccountForm() {
  const { displayName, role } = useAdminSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const onToken = useCallback((t: string | null) => setToken(t), []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const errs: Errors = {};
    if (!current) errs.currentPassword = "Enter your current password";
    if (next.length < PASSWORD_MIN_LENGTH) errs.newPassword = `Use at least ${PASSWORD_MIN_LENGTH} characters`;
    // BUG-012: same cap as the Staff page and the server (72 characters AND 72 bytes; Nepali letters take 3 bytes each)
    else if (next.length > PASSWORD_MAX_LENGTH || new TextEncoder().encode(next).length > PASSWORD_MAX_LENGTH) {
      errs.newPassword = `Use at most ${PASSWORD_MAX_LENGTH} characters (fewer if you use Nepali letters or emoji)`;
    }
    else if (next === current) errs.newPassword = "Choose a password that is different from the current one";
    if (confirm !== next) errs.confirm = "The two new passwords do not match";
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      setMsg({ ok: false, text: "Please fix the highlighted fields." });
      return;
    }
    setBusy(true);
    // The server checks the bot token only when Supabase Auth CAPTCHA is switched on (SEC-004); sending it is harmless.
    const res = await adminApi.changePassword({ currentPassword: current, newPassword: next, ...(token ? { turnstileToken: token } : {}) });
    setBusy(false);
    if (res.ok) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: "Password changed. You stay signed in here; any other devices are signed out." });
    } else {
      const fe = res.error.fieldErrors ?? {};
      setErrors({
        currentPassword: fe.currentPassword?.join(", "),
        newPassword: fe.newPassword?.join(", "),
      });
      setMsg({ ok: false, text: res.error.message });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
      <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Account</h1>
      <p className="text-ink-muted">
        Signed in as {displayName} ({role}).
      </p>
      <h2 className="font-display text-xl">Change your password</h2>
      <div role="status" aria-live="polite">
        {msg ? <Banner tone={msg.ok ? "success" : "danger"}>{msg.text}</Banner> : null}
      </div>
      <TextField
        label="Current password"
        type="password"
        required
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        error={errors.currentPassword}
      />
      <TextField
        label="New password"
        type="password"
        required
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        hint={`${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters. A short sentence is easy to remember and hard to guess.`}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        error={errors.newPassword}
      />
      <TextField
        label="New password again"
        type="password"
        required
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={errors.confirm}
      />
      <TurnstileSlot onToken={onToken} />
      <Button type="submit" disabled={busy}>
        {busy ? "Saving..." : "Change password"}
      </Button>
    </form>
  );
}

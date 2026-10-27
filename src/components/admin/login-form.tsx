"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { botCheckFailedMessage, LOGIN_TICK_MESSAGE } from "@/components/shop/turnstile-logic";
import { TurnstileSlot, useTurnstileGate } from "@/components/shop/turnstile-slot";
import { adminApi } from "@/data-access/admin";
import { safeNextPath } from "./safe-next";

/** Same wait as checkout: the invisible bot check may still be running when "Sign in" is pressed. */
const TOKEN_WAIT_MS = 10_000;
/** BUG-019: staff get the failure message without the "call us to order" line. */
const FAILED_MESSAGE = botCheckFailedMessage(null);

export function LoginForm() {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A token or "Try again" clears an old bot-check error (not a wrong-password one).
  const clearBotError = useCallback(
    () => setError((e) => (e === FAILED_MESSAGE || e === LOGIN_TICK_MESSAGE ? null : e)),
    [],
  );
  const gate = useTurnstileGate(clearBotError);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // The token is still required before anything is sent; the server verifies it exactly as before.
    const t = await gate.getToken(TOKEN_WAIT_MS);
    if (t.token === null) {
      setBusy(false);
      // "failed": the slot shows the message with "Try again" and has moved focus to it.
      setError(t.reason === "failed" ? FAILED_MESSAGE : LOGIN_TICK_MESSAGE);
      return;
    }
    const res = await adminApi.signIn({ email, password, turnstileToken: t.token });
    setBusy(false);
    if (res.ok) router.replace(next);
    else setError(res.error.message); // generic on purpose: same text for a wrong email or password
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Staff sign in</h1>
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
      <TextField label="Email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      <TextField label="Password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <TurnstileSlot ref={gate.slot} onToken={gate.onToken} onFail={gate.onFail} onRetry={gate.onRetry} />
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  );
}

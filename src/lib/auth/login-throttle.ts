import type { Db } from "@/lib/data/types";
import { AppError, logAppError, toAppError } from "@/lib/errors";
import { securityEvent } from "@/lib/log";
import { hmacHex, LIMITS, recordHit, resetLimit } from "@/lib/ratelimit";

/**
 * Sign-in throttle for signIn and changePassword (SEC-004, reworked for SEC-020).
 *
 * Every ATTEMPT is counted atomically (rate_limit_hit_info) BEFORE the password check, so parallel requests each
 * use up the budget: there is no check-then-record race any more. Two counters:
 *  - strict, per (email + IP bucket): 5 attempts / 15 min, cleared by a successful password check. Someone
 *    guessing from one IP locks only themselves out; the real person on another network can still sign in.
 *  - ceiling, per email whatever the IP: 30 attempts / hour, NOT cleared on success. Caps a guesser spread over
 *    many IPs. Locking a named person out through it takes 30 attempts in an hour, each with a fresh bot-check
 *    token, from at least 2 IPs (each IP is held to 5 by the strict counter and to 10 per 15 min by the IP limit).
 * Keys hold only HMACs (salt, "email:" + lowercased email; the IP hash as everywhere else), so a lock says nothing
 * about whether the account exists. With AUTH_CAPTCHA_ENABLED=true the bot check happens inside the password call,
 * so an attempt with a bad token is counted too (it is already counted when Supabase answers captcha_failed).
 */

export function lockMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many failed sign-in attempts. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
}

export type LoginThrottleKeys = {
  /** `login:email-ip:<hmac(email)>:<ip hash>` (strict, cleared on success). */
  emailIp: string;
  /** `login:email-hour:<hmac(email)>` (ceiling). */
  email: string;
};

export async function loginThrottleKeys(email: string, ipHash: string, salt: string): Promise<LoginThrottleKeys> {
  const e = await hmacHex(salt, "email", email.trim().toLowerCase());
  return { emailIp: `login:email-ip:${e}:${ipHash}`, email: `login:email-hour:${e}` };
}

/**
 * Count one sign-in attempt on both counters, before the password is checked. Throws RATE_LIMITED (message says how
 * long to wait; server actions cannot send Retry-After) when either is used up. Database errors are INTERNAL:
 * sign-in fails closed. The ceiling is not counted for an attempt the strict counter already refused.
 */
export async function countLoginAttempt(db: Db, keys: LoginThrottleKeys, ctx: { requestId?: string; ipHashPrefix?: string } = {}): Promise<void> {
  const strict = await recordHit(db, keys.emailIp, LIMITS.loginEmailIp);
  if (!strict.allowed) {
    securityEvent("login_locked", { requestId: ctx.requestId, scope: "login", kind: "email-ip", ipHashPrefix: ctx.ipHashPrefix });
    throw new AppError("RATE_LIMITED", lockMessage(strict.retry_after_seconds), { retryAfterSeconds: strict.retry_after_seconds });
  }
  const ceiling = await recordHit(db, keys.email, LIMITS.loginEmail);
  if (!ceiling.allowed) {
    securityEvent("login_locked", { requestId: ctx.requestId, scope: "login", kind: "email", ipHashPrefix: ctx.ipHashPrefix });
    throw new AppError("RATE_LIMITED", lockMessage(ceiling.retry_after_seconds), { retryAfterSeconds: ceiling.retry_after_seconds });
  }
}

/** After a correct password: clear the strict (email + IP) counter. Never throws (the sign-in already succeeded). */
export async function clearLoginAttempts(db: Db, keys: LoginThrottleKeys): Promise<void> {
  try {
    await resetLimit(db, keys.emailIp);
  } catch (e) {
    logAppError(toAppError(e));
  }
}

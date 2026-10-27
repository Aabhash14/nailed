import { z } from "zod";

/**
 * Environment validation. Lazy on purpose: `next build` must pass on the empty scaffold
 * with no secrets. Call `serverEnv()` / `publicEnv()` at request time, where the value is needed
 * (`ipSalt()` in deps.ts runs `serverEnv()` on first use, SEC-010).
 * Names match engineering/ops/env.md and .env.example.
 *
 * Telegram and Resend are optional: the notifiers no-op when they are unset (api-contract 3.1, ADR 0001).
 * An empty string counts as unset for every optional variable (a blank line copied from .dev.vars.example).
 */
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
});

/** Decode standard base64 or base64url (padding optional). null when it is not valid base64. */
export function decodeBase64Key(v: string): Uint8Array | null {
  const t = v.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (t.length === 0 || !/^[A-Za-z0-9+/]+$/.test(t) || t.length % 4 === 1) return null;
  try {
    const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A table cookie key: valid base64 of at least 32 bytes. */
function isCookieKey(v: string): boolean {
  const bytes = decodeBase64Key(v);
  return bytes !== null && bytes.length >= 32;
}

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s.optional());

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: optional(z.string().min(1)),
  TELEGRAM_CHAT_ID: optional(z.string().min(1)),
  // SEC-010: 32+ random characters (e.g. `openssl rand -base64 36`), different per environment.
  IP_HASH_SALT: z.string().min(32, "IP_HASH_SALT must be at least 32 characters"),
  RESEND_API_KEY: optional(z.string().min(1)), // only when a verified domain exists
  RESEND_FROM_EMAIL: optional(z.string().min(3)), // e.g. "Nailed Cafe <orders@yourdomain>"
  // "development" (or unset) = a developer machine. staging/production are the deployed Workers (wrangler.jsonc vars):
  // they switch on the mock-build 503 guard and cf-connecting-ip-only client IPs. Any other value fails validation.
  APP_ENV: optional(z.enum(["development", "staging", "production"])),
  // SEC-004: "true" once Supabase Auth > Attack Protection > CAPTCHA (Turnstile) is ON for this project.
  AUTH_CAPTCHA_ENABLED: optional(z.enum(["true", "false"])),
  /*
   * Table ordering guest cookie (api-contract 9.2, SEC-025). A dedicated HMAC key: 32+ random bytes, base64 or
   * base64url (`openssl rand -base64 32`), different per environment. Optional HERE so checkout and login keep
   * working on an environment that has no table ordering yet; the /api/table/* routes answer INTERNAL without it
   * (src/lib/tables/cookie.ts `tableCookieKeysFromEnv`). Key ids are one digit 1..9; the current id signs.
   * The previous key (and its id) is accepted for verification only, during a rotation; devops removes it 12 h later.
   */
  TABLE_COOKIE_KEY: optional(z.string().refine(isCookieKey, "TABLE_COOKIE_KEY must be at least 32 random bytes, base64")),
  TABLE_COOKIE_KEY_ID: optional(z.string().regex(/^[1-9]$/, "TABLE_COOKIE_KEY_ID must be one digit 1..9")),
  TABLE_COOKIE_KEY_PREVIOUS: optional(
    z.string().refine(isCookieKey, "TABLE_COOKIE_KEY_PREVIOUS must be at least 32 random bytes, base64"),
  ),
  TABLE_COOKIE_KEY_PREVIOUS_ID: optional(z.string().regex(/^[1-9]$/, "TABLE_COOKIE_KEY_PREVIOUS_ID must be one digit 1..9")),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

export function publicEnv(source: Record<string, string | undefined> = process.env): PublicEnv {
  return publicSchema.parse(source);
}

export function serverEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  return serverSchema.parse(source);
}

/**
 * Names (never values) of the server variables that fail validation, or [] when all is well.
 * Used to build a log line that says what is misconfigured without echoing a secret.
 */
export function serverEnvProblems(source: Record<string, string | undefined> = process.env): string[] {
  const r = serverSchema.safeParse(source);
  if (r.success) return [];
  return [...new Set(r.error.issues.map((i) => String(i.path[0] ?? "?")))];
}

/** Read one variable; empty string counts as unset. */
export function optionalEnv(name: string, source: Record<string, string | undefined> = process.env) {
  const v = source[name];
  return v && v.trim() !== "" ? v : undefined;
}

/** True when Supabase Auth verifies the Turnstile token itself (captcha at the password endpoint). */
export function authCaptchaEnabled(source: Record<string, string | undefined> = process.env): boolean {
  return optionalEnv("AUTH_CAPTCHA_ENABLED", source) === "true";
}

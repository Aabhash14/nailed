/**
 * BUG-014 follow-up: Supabase Auth codes that mean "the person got something wrong" (or the account is not usable).
 * Anything else (e.g. `email_provider_disabled`, `unexpected_failure`, a missing code, any 5xx) is a server-side
 * problem: still the generic message for the user, but logged at error level so it reaches the internal-error alerts
 * instead of looking like a wrong password.
 */
export const CREDENTIAL_AUTH_CODES = new Set(["invalid_credentials", "user_not_found", "email_not_confirmed", "user_banned"]);

export function isCredentialAuthError(error: { code?: string; status?: number }): boolean {
  if (typeof error.status === "number" && error.status >= 500) return false;
  return typeof error.code === "string" && CREDENTIAL_AUTH_CODES.has(error.code);
}

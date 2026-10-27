import { describe, expect, it } from "vitest";
import { isCredentialAuthError } from "@/lib/auth/auth-errors";
import { serverEnv, serverEnvProblems } from "@/lib/env";
import { storageGuardMessage } from "@/lib/images/storage-errors";
import { refuseMockBuild } from "@/lib/middleware-guards";
import { allowForwardedFallback, clientIp } from "@/lib/ratelimit/ip-hash";

/**
 * Fixes from the first live-mode QA run (engineering/qa/report-2026-10-23-live.md): APP_ENV=development,
 * the Auth error classifier (BUG-014 follow-up) and the Storage guard message mapper. Pure functions, no network.
 */

const base = { SUPABASE_SERVICE_ROLE_KEY: "k", TURNSTILE_SECRET_KEY: "t", IP_HASH_SALT: "x".repeat(32) };

describe("APP_ENV: development is a valid local value (QA live run: it used to make every request INTERNAL)", () => {
  it.each(["development", "staging", "production", "", undefined])("APP_ENV=%s passes server-env validation", (v) => {
    expect(serverEnvProblems({ ...base, APP_ENV: v })).toEqual([]);
  });
  it("unset counts as unset (development), not as a value", () => {
    expect(serverEnv(base).APP_ENV).toBeUndefined();
    expect(serverEnv({ ...base, APP_ENV: "development" }).APP_ENV).toBe("development");
  });
  it("any other value still fails, and only the NAME is reported", () => {
    expect(serverEnvProblems({ ...base, APP_ENV: "prod" })).toEqual(["APP_ENV"]);
    expect(serverEnvProblems({ ...base, APP_ENV: "dev" })).toEqual(["APP_ENV"]);
  });
  it("the mock-build 503 guard fires for staging/production only", () => {
    expect(refuseMockBuild("staging")).toBe(true);
    expect(refuseMockBuild("production")).toBe(true);
    expect(refuseMockBuild("development")).toBe(false);
    expect(refuseMockBuild(undefined)).toBe(false);
    expect(refuseMockBuild("")).toBe(false);
  });
  it("forwarded-header IPs are trusted for development (or unset) outside a production build only (SEC-009 kept)", () => {
    const fwd = new Headers({ "x-forwarded-for": "6.6.6.6" });
    expect(allowForwardedFallback({ NODE_ENV: "development", APP_ENV: "development" })).toBe(true);
    expect(clientIp(fwd, { NODE_ENV: "development", APP_ENV: "development" })).toBe("6.6.6.6");
    expect(allowForwardedFallback({ NODE_ENV: "development" })).toBe(true);
    // a production build never trusts them, whatever APP_ENV says
    expect(allowForwardedFallback({ NODE_ENV: "production", APP_ENV: "development" })).toBe(false);
    expect(clientIp(fwd, { NODE_ENV: "production", APP_ENV: "development" })).toBeNull();
    // deployed environments and unknown values never trust them
    for (const v of ["staging", "production", "prod"]) expect(allowForwardedFallback({ NODE_ENV: "development", APP_ENV: v })).toBe(false);
  });
});

describe("isCredentialAuthError (BUG-014 follow-up)", () => {
  it.each(["invalid_credentials", "user_not_found", "email_not_confirmed", "user_banned"])("%s is a credential error", (code) => {
    expect(isCredentialAuthError({ code, status: 400 })).toBe(true);
  });
  it.each([
    [{ code: "email_provider_disabled", status: 422 }],
    [{ code: "unexpected_failure", status: 500 }],
    [{ code: "invalid_credentials", status: 502 }],
    [{ code: "over_request_rate_limit", status: 429 }],
    [{ status: 0 }],
    [{}],
  ])("%o is not a credential error", (e) => {
    expect(isCredentialAuthError(e)).toBe(false);
  });
});

describe("storageGuardMessage (SEC-018 guard refusals)", () => {
  const msg = "public-media: 480 px image is 41000 bytes, the limit is 40960 bytes";
  it("returns the guard's message for a StorageApiError (400, statusCode 403, code AccessDenied)", () => {
    expect(storageGuardMessage({ name: "StorageApiError", message: msg, status: 400, statusCode: "403", code: "AccessDenied" })).toBe(msg);
  });
  it("also reads a raw upload response body", () => {
    expect(storageGuardMessage({ statusCode: "403", error: "AccessDenied", message: msg })).toBe(msg);
  });
  it("ignores RLS refusals, other errors and non-objects", () => {
    expect(storageGuardMessage({ message: "new row violates row-level security policy", statusCode: "403", code: "AccessDenied" })).toBeNull();
    expect(storageGuardMessage({ message: msg, statusCode: "500" })).toBeNull();
    expect(storageGuardMessage(null)).toBeNull();
    expect(storageGuardMessage("public-media: x")).toBeNull();
  });
  it("caps the message length", () => {
    expect(storageGuardMessage({ message: `public-media: ${"x".repeat(500)}`, code: "AccessDenied" })?.length).toBe(200);
  });
});

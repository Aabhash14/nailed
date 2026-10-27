import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./helpers/memory-db";

// ---- module mocks: no real Supabase, no Next runtime -------------------------------------------------------
type AuthResult = { data: { user: { id: string; email?: string } | null }; error: { code?: string; message?: string; status?: number } | null };
const state = vi.hoisted(() => ({
  user: null as null | { userId: string; role: "owner" | "staff"; displayName: string },
  db: null as unknown,
  session: null as unknown,
  probe: null as unknown,
  turnstile: null as unknown,
  ip: "203.0.113.9",
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "cf-connecting-ip": state.ip }),
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}));
vi.mock("@/lib/data/server-admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/data/public-client", () => ({ createPublicClient: () => state.probe }));
vi.mock("@/lib/auth/server-client", () => ({ createSessionClient: async () => state.session }));
vi.mock("@/lib/deps", () => ({ ipSalt: () => "s".repeat(32), scheduleAfter: () => undefined }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: (...a: unknown[]) => (state.turnstile as (...x: unknown[]) => Promise<void>)(...a) }));
vi.mock("@/lib/auth/require-role", async () => {
  const { AppError } = await import("@/lib/errors");
  const { roleAllows } = await import("@/lib/auth/roles");
  return {
    getCurrentUser: async () => state.user,
    requireRole: async (need: "owner" | "staff") => {
      if (!state.user) throw new AppError("UNAUTHENTICATED");
      if (!roleAllows(state.user.role, need)) throw new AppError("FORBIDDEN");
      return state.user;
    },
  };
});

import { AppError } from "@/lib/errors";
import { changePassword, signIn } from "@/app/admin/_actions/auth";

/**
 * Sign-in throttle (SEC-004, reworked for SEC-020). The rate_limits table is the stateful in-memory stand-in
 * (helpers/memory-db.ts) so counting, locking and clearing behave like the SQL function. No network.
 */

const STAFF = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "staff", displayName: "Staff" } as const;
const EMAIL = "Asha@Example.com";
const PASSWORD = "correct horse battery";
const WRONG: AuthResult = { data: { user: null }, error: { code: "invalid_credentials", message: "Invalid login credentials" } };
const GOOD: AuthResult = { data: { user: { id: STAFF.userId } }, error: null };
const clock = { t: Date.parse("2026-10-23T06:00:10Z") };

function authClient(signInResult: AuthResult, me: AuthResult = { data: { user: { id: STAFF.userId, email: "asha@example.com" } }, error: null }) {
  return {
    auth: {
      signInWithPassword: vi.fn(async (args: unknown) => (void args, signInResult)),
      signOut: vi.fn(async (args?: unknown) => (void args, { error: null })),
      getUser: vi.fn(async () => me),
    },
  };
}

function setup(opts: { signIn?: AuthResult; profile?: boolean } = {}) {
  const m = memoryDb({ now: () => clock.t });
  state.db = m.db;
  state.session = authClient(opts.signIn ?? GOOD);
  state.user = opts.profile === false ? null : STAFF;
  state.turnstile = vi.fn(async () => undefined);
  state.ip = "203.0.113.9";
  return m;
}
const session = () => (state.session as ReturnType<typeof authClient>).auth;
const setPassword = (r: AuthResult) => session().signInWithPassword.mockImplementation(async () => r);
const keys = (m: ReturnType<typeof memoryDb>, prefix: string) =>
  [...new Set(m.tables.rate_limits!.map((r) => String(r.key)).filter((k) => k.startsWith(prefix)))];
const count = (m: ReturnType<typeof memoryDb>, prefix: string) =>
  m.tables.rate_limits!.filter((r) => String(r.key).startsWith(prefix)).reduce((n, r) => n + Number(r.count), 0);
const logs = () =>
  [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls].map((c) => String(c[0]));
const attempt = (password = "wrong") => signIn({ email: EMAIL, password, turnstileToken: "tok" }) as Promise<{ ok: boolean; error?: { code: string; message: string } }>;

beforeEach(() => {
  clock.t = Date.parse("2026-10-23T06:00:10Z");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signIn: attempts are counted BEFORE the password check (SEC-020)", () => {
  it("success: IP limit, Turnstile, both counters, password; the email+IP counter is then cleared; log has no email", async () => {
    const m = setup();
    expect(await attempt(PASSWORD)).toEqual({ ok: true, data: { role: "staff" } });
    expect(m.rpcCalls.map((c) => String(c.args.p_key).split(":")[1])).toEqual(["ip", "email-ip", "email-hour"]);
    expect(m.rpcCalls[1]?.args).toMatchObject({ p_window_seconds: 900, p_max: 5 });
    expect(m.rpcCalls[2]?.args).toMatchObject({ p_window_seconds: 3600, p_max: 30 });
    expect(String(m.rpcCalls[1]?.args.p_key)).toMatch(/^login:email-ip:[0-9a-f]{64}:[0-9a-f]{64}$/);
    expect(String(m.rpcCalls[2]?.args.p_key)).toMatch(/^login:email-hour:[0-9a-f]{64}$/);
    expect(keys(m, "login:email-ip:")).toHaveLength(0); // cleared on success
    expect(count(m, "login:email-hour:")).toBe(1); // the ceiling is not cleared
    expect(state.turnstile).toHaveBeenCalledTimes(1);
    expect(session().signInWithPassword).toHaveBeenCalledWith({ email: "Asha@Example.com", password: PASSWORD });
    expect(logs().some((l) => l.includes('"event":"login_succeeded"'))).toBe(true);
    expect(logs().join("\n")).not.toMatch(/asha@example|correct horse/i);
  });

  it("wrong password: generic UNAUTHENTICATED; the attempt stays counted", async () => {
    const m = setup({ signIn: WRONG });
    const r = await attempt();
    expect(r.error).toMatchObject({ code: "UNAUTHENTICATED", message: "Invalid email or password." });
    expect(count(m, "login:email-ip:")).toBe(1);
    expect(count(m, "login:email-hour:")).toBe(1);
    expect(logs().some((l) => l.includes('"event":"login_failed"'))).toBe(true);
    expect(logs().join("\n")).not.toMatch(/asha@example|wrong/i);
  });

  it("the account key ignores case and spaces, so 'ASHA@example.com ' is the same account", async () => {
    const m = setup({ signIn: WRONG });
    await attempt();
    await signIn({ email: " asha@EXAMPLE.com ", password: "x", turnstileToken: "tok" });
    expect(keys(m, "login:email-ip:")).toHaveLength(1);
    expect(count(m, "login:email-ip:")).toBe(2);
  });

  it("10 PARALLEL wrong-password requests for one email reach the password check at most 5 times", async () => {
    const m = setup({ signIn: WRONG });
    const results = await Promise.all(Array.from({ length: 10 }, () => attempt()));
    expect(session().signInWithPassword.mock.calls.length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.error?.code === "RATE_LIMITED")).toHaveLength(5);
    expect(count(m, "login:email-hour:")).toBe(5); // refused attempts do not burn the ceiling
  });

  it("6th attempt from the same IP is locked before the password check, with how long to wait", async () => {
    setup({ signIn: WRONG });
    for (let i = 0; i < 5; i++) await attempt();
    const r = await attempt(PASSWORD);
    expect(r.error?.code).toBe("RATE_LIMITED");
    expect(r.error?.message).toBe("Too many failed sign-in attempts. Please wait 15 minutes and try again."); // window 06:00-06:15
    expect(session().signInWithPassword).toHaveBeenCalledTimes(5);
    expect(logs().some((l) => l.includes('"event":"login_locked"') && l.includes('"kind":"email-ip"'))).toBe(true);
  });

  it("a successful sign-in clears the counter: 4 typos, success, then 5 more tries before a lock", async () => {
    setup({ signIn: WRONG });
    for (let i = 0; i < 4; i++) await attempt();
    setPassword(GOOD);
    expect((await attempt(PASSWORD)).ok).toBe(true);
    setPassword(WRONG);
    const after: Awaited<ReturnType<typeof attempt>>[] = [];
    for (let i = 0; i < 6; i++) after.push(await attempt());
    expect(after.map((r) => r.error?.code)).toEqual([...Array(5).fill("UNAUTHENTICATED"), "RATE_LIMITED"]);
  });

  it("a lock from IP A does not lock the same email out from IP B", async () => {
    setup({ signIn: WRONG });
    for (let i = 0; i < 5; i++) await attempt();
    expect((await attempt()).error?.code).toBe("RATE_LIMITED");
    state.ip = "198.51.100.20";
    setPassword(GOOD);
    expect(await attempt(PASSWORD)).toEqual({ ok: true, data: { role: "staff" } });
  });

  it("the per-email ceiling (30 / hour) still caps a guesser spread over many IPs", async () => {
    const m = setup({ signIn: WRONG });
    for (let ip = 1; ip <= 6; ip++) {
      state.ip = `198.51.100.${ip}`;
      for (let i = 0; i < 5; i++) expect((await attempt()).error?.code).toBe("UNAUTHENTICATED");
    }
    state.ip = "198.51.100.7";
    const r = await attempt(PASSWORD);
    expect(r.error?.code).toBe("RATE_LIMITED");
    expect(r.error?.message).toBe("Too many failed sign-in attempts. Please wait 60 minutes and try again."); // window 06:00-07:00
    expect(session().signInWithPassword).toHaveBeenCalledTimes(30);
    expect(count(m, "login:email-hour:")).toBe(31);
    expect(logs().some((l) => l.includes('"event":"login_locked"') && l.includes('"kind":"email"'))).toBe(true);
  });

  it("a Supabase user without a cafe profile is signed out; the attempt stays counted", async () => {
    const m = setup({ profile: false });
    expect((await attempt(PASSWORD)).error?.code).toBe("UNAUTHENTICATED");
    expect(session().signOut).toHaveBeenCalled();
    expect(count(m, "login:email-ip:")).toBe(1);
  });

  it("an app-side bot check failure is not counted against the account", async () => {
    const m = setup();
    state.turnstile = vi.fn(async () => {
      throw new AppError("BOT_CHECK_FAILED");
    });
    expect((await attempt(PASSWORD)).error?.code).toBe("BOT_CHECK_FAILED");
    expect(keys(m, "login:email")).toHaveLength(0);
    expect(session().signInWithPassword).not.toHaveBeenCalled();
  });

  it("fails closed: no counter, no password check", async () => {
    setup();
    state.db = memoryDb({ now: () => clock.t, fail: { rpc: true } }).db;
    expect((await attempt(PASSWORD)).error?.code).toBe("INTERNAL");
    expect(session().signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("signIn with Supabase Auth CAPTCHA on (AUTH_CAPTCHA_ENABLED=true)", () => {
  it("passes the Turnstile token to Supabase and does not verify it twice", async () => {
    vi.stubEnv("AUTH_CAPTCHA_ENABLED", "true");
    setup();
    expect((await signIn({ email: EMAIL, password: PASSWORD, turnstileToken: "tok-1" })).ok).toBe(true);
    expect(state.turnstile).not.toHaveBeenCalled();
    expect(session().signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD, options: { captchaToken: "tok-1" } });
  });
  it("captcha_failed from Supabase -> BOT_CHECK_FAILED; the attempt IS counted (the bot check is inside the password call)", async () => {
    vi.stubEnv("AUTH_CAPTCHA_ENABLED", "true");
    const m = setup({ signIn: { data: { user: null }, error: { code: "captcha_failed" } } });
    expect((await attempt(PASSWORD)).error?.code).toBe("BOT_CHECK_FAILED");
    expect(count(m, "login:email-ip:")).toBe(1);
  });
});

describe("signIn: non-credential Supabase Auth errors are logged at error level (BUG-014 follow-up)", () => {
  const errorLines = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
  const fail = (error: NonNullable<AuthResult["error"]>): AuthResult => ({ data: { user: null }, error });

  it.each([
    ["email_provider_disabled (422)", { code: "email_provider_disabled", message: "Email logins are disabled", status: 422 }, "email_provider_disabled"],
    ["unexpected_failure (500)", { code: "unexpected_failure", message: "boom", status: 500 }, "unexpected_failure"],
    ["a 5xx even with a credential-looking code", { code: "invalid_credentials", message: "x", status: 503 }, "invalid_credentials"],
    ["no code at all (network / fetch failure)", { message: "fetch failed", status: 0 }, "no_code"],
  ])("%s: generic UNAUTHENTICATED for the user, error-level internal log with the code", async (_n, error, code) => {
    const m = setup({ signIn: fail(error) });
    const r = await attempt(PASSWORD);
    expect(r.error).toMatchObject({ code: "UNAUTHENTICATED", message: "Invalid email or password." });
    const lines = errorLines();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ level: "error", type: "internal" });
    expect(String(line.detail)).toContain(`auth error code ${code}`);
    expect(String(line.detail)).toContain(`status ${error.status}`);
    // the security event is still written, and the attempt still counts
    expect(logs().some((l) => l.includes('"event":"login_failed"') && l.includes(`"code":"${code}"`))).toBe(true);
    expect(count(m, "login:email-ip:")).toBe(1);
    // no email, password or Supabase message text in any log line
    expect(logs().join(" | ")).not.toMatch(/asha@example|correct horse|Email logins are disabled|boom|fetch failed/i);
  });

  it.each(["invalid_credentials", "user_not_found", "email_not_confirmed", "user_banned"])(
    "%s (400) is a credential failure: warn-level security event only, nothing at error level",
    async (code) => {
      setup({ signIn: fail({ code, message: "x", status: 400 }) });
      expect((await attempt()).error).toMatchObject({ code: "UNAUTHENTICATED", message: "Invalid email or password." });
      expect(errorLines()).toHaveLength(0);
      expect(logs().some((l) => l.includes('"event":"login_failed"') && l.includes(`"code":"${code}"`))).toBe(true);
    },
  );

  it("captcha_failed keeps its own BOT_CHECK_FAILED path and is not logged as internal", async () => {
    vi.stubEnv("AUTH_CAPTCHA_ENABLED", "true");
    setup({ signIn: fail({ code: "captcha_failed", status: 400 }) });
    expect((await attempt(PASSWORD)).error?.code).toBe("BOT_CHECK_FAILED");
    expect(errorLines()).toHaveLength(0);
  });
});

describe("changePassword (SEC-004, SEC-020)", () => {
  function setupChange(probeResult: AuthResult, opts: { updateError?: { code: string } } = {}) {
    const m = setup();
    const updateUserById = vi.fn(async (id: string, attrs: unknown) => (void id, void attrs, { data: {}, error: opts.updateError ?? null }));
    (m.db as unknown as { auth: unknown }).auth = { admin: { updateUserById } };
    state.probe = authClient(probeResult);
    return { m, updateUserById, probe: (state.probe as ReturnType<typeof authClient>).auth };
  }
  const change = (input: Record<string, unknown> = {}) =>
    changePassword({ currentPassword: "old-password-1", newPassword: "a-brand-new-password", ...input }) as Promise<{
      ok: boolean;
      error?: { code: string; fieldErrors?: Record<string, string[]> };
    }>;

  it("needs a signed-in user and a new password of 12+ characters, different from the current one", async () => {
    setupChange(GOOD);
    state.user = null;
    expect((await change()).error?.code).toBe("UNAUTHENTICATED");
    state.user = STAFF;
    const short = await change({ newPassword: "short" });
    expect(short.error?.code).toBe("VALIDATION");
    expect(short.error?.fieldErrors).toHaveProperty("newPassword");
    expect((await change({ currentPassword: "same-password-1", newPassword: "same-password-1" })).error?.code).toBe("VALIDATION");
    expect((await change({ currentPassword: "x", newPassword: "é".repeat(40) })).error?.code).toBe("VALIDATION"); // 80 bytes > 72
  });

  it("wrong current password -> VALIDATION on currentPassword, counted before the re-check, nothing updated", async () => {
    const { m, updateUserById } = setupChange(WRONG);
    const r = await change({ currentPassword: "nope" });
    expect(r.error?.code).toBe("VALIDATION");
    expect(r.error?.fieldErrors).toHaveProperty("currentPassword");
    expect(count(m, "login:email-ip:")).toBe(1);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("success: updates the SESSION user's password (never an id from input), clears the counter, signs out other sessions", async () => {
    const { m, updateUserById, probe } = setupChange(GOOD);
    expect(await change({ userId: "someone-else" })).toEqual({ ok: true, data: null });
    expect(probe.signInWithPassword).toHaveBeenCalledWith({ email: "asha@example.com", password: "old-password-1" });
    expect(probe.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(updateUserById).toHaveBeenCalledWith(STAFF.userId, { password: "a-brand-new-password" });
    expect(session().signOut).toHaveBeenCalledWith({ scope: "others" });
    expect(keys(m, "login:email-ip:")).toHaveLength(0);
    expect(logs().join("\n")).not.toMatch(/old-password|brand-new/);
  });

  it("shares the sign-in counter: after 5 failed sign-ins from this IP it is locked too", async () => {
    const { probe, updateUserById } = setupChange(GOOD);
    setPassword(WRONG);
    for (let i = 0; i < 5; i++) await signIn({ email: "asha@example.com", password: "x", turnstileToken: "tok" });
    expect((await change()).error?.code).toBe("RATE_LIMITED");
    expect(probe.signInWithPassword).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("a weak password rejected by Supabase Auth is VALIDATION on newPassword", async () => {
    setupChange(GOOD, { updateError: { code: "weak_password" } });
    const r = await change({ newPassword: "aaaaaaaaaaaa" });
    expect(r.error?.code).toBe("VALIDATION");
    expect(r.error?.fieldErrors).toHaveProperty("newPassword");
  });

  it("with Auth CAPTCHA on, a Turnstile token is required and passed through", async () => {
    vi.stubEnv("AUTH_CAPTCHA_ENABLED", "true");
    const { probe } = setupChange(GOOD);
    expect((await change()).error?.code).toBe("VALIDATION");
    expect((await change({ turnstileToken: "t" })).ok).toBe(true);
    expect(probe.signInWithPassword).toHaveBeenCalledWith({ email: "asha@example.com", password: "old-password-1", options: { captchaToken: "t" } });
  });
});

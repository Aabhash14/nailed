"use server";

import { headers } from "next/headers";
import { runAction } from "@/lib/actions";
import { isCredentialAuthError } from "@/lib/auth/auth-errors";
import { clearLoginAttempts, countLoginAttempt, loginThrottleKeys } from "@/lib/auth/login-throttle";
import { createSessionClient } from "@/lib/auth/server-client";
import { getCurrentUser, requireRole } from "@/lib/auth/require-role";
import { createPublicClient } from "@/lib/data/public-client";
import { createAdminClient } from "@/lib/data/server-admin";
import { ipSalt } from "@/lib/deps";
import { authCaptchaEnabled } from "@/lib/env";
import { AppError, logAppError } from "@/lib/errors";
import { securityEvent } from "@/lib/log";
import { clientIp, enforceLimit, ipKey, LIMITS } from "@/lib/ratelimit";
import { verifyTurnstile } from "@/lib/turnstile";
import { changePasswordSchema, inviteStaffSchema, signInSchema } from "@/lib/validation/admin";
import { parseInput } from "@/lib/validation/common";
import type { Role } from "@/types/db";

const BAD_LOGIN = "Invalid email or password.";

/**
 * Public. Order: IP limit (10 / 15 min / IP) -> bot check (app-side Turnstile, when Supabase does not check it) ->
 * COUNT the attempt (SEC-020: 5 / 15 min per email + IP, 30 / hour per email; atomic, before the password) ->
 * password -> profile. A correct password clears the email + IP counter. Same message for every credential failure.
 * Bot check: our own Turnstile verify, OR (AUTH_CAPTCHA_ENABLED=true) the token is passed to Supabase Auth,
 * which verifies it at the password endpoint itself, so calling Supabase directly no longer skips it.
 * A Turnstile token is single-use, so exactly one of the two verifies it.
 */
export async function signIn(input: unknown) {
  return runAction(async (): Promise<{ role: Role }> => {
    const data = parseInput(signInSchema, input);
    const h = await headers();
    const salt = ipSalt();
    const admin = createAdminClient();
    const ipk = await ipKey("login", h, salt);
    await enforceLimit(admin, ipk.key, LIMITS.loginIp);

    const captchaAtAuth = authCaptchaEnabled();
    if (!captchaAtAuth) {
      try {
        await verifyTurnstile(data.turnstileToken, clientIp(h));
      } catch (e) {
        if (e instanceof AppError && e.code === "BOT_CHECK_FAILED") securityEvent("login_bot_check_failed", { ipHashPrefix: ipk.hash });
        throw e;
      }
    }

    // SEC-020: counted BEFORE the password check, so parallel requests cannot all pass a lock check first.
    const throttle = await loginThrottleKeys(data.email, ipk.hash, salt);
    await countLoginAttempt(admin, throttle, { ipHashPrefix: ipk.hash });

    const supabase = await createSessionClient();
    const { data: auth, error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
      ...(captchaAtAuth ? { options: { captchaToken: data.turnstileToken } } : {}),
    });
    if (error?.code === "captcha_failed") {
      securityEvent("login_bot_check_failed", { ipHashPrefix: ipk.hash });
      throw new AppError("BOT_CHECK_FAILED");
    }
    if (error || !auth.user) {
      const code = error ? (error.code ?? "no_code") : "no_user";
      securityEvent("login_failed", { ipHashPrefix: ipk.hash, code });
      if (error && !isCredentialAuthError(error)) {
        logAppError(
          new AppError("INTERNAL", undefined, {
            logDetail: `signInWithPassword: auth error code ${code}, status ${error.status ?? "?"}`.slice(0, 200),
          }),
        );
      }
      throw new AppError("UNAUTHENTICATED", BAD_LOGIN);
    }

    // Signed in to Supabase Auth is not enough: the person must have a cafe profile (role).
    const user = await getCurrentUser();
    if (!user) {
      await supabase.auth.signOut();
      securityEvent("login_failed", { ipHashPrefix: ipk.hash, code: "no_profile" });
      throw new AppError("UNAUTHENTICATED", BAD_LOGIN);
    }
    await clearLoginAttempts(admin, throttle);
    securityEvent("login_succeeded", { userId: user.userId, role: user.role, ipHashPrefix: ipk.hash });
    return { role: user.role };
  });
}

export async function signOut() {
  return runAction(async (): Promise<null> => {
    await requireRole("staff");
    const supabase = await createSessionClient();
    await supabase.auth.signOut();
    return null;
  });
}

/** Read helper for layouts/pages: who am I (role comes from profiles). Not in the contract table. */
export async function getSession() {
  return runAction(async () => {
    const user = await getCurrentUser();
    if (!user) throw new AppError("UNAUTHENTICATED");
    return { role: user.role, displayName: user.displayName };
  });
}

/** Owner only. Creates the auth user with an owner-set temporary password (no invite email) and the staff profile. */
export async function inviteStaff(input: unknown) {
  return runAction(async (): Promise<{ userId: string }> => {
    const owner = await requireRole("owner");
    const data = parseInput(inviteStaffSchema, input);
    const admin = createAdminClient();
    const created = await admin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      const msg = created.error?.message ?? "";
      if (/already|registered|exists/i.test(msg)) throw new AppError("CONFLICT", "That email already has an account.");
      throw new AppError("INTERNAL", undefined, { logDetail: `createUser: ${msg}`.slice(0, 200) });
    }
    const userId = created.data.user.id;
    const { error } = await admin
      .from("profiles")
      .insert({ id: userId, role: "staff", display_name: data.displayName });
    if (error) {
      await admin.auth.admin.deleteUser(userId); // do not leave a user without a profile
      throw new AppError("INTERNAL", undefined, { logDetail: `profile insert: ${error.code}` });
    }
    securityEvent("staff_invited", { userId: owner.userId, targetUserId: userId });
    return { userId };
  });
}

/**
 * Owner or staff: change YOUR OWN password (SEC-004). The current password is re-checked on a throwaway
 * client (the cookie session is untouched). Each re-check is counted on the same sign-in throttle as signIn
 * BEFORE it runs (SEC-020), so this cannot be used to guess the password faster than the login form. The user id
 * comes from the verified session, never from input. Other sessions of the account are signed out afterwards.
 */
export async function changePassword(input: unknown) {
  return runAction(async (): Promise<null> => {
    const user = await requireRole("staff");
    const data = parseInput(changePasswordSchema, input);
    const captchaAtAuth = authCaptchaEnabled();
    if (captchaAtAuth && !data.turnstileToken) {
      throw new AppError("VALIDATION", undefined, { fieldErrors: { turnstileToken: ["Complete the bot check"] } });
    }

    const session = await createSessionClient();
    const { data: me, error: meError } = await session.auth.getUser();
    const authUser = me?.user;
    if (meError || !authUser?.email || authUser.id !== user.userId) throw new AppError("UNAUTHENTICATED");
    const email = authUser.email;

    const salt = ipSalt();
    const admin = createAdminClient();
    const ipk = await ipKey("login", await headers(), salt);
    const throttle = await loginThrottleKeys(email, ipk.hash, salt);
    await countLoginAttempt(admin, throttle, { ipHashPrefix: ipk.hash }); // SEC-020: before the re-check

    const probe = createPublicClient();
    const check = await probe.auth.signInWithPassword({
      email,
      password: data.currentPassword,
      ...(captchaAtAuth ? { options: { captchaToken: data.turnstileToken } } : {}),
    });
    if (check.error?.code === "captcha_failed") throw new AppError("BOT_CHECK_FAILED");
    if (check.error || !check.data.user || check.data.user.id !== user.userId) {
      securityEvent("password_change_failed", { userId: user.userId, code: "wrong_current_password" });
      throw new AppError("VALIDATION", undefined, { fieldErrors: { currentPassword: ["The current password is not correct"] } });
    }
    await clearLoginAttempts(admin, throttle);
    await probe.auth.signOut({ scope: "local" }).catch(() => undefined); // drop the throwaway session

    const upd = await admin.auth.admin.updateUserById(user.userId, { password: data.newPassword });
    if (upd.error) {
      const code = upd.error.code ?? "";
      if (code === "weak_password" || code === "same_password" || code === "validation_failed") {
        throw new AppError("VALIDATION", undefined, { fieldErrors: { newPassword: ["Choose a longer or less common password"] } });
      }
      throw new AppError("INTERNAL", undefined, { logDetail: `updateUserById: ${code || upd.error.status || "?"}` });
    }
    await session.auth.signOut({ scope: "others" }).catch(() => undefined);
    securityEvent("password_changed", { userId: user.userId });
    return null;
  });
}

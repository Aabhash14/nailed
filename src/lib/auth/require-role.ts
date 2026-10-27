import "server-only";
import { AppError } from "@/lib/errors";
import { createAdminClient } from "@/lib/data/server-admin";
import type { Db } from "@/lib/data/types";
import { securityEvent } from "@/lib/log";
import type { ProfileRow } from "@/types/db";
import { createSessionClient } from "./server-client";
import { roleAllows, type AuthContext, type RoleRequirement } from "./roles";

export type { AuthContext, RoleRequirement } from "./roles";

type Deps = {
  /** Returns the verified user id from the session cookie, or null. Must validate the JWT with Supabase (getUser). */
  getUserId: () => Promise<string | null>;
  admin: () => Db;
};

async function defaultUserId(): Promise<string | null> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.getUser(); // verifies the token server-side, not just decodes it
  if (error || !data.user) return null;
  return data.user.id;
}

/**
 * Current user + role, or null. Role is read from `profiles.role` with the service client:
 * never from the client, never from JWT claims the user could influence.
 * Pages/layouts may call this to render; it grants nothing by itself.
 */
export async function getCurrentUser(deps: Partial<Deps> = {}): Promise<AuthContext | null> {
  const userId = await (deps.getUserId ?? defaultUserId)();
  if (!userId) return null;
  const { data, error } = await (deps.admin ?? createAdminClient)()
    .from("profiles")
    .select("id, role, display_name")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new AppError("INTERNAL", undefined, { logDetail: `profiles lookup: ${error.code}` });
  const p = data as Pick<ProfileRow, "id" | "role" | "display_name"> | null;
  if (!p) return null; // authenticated in Supabase Auth but not a cafe user: treated as no access
  return { userId: p.id, role: p.role, displayName: p.display_name };
}

/**
 * First line of every admin action and mutation. UNAUTHENTICATED when there is no valid session or no
 * profile, FORBIDDEN when the role is too low.
 */
export async function requireRole(need: RoleRequirement, deps: Partial<Deps> = {}): Promise<AuthContext> {
  const user = await getCurrentUser(deps);
  if (!user) throw new AppError("UNAUTHENTICATED");
  if (!roleAllows(user.role, need)) {
    securityEvent("forbidden", { userId: user.userId, role: user.role, need }); // SEC-013: staff probing owner actions
    throw new AppError("FORBIDDEN");
  }
  return user;
}

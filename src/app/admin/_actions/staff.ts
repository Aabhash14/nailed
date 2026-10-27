"use server";

import { runAction } from "@/lib/actions";
import { requireRole } from "@/lib/auth/require-role";
import { unwrap } from "@/lib/data/db-errors";
import { createAdminClient } from "@/lib/data/server-admin";
import { AppError } from "@/lib/errors";
import { securityEvent } from "@/lib/log";
import { deactivateStaffSchema } from "@/lib/validation/admin";
import { parseInput } from "@/lib/validation/common";
import type { ProfileRow, Role } from "@/types/db";

/** Staff management (SEC-004: offboarding used to need the Supabase dashboard). Owner only. */

export type StaffMember = {
  userId: string;
  displayName: string;
  role: Role;
  email: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  isSelf: boolean;
  /** Always true: deactivated staff are deleted, so they are not listed. Kept for the frontend shape. */
  isActive: true;
};

/** Owner only. Everyone with a cafe profile (owner and staff), oldest first. */
export async function listStaff() {
  return runAction(async (): Promise<{ rows: StaffMember[] }> => {
    const me = await requireRole("owner");
    const admin = createAdminClient();
    const profiles = (unwrap(
      await admin.from("profiles").select("id, role, display_name, created_at").order("created_at", { ascending: true }),
    ) ?? []) as Pick<ProfileRow, "id" | "role" | "display_name" | "created_at">[];

    const users = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (users.error) throw new AppError("INTERNAL", undefined, { logDetail: `listUsers: ${users.error.code ?? users.error.status ?? "?"}` });
    const byId = new Map(users.data.users.map((u) => [u.id, u]));

    return {
      rows: profiles.map((p) => {
        const u = byId.get(p.id);
        return {
          userId: p.id,
          displayName: p.display_name,
          role: p.role,
          email: u?.email ?? null,
          createdAt: p.created_at,
          lastSignInAt: u?.last_sign_in_at ?? null,
          isSelf: p.id === me.userId,
          isActive: true as const,
        };
      }),
    };
  });
}

/**
 * Owner only. Removes a STAFF member's access for good: deletes the Supabase auth user, which cascades to
 * the profile (blocked_contacts.created_by becomes null) and revokes all their sessions; their next request
 * fails requireRole because getUser() no longer finds them. The owner cannot deactivate themselves, and
 * owner accounts are not removable here. To restore access, invite the person again.
 */
export async function deactivateStaff(input: unknown) {
  return runAction(async (): Promise<null> => {
    const me = await requireRole("owner");
    const { userId } = parseInput(deactivateStaffSchema, input);
    if (userId === me.userId) throw new AppError("CONFLICT", "You cannot deactivate your own account.");

    const admin = createAdminClient();
    const target = unwrap(await admin.from("profiles").select("id, role").eq("id", userId).maybeSingle()) as Pick<
      ProfileRow,
      "id" | "role"
    > | null;
    if (!target) throw new AppError("NOT_FOUND");
    if (target.role !== "staff") throw new AppError("CONFLICT", "Owner accounts cannot be deactivated here.");

    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new AppError("INTERNAL", undefined, { logDetail: `deleteUser: ${error.code ?? error.status ?? "?"}` });
    securityEvent("staff_deactivated", { userId: me.userId, targetUserId: userId });
    return null;
  });
}

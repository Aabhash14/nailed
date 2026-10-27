import type { Role } from "@/types/db";

export type AuthContext = { userId: string; role: Role; displayName: string };

/** "owner" = O in the contract tables, "staff" = S (owner or staff). */
export type RoleRequirement = "owner" | "staff";

export function roleAllows(role: Role | null | undefined, need: RoleRequirement): boolean {
  if (!role) return false;
  return need === "staff" ? role === "owner" || role === "staff" : role === "owner";
}

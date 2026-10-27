"use server";

import { runAction } from "@/lib/actions";
import { requireRole } from "@/lib/auth/require-role";
import { mapRpcError, unwrap } from "@/lib/data/db-errors";
import { createAdminClient } from "@/lib/data/server-admin";
import { AppError } from "@/lib/errors";
import { securityEvent } from "@/lib/log";
import { normalizeNepalPhone } from "@/lib/phone";
import { blockContactSchema, listBlockedSchema, unblockContactSchema } from "@/lib/validation/admin";
import { parseInput } from "@/lib/validation/common";
import type { BlockedContactRow } from "@/types/db";

export type BlockedContact = {
  id: string;
  kind: "phone" | "ip_hash";
  value: string;
  reason: string | null;
  createdBy: string;
  createdAt: string;
};

const toDto = (r: BlockedContactRow): BlockedContact => ({
  id: r.id,
  kind: r.kind,
  value: r.value,
  reason: r.reason,
  createdBy: r.created_by ?? "",
  createdAt: r.created_at,
});

/** Owner or staff. Only non-expired entries. */
export async function listBlockedContacts(input: unknown) {
  return runAction(async (): Promise<{ rows: BlockedContact[]; total: number }> => {
    await requireRole("staff");
    const f = parseInput(listBlockedSchema, input ?? {});
    const page = f.page ?? 1;
    const pageSize = f.pageSize ?? 25;
    const res = await createAdminClient()
      .from("blocked_contacts")
      .select("*", { count: "exact" })
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (res.error) throw new AppError("INTERNAL", undefined, { logDetail: `listBlocked: ${res.error.code}` });
    const rows = (res.data ?? []) as BlockedContactRow[];
    return { rows: rows.map(toDto), total: res.count ?? rows.length };
  });
}

/**
 * Owner or staff. A phone is normalised. An ip_hash is accepted only if it already exists on an order
 * (it is never typed in by a person; the UI offers "block this order's IP").
 */
export async function blockContact(input: unknown) {
  return runAction(async (): Promise<BlockedContact> => {
    const user = await requireRole("staff");
    const data = parseInput(blockContactSchema, input);
    const db = createAdminClient();
    const value = data.kind === "phone" ? (normalizeNepalPhone(data.value) as string) : data.value;

    if (data.kind === "ip_hash") {
      const seen = unwrap(await db.from("orders").select("id").eq("ip_hash", value).limit(1));
      if (!Array.isArray(seen) || seen.length === 0) {
        throw new AppError("VALIDATION", undefined, { fieldErrors: { value: ["Invalid contact"] } });
      }
    }

    // Insert-or-nothing in the database (SEC-008, migration 20261021000003): a live entry is returned unchanged,
    // so staff cannot shorten or rewrite an existing block. Expiry = now + order_rules.blocklist_months.
    const res = await db.rpc("block_contact", {
      p_kind: data.kind,
      p_value: value,
      p_reason: data.reason || null,
      p_actor: user.userId,
    });
    if (res.error) throw mapRpcError(res.error);
    const out = (Array.isArray(res.data) ? res.data[0] : res.data) as { out_id: string; out_created: boolean } | undefined;
    if (!out?.out_id) throw new AppError("INTERNAL", undefined, { logDetail: "block_contact returned no row" });

    const row = unwrap(await db.from("blocked_contacts").select("*").eq("id", out.out_id).maybeSingle()) as BlockedContactRow | null;
    if (!row) throw new AppError("INTERNAL", undefined, { logDetail: "blocked contact row missing after block_contact" });
    if (out.out_created) {
      securityEvent("blocklist_added", {
        userId: user.userId,
        kind: data.kind,
        ipHashPrefix: data.kind === "ip_hash" ? value : undefined,
      });
    }
    return toDto(row);
  });
}

/** Owner only: staff can add but never remove. */
export async function unblockContact(input: unknown) {
  return runAction(async (): Promise<null> => {
    const user = await requireRole("owner");
    const { id } = parseInput(unblockContactSchema, input);
    const rows = unwrap(await createAdminClient().from("blocked_contacts").delete().eq("id", id).select("id, kind"));
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError("NOT_FOUND");
    securityEvent("blocklist_removed", { userId: user.userId, kind: (rows[0] as { kind?: string }).kind });
    return null;
  });
}

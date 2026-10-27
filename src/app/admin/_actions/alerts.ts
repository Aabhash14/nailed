"use server";

import { runAction } from "@/lib/actions";
import { requireRole } from "@/lib/auth/require-role";
import { unwrap } from "@/lib/data/db-errors";
import { createAdminClient } from "@/lib/data/server-admin";
import type { Db } from "@/lib/data/types";
import { AppError } from "@/lib/errors";
import { securityEvent } from "@/lib/log";
import { enabledChannels } from "@/lib/notify/notifier";
import { ALERT_COLUMNS, deliveryFor, toAdminAlert, type DeliveryRowLite } from "@/lib/tables/alerts";
import type { AdminAlert } from "@/lib/tables/types";
import { listAlertsSchema, markAlertsReadSchema } from "@/lib/tables/validation";
import { parseInput } from "@/lib/validation/common";
import type { AdminAlertRow } from "@/types/db";

/**
 * Owner alerts (api-contract 2.3.0 section 9.10): the in-app Alerts view is the v1 delivery. All three actions are
 * OWNER only (staff get FORBIDDEN from requireRole). Reads are plain service-role selects of admin_alerts after
 * requireRole("owner") (data-model decision 22); marking read goes through mark_admin_alerts_read (owner re-checked
 * in the database). `delivery` is `[]` while no channel is enabled (v1), and then no delivery rows are read.
 */

async function countUnread(db: Db): Promise<number> {
  const res = await db.from("admin_alerts").select("id", { count: "exact", head: true }).is("read_at", null);
  unwrap(res);
  if (typeof res.count !== "number") throw new AppError("INTERNAL", undefined, { logDetail: "admin_alerts: no count" });
  return res.count;
}

/** O. Newest first. `{ unreadOnly?, page? (1..1000), pageSize? (1..100, default 25) }`. */
export async function listAlerts(input?: unknown) {
  return runAction(async (): Promise<{ rows: AdminAlert[]; total: number; unread: number }> => {
    await requireRole("owner");
    const f = parseInput(listAlertsSchema, input ?? {});
    const page = f.page ?? 1;
    const pageSize = f.pageSize ?? 25;
    const db = createAdminClient();

    let q = db.from("admin_alerts").select(ALERT_COLUMNS, { count: "exact" });
    if (f.unreadOnly) q = q.is("read_at", null);
    const [res, unread] = await Promise.all([
      q
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1),
      countUnread(db),
    ]);
    unwrap(res);
    const rows = (res.data ?? []) as unknown as AdminAlertRow[];

    // readByName: display names only (never an email), one query for the page.
    const readers = [...new Set(rows.map((r) => r.read_by).filter((v): v is string => typeof v === "string"))];
    const names = new Map<string, string>();
    if (readers.length > 0) {
      const p = await db.from("profiles").select("id, display_name").in("id", readers);
      unwrap(p);
      for (const r of (p.data ?? []) as { id: string; display_name: string }[]) names.set(r.id, r.display_name);
    }

    const channels = enabledChannels().map((c) => c.channel);
    let deliveries: DeliveryRowLite[] = [];
    if (channels.length > 0 && rows.length > 0) {
      const d = await db
        .from("alert_deliveries")
        .select("alert_id, channel, status, attempts")
        .in(
          "alert_id",
          rows.map((r) => r.id),
        );
      unwrap(d);
      deliveries = (d.data ?? []) as DeliveryRowLite[];
    }
    const now = Date.now();
    const out = rows
      .map((r) => toAdminAlert(r, names, deliveryFor(r.id, r.created_at, channels, deliveries, now)))
      .filter((a): a is AdminAlert => a !== null);
    return { rows: out, total: res.count ?? out.length, unread };
  });
}

/** O. `{ ids: Uuid[] (1..100) }` or `{ all: true }`. Returns the unread count left. */
export async function markAlertsRead(input: unknown) {
  return runAction(async (): Promise<{ unread: number }> => {
    const me = await requireRole("owner");
    const d = parseInput(markAlertsReadSchema, input);
    try {
      const data: unknown = unwrap(
        await createAdminClient().rpc("mark_admin_alerts_read", {
          p_ids: d.all ? null : (d.ids ?? null),
          p_all: d.all === true,
          p_actor: me.userId,
        }),
      );
      const unread = typeof data === "number" ? data : Number(data);
      if (!Number.isInteger(unread) || unread < 0) {
        throw new AppError("INTERNAL", undefined, { logDetail: "mark_admin_alerts_read: unexpected result" });
      }
      return { unread };
    } catch (e) {
      if (e instanceof AppError && e.code === "FORBIDDEN") {
        securityEvent("forbidden", { userId: me.userId, role: me.role, scope: "tables", code: "db", reason: "alerts" });
      }
      throw e;
    }
  });
}

/** O. Unread count for the owner's admin nav (staff get FORBIDDEN; the layout calls it for owners only). */
export async function getAlertCount() {
  return runAction(async (): Promise<{ unread: number }> => {
    await requireRole("owner");
    return { unread: await countUnread(createAdminClient()) };
  });
}

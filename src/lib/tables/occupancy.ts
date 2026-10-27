import type { Db } from "@/lib/data/types";
import type { TableOccupancyRow } from "@/types/db";
import type { TableOccupancy } from "./types";

/**
 * Public occupancy for GET /api/menu (api-contract 2 and 9.1, threat model B6). Reads the view `table_occupancy`
 * (service role only; exactly number, label, occupied) with an explicit column list: never table_sessions, never a
 * code. Returns null on any failure (the menu must not fail because of it) and logs `table_occupancy_failed`.
 */
export const OCCUPANCY_COLUMNS = "number, label, occupied";

export async function readTableOccupancy(db: Db): Promise<TableOccupancy | null> {
  try {
    const { data, error } = await db.from("table_occupancy").select(OCCUPANCY_COLUMNS).order("number");
    if (error) throw new Error(String(error.code ?? "?"));
    const tables = ((data ?? []) as TableOccupancyRow[])
      .filter((r) => Number.isInteger(r.number))
      .map((r) => ({
        number: r.number,
        label: typeof r.label === "string" && r.label !== "" ? r.label : null,
        occupied: r.occupied === true,
      }));
    return { total: tables.length, free: tables.filter((t) => !t.occupied).length, tables };
  } catch (e) {
    console.error(
      JSON.stringify({ level: "error", event: "table_occupancy_failed", code: (e instanceof Error ? e.message : "?").slice(0, 16) }),
    );
    return null;
  }
}

import { AppError } from "@/lib/errors";

/** The database's text for "this number belongs to a deactivated table with history" (save_cafe_tables). */
export const DB_INACTIVE_NUMBER_TEXT =
  "An old table with order history uses this number. Keep that table in the list, or pick another number.";

/** 2.3.0 (9.7): VALIDATION `tables.N.number` "Table <n> is still on file as inactive. Turn it back on instead." */
export function inactiveNumberMessage(n: number): string {
  return `Table ${n} is still on file as inactive. Turn it back on instead.`;
}

/**
 * saveCafeTables: replace the database's wording of the "inactive table with history" error by the contract text
 * (2.3.0), using the number the owner typed in row N. Every other error passes through unchanged.
 */
export function rewordSaveTablesError(e: unknown, numbers: readonly number[]): unknown {
  if (!(e instanceof AppError) || e.code !== "VALIDATION" || !e.fieldErrors) return e;
  let changed = false;
  const out: Record<string, string[]> = {};
  for (const [key, msgs] of Object.entries(e.fieldErrors)) {
    const m = /^tables\.(\d+)\.number$/.exec(key);
    const n = m ? numbers[Number(m[1])] : undefined;
    out[key] =
      n === undefined
        ? msgs
        : msgs.map((x) => {
            if (x !== DB_INACTIVE_NUMBER_TEXT) return x;
            changed = true;
            return inactiveNumberMessage(n);
          });
  }
  return changed ? new AppError("VALIDATION", e.message, { fieldErrors: out }) : e;
}

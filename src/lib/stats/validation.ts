import { z } from "zod";
import { uuid } from "@/lib/validation/common";
import type { IsoDate } from "@/types/db";
import {
  daysInclusive,
  defaultGrain,
  isIsoDate,
  previousRange,
  STATS_MAX_RANGE_DAYS,
  type DateRange,
} from "./dates";
import type { ResolvedStatsRange } from "./types";

/**
 * Zod schemas for the statistics and daily-sales actions (api-contract 1.5.0). Field paths match the database's
 * VALIDATION keys (`date`, `range`, `compare.range`, `lines`, `lines.N`, ...) so the form shows one set of keys,
 * whichever side refused. Unknown keys are stripped: a price sent with a line is ignored (the DB snapshots prices).
 */

export const MSG = {
  date: "Use a date in the form YYYY-MM-DD.",
  rangeOrder: "The start date must be on or before the end date.",
  rangeTooLong: `Pick a range of at most ${STATS_MAX_RANGE_DAYS.toLocaleString("en-US")} days (about 3 years).`,
  qty: "Enter a whole number from 0 to 9999.",
  tillTotal: "Enter a whole amount from 0 to 1,000,000,000 paisa (Rs. 1,00,00,000).",
  note: "Keep the note to 500 characters or fewer.",
  lines: "Send at most 500 lines.",
  duplicate: "The same item and variant appears more than once.",
  future: "This date is in the future.",
  tooOld: "This date is too far in the past.",
  staffLog: "Staff can log today and yesterday only. Ask the owner to change older days.",
  staffRead: "Staff can see today and yesterday only.",
} as const;

export const TILL_TOTAL_MAX_PAISA = 1_000_000_000;
export const LINE_QTY_MAX = 9999;
export const LINES_MAX = 500;
export const NOTE_MAX_CHARS = 500;
/** Rows per top-food / top-merch list in the bundle. */
export const STATS_TOP_LIMIT = 10;
/** Note the seed puts on its made-up daily logs (supabase/seed.sql). Counted case-insensitively in `range.demoDataDays`. */
export const DEMO_DATA_NOTE = "DEMO DATA";

export const isoDate = z.string().refine((v) => isIsoDate(v), MSG.date);

function checkRange(
  ctx: z.RefinementCtx,
  from: IsoDate,
  to: IsoDate,
  path: (string | number)[],
): void {
  if (!isIsoDate(from) || !isIsoDate(to)) return; // the field issue is already reported
  const n = daysInclusive(from, to);
  if (n < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: MSG.rangeOrder });
  else if (n > STATS_MAX_RANGE_DAYS)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: MSG.rangeTooLong });
}

// ---- daily sales ----------------------------------------------------------------------------------------------

export const getDailySalesSchema = z.object({ date: isoDate });

const lineSchema = z.object({
  menuItemId: uuid,
  variantId: uuid.nullable().optional(),
  qty: z
    .number({ invalid_type_error: MSG.qty, required_error: MSG.qty })
    .int(MSG.qty)
    .min(0, MSG.qty)
    .max(LINE_QTY_MAX, MSG.qty),
});

/** Characters as Postgres counts them (code points), not UTF-16 units. */
const charCount = (s: string) => [...s].length;

export const logDailySalesSchema = z
  .object({
    date: isoDate,
    lines: z.array(lineSchema).max(LINES_MAX, MSG.lines),
    tillTotalPaisa: z
      .number({ invalid_type_error: MSG.tillTotal })
      .int(MSG.tillTotal)
      .min(0, MSG.tillTotal)
      .max(TILL_TOTAL_MAX_PAISA, MSG.tillTotal)
      .nullable()
      .optional(),
    note: z
      .string()
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : v === null ? null : v.trim() || null))
      .refine((v) => v == null || charCount(v) <= NOTE_MAX_CHARS, MSG.note),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.lines.forEach((l, i) => {
      const key = `${l.menuItemId.toLowerCase()}|${(l.variantId ?? "").toLowerCase()}`;
      if (seen.has(key))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines", i], message: MSG.duplicate });
      seen.add(key);
    });
  });
export type LogDailySalesParsed = z.output<typeof logDailySalesSchema>;

// ---- stats ----------------------------------------------------------------------------------------------------

export const statsGrainSchema = z.enum(["day", "week", "month"]);

export const getStatsSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    compare: z
      .union([z.literal("previous"), z.literal("none"), z.object({ from: isoDate, to: isoDate })])
      .optional(),
    grain: statsGrainSchema.optional(),
  })
  .superRefine((v, ctx) => {
    checkRange(ctx, v.from, v.to, ["range"]);
    if (v.compare && typeof v.compare === "object")
      checkRange(ctx, v.compare.from, v.compare.to, ["compare", "range"]);
  });
export type GetStatsParsed = z.output<typeof getStatsSchema>;

/**
 * Turn validated `getStats` input into the concrete ranges and grain. compare: "previous" (default) = the same
 * number of days immediately before; "none" = no compare range; an object = that range.
 */
export function resolveStatsRange(input: GetStatsParsed): ResolvedStatsRange {
  let cmp: DateRange | null;
  const compare = input.compare ?? "previous";
  if (compare === "none") cmp = null;
  else if (compare === "previous") cmp = previousRange(input.from, input.to);
  else cmp = { from: compare.from, to: compare.to };
  return {
    from: input.from,
    to: input.to,
    compareFrom: cmp?.from ?? null,
    compareTo: cmp?.to ?? null,
    grain: input.grain ?? defaultGrain(input.from, input.to),
    timezone: "Asia/Kathmandu",
  };
}

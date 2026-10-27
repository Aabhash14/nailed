import { z } from "zod";
import { charCount } from "@/lib/menu-translations";
import { uuid } from "@/lib/validation/common";

/**
 * Zod schemas for table ordering (api-contract 2.3.0 section 9). The database re-validates everything and is the
 * authority; these give the same field-error keys first: `table`, `code`, `turnstileToken`, `clientRequestId`,
 * `items`, `items.N`, `items.N.qty`, `items.N.variantIds`, `note`, `tables`, `tables.N.number`, `tables.N.label`, `mode`,
 * `since`, `sessionId`, `tableId`, `roundId`, `status`, `reason`, `outcome`, `paidVia`, `expectedTotal`, `locked`,
 * `ids`, `all`, `page`, `pageSize`.
 *
 * Messages are fixed text: no schema here ever echoes the typed code (SEC-029 item 6, SEC-028 B4).
 */

// ---- shared ---------------------------------------------------------------------------------------------------

export const TABLE_NUMBER_MIN = 1;
export const TABLE_NUMBER_MAX = 99;
export const TABLE_LABEL_MAX = 40;
export const NOTE_MAX = 200;
export const TABLE_LINES_MAX = 20;
export const TABLE_QTY_MAX = 20;
export const TABLE_OPTIONS_MAX = 4;

/** Alphabet without look-alikes (ADR 0002 section 2): 2-9, A-Z without I, L, O. */
export const TABLE_CODE_RE = /^[2-9A-HJKMNP-Z]{6}$/;

/** Control characters (C0, DEL, C1) and bidi overrides (U+202A..U+202E, U+2066..U+2069). Same rule as the database. */
export const UNSAFE_TEXT_RE = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

export const MSG = {
  table: "Pick a table number from 1 to 99.",
  codeShape: "Enter the 6-character code from our staff.",
  plainText: "Use one line of plain text.",
  noteLength: "At most 200 characters.",
  labelLength: "At most 40 characters.",
  numberTwice: "That table number is used twice.",
  paidViaRequired: "Choose how the table paid.",
  paidViaForVoid: "Leave this empty when voiding a table.",
  variantTwice: "Each option can be picked once.",
} as const;

const tableNumber = z
  .number({ invalid_type_error: MSG.table, required_error: MSG.table })
  .int(MSG.table)
  .min(TABLE_NUMBER_MIN, MSG.table)
  .max(TABLE_NUMBER_MAX, MSG.table);

/** Remove spaces and "-", upper-case (the database applies the same normalisation). */
export function normaliseTableCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

// ---- guest routes ---------------------------------------------------------------------------------------------

/** POST /api/table/join (9.3). `code` comes out normalised. */
export const joinTableRequestSchema = z.object({
  table: tableNumber,
  code: z
    .string({ invalid_type_error: MSG.codeShape, required_error: MSG.codeShape })
    .min(1, MSG.codeShape)
    .max(20, MSG.codeShape)
    .transform(normaliseTableCode)
    .refine((c) => TABLE_CODE_RE.test(c), MSG.codeShape),
  turnstileToken: z.string().min(1).max(4096),
});
export type JoinTableRequest = z.input<typeof joinTableRequestSchema>;

/**
 * Round note (9.5): trimmed; "" = absent; at most 200 characters (code points, as Postgres counts); one line of
 * plain text (no control characters, newlines included, and no bidi overrides).
 */
const noteSchema = z
  .string()
  .transform((v) => v.trim())
  .superRefine((v, ctx) => {
    if (charCount(v) > NOTE_MAX) ctx.addIssue({ code: z.ZodIssueCode.custom, message: MSG.noteLength });
    else if (UNSAFE_TEXT_RE.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: MSG.plainText });
  })
  .transform((v) => (v === "" ? undefined : v));

const orderLineSchema = z.object({
  menuItemId: uuid,
  variantIds: z
    .array(uuid)
    .max(TABLE_OPTIONS_MAX)
    .refine((ids) => new Set(ids.map((i) => i.toLowerCase())).size === ids.length, MSG.variantTwice)
    .optional()
    .transform((ids) => [...(ids ?? [])].sort()),
  qty: z.number().int().min(1).max(TABLE_QTY_MAX),
});

/**
 * POST /api/table/orders (9.5). Unknown keys (a `table`, `session`, `sessionId`, any price) are DROPPED: the session
 * comes only from the verified cookie (B3) and prices only from the database. Merging of equal lines and "one option
 * per kind" are checked by create_table_order, which knows the menu.
 */
export const tableOrderRequestSchema = z.object({
  clientRequestId: uuid,
  items: z.array(orderLineSchema).min(1).max(TABLE_LINES_MAX),
  note: noteSchema.optional(),
});
export type TableOrderRequest = z.input<typeof tableOrderRequestSchema>;

/** `since` on GET /api/table/session (9.4): an integer 0..2,147,483,647; anything else is ignored (undefined). */
export function parseSince(raw: string | null): number | undefined {
  if (raw === null || !/^\d{1,10}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= 2_147_483_647 ? n : undefined;
}

// ---- admin actions (9.7) --------------------------------------------------------------------------------------

const tableLabel = z
  .string()
  .nullable()
  .optional()
  .transform((v) => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  })
  .superRefine((v, ctx) => {
    if (v === null) return;
    if (charCount(v) > TABLE_LABEL_MAX) ctx.addIssue({ code: z.ZodIssueCode.custom, message: MSG.labelLength });
    else if (UNSAFE_TEXT_RE.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: MSG.plainText });
  });

export const saveCafeTablesSchema = z
  .object({
    tables: z
      .array(
        z.object({
          id: uuid.optional(),
          number: tableNumber,
          label: tableLabel,
          isActive: z.boolean(),
        }),
      )
      .max(99),
  })
  .superRefine((v, ctx) => {
    const seen = new Map<number, number>();
    for (const t of v.tables) seen.set(t.number, (seen.get(t.number) ?? 0) + 1);
    v.tables.forEach((t, i) => {
      if ((seen.get(t.number) ?? 0) > 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tables", i, "number"], message: MSG.numberTwice });
      }
    });
  });

export const tableOrderingModeSchema = z.enum(["off", "on", "paused"]);
export const setTableOrderingSchema = z.object({ mode: tableOrderingModeSchema });

export const getTableBoardSchema = z.object({ since: z.string().max(64).optional() });
export const openTableSchema = z.object({ tableId: uuid });
export const rotateTableCodeSchema = z.object({ sessionId: uuid });
export const setTableOrdersLockedSchema = z.object({ sessionId: uuid, locked: z.boolean() });

export const closeTableSchema = z
  .object({
    sessionId: uuid,
    outcome: z.enum(["paid", "void"]),
    paidVia: z.enum(["cash", "fonepay", "other"]).optional(),
    expectedTotal: z.number().int().min(0).max(2_000_000_000),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === "paid" && !v.paidVia) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paidVia"], message: MSG.paidViaRequired });
    }
    if (v.outcome === "void" && v.paidVia !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paidVia"], message: MSG.paidViaForVoid });
    }
  });

export const setTableRoundStatusSchema = z.object({ roundId: uuid, status: z.enum(["preparing", "served"]) });

/** `session_closed` is system only: VALIDATION `reason` (9.7). */
export const cancelTableRoundSchema = z.object({
  roundId: uuid,
  reason: z.enum(["guest_request", "unavailable", "mistake", "other"], {
    errorMap: () => ({ message: "Pick a reason: guest request, unavailable, mistake or other." }),
  }),
});

// ---- owner alerts (9.10) --------------------------------------------------------------------------------------

export const listAlertsSchema = z.object({
  unreadOnly: z.boolean().optional(),
  page: z.number().int().min(1).max(1000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

/** `{ ids: Uuid[] }` (1..100) or `{ all: true }`, exactly one of them. */
export const markAlertsReadSchema = z
  .object({
    ids: z.array(uuid).min(1).max(100).optional(),
    all: z.literal(true).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.ids === undefined) === (v.all === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ids"], message: "Send 1 to 100 alert ids, or all: true." });
    }
  });

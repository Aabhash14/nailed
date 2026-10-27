import { z, type ZodTypeAny } from "zod";
import { AppError } from "@/lib/errors";
import { normalizeNepalPhone } from "@/lib/phone";

export const uuid = z.string().uuid();
export const paisa = z.number().int().min(0).max(2_000_000_000);

/** Nepal mobile, normalised to +977 9[78]XXXXXXXX. */
export const nepalPhone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normalizeNepalPhone(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid Nepal mobile number" });
      return z.NEVER;
    }
    return n;
  });

/** Zod issues -> contract fieldErrors keyed by path ("items.0.qty"). */
export function fieldErrorsFromZod(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Validate untrusted input at the boundary. Throws VALIDATION with fieldErrors. */
export function parseInput<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError("VALIDATION", undefined, { fieldErrors: fieldErrorsFromZod(r.error) });
  }
  return r.data;
}

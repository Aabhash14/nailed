import { z } from "zod";
import { nepalPhone, uuid } from "./common";

/** api-contract.md 3.1 CheckoutRequest. Prices from the client do not exist: the DB re-prices. */
export const paymentMethodSchema = z.enum(["cod", "pickup"]);
export const fulfilmentSchema = z.enum(["pickup", "delivery"]);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const checkoutRequestSchema = z
  .object({
    items: z
      .array(z.object({ variantId: uuid, qty: z.number().int().min(1).max(10) }))
      .min(1)
      .max(20),
    fulfilment: fulfilmentSchema,
    paymentMethod: paymentMethodSchema,
    customer: z.object({
      name: z.string().trim().min(2).max(80),
      phone: nepalPhone,
      email: z
        .string()
        .trim()
        .max(254)
        .optional()
        .transform((v) => (v ? v : undefined))
        .pipe(z.string().email().optional()),
    }),
    delivery: z
      .object({
        address: z.string().trim().min(3).max(300),
        landmark: z.string().trim().min(2).max(200),
        area: z.string().trim().min(2).max(100),
      })
      .optional(),
    notes: optionalText(300),
    turnstileToken: z.string().min(1).max(4096),
  })
  .superRefine((v, ctx) => {
    if (v.fulfilment === "delivery" && !v.delivery) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["delivery"], message: "Delivery details are required" });
    }
    const expected = v.fulfilment === "delivery" ? "cod" : "pickup";
    if (v.paymentMethod !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentMethod"],
        message: v.fulfilment === "delivery" ? "Delivery orders are paid in cash on delivery" : "Pickup orders are paid at pickup",
      });
    }
  });
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const orderTokenSchema = uuid;

/** The isolated payments seam (architecture.md section 9). v1 is cash only. */
export type PaymentMethod = "cod" | "pickup";
export type Fulfilment = "delivery" | "pickup";
export type PaymentPrepared = { type: "none" };

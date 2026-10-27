import type { Fulfilment, PaymentMethod, PaymentPrepared } from "./types";

/** cod is valid only with delivery, pickup only with pickup (api-contract.md section 1). */
export function methodForFulfilment(f: Fulfilment): PaymentMethod {
  return f === "delivery" ? "cod" : "pickup";
}

export function prepare(method: PaymentMethod): PaymentPrepared {
  // Both v1 methods are cash: nothing to redirect to.
  void method;
  return { type: "none" };
}

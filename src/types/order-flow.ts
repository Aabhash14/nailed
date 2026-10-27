import type { Fulfilment, OrderStatus, Role } from "./contract";

/** Order state machine, api-contract.md section 3.2. The database is the authority; this only drives the UI. */
export const ACTIVE_STATUSES: OrderStatus[] = [
  "placed",
  "confirmed",
  "out_for_delivery",
  "ready_for_pickup",
];

export function isActive(status: OrderStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export type ForwardStatus = "confirmed" | "out_for_delivery" | "ready_for_pickup" | "completed";

/** The single forward move offered to staff for an order, or null if terminal. */
export function nextForwardStatus(
  status: OrderStatus,
  fulfilment: Fulfilment,
): ForwardStatus | null {
  switch (status) {
    case "placed":
      return "confirmed";
    case "confirmed":
      return fulfilment === "delivery" ? "out_for_delivery" : "ready_for_pickup";
    case "out_for_delivery":
    case "ready_for_pickup":
      return "completed";
    default:
      return null;
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus, fulfilment: Fulfilment): boolean {
  if (to === "cancelled") return isActive(from);
  return nextForwardStatus(from, fulfilment) === to;
}

/** Staff may cancel placed/confirmed; only the owner may cancel out_for_delivery/ready_for_pickup. */
export function canCancelAs(status: OrderStatus, role: Role): boolean {
  if (status === "placed" || status === "confirmed") return true;
  if (status === "out_for_delivery" || status === "ready_for_pickup") return role === "owner";
  return false;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  placed: "New, not yet confirmed",
  confirmed: "Confirmed",
  out_for_delivery: "Out for delivery",
  ready_for_pickup: "Ready for pickup",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const FORWARD_ACTION_LABEL: Record<ForwardStatus, string> = {
  confirmed: "Confirm (after the call)",
  out_for_delivery: "Send out for delivery",
  ready_for_pickup: "Mark ready for pickup",
  completed: "Complete (cash received)",
};

export const CANCEL_REASON_LABEL: Record<string, string> = {
  customer_request: "Customer asked to cancel",
  unreachable: "Could not reach the customer",
  no_show: "Customer did not show up",
  refused: "Customer refused the order",
  fake: "Fake or prank order",
  out_of_stock: "Out of stock",
  other: "Other",
  auto_unconfirmed: "Not confirmed in time (cancelled automatically)",
};

/** Reasons a person may choose when cancelling. customer_request comes from the customer page, auto_unconfirmed from the system. */
export const STAFF_CANCEL_REASONS = ["unreachable", "no_show", "refused", "fake", "out_of_stock", "other"] as const;

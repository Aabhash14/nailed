import { describe, expect, it } from "vitest";
import { finishedAt, finishedOnDay, sortFinished, sortNeedsAction, splitBoard } from "@/components/admin/orders-logic";
import type { AdminOrderRow } from "@/types/contract";

/** Today's orders board: BUG-013 (finished today = finish time) and design review T-048 fix 5 (oldest waiting first). */

type R = Pick<AdminOrderRow, "status" | "createdAt" | "completedAt" | "cancelledAt"> & { n: string };
const row = (n: string, status: R["status"], createdAt: string, done: string | null = null): R => ({
  n,
  status,
  createdAt,
  completedAt: status === "completed" ? done : null,
  cancelledAt: status === "cancelled" ? done : null,
});

// Kathmandu is UTC+05:45, so 18:15Z is 00:00 the next day in NST
const NOW = new Date("2026-10-22T19:00:00Z"); // 00:45 NST on 23 Oct

describe("finished today (BUG-013)", () => {
  it("uses the finish time, not the order time", () => {
    const lateNight = row("NC-1042", "completed", "2026-10-22T18:07:00Z", "2026-10-22T18:27:00Z"); // 23:52 -> 00:12 NST
    expect(finishedOnDay(lateNight, "2026-10-23")).toBe(true);
    expect(finishedOnDay(lateNight, "2026-10-22")).toBe(false);
    expect(splitBoard([lateNight], NOW).done.map((r) => r.n)).toEqual(["NC-1042"]);
  });

  it("an order auto-cancelled after midnight shows on the new day; one finished yesterday does not", () => {
    const auto = row("A", "cancelled", "2026-10-22T15:00:00Z", "2026-10-22T18:30:00Z");
    const yesterday = row("B", "completed", "2026-10-22T10:00:00Z", "2026-10-22T11:00:00Z");
    expect(splitBoard([auto, yesterday], NOW).done.map((r) => r.n)).toEqual(["A"]);
  });

  it("open orders have no finish time; a missing timestamp falls back to the order time", () => {
    expect(finishedAt(row("C", "placed", "2026-10-22T18:00:00Z"))).toBeNull();
    expect(finishedAt(row("D", "completed", "2026-10-22T18:20:00Z", null))).toBe("2026-10-22T18:20:00Z");
  });

  it("finished orders are listed most recently finished first", () => {
    const a = row("a", "completed", "2026-10-22T18:16:00Z", "2026-10-22T18:40:00Z");
    const b = row("b", "cancelled", "2026-10-22T18:30:00Z", "2026-10-22T18:31:00Z");
    expect(sortFinished([b, a]).map((r) => r.n)).toEqual(["a", "b"]);
  });
});

describe("needs action order (design review fix 5)", () => {
  it("placed first, then confirmed, then ready / out for delivery; oldest first inside each group", () => {
    const rows = [
      row("ready-old", "ready_for_pickup", "2026-10-22T17:00:00Z"),
      row("placed-new", "placed", "2026-10-22T18:50:00Z"),
      row("confirmed", "confirmed", "2026-10-22T18:40:00Z"),
      row("placed-stale", "placed", "2026-10-22T18:00:00Z"),
      row("out", "out_for_delivery", "2026-10-22T16:00:00Z"),
    ];
    expect(sortNeedsAction(rows).map((r) => r.n)).toEqual(["placed-stale", "placed-new", "confirmed", "out", "ready-old"]);
    expect(rows[0]!.n).toBe("ready-old"); // input not mutated
  });

  it("finished orders never appear under Needs action", () => {
    const { open } = splitBoard([row("x", "completed", "2026-10-22T18:30:00Z", "2026-10-22T18:35:00Z")], NOW);
    expect(open).toEqual([]);
  });
});

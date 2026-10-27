import { describe, expect, it } from "vitest";
import { formatNpr } from "@/lib/money";
import { methodForFulfilment } from "@/lib/payments/cod";
import { apiErrorSchema, err, ok } from "@/lib/validation/api";

describe("formatNpr", () => {
  it("drops decimals for whole rupees", () => expect(formatNpr(35000)).toBe("Rs. 350"));
  it("keeps paisa when present", () => expect(formatNpr(35050)).toBe("Rs. 350.50"));
  it("groups lakhs the Nepali way", () => expect(formatNpr(12345600)).toBe("Rs. 1,23,456"));
  it("rejects floats", () => expect(() => formatNpr(1.5)).toThrow());
});

describe("payments seam", () => {
  it("maps fulfilment to the only valid cash method", () => {
    expect(methodForFulfilment("delivery")).toBe("cod");
    expect(methodForFulfilment("pickup")).toBe("pickup");
  });
});

describe("api envelope", () => {
  it("builds ok and error results", () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 });
    expect(apiErrorSchema.safeParse(err("VALIDATION", "bad").error).success).toBe(true);
  });
});

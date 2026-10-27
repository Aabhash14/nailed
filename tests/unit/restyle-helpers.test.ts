import { describe, expect, it } from "vitest";
import { orderChartColumns, orderSizes, orderVariants, sizeRank } from "@/components/shop/size-order";
import { ratioFromClass } from "@/components/ui/media-ratio";
import { devanagariNumeral } from "@/components/site/accents";

describe("BUG-015 frontend: size chart and size picker order", () => {
  it("orders jsonb-shuffled sizes by garment rank", () => {
    expect(orderSizes(["L", "M", "S", "XL"])).toEqual(["S", "M", "L", "XL"]);
    expect(orderSizes(["XXL", "xs", "M"])).toEqual(["xs", "M", "XXL"]);
  });
  it("puts unknown sizes after known ones, in the product's variant order", () => {
    expect(orderSizes(["Kids 8", "M", "Kids 6"], ["Kids 6", "Kids 8", "M"])).toEqual([
      "M",
      "Kids 6",
      "Kids 8",
    ]);
    expect(orderSizes(["One size"])).toEqual(["One size"]);
  });
  it("orders chart columns Chest, Length, Sleeve, then the rest as given", () => {
    expect(orderChartColumns(["Sleeve", "Length", "Chest"])).toEqual(["Chest", "Length", "Sleeve"]);
    expect(orderChartColumns(["Hip", "Chest", "Waist"])).toEqual(["Chest", "Hip", "Waist"]);
  });
  it("matches the database size_rank (XXL = 2XL, numeric after letters, One size last)", () => {
    expect(sizeRank("2XL")).toBe(sizeRank("XXL"));
    expect(sizeRank(" xl ")).toBe(60);
    expect(sizeRank("42")).toBe(242);
    expect(orderSizes(["One size", "Kids", "40", "M"])).toEqual(["M", "40", "Kids", "One size"]);
  });
  it("orders variants like the server: colour, then size rank, without mutating the input", () => {
    const v = [
      { size: "L", colour: "Black" },
      { size: "S", colour: "White" },
      { size: "S", colour: "Black" },
    ];
    expect(orderVariants(v).map((x) => `${x.size}/${x.colour}`)).toEqual([
      "S/Black",
      "L/Black",
      "S/White",
    ]);
    expect(v[0]!.size).toBe("L");
  });
});

describe("media + accents helpers", () => {
  it("reads the image ratio from the first aspect class (review fix 32)", () => {
    expect(ratioFromClass("aspect-square")).toBe(1);
    expect(ratioFromClass("aspect-[4/3] md:aspect-[16/9]")).toBeCloseTo(4 / 3);
    expect(ratioFromClass("aspect-[16/9]")).toBeCloseTo(16 / 9);
    expect(ratioFromClass("")).toBeCloseTo(4 / 3);
  });
  it("writes Devanagari digits", () => {
    expect(devanagariNumeral(1)).toBe("१");
    expect(devanagariNumeral(12)).toBe("१२");
  });
});

describe("admin photo upload: storage guard reason is shown (BUG-016 follow-up)", () => {
  it("shows the guard's reason without the bucket prefix", async () => {
    const { uploadRefusalMessage } = await import("@/components/admin/upload-errors");
    expect(
      uploadRefusalMessage({ statusCode: "403", error: "AccessDenied", message: "public-media: 480 px image is too large" }),
    ).toBe("This photo was refused: 480 px image is too large.");
  });
  it("falls back to the generic message for anything else", async () => {
    const { uploadRefusalMessage, GENERIC_UPLOAD_ERROR } = await import("@/components/admin/upload-errors");
    expect(uploadRefusalMessage(null)).toBe(GENERIC_UPLOAD_ERROR);
    expect(uploadRefusalMessage({ statusCode: "500", message: "boom" })).toBe(GENERIC_UPLOAD_ERROR);
    expect(uploadRefusalMessage({ statusCode: "403", message: "new row violates row-level security" })).toBe(GENERIC_UPLOAD_ERROR);
  });
});

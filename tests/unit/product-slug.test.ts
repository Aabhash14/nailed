import { describe, expect, it, vi } from "vitest";

// public-server pulls in next/cache and the live Supabase reader; neither is needed for the pure shape check
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/data-access/public-live", () => ({
  liveMenuSnapshot: vi.fn(),
  liveSettings: vi.fn(),
  liveProducts: vi.fn(() => {
    throw new Error("SEC-021: no data read expected for a badly shaped slug");
  }),
}));

const { getProductBySlug, isWellFormedProductSlug } = await import("@/data-access/public-server");

/** SEC-021: a product slug is checked against the server's shape rule before any data read. */
describe("product slug shape (SEC-021)", () => {
  it("accepts the shapes the server can store", () => {
    for (const s of ["sample-tee", "tee", "tee-2026", "a1-b2-c3", "x".repeat(80)]) expect(isWellFormedProductSlug(s), s).toBe(true);
  });

  it("refuses everything else", () => {
    for (const s of ["", "Sample-Tee", "-tee", "tee-", "tee--two", "tee_two", "tee two", "टी", "%41", "../etc", "x".repeat(81)]) {
      expect(isWellFormedProductSlug(s), JSON.stringify(s)).toBe(false);
    }
  });

  it("a badly shaped slug returns null without reading data", async () => {
    await expect(getProductBySlug("NOT a slug")).resolves.toBeNull();
    await expect(getProductBySlug("y".repeat(200))).resolves.toBeNull();
  });
});

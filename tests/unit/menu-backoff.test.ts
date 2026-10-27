import { describe, expect, it } from "vitest";
import { MAX_BACKOFF_MS, POLL_MS, backoffMs } from "@/components/menu/use-live-menu";
import { parseRetryAfter } from "@/data-access/public-client";

/** Contract 1.3.3: /api/menu may answer 429 with Retry-After. The menu poll keeps the last menu and backs off. */
describe("menu poll backoff", () => {
  it("respects the server's Retry-After, capped at 5 minutes", () => {
    expect(backoffMs(1, 12_000)).toBe(12_000);
    expect(backoffMs(4, 12_000)).toBe(12_000); // the server's number wins over the doubling
    expect(backoffMs(1, 3_600_000)).toBe(MAX_BACKOFF_MS);
  });

  it("without Retry-After: 30 s, 60 s, 120 s ... up to 5 minutes", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, null))).toEqual([POLL_MS, 60_000, 120_000, 240_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  });

  it("reads Retry-After seconds; ignores dates and junk", () => {
    expect(parseRetryAfter("20")).toBe(20_000);
    expect(parseRetryAfter(" 7 ")).toBe(7_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(parseRetryAfter("-1")).toBeNull();
  });
});

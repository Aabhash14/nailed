import { describe, expect, it } from "vitest";
import {
  botCheckFailedMessage,
  CHECKOUT_TICK_MESSAGE,
  LOGIN_TICK_MESSAGE,
  mockTurnstileOutcome,
  noTokenReason,
  parseMockTurnstile,
} from "@/components/shop/turnstile-logic";
import { loadedLogStatus } from "@/components/admin/sales/sales-logic";

describe("BUG-019 bot check failure copy", () => {
  it("checkout: the draft message with the cafe's phone", () => {
    expect(botCheckFailedMessage("01-4410000")).toBe(
      "We couldn't run the security check. Check your connection and tap Try again. If it keeps failing, call us on 01-4410000 to order.",
    );
  });
  it("staff sign-in (no phone) and a blank phone: no call line", () => {
    const short = "We couldn't run the security check. Check your connection and tap Try again.";
    expect(botCheckFailedMessage(null)).toBe(short);
    expect(botCheckFailedMessage(undefined)).toBe(short);
    expect(botCheckFailedMessage("  ")).toBe(short);
  });
  it("the 'tick the widget' copy is unchanged", () => {
    expect(CHECKOUT_TICK_MESSAGE).toBe("Please complete the check below");
    expect(LOGIN_TICK_MESSAGE).toBe("Please complete the check below.");
  });
});

describe("BUG-019 no-token reason", () => {
  it("only a widget waiting for a tick counts as 'interactive'; everything else is a failure", () => {
    expect(noTokenReason("interactive")).toBe("interactive");
    expect(noTokenReason("failed")).toBe("failed");
    expect(noTokenReason("loading")).toBe("failed"); // nothing came back in time (script hanging or blocked)
    expect(noTokenReason("ok")).toBe("failed"); // token cleared after it was handed over
    expect(noTokenReason(undefined)).toBe("failed"); // slot not mounted
  });
});

describe("BUG-019 mock bot check (mock builds only)", () => {
  it("parses only the known modes", () => {
    expect(parseMockTurnstile("fail")).toBe("fail");
    expect(parseMockTurnstile("fail-once")).toBe("fail-once");
    expect(parseMockTurnstile("hang")).toBe("hang");
    expect(parseMockTurnstile("pass")).toBeNull();
    expect(parseMockTurnstile(null)).toBeNull();
    expect(parseMockTurnstile(undefined)).toBeNull();
  });
  it("outcome per attempt", () => {
    expect(mockTurnstileOutcome(null, 0)).toBe("token");
    expect(mockTurnstileOutcome("fail", 0)).toBe("fail");
    expect(mockTurnstileOutcome("fail", 3)).toBe("fail");
    expect(mockTurnstileOutcome("fail-once", 0)).toBe("fail");
    expect(mockTurnstileOutcome("fail-once", 1)).toBe("token");
    expect(mockTurnstileOutcome("hang", 2)).toBe("hang");
  });
});

describe("sales log: loaded log status with updatedByName", () => {
  // 18:30 in Kathmandu (UTC+05:45) on 25 Oct 2026
  const at = "2026-10-25T12:45:00Z";
  it("with a name: 'Saved at HH:MM by NAME' on its own line", () => {
    expect(loadedLogStatus({ businessDate: "2026-10-25", updatedAt: at, updatedByName: "Asha" })).toEqual({
      ownLine: true,
      text: "Saved at 18:30 by Asha",
    });
  });
  it("saved on a later day names that day", () => {
    expect(loadedLogStatus({ businessDate: "2026-10-24", updatedAt: at, updatedByName: "Asha" }).text).toBe(
      "Saved Sun 25 Oct at 18:30 by Asha",
    );
  });
  it("without a name (absent, null or blank): the old inline wording", () => {
    for (const updatedByName of [undefined, null, " "]) {
      expect(loadedLogStatus({ businessDate: "2026-10-25", updatedAt: at, updatedByName })).toEqual({
        ownLine: false,
        text: ": last saved at 18:30.",
      });
    }
    expect(loadedLogStatus({ businessDate: "2026-10-24", updatedAt: at }).text).toBe(": last saved Sun 25 Oct at 18:30.");
  });
});

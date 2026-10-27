import { describe, expect, it } from "vitest";
import { openStatus, openStatusText, todayHoursText } from "@/components/site/open-status-logic";
import type { OpeningHours } from "@/types/contract";

const day = [{ open: "07:00", close: "21:00" }];
const hours: OpeningHours = {
  weekly: {
    0: [{ open: "08:00", close: "20:00" }],
    1: day,
    2: day,
    3: day,
    4: day,
    5: day,
    6: null,
  },
  closures: [],
};

// Kathmandu is UTC+5:45. 2026-10-26 is a Monday.
const ktm = (local: string) =>
  new Date(new Date(`${local}:00Z`).getTime() - (5 * 60 + 45) * 60_000);

describe("openStatus (Kathmandu time)", () => {
  it("is open inside a slot and reports the closing time", () => {
    expect(openStatus(hours, ktm("2026-10-26T10:00"))).toEqual({
      state: "open",
      closesAt: "21:00",
      closingSoon: false,
    });
  });

  it("flags closing soon within 30 minutes", () => {
    expect(openStatus(hours, ktm("2026-10-26T20:40"))).toMatchObject({
      state: "open",
      closingSoon: true,
    });
  });

  it("is closed exactly at closing time and opens tomorrow", () => {
    expect(openStatus(hours, ktm("2026-10-26T21:00"))).toEqual({
      state: "closed",
      opensAt: "07:00",
      opensDay: "tomorrow",
      closure: null,
    });
  });

  it("is closed before opening and opens later today", () => {
    expect(openStatus(hours, ktm("2026-10-26T06:30"))).toEqual({
      state: "closed",
      opensAt: "07:00",
      opensDay: null,
      closure: null,
    });
  });

  it("skips a closed day (Saturday) to the next opening", () => {
    // Friday 2026-10-30 after closing -> Saturday closed -> Sunday 08:00
    expect(openStatus(hours, ktm("2026-10-30T22:00"))).toMatchObject({
      state: "closed",
      opensAt: "08:00",
      opensDay: "Sun",
    });
  });

  it("respects a dated closure today", () => {
    const h = { ...hours, closures: [{ date: "2026-10-26", label: "Tihar" }] };
    expect(openStatus(h, ktm("2026-10-26T10:00"))).toEqual({
      state: "closed",
      opensAt: "07:00",
      opensDay: "tomorrow",
      closure: "Tihar",
    });
  });

  it("uses Kathmandu, not UTC, for the day boundary", () => {
    // 2026-10-26 00:30 in Kathmandu is still Sunday 18:45 UTC; Monday has not opened yet.
    expect(openStatus(hours, ktm("2026-10-26T00:30"))).toMatchObject({
      state: "closed",
      opensAt: "07:00",
      opensDay: null,
    });
  });

  it("returns null when no hours are entered", () => {
    const none: OpeningHours = {
      weekly: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
      closures: [],
    };
    expect(openStatus(none, ktm("2026-10-26T10:00"))).toBeNull();
  });

  it("formats short and detail text", () => {
    expect(openStatusText({ state: "open", closesAt: "21:00", closingSoon: false })).toEqual({
      short: "Open now",
      detail: "until 21:00",
    });
    expect(
      openStatusText({ state: "closed", opensAt: "07:00", opensDay: "tomorrow", closure: null }),
    ).toEqual({
      short: "Closed",
      detail: "opens tomorrow 07:00",
    });
  });
});

describe("todayHoursText (Home 'Find us', S25 2026-10-25)", () => {
  it("shows today's slots in Kathmandu time, even after closing", () => {
    expect(todayHoursText(hours, ktm("2026-10-26T10:00"))).toBe("Today: 07:00 to 21:00");
    expect(todayHoursText(hours, ktm("2026-10-26T22:30"))).toBe("Today: 07:00 to 21:00");
  });

  it("joins split days", () => {
    const h: OpeningHours = {
      ...hours,
      weekly: {
        ...hours.weekly,
        1: [
          { open: "14:00", close: "20:00" },
          { open: "07:00", close: "12:00" },
        ],
      },
    };
    expect(todayHoursText(h, ktm("2026-10-26T09:00"))).toBe(
      "Today: 07:00 to 12:00, 14:00 to 20:00",
    );
  });

  it("a weekly closed day names the next opening day", () => {
    // Saturday 2026-10-31 is closed -> Sunday 08:00 (tomorrow)
    expect(todayHoursText(hours, ktm("2026-10-31T10:00"))).toBe(
      "Closed today, opens tomorrow at 08:00",
    );
    const h: OpeningHours = { ...hours, weekly: { ...hours.weekly, 0: null } };
    expect(todayHoursText(h, ktm("2026-10-31T10:00"))).toBe("Closed today, opens Monday at 07:00");
  });

  it("a dated closure today gives its label", () => {
    const h = { ...hours, closures: [{ date: "2026-10-26", label: "Tihar" }] };
    expect(todayHoursText(h, ktm("2026-10-26T10:00"))).toBe(
      "Closed today (Tihar), opens tomorrow at 07:00",
    );
  });

  it("is null when no hours have been entered", () => {
    const none: OpeningHours = {
      weekly: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
      closures: [],
    };
    expect(todayHoursText(none, ktm("2026-10-26T10:00"))).toBeNull();
  });
});

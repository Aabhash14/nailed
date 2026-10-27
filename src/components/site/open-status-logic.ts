import type { OpeningHours } from "@/types/contract";

const TZ = "Asia/Kathmandu";
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Within this many minutes of closing the status reads "Closes soon". */
export const CLOSING_SOON_MIN = 30;

export type OpenStatus =
  | { state: "open"; closesAt: string; closingSoon: boolean }
  | { state: "closed"; opensAt: string | null; opensDay: string | null; closure: string | null };

type KtmNow = { day: number; minutes: number; dateKey: string };

/** Day of week (0 = Sunday), minutes since midnight and yyyy-mm-dd, all in Kathmandu time. */
export function kathmanduNow(now: Date): KtmNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    day: SHORT_DAYS.indexOf(get("weekday")),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** yyyy-mm-dd of the day `offset` days after `dateKey` (calendar arithmetic, no time zone involved). */
function addDays(dateKey: string, offset: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Open/closed right now in Kathmandu, from the cafe's weekly hours and dated closures.
 * Returns null when no hours have been entered at all, so the badge is hidden rather than wrong.
 */
export function openStatus(hours: OpeningHours, now: Date = new Date()): OpenStatus | null {
  const days = [0, 1, 2, 3, 4, 5, 6] as const;
  if (!days.some((d) => hours.weekly[d] !== null)) return null;

  const { day, minutes, dateKey } = kathmanduNow(now);
  const closureOn = (key: string) => hours.closures.find((c) => c.date === key) ?? null;
  const slotsFor = (d: number) =>
    [...(hours.weekly[d as 0] ?? [])].sort((a, b) => toMinutes(a.open) - toMinutes(b.open));

  const todayClosure = closureOn(dateKey);
  if (!todayClosure) {
    for (const s of slotsFor(day)) {
      const open = toMinutes(s.open);
      const close = toMinutes(s.close);
      if (minutes >= open && minutes < close) {
        return {
          state: "open",
          closesAt: s.close,
          closingSoon: close - minutes <= CLOSING_SOON_MIN,
        };
      }
    }
    const later = slotsFor(day).find((s) => toMinutes(s.open) > minutes);
    if (later) return { state: "closed", opensAt: later.open, opensDay: null, closure: null };
  }

  for (let offset = 1; offset <= 7; offset++) {
    const key = addDays(dateKey, offset);
    if (closureOn(key)) continue;
    const first = slotsFor((day + offset) % 7)[0];
    if (first) {
      return {
        state: "closed",
        opensAt: first.open,
        opensDay: offset === 1 ? "tomorrow" : SHORT_DAYS[(day + offset) % 7]!,
        closure: todayClosure?.label ?? null,
      };
    }
  }
  return { state: "closed", opensAt: null, opensDay: null, closure: todayClosure?.label ?? null };
}

/** Short visible text plus a longer one for wider screens and screen readers. */
export function openStatusText(s: OpenStatus): { short: string; detail: string } {
  if (s.state === "open") {
    return { short: s.closingSoon ? "Closes soon" : "Open now", detail: `until ${s.closesAt}` };
  }
  const when = s.opensAt ? `opens ${s.opensDay ? `${s.opensDay} ` : ""}${s.opensAt}` : "";
  return { short: "Closed", detail: when };
}

const LONG_DAYS: Record<string, string> = {
  Sun: "Sunday",
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
};

/**
 * One line for today's hours in Kathmandu (Home "Find us"; the Visit page keeps the full week):
 * "Today: 07:00 to 21:00", or "Closed today (Tihar), opens tomorrow at 07:00" / "Closed today, opens Sunday at 08:00".
 * Null when no hours have been entered at all (nothing is shown, as with the badge).
 */
export function todayHoursText(hours: OpeningHours, now: Date = new Date()): string | null {
  const status = openStatus(hours, now);
  if (!status) return null;
  const { day, dateKey } = kathmanduNow(now);
  const closure = hours.closures.find((c) => c.date === dateKey) ?? null;
  const slots = [...(hours.weekly[day as 0] ?? [])].sort(
    (a, b) => toMinutes(a.open) - toMinutes(b.open),
  );
  if (!closure && slots.length > 0)
    return `Today: ${slots.map((s) => `${s.open} to ${s.close}`).join(", ")}`;
  // Closed all day: openStatus has already looked past today for the next opening.
  const reason = closure ? ` (${closure.label})` : "";
  if (status.state === "closed" && status.opensAt) {
    const when =
      status.opensDay === "tomorrow" || !status.opensDay
        ? "tomorrow"
        : (LONG_DAYS[status.opensDay] ?? status.opensDay);
    return `Closed today${reason}, opens ${when} at ${status.opensAt}`;
  }
  return `Closed today${reason}`;
}

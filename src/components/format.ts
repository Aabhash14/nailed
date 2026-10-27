import { parseRupeesToPaisa } from "@/lib/money";
import { normalizeNepalPhone } from "@/lib/phone";
import type { OpeningHours, Paisa } from "@/types/contract";

/** Pure display helpers shared by pages and tests. No React, no browser APIs. */

const TZ = "Asia/Kathmandu";

/**
 * Rupees typed by a person -> integer paisa, or null (BUG-006: strict; "12,50" is rejected, not read as Rs. 1,250).
 * Delegates to the server's parser so the admin forms and the API agree exactly.
 */
export function rupeesToPaisa(input: string): Paisa | null {
  return parseRupeesToPaisa(input);
}

/** Integer paisa -> "250" or "250.50" for an input box. */
export function paisaToRupees(paisa: Paisa): string {
  const whole = Math.trunc(paisa / 100);
  const rem = paisa % 100;
  return rem === 0 ? String(whole) : `${whole}.${String(rem).padStart(2, "0")}`;
}

/**
 * Nepal mobile -> "+97798XXXXXXXX", or null. BUG-004: this is the SAME function the server uses
 * (src/lib/phone.ts, contract section 0), so the form never rejects a number the API would accept, or the reverse.
 */
export function normaliseNepalPhone(input: string): string | null {
  return normalizeNepalPhone(input);
}

/** True for the common "0" + mobile typing habit (09841234567): rejected by the contract, but worth a specific hint. */
export function hasLeadingZeroMobile(input: string): boolean {
  return /^0(9[78]\d{8})$/.test(input.trim().replace(/[\s\-().]/g, ""));
}

export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

/** SEC-012 render guard: only https links from settings become anchors (no javascript:, data:, http:). */
export function safeHttpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** yyyy-mm-dd in Kathmandu time, used to decide "today". */
export function kathmanduDateKey(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function minutesAgo(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}

export function agoLabel(iso: string, now: number): string {
  const m = minutesAgo(iso, now);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function dayName(i: number): string {
  return DAY_NAMES[i] ?? "";
}

/** Returns null when no hours have been entered at all (shown as "to be confirmed"). */
export function hoursRows(hours: OpeningHours): { day: string; text: string }[] | null {
  const days = [1, 2, 3, 4, 5, 6, 0] as const;
  const anySet = days.some((d) => hours.weekly[d] !== null);
  if (!anySet) return null;
  return days.map((d) => {
    const slots = hours.weekly[d];
    return {
      day: dayName(d),
      text: slots && slots.length > 0 ? slots.map((s) => `${s.open} to ${s.close}`).join(", ") : "Closed",
    };
  });
}

/**
 * Parses "7:00-20:00" or "07:00-12:00, 14:00-20:00" into zero-padded "HH:mm" slots; null if invalid.
 * "24:00" is allowed as a CLOSING time only (midnight), same as the database check.
 */
export function parseSlots(text: string): { open: string; close: string }[] | null {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const slots: { open: string; close: string }[] = [];
  for (const p of parts) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(p);
    if (!m) return null;
    const [h1, m1, h2, m2] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    if (h1 > 23 || m1 > 59 || m2 > 59 || h2 > 24 || (h2 === 24 && m2 !== 0)) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    slots.push({ open: `${pad(h1)}:${pad(m1)}`, close: `${pad(h2)}:${pad(m2)}` });
  }
  return slots;
}

/**
 * BUG-006: a day's slots must each close after they open, in order, without overlapping. Overnight hours
 * (e.g. 18:00-02:00) are not supported: close at 24:00 instead. Returns a message for the owner, or null when fine.
 */
export function slotsProblem(slots: { open: string; close: string }[]): string | null {
  let prevClose = "";
  for (const s of slots) {
    if (s.close <= s.open) {
      return `Closing time must be after opening time (${s.open}-${s.close}). For late nights, close at 24:00.`;
    }
    if (prevClose && s.open < prevClose) return "Write the times in order, without overlaps, like 07:00-12:00, 14:00-20:00";
    prevClose = s.close;
  }
  return null;
}

/** Cafe phone / WhatsApp as shown on the site: digits with optional + ( ) - and spaces, 7 to 15 digits (SEC-012). */
export function isPlausiblePhone(input: string): boolean {
  const t = input.trim();
  if (!/^\+?[\d\s\-()]+$/.test(t)) return false;
  const digits = t.replace(/\D/g, "").length;
  return digits >= 7 && digits <= 15;
}

export function slotsToText(slots: { open: string; close: string }[] | null): string {
  return slots ? slots.map((s) => `${s.open}-${s.close}`).join(", ") : "";
}

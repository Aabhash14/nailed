import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleHealth } from "@/lib/health";
import { formatStaffDigest, runStaffDigest, DIGEST_CURSOR_KEY, DIGEST_KEY, type DigestFacts } from "@/lib/notify/staff-digest";
import { ALERT_MAX_PER_WINDOW, notifyCustomerCancelled, notifyNewOrder, type OrderAlert } from "@/lib/notify/telegram";
import { memoryDb, type Row } from "./helpers/memory-db";

/**
 * SEC-019: no real order may go unannounced.
 *  - the gate coalesces only bursts above 5 a minute (normal traffic: one alert per order),
 *  - held-back alerts are always flushed (next alert, or the 5-minute digest),
 *  - every auto-cancel produces exactly one staff message (digest), with no PII.
 * The database is the in-memory stand-in (helpers/memory-db.ts) with a test clock; no network.
 */

const at = (iso: string) => Date.parse(iso);
const clock = { t: at("2026-10-23T06:00:10Z") };
const now = () => clock.t;

function telegram(status = 200) {
  return vi.fn(async (url: string, init: RequestInit) => (void url, void init, new Response("{}", { status })));
}
const texts = (send: ReturnType<typeof telegram>) => send.mock.calls.map((c) => String(JSON.parse(String(c[1].body)).text));

const order = (n: number): OrderAlert => ({ orderId: `id-${n}`, orderNumber: `NC-${n}`, itemCount: 1, fulfilment: "pickup", total: 35000 });
const placed = (n: number, createdIso: string): Row => ({ number: `NC-${n}`, status: "placed", cancel_reason: null, cancelled_at: null, created_at: createdIso });
const autoCancelled = (n: number, cancelledIso: string): Row => ({
  number: `NC-${n}`,
  status: "cancelled",
  cancel_reason: "auto_unconfirmed",
  cancelled_at: cancelledIso,
  created_at: "2026-10-23T04:00:00Z",
});

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "bot-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "chat");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://cafe.test");
  clock.t = at("2026-10-23T06:00:10Z");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The keep-alive cron: GET /api/health every 5 minutes at minute 2, 7, 12, ... runs the digest after the response. */
async function cronAt(m: ReturnType<typeof memoryDb>, iso: string, send: ReturnType<typeof telegram>) {
  clock.t = at(iso);
  return runStaffDigest(m.db, { fetchImpl: send as unknown as typeof fetch, now });
}

describe("SEC-019 fix 1: the gate catches floods, not normal traffic", () => {
  it("two orders 30 s apart with no later order produce two alerts (and the digest adds nothing)", async () => {
    const m = memoryDb({ now, tables: { orders: [placed(1001, "2026-10-23T06:00:10Z"), placed(1002, "2026-10-23T06:00:40Z")] } });
    const send = telegram();
    expect(await notifyNewOrder(m.db, order(1001), send as unknown as typeof fetch)).toBe(true);
    clock.t += 30_000;
    expect(await notifyNewOrder(m.db, order(1002), send as unknown as typeof fetch)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(texts(send)[0]).toContain("New order NC-1001");
    expect(texts(send)[1]).toContain("New order NC-1002");
    expect(texts(send).join("\n")).not.toContain("more");
    // the next cron runs find nothing held back: still exactly two messages
    await cronAt(m, "2026-10-23T06:02:00Z", send);
    await cronAt(m, "2026-10-23T06:07:00Z", send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it(`up to ${ALERT_MAX_PER_WINDOW} alerts a minute are sent one by one; the 6th and 7th are held back`, async () => {
    const m = memoryDb({ now });
    const send = telegram();
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      results.push(await notifyNewOrder(m.db, order(1100 + i), send as unknown as typeof fetch));
      clock.t += 4_000;
    }
    expect(results).toEqual([true, true, true, true, true, false, false]);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("the first alert of a later window reports the held-back count once; the digest then does not repeat it", async () => {
    const m = memoryDb({ now });
    const send = telegram();
    for (let i = 0; i < 7; i++) await notifyNewOrder(m.db, order(1200 + i), send as unknown as typeof fetch);
    clock.t = at("2026-10-23T06:01:30Z");
    await notifyNewOrder(m.db, order(1300), send as unknown as typeof fetch);
    const last = texts(send).at(-1)!;
    expect(last).toContain("New order NC-1300");
    expect(last).toContain("+2 more new orders since the previous alert");
    expect(last).toContain("limited to 5 a minute");
    clock.t = at("2026-10-23T06:01:40Z");
    await notifyNewOrder(m.db, order(1301), send as unknown as typeof fetch); // 2nd of the window: no summary line
    expect(texts(send).at(-1)).not.toContain("more");
    const before = send.mock.calls.length;
    await cronAt(m, "2026-10-23T06:02:00Z", send);
    await cronAt(m, "2026-10-23T06:07:00Z", send);
    expect(send.mock.calls.length).toBe(before);
  });
});

describe("SEC-019: held-back alerts are always flushed, even when no later order comes", () => {
  it("a burst of 7 with nothing after it: the 5-minute digest reports 2 not announced and how many are waiting", async () => {
    const orders = Array.from({ length: 7 }, (_, i) => placed(1400 + i, `2026-10-23T06:00:${String(10 + i * 4).padStart(2, "0")}Z`));
    const m = memoryDb({ now, tables: { orders } });
    const send = telegram();
    for (let i = 0; i < 7; i++) {
      await notifyNewOrder(m.db, order(1400 + i), send as unknown as typeof fetch);
      clock.t += 4_000;
    }
    expect(send).toHaveBeenCalledTimes(5);

    const first = await cronAt(m, "2026-10-23T06:02:00Z", send); // window still settling: nothing yet
    expect(first).toMatchObject({ ran: true, sent: false });
    const second = await cronAt(m, "2026-10-23T06:07:00Z", send);
    expect(second).toMatchObject({ ran: true, sent: true });
    expect(send).toHaveBeenCalledTimes(6);
    const digest = texts(send)[5]!;
    expect(digest).toContain("2 new orders were not announced one by one (more than 5 a minute).");
    expect(digest).toContain("7 orders are waiting for a call now; the oldest has waited 6 min.");
    expect(digest).toContain("https://cafe.test/admin/orders");

    // reported once: later cron runs and the next real order do not repeat it
    await cronAt(m, "2026-10-23T06:12:00Z", send);
    expect(send).toHaveBeenCalledTimes(6);
    clock.t = at("2026-10-23T06:13:00Z");
    await notifyNewOrder(m.db, order(1500), send as unknown as typeof fetch);
    expect(texts(send).at(-1)).not.toContain("more");
  });

  it("customer-cancel bursts are flushed the same way", async () => {
    const m = memoryDb({ now });
    const send = telegram();
    for (let i = 0; i < 6; i++) await notifyCustomerCancelled(m.db, `NC-${1600 + i}`, send as unknown as typeof fetch);
    expect(send).toHaveBeenCalledTimes(5);
    await cronAt(m, "2026-10-23T06:02:00Z", send);
    await cronAt(m, "2026-10-23T06:07:00Z", send);
    expect(texts(send).at(-1)).toContain("1 customer cancellation was not announced one by one.");
  });
});

describe("SEC-019 fix 2: auto-cancel is never silent", () => {
  it("an auto-cancel produces exactly one staff message, listing the order number", async () => {
    // pg_cron's auto-cancel ran at 06:05 (transaction start time = cancelled_at)
    const m = memoryDb({ now, tables: { orders: [autoCancelled(1042, "2026-10-23T06:05:00.400Z")] } });
    const send = telegram();
    await cronAt(m, "2026-10-23T06:02:00Z", send); // before the cancel
    await cronAt(m, "2026-10-23T06:07:00Z", send); // cancel is inside the settle margin: not yet
    expect(send).toHaveBeenCalledTimes(0);
    const r = await cronAt(m, "2026-10-23T06:12:00Z", send);
    expect(r).toMatchObject({ ran: true, sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(texts(send)[0]).toBe(
      "Order update:\n- 1 unconfirmed order was cancelled automatically because nobody confirmed it in time: NC-1042. Stock was put back. Call the customer if you still want the order.\nhttps://cafe.test/admin/orders",
    );
    // a second caller in the same window, and every later window, sends nothing more
    expect(await cronAt(m, "2026-10-23T06:12:40Z", send)).toEqual({ ran: false, reason: "not_due" });
    await cronAt(m, "2026-10-23T06:17:00Z", send);
    await cronAt(m, "2026-10-23T06:22:00Z", send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("several auto-cancels in one run make one message; consecutive runs never overlap or leave a gap", async () => {
    const m = memoryDb({
      now,
      tables: {
        orders: [
          autoCancelled(1050, "2026-10-23T06:10:00.100Z"),
          autoCancelled(1051, "2026-10-23T06:10:00.100Z"),
          autoCancelled(1052, "2026-10-23T06:13:59.000Z"), // right on a range edge (06:14 = 06:15 - 60 s)
          autoCancelled(1053, "2026-10-23T06:14:00.000Z"),
        ],
      },
    });
    const send = telegram();
    for (const t of ["06:02", "06:07", "06:12", "06:17", "06:22", "06:27"]) await cronAt(m, `2026-10-23T${t}:00Z`, send);
    const all = texts(send).join("\n");
    for (const n of [1050, 1051, 1052, 1053]) expect(all.match(new RegExp(`NC-${n}\\b`, "g"))?.length, `NC-${n}`).toBe(1);
    expect(texts(send)[0]).toContain("3 unconfirmed orders were cancelled automatically because nobody confirmed them in time: NC-1050, NC-1051, NC-1052.");
  });

  it("if Telegram fails, the same range is reported by the next run (cursor not advanced)", async () => {
    const m = memoryDb({ now, tables: { orders: [autoCancelled(1060, "2026-10-23T06:05:00Z")] } });
    await cronAt(m, "2026-10-23T06:07:00Z", telegram());
    const down = telegram(502);
    const r = await cronAt(m, "2026-10-23T06:12:00Z", down);
    expect(r).toMatchObject({ ran: true, sent: false });
    expect(down).toHaveBeenCalledTimes(1);
    const up = telegram();
    await cronAt(m, "2026-10-23T06:17:00Z", up);
    expect(up).toHaveBeenCalledTimes(1);
    expect(texts(up)[0]).toContain("NC-1060");
  });

  it("a cron gap (missed runs) is covered by the next run, from the last cursor", async () => {
    const m = memoryDb({ now, tables: { orders: [autoCancelled(1070, "2026-10-23T06:10:00Z"), autoCancelled(1071, "2026-10-23T06:20:00Z")] } });
    const send = telegram();
    await cronAt(m, "2026-10-23T06:07:00Z", send);
    await cronAt(m, "2026-10-23T06:32:00Z", send); // 06:12 .. 06:27 never ran
    expect(send).toHaveBeenCalledTimes(1);
    expect(texts(send)[0]).toContain("NC-1070, NC-1071");
  });

  it("long lists are cut at 15 numbers with a count of the rest", () => {
    const facts: DigestFacts = {
      autoCancelled: { count: 18, numbers: Array.from({ length: 15 }, (_, i) => `NC-${2000 + i}`) },
      heldBack: { "new-order": 0, "customer-cancel": 0, "internal-error": 0 },
      waiting: null,
    };
    const t = formatStaffDigest(facts, undefined);
    expect(t).toContain("NC-2014 and 3 more.");
    expect(t).not.toContain("http");
    expect(t.length).toBeLessThan(1000); // sendTelegram cuts at 1000 characters
  });
});

describe("staff digest: safety", () => {
  it("does nothing (no database call) when Telegram is not configured", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const m = memoryDb({ now });
    expect(await runStaffDigest(m.db, { now })).toEqual({ ran: false, reason: "not_configured" });
    expect(m.rpcCalls).toHaveLength(0);
    expect(m.ops).toHaveLength(0);
  });

  it("a database error sends nothing, never throws, and leaves the cursor for the next run", async () => {
    const m = memoryDb({ now, tables: { orders: [autoCancelled(1080, "2026-10-23T06:05:00Z")] }, fail: { tables: ["orders"] } });
    const send = telegram();
    await cronAt(m, "2026-10-23T06:07:00Z", send);
    expect(await cronAt(m, "2026-10-23T06:12:00Z", send)).toEqual({ ran: false, reason: "db_error" });
    expect(send).not.toHaveBeenCalled();
    expect(m.rows(DIGEST_CURSOR_KEY)).toHaveLength(0);
  });

  it("only one run per 5-minute window, whoever calls (the endpoint is public)", async () => {
    const m = memoryDb({ now });
    const send = telegram();
    const runs = await Promise.all(Array.from({ length: 10 }, () => cronAt(m, "2026-10-23T06:07:00Z", send)));
    expect(runs.filter((r) => r.ran)).toHaveLength(1);
    expect(m.rows(DIGEST_KEY)).toHaveLength(1);
  });

  it("messages carry order numbers and counts only", async () => {
    const m = memoryDb({
      now,
      tables: { orders: [{ ...autoCancelled(1090, "2026-10-23T06:05:00Z"), customer_name: "Asha Gurung", customer_phone: "+9779841000000", address: "Thamel" }] },
    });
    const send = telegram();
    await cronAt(m, "2026-10-23T06:07:00Z", send);
    await cronAt(m, "2026-10-23T06:12:00Z", send);
    const body = texts(send).join("\n");
    expect(body).toContain("NC-1090");
    expect(body).not.toMatch(/Asha|9841|Thamel/);
  });
});

describe("GET /api/health drives the digest (keep-alive cron every 5 minutes)", () => {
  const SALT = "s".repeat(32);
  const get = () => new Request("https://cafe.test/api/health", { headers: { "cf-connecting-ip": "198.51.100.7" } });
  const ping = { health_ping: () => ({ data: "2026-10-23T06:07:00Z", error: null }) };

  it("schedules the digest after the response when the database is up; the response is unchanged", async () => {
    const m = memoryDb({ now, rpc: ping });
    const scheduled: (() => Promise<unknown>)[] = [];
    const res = await handleHealth(get(), { db: () => m.db, salt: () => SALT, schedule: (w) => scheduled.push(w) });
    expect(res.status).toBe(200);
    expect(Object.keys(((await res.json()) as { data: object }).data)).toEqual(["db", "time"]);
    expect(scheduled).toHaveLength(1);
    await expect(scheduled[0]!()).resolves.toMatchObject({ ran: true });
  });

  it("does not schedule it when the database is down or the caller is rate-limited", async () => {
    const down = memoryDb({ now, rpc: { health_ping: () => ({ data: null, error: { code: "08006" } }) } });
    const scheduled: unknown[] = [];
    await handleHealth(get(), { db: () => down.db, salt: () => SALT, schedule: (w) => scheduled.push(w) });
    expect(scheduled).toHaveLength(0);
    const m = memoryDb({ now, rpc: ping });
    for (let i = 0; i < 31; i++) await handleHealth(get(), { db: () => m.db, salt: () => SALT, schedule: (w) => scheduled.push(w) });
    expect(scheduled).toHaveLength(30); // the 31st call is 429 and schedules nothing
  });
});

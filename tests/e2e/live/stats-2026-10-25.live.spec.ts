import { mkdirSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { devices, request as pwRequest } from "@playwright/test";
import {
  actionResult,
  callAction,
  clearLoginLimits,
  expect,
  freshIp,
  guardLocal,
  LIVE,
  noHorizontalScroll,
  one,
  OWNER,
  routeIp,
  signIn,
  sql,
  STAFF,
  test,
  TURNSTILE_TEST_TOKEN,
} from "./live-helpers";

/**
 * QA 2026-10-25 (qa-engineer): owner Stats dashboard (/admin/stats) and the staff + owner daily food log (/admin/sales),
 * api-contract 1.5.1, migrations 20261025000001/2. LIVE production build, LOCAL stack only.
 *  - Owner numbers vs. independent SQL (not the stats_* RPCs) for one custom range: food revenue, merch revenue of
 *    completed orders by Kathmandu completed_at, compare % (rounded in SQL), top food #1, best food on 3 dates,
 *    cancellation counts, stock alerts, demo-day count.
 *  - Presets, compare toggle, grain switching, demo banner on/off.
 *  - Staff: Stats blocked in the UI, in the nav and at the action (FORBIDDEN), and in the database.
 *  - Sales log: save / reload / "Saved at ... by NAME" / edit / clear with 0 / till + note set and cleared; staff
 *    refused 3 days ago; owner corrects an older date, refused a future one; price snapshot after a menu price change.
 *  - axe (WCAG A/AA) at 390 and 1280, no sideways scroll, every "Show as table".
 *  - Screenshots at 390 / 820 / 1280 into engineering/qa/screenshots/2026-10-25-stats/.
 * WRITES (LOCAL DB): food logs for TODAY and for 2026-08-10 / 2026-08-11 only (the DEMO DATA days are 2026-08-26 to
 * 2026-10-23, so none of them is written); all are deleted in afterAll. Lemon Tea's price is changed and restored.
 */
test.skip(!LIVE, "live-mode spec: set E2E_LIVE=1 and run with tests/e2e/live/playwright.live.config.ts");

const SHOTS = path.join(process.cwd(), "..", "qa", "screenshots", "2026-10-25-stats");
const AXE = path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const STAFF_ID = "05826854-dcbc-442b-afc6-dd35d669b201";
const OWNER_ID = "9768235f-366d-486d-a63a-694a3038f975";
const LEMON_TEA = "20000000-0000-4000-8000-000000000007"; // Rs. 80
const MASALA_CHAI = "20000000-0000-4000-8000-000000000006"; // Rs. 90, Large +30
const MOMO = "20000000-0000-4000-8000-000000000009"; // Steam Chicken Momo Rs. 220
const VEG_MOMO = "20000000-0000-4000-8000-000000000010"; // Rs. 180
const QA_OLD_DAY = "2026-08-10"; // Monday, before the first DEMO DATA day (2026-08-26)
const QA_OLD_DAY_2 = "2026-08-11";
const RANGE = { from: "2026-10-01", to: "2026-10-24" }; // the SQL-match range: demo days + the local shop orders

/* ---- Kathmandu dates + formatting (own copies, so the test does not trust the app's helpers) ---------------- */
const DAY = 86_400_000;
const ktmToday = () => new Date(Date.now() + 345 * 60_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ymd = (d: string) => d.split("-").map(Number) as [number, number, number];
const shortDate = (d: string) => {
  const [y, m, dd] = ymd(d);
  return `${WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]} ${dd} ${MON[m - 1]}`;
};
const rangeLabel = (f: string, t: string) => {
  const [ay, am, ad] = ymd(f);
  const [by, bm, bd] = ymd(t);
  if (f === t) return `${bd} ${MON[bm - 1]} ${by}`;
  return `${ay === by ? `${ad} ${MON[am - 1]}` : `${ad} ${MON[am - 1]} ${ay}`} to ${bd} ${MON[bm - 1]} ${by}`;
};
const fmtNpr = (p: number) => `Rs. ${new Intl.NumberFormat("en-IN", { minimumFractionDigits: p % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(p / 100)}`;
const fmtCount = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(n);
const fmtPct = (n: number) => `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1, minimumFractionDigits: n % 1 === 0 ? 0 : 1 }).format(n)}%`;
const clock = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const kdate = (col: string) => `(${col} at time zone 'Asia/Kathmandu')::date`;
const n = (q: string) => Number(one(q));

/* ---- shared ------------------------------------------------------------------------------------------------ */
let runStart = "";
let today = "";

test.beforeAll(({ baseURL }) => {
  guardLocal(baseURL);
  runStart = one("select now()");
  today = ktmToday();
  // Precondition: nothing is logged on the QA dates (today and two August days before the demo data). This spec
  // deletes only rows it created during this run, so it refuses to start if anyone's log is already there.
  expect(
    one(`select count(*) from daily_sales where business_date in ('${today}', '${QA_OLD_DAY}', '${QA_OLD_DAY_2}')`),
    "a food log already exists on a QA date; clean it up (or pick other dates) before running",
  ).toBe("0");
});
test.beforeEach(() => clearLoginLimits());

test.afterAll(async ({ baseURL }) => {
  // Clean-up: only rows this spec wrote (QA dates, created during this run, never DEMO DATA), and Lemon Tea's price.
  sql(
    `delete from daily_sales where business_date in ('${today || ktmToday()}', '${QA_OLD_DAY}', '${QA_OLD_DAY_2}') and note is distinct from 'DEMO DATA' and created_at >= '${runStart}'`,
  );
  if (one(`select price_paisa from menu_items where id = '${LEMON_TEA}'`) !== "8000") {
    const ctx = await apiAs(baseURL!, OWNER);
    await action(ctx, baseURL!, "setItemPrice", { itemId: LEMON_TEA, price: 8000 }, "/admin/menu");
    await ctx.dispose();
  }
});

async function apiAs(baseURL: string, who: { email: string; password: string }): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": `198.51.100.${who === OWNER ? 211 : 212}` } });
  const r = actionResult((await callAction(ctx, baseURL, "signIn", { ...who, turnstileToken: TURNSTILE_TEST_TOKEN }, "/admin/login")).text);
  if (!r.ok) throw new Error(`sign-in failed: ${JSON.stringify(r.error)}`);
  return ctx;
}
async function action(ctx: APIRequestContext, baseURL: string, name: string, arg: unknown, at = "/admin/stats") {
  return actionResult((await callAction(ctx, baseURL, name, arg, at)).text);
}

type AxeViolation = { id: string; impact: string; help: string; nodes: { target: string[] }[] };
async function axe(page: Page, selector = "body"): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  const v = await page.evaluate(
    async ([sel, tags]) => {
      const a = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
      const r = await a.run(document.querySelector(sel as string), { runOnly: { type: "tag", values: tags } });
      return r.violations.map((x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.map((nn) => ({ target: nn.target })) }));
    },
    [selector, AXE_TAGS] as const,
  );
  return v.map((x) => `${x.impact} ${x.id}: ${x.help} (${x.nodes.length}x, e.g. ${x.nodes.slice(0, 3).map((nn) => nn.target.join(" ")).join(" | ")})`);
}

const kpi = (page: Page, label: string) =>
  page.getByRole("region", { name: "Totals" }).getByRole("listitem").filter({ has: page.locator("p", { hasText: new RegExp(`^${label}$`) }) });
const kpiValue = (page: Page, label: string) => kpi(page, label).locator("p").nth(1);
const fact = (page: Page, term: string) =>
  page.getByRole("region", { name: "Cancellations and no-shows" }).locator("div", { has: page.locator("dt", { hasText: new RegExp(`^${term}$`) }) }).locator("dd");
/** The range is on screen in the controls AND in the live region (which only says it once the data is in). */
const shown = (page: Page, f: string, t: string) => expect(page.getByText(`Showing ${rangeLabel(f, t)}`, { exact: true })).toHaveCount(2, { timeout: 20_000 });
const loaded = (page: Page) => expect(page.getByRole("region", { name: "Stock alerts" })).toBeVisible({ timeout: 20_000 });

async function ctxAt(browser: Browser, w: number, baseURL: string) {
  const opts =
    w === 390
      ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }
      : { ...devices["Desktop Chrome"], viewport: { width: w, height: w === 820 ? 1180 : 800 }, hasTouch: w === 820 };
  const ctx = await browser.newContext({ ...opts, baseURL });
  const page = await ctx.newPage();
  await routeIp(page, freshIp(`w${w}`));
  return { ctx, page };
}

/* ================================================================================================================ */

test.describe("stats: owner numbers vs. SQL", () => {
  test(`custom range ${RANGE.from}..${RANGE.to}: KPIs, compare %, top food, best food on 3 dates, cancellations, stock alerts, demo banner`, async ({ page, ip }) => {
    void ip;
    const { from: F, to: T } = RANGE;
    const cmpTo = addDays(F, -1);
    const cmpFrom = addDays(cmpTo, -(days(F, T) - 1));
    const food = (a: string, b: string) =>
      n(`select coalesce(sum(l.qty::bigint * l.unit_price_paisa), 0) from daily_sales_lines l join daily_sales d on d.id = l.daily_sales_id where d.business_date between '${a}' and '${b}'`);
    const items = (a: string, b: string) =>
      n(`select coalesce(sum(l.qty), 0) from daily_sales_lines l join daily_sales d on d.id = l.daily_sales_id where d.business_date between '${a}' and '${b}'`);
    const merch = (a: string, b: string) =>
      one(`select coalesce(sum(total_paisa), 0) || '|' || count(*) from orders where status = 'completed' and ${kdate("completed_at")} between '${a}' and '${b}'`).split("|").map(Number) as [number, number];
    const pct = (v: number, c: number) => (c === 0 ? null : Number(one(`select round((${v} - ${c})::numeric / ${c} * 100, 1)`)));

    const foodV = food(F, T);
    const foodC = food(cmpFrom, cmpTo);
    const [merchV, merchN] = merch(F, T);
    const [merchC] = merch(cmpFrom, cmpTo);
    const totalV = foodV + merchV;
    const totalC = foodC + merchC;
    const itemsV = items(F, T);
    const loggedDays = n(`select count(*) from daily_sales where business_date between '${F}' and '${T}'`);
    const demoDays = n(`select count(*) from daily_sales where business_date between '${F}' and '${T}' and note ilike 'DEMO DATA'`);

    await signIn(page, OWNER, "/admin/stats");
    await page.goto(`/admin/stats?range=custom&from=${F}&to=${T}`);
    await loaded(page);
    await shown(page, F, T);
    await expect(page.getByText(`Changes are against ${rangeLabel(cmpFrom, cmpTo)}.`)).toBeVisible();

    // KPIs
    await expect(kpiValue(page, "Food earnings")).toHaveText(fmtNpr(foodV));
    await expect(kpiValue(page, "Merch earnings")).toHaveText(fmtNpr(merchV));
    await expect(kpiValue(page, "Total earnings")).toHaveText(fmtNpr(totalV));
    await expect(kpiValue(page, "Merch orders")).toHaveText(fmtCount(merchN));
    await expect(kpiValue(page, "Food items sold")).toHaveText(fmtCount(itemsV));
    await expect(kpiValue(page, "Average merch order")).toHaveText(merchN ? fmtNpr(Math.round(merchV / merchN)) : "No orders");
    await expect(kpi(page, "Food earnings")).toContainText(`Logged on ${fmtCount(loggedDays)} of ${fmtCount(days(F, T))} days`);
    await expect(kpi(page, "Food earnings")).toContainText(`Previous: ${fmtNpr(foodC)}`);

    // compare % maths (rounded by Postgres, half away from zero)
    const words = (p: number | null, v: number, c: number) =>
      p === null ? (c === 0 && v > 0 ? "New: none in previous period" : "None in previous period either") : p === 0 ? "Same as previous period" : `${p > 0 ? "Up" : "Down"} ${fmtPct(Math.abs(p))} on previous period`;
    const foodPct = pct(foodV, foodC);
    const totalPct = pct(totalV, totalC);
    await expect(kpi(page, "Food earnings")).toContainText(words(foodPct, foodV, foodC));
    await expect(kpi(page, "Total earnings")).toContainText(words(totalPct, totalV, totalC));
    await expect(kpi(page, "Merch earnings")).toContainText(words(pct(merchV, merchC), merchV, merchC));

    // top food #1 by quantity and by earnings (variants summed into their item)
    const top = (orderBy: string) =>
      one(
        `select coalesce(mi.name, max(l.name_snapshot)) || '|' || sum(l.qty) || '|' || sum(l.line_total_paisa) from daily_sales_lines l join daily_sales d on d.id = l.daily_sales_id left join menu_items mi on mi.id = l.menu_item_ref where d.business_date between '${F}' and '${T}' group by l.menu_item_ref, mi.name order by ${orderBy} limit 1`,
      ).split("|");
    const [qName, qQty, qRev] = top("sum(l.qty) desc, sum(l.line_total_paisa) desc, 1");
    const [rName, , rRev] = top("sum(l.line_total_paisa) desc, sum(l.qty) desc, 1");
    const firstQty = page.getByRole("list", { name: "Top food by quantity" }).getByRole("listitem").first();
    await expect(firstQty).toContainText(`1.${qName}`);
    await expect(firstQty).toContainText(`${fmtCount(Number(qQty))} sold`);
    await expect(firstQty).toContainText(fmtNpr(Number(qRev)));
    await page.getByRole("tab", { name: "By earnings" }).click();
    const firstRev = page.getByRole("list", { name: "Top food by earnings" }).getByRole("listitem").first();
    await expect(firstRev).toContainText(`1.${rName}`);
    await expect(firstRev).toContainText(fmtNpr(Number(rRev)));

    // best food per day on three logged dates (latest 14 days are on screen) + one unlogged Saturday
    const best = page.getByRole("region", { name: "Best food each day" });
    const checked: string[] = [];
    for (const d of ["2026-10-23", "2026-10-20", "2026-10-16"]) {
      const [bn, bq, br] = one(
        `select coalesce(mi.name, max(l.name_snapshot)) || '|' || sum(l.qty) || '|' || sum(l.line_total_paisa) from daily_sales_lines l join daily_sales s on s.id = l.daily_sales_id left join menu_items mi on mi.id = l.menu_item_ref where s.business_date = '${d}' group by l.menu_item_ref, mi.name having sum(l.qty) > 0 order by sum(l.qty) desc, sum(l.line_total_paisa) desc, 1 limit 1`,
      ).split("|");
      const row = best.locator("tr").filter({ has: page.locator("th", { hasText: new RegExp(`^${shortDate(d)}$`) }) });
      await expect(row.locator("td")).toHaveText([bn!, fmtCount(Number(bq)), fmtNpr(Number(br))]);
      checked.push(`${d} ${bn} x${bq} ${fmtNpr(Number(br))}`);
    }
    await expect(best.locator("tr").filter({ has: page.locator("th", { hasText: /^Sat 17 Oct$/ }) })).toContainText("Not logged");

    // cancellations (orders placed in the range, by Kathmandu created_at)
    const [placed, done, cancelled, open] = one(
      `select count(*) || '|' || count(*) filter (where status = 'completed') || '|' || count(*) filter (where status = 'cancelled') || '|' || count(*) filter (where status not in ('completed', 'cancelled')) from orders where ${kdate("created_at")} between '${F}' and '${T}'`,
    ).split("|").map(Number) as [number, number, number, number];
    const rate = (x: number) => (placed ? ` (${fmtPct(Number(one(`select round(${x}::numeric / ${placed} * 100, 1)`)))})` : "");
    await expect(fact(page, "Orders placed")).toHaveText(fmtCount(placed));
    await expect(fact(page, "Cancelled")).toHaveText(`${fmtCount(cancelled)}${rate(cancelled)}`);
    await expect(fact(page, "Completed")).toHaveText(`${fmtCount(done)}${rate(done)}`);
    await expect(fact(page, "Still open")).toHaveText(fmtCount(open));
    const reasons = sql(`select cancel_reason || '|' || count(*) from orders where status = 'cancelled' and ${kdate("created_at")} between '${F}' and '${T}' group by cancel_reason order by count(*) desc`);
    await expect(page.getByRole("list", { name: "Cancellation reasons" }).getByRole("listitem")).toHaveCount(reasons.length);

    // stock alerts: current stock, not bound to the range
    const alerts = sql(`select p.name || ', ' || v.size || ' / ' || v.colour || '|' || v.stock from product_variants v join products p on p.id = v.product_id where v.stock <= 3 order by (v.stock = 0) desc`);
    const list = page.getByRole("region", { name: "Stock alerts" }).getByRole("listitem");
    await expect(list).toHaveCount(alerts.length);
    for (const a of alerts) {
      const [name, st] = a.split("|");
      await expect(list.filter({ hasText: name! })).toContainText(st === "0" ? "Sold out" : `Only ${st} left`);
    }
    const soldOut = alerts.filter((a) => a.endsWith("|0")).length;
    for (let i = 0; i < soldOut; i++) await expect(list.nth(i)).toContainText("Sold out"); // sold out first

    // demo banner: the range holds DEMO DATA days
    expect(demoDays).toBeGreaterThan(0);
    await expect(page.getByText("Demo data", { exact: true })).toBeVisible();

    test.info().annotations.push({
      type: "sql match",
      description: `${F}..${T} vs ${cmpFrom}..${cmpTo}: food ${fmtNpr(foodV)} (prev ${fmtNpr(foodC)}, ${foodPct}%), merch ${fmtNpr(merchV)} in ${merchN} completed orders (prev ${fmtNpr(merchC)}), total ${fmtNpr(totalV)} (${totalPct}%), items ${itemsV}, logged days ${loggedDays} (demo ${demoDays}); top qty ${qName} ${qQty}; top revenue ${rName} ${fmtNpr(Number(rRev))}; best: ${checked.join("; ")}; orders placed ${placed}, completed ${done}, cancelled ${cancelled}, open ${open}, reasons ${reasons.join(",")}; stock alerts ${alerts.length} (${soldOut} sold out)`,
    });
  });

  test("getStats bundle matches SQL too: demoDataDays, compare none, a future range is empty with no demo days", async ({ baseURL }) => {
    const ctx = await apiAs(baseURL!, OWNER);
    try {
      const r = await action(ctx, baseURL!, "getStats", { from: RANGE.from, to: RANGE.to, compare: "none" });
      expect(r.ok).toBe(true);
      const b = r.data as { range: { demoDataDays: number; compareFrom: null | string; grain: string }; overview: Record<string, { value: number; changePct: number | null }> };
      expect(b.range.demoDataDays).toBe(n(`select count(*) from daily_sales where business_date between '${RANGE.from}' and '${RANGE.to}' and note ilike 'DEMO DATA'`));
      expect(b.range.compareFrom).toBeNull();
      expect(b.range.grain).toBe("day");
      expect(Object.values(b.overview).filter((m) => typeof m === "object" && m && "changePct" in m).every((m) => m.changePct === null)).toBe(true);

      const fut = { from: addDays(ktmToday(), 7), to: addDays(ktmToday(), 37) };
      const f = await action(ctx, baseURL!, "getStats", fut);
      expect(f.ok).toBe(true);
      const fb = f.data as { range: { demoDataDays: number }; overview: Record<string, { value: number | null }>; cancellations: { ordersPlaced: number } };
      expect(fb.range.demoDataDays).toBe(0);
      expect(fb.overview.totalRevenuePaisa!.value).toBe(0);
      expect(fb.overview.foodDaysLogged!.value).toBe(0);
      expect(fb.cancellations.ordersPlaced).toBe(0);

      const bad = await action(ctx, baseURL!, "getStats", { from: "2026-10-10", to: "2026-10-01" });
      expect(bad.ok).toBe(false);
      expect(bad.error?.fieldErrors?.range?.[0]).toBe("The start date must be on or before the end date.");
    } finally {
      await ctx.dispose();
    }
  });
});

test.describe("stats: owner controls", () => {
  test("presets set the range and the compare range; compare off; grain day/week/month; demo banner on demo ranges only", async ({ page, ip }) => {
    void ip;
    test.setTimeout(120_000);
    const t = ktmToday();
    const first = `${t.slice(0, 7)}-01`;
    const lastPrev = addDays(first, -1);
    const presets: [string, string, string][] = [
      ["Today", t, t],
      ["Yesterday", addDays(t, -1), addDays(t, -1)],
      ["Last 7 days", addDays(t, -6), t],
      ["Last 30 days", addDays(t, -29), t],
      ["This month", first, t],
      ["Last month", `${lastPrev.slice(0, 7)}-01`, lastPrev],
    ];
    await signIn(page, OWNER, "/admin/stats");
    const ctl = page.getByRole("region", { name: "Choose the dates" });
    await loaded(page);
    await shown(page, addDays(t, -29), t); // default: last 30 days
    const seen: string[] = [];
    for (const [label, f, to] of presets) {
      await ctl.getByText(label, { exact: true }).click();
      const cTo = addDays(f, -1);
      const cFrom = addDays(cTo, -(days(f, to) - 1));
      await shown(page, f, to); // controls + the live region: the data for this range has arrived
      await expect(page.getByText(`${rangeLabel(cFrom, cTo)} (same number of days, just before)`)).toBeVisible();
      await loaded(page);
      const demo = n(`select count(*) from daily_sales where business_date between '${f}' and '${to}' and note ilike 'DEMO DATA'`);
      await expect(page.getByText("Demo data", { exact: true })).toHaveCount(demo > 0 ? 1 : 0);
      seen.push(`${label}: ${f}..${to} vs ${cFrom}..${cTo}, demo days ${demo}`);
    }
    await expect(page).toHaveURL(/range=lastMonth/);

    // back to last 30 days: grain switching (table rows = buckets)
    await ctl.getByText("Last 30 days", { exact: true }).click();
    await shown(page, addDays(t, -29), t);
    await loaded(page);
    const from30 = addDays(t, -29);
    const chart = page.getByRole("region", { name: "Earnings over time" });
    const rows = async () => {
      await chart.getByRole("button", { name: "Show as table" }).click();
      const c = await chart.locator("tbody tr").count();
      const head = (await chart.locator("thead th").first().textContent())?.trim();
      await chart.getByRole("button", { name: "Show as chart" }).click();
      return { c, head };
    };
    // the checked chip shows a "◆" before its label, so check the radio by its accessible name
    await expect(ctl.getByRole("radio", { name: "Auto (day)" })).toBeChecked();
    await expect(chart.getByText("Earnings by day", { exact: true })).toHaveCount(1);
    expect(await rows()).toEqual({ c: 30, head: "Day" });
    await ctl.getByText("Week", { exact: true }).click();
    await expect(page).toHaveURL(/grain=week/);
    await expect(page.getByText(/chart by week, weeks start on Sunday/)).toBeVisible();
    await expect(chart.getByText("Earnings by week", { exact: true })).toHaveCount(1); // caption from the data's grain
    const firstSunday = addDays(from30, -new Date(`${from30}T00:00:00Z`).getUTCDay());
    const weeks = Math.ceil(days(firstSunday, t) / 7);
    expect(await rows()).toEqual({ c: weeks, head: "Week" });
    await expect(chart).toContainText("(part)");
    await ctl.getByText("Month", { exact: true }).click();
    await expect(page).toHaveURL(/grain=month/);
    await expect(chart.getByText("Earnings by month", { exact: true })).toHaveCount(1);
    const months = from30.slice(0, 7) === t.slice(0, 7) ? 1 : 2;
    expect(await rows()).toEqual({ c: months, head: "Month" });
    await ctl.getByText("Day", { exact: true }).click();
    await expect(chart.getByText("Earnings by day", { exact: true })).toHaveCount(1);
    expect(await rows()).toEqual({ c: 30, head: "Day" });

    // compare off
    await page.getByLabel("Compare to previous period").uncheck();
    await expect(page).toHaveURL(/compare=0/);
    await loaded(page);
    await expect(kpi(page, "Total earnings")).toContainText("No comparison");
    await expect(page.getByText(/^Changes are against/)).toHaveCount(0);
    await page.getByLabel("Compare to previous period").check();
    await loaded(page);
    await expect(page.getByText(/^Changes are against/)).toBeVisible();

    // an empty past range: no demo banner, empty state; a future end date is refused in the form
    await page.goto("/admin/stats?range=custom&from=2025-01-01&to=2025-01-31");
    await loaded(page);
    await expect(page.getByText("Nothing recorded for these dates")).toBeVisible();
    await expect(page.getByText("Demo data", { exact: true })).toHaveCount(0);
    await page.getByLabel("To", { exact: true }).fill(addDays(t, 10));
    await page.getByRole("button", { name: "Show these dates" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The end date cannot be after today." })).toBeVisible();
    await expect(page).toHaveURL(/to=2025-01-31/);
    test.info().annotations.push({ type: "presets", description: `${seen.join(" | ")}; last 30 days: 30 day rows, ${weeks} week rows, ${months} month rows` });
  });
});

test("stats: staff are blocked in the nav, on the page, at the action (FORBIDDEN) and in the database", async ({ page, ip, baseURL }) => {
  void ip;
  await signIn(page, STAFF, "/admin/stats");
  await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Stats" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Sales" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stats", level: 1 })).toBeVisible();
  await expect(page.getByText("Owner only")).toBeVisible();
  await expect(page.getByText("Total earnings")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Log today's sales" })).toHaveAttribute("href", "/admin/sales");

  const ctx = await apiAs(baseURL!, STAFF);
  try {
    const r = await action(ctx, baseURL!, "getStats", { from: RANGE.from, to: RANGE.to });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("FORBIDDEN");
    expect(JSON.stringify(r)).not.toContain("foodRevenuePaisa");
  } finally {
    await ctx.dispose();
  }
  // database backstop: the RPC itself refuses a staff actor
  expect(() => sql(`select public.stats_overview('${RANGE.from}', '${RANGE.to}', null, null, '${STAFF_ID}')`)).toThrow(/FORBIDDEN/);
});

/* ================================================================================================================ */

test.describe.serial("sales log", () => {
  const line = (date: string, item: string, variant: string | null = null) =>
    one(
      `select l.qty || '|' || l.unit_price_paisa || '|' || l.line_total_paisa from daily_sales_lines l join daily_sales d on d.id = l.daily_sales_id where d.business_date = '${date}' and l.menu_item_ref = '${item}' and l.variant_ref ${variant ? `= '${variant}'` : "is null"}`,
    );
  const header = (date: string) => one(`select coalesce(till_total_paisa::text, 'null') || '|' || coalesce(note, 'null') || '|' || updated_at || '|' || coalesce(updated_by::text, '') from daily_sales where business_date = '${date}'`);
  const qty = (page: Page, name: string) => page.getByLabel(`Quantity of ${name}`, { exact: true });
  const save = async (page: Page, by: string) => {
    await page.getByRole("button", { name: "Save" }).click();
    const banner = page.getByRole("status").getByText(new RegExp(`^Saved at \\d\\d:\\d\\d by ${by}$`));
    await expect(banner).toBeVisible();
    return (await banner.textContent())!;
  };

  test("staff: log today, reload shows 'Saved at ... by Local Staff', edit a qty, clear a line with 0, till + note set and cleared", async ({ page, ip }, info) => {
    void ip;
    test.skip(info.project.name !== "desktop-1280", "writes today's log once; the phone run covers layout/axe below");
    const largeChai = one(`select id from menu_variants where item_id = '${MASALA_CHAI}' and label = 'Large'`);
    await signIn(page, STAFF, "/admin");
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Sales" }).click();
    await expect(page.getByRole("heading", { name: "Log today's sales", level: 1 })).toBeVisible();
    await expect(page.getByText(": nothing logged yet.")).toBeVisible();
    await expect(page.getByLabel("Another day")).toHaveCount(0);
    await expect(page.getByText("Staff can log today and yesterday. Ask the owner to change older days.")).toBeVisible();

    await page.getByRole("button", { name: "One more Masala Chai", exact: true }).click();
    await page.getByRole("button", { name: "One more Masala Chai", exact: true }).click();
    await qty(page, "Steam Chicken Momo").fill("12");
    await page.getByRole("button", { name: "One more Masala Chai, Large" }).click();
    await expect(page.getByText("15 items, Rs. 2,940")).toBeVisible(); // 2 x 90 + 12 x 220 + 1 x (90 + 30)
    await expect(page.getByText("Not saved yet")).toBeVisible();
    await page.getByLabel(/^Till total for food/).fill("3,000");
    await page.getByLabel(/^Note/).fill("QA run 2026-10-25 (delete me)");
    const savedText = await save(page, "Local Staff");
    await expect(page.getByText("All saved")).toBeVisible();
    expect(line(today, MASALA_CHAI)).toBe("2|9000|18000");
    expect(line(today, MASALA_CHAI, largeChai)).toBe("1|12000|12000");
    expect(line(today, MOMO)).toBe("12|22000|264000");
    const [till, note, updatedAt, by] = header(today).split("|");
    expect([till, note, by]).toEqual(["300000", "QA run 2026-10-25 (delete me)", STAFF_ID]);
    expect(savedText).toBe(`Saved at ${clock(updatedAt!)} by Local Staff`);

    await page.reload();
    await expect(page.getByText(`Saved at ${clock(updatedAt!)} by Local Staff`, { exact: true })).toBeVisible();
    await expect(qty(page, "Masala Chai")).toHaveValue("2");
    await expect(qty(page, "Steam Chicken Momo")).toHaveValue("12");
    await expect(qty(page, "Masala Chai, Large")).toHaveValue("1");
    await expect(page.getByLabel(/^Till total for food/)).toHaveValue("3000");
    await expect(page.getByLabel(/^Note/)).toHaveValue("QA run 2026-10-25 (delete me)");

    // edit a qty: only that line changes (lines merge)
    await qty(page, "Steam Chicken Momo").fill("15");
    await expect(page.getByText("18 items, Rs. 3,600")).toBeVisible();
    await save(page, "Local Staff");
    expect(line(today, MOMO)).toBe("15|22000|330000");
    expect(line(today, MASALA_CHAI)).toBe("2|9000|18000");

    // clear a line: empty box sends qty 0
    await qty(page, "Masala Chai").fill("");
    await expect(page.getByText("16 items, Rs. 3,420")).toBeVisible();
    await save(page, "Local Staff");
    expect(line(today, MASALA_CHAI)).toBe("0|9000|0");
    await page.reload();
    await expect(qty(page, "Masala Chai")).toHaveValue("");
    await expect(qty(page, "Steam Chicken Momo")).toHaveValue("15");

    // till + note cleared
    await page.getByLabel(/^Till total for food/).fill("");
    await page.getByLabel(/^Note/).fill("");
    await save(page, "Local Staff");
    expect(header(today).split("|").slice(0, 2)).toEqual(["null", "null"]);
    await page.reload();
    await expect(page.getByLabel(/^Till total for food/)).toHaveValue("");
    await expect(page.getByLabel(/^Note/)).toHaveValue("");
    await expect(qty(page, "Steam Chicken Momo")).toHaveValue("15");
    await noHorizontalScroll(page);
  });

  test("staff are refused a date 3 days ago (app message, and the database as backstop); nothing is written", async ({ baseURL }, info) => {
    test.skip(info.project.name !== "desktop-1280", "API-level, once");
    const d3 = addDays(ktmToday(), -3);
    const before = one(`select count(*) || '|' || coalesce(max(updated_at)::text, '') from daily_sales where business_date = '${d3}'`);
    const ctx = await apiAs(baseURL!, STAFF);
    try {
      const w = await action(ctx, baseURL!, "logDailySales", { date: d3, lines: [{ menuItemId: LEMON_TEA, qty: 1 }] }, "/admin/sales");
      expect(w.ok).toBe(false);
      expect(w.error?.code).toBe("VALIDATION");
      expect(w.error?.fieldErrors?.date).toEqual(["Staff can log today and yesterday only. Ask the owner to change older days."]);
      const r = await action(ctx, baseURL!, "getDailySales", { date: d3 }, "/admin/sales");
      expect(r.ok).toBe(false);
      expect(r.error?.fieldErrors?.date).toEqual(["Staff can see today and yesterday only."]);
      // yesterday is allowed for staff (read only here: nothing is written)
      const y = await action(ctx, baseURL!, "getDailySales", { date: addDays(ktmToday(), -1) }, "/admin/sales");
      expect(y.ok).toBe(true);
    } finally {
      await ctx.dispose();
    }
    // database backstop, inside a transaction that rolls back whatever happens
    expect(() =>
      sql(`begin; select public.upsert_daily_sales('${d3}', '[{"menuItemId":"${LEMON_TEA}","qty":1}]'::jsonb, null, null, '${STAFF_ID}'); rollback;`),
    ).toThrow(/FORBIDDEN/);
    expect(one(`select count(*) || '|' || coalesce(max(updated_at)::text, '') from daily_sales where business_date = '${d3}'`)).toBe(before);
  });

  test("owner corrects an older date, is refused a future one; a menu price change leaves the old log's price alone", async ({ page, ip, baseURL }, info) => {
    void ip;
    test.skip(info.project.name !== "desktop-1280", "writes the QA dates once");
    await signIn(page, OWNER, "/admin/sales");
    await expect(page.getByRole("heading", { name: "Log today's sales", level: 1 })).toBeVisible();
    await page.getByLabel("Another day").fill(QA_OLD_DAY);
    await expect(page.getByText(/Monday 10 August 2026/).first()).toBeVisible();
    await expect(page.getByText(": nothing logged yet.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Log sales", level: 1 })).toBeVisible();
    await qty(page, "Lemon Tea").fill("3");
    await qty(page, "Veg Momo").fill("2");
    await save(page, "Local Owner");
    expect(line(QA_OLD_DAY, LEMON_TEA)).toBe("3|8000|24000");
    // the owner corrects it
    await qty(page, "Lemon Tea").fill("5");
    await save(page, "Local Owner");
    expect(line(QA_OLD_DAY, LEMON_TEA)).toBe("5|8000|40000");
    expect(line(QA_OLD_DAY, VEG_MOMO)).toBe("2|18000|36000");

    // future date: the date box ignores it, the action and the database refuse it
    const tomorrow = addDays(ktmToday(), 1);
    await page.getByLabel("Another day").fill(tomorrow);
    await expect(page.getByText(/Monday 10 August 2026/).first()).toBeVisible();
    const ctx = await apiAs(baseURL!, OWNER);
    try {
      const f = await action(ctx, baseURL!, "logDailySales", { date: tomorrow, lines: [{ menuItemId: LEMON_TEA, qty: 1 }] }, "/admin/sales");
      expect(f.ok).toBe(false);
      expect(f.error?.fieldErrors?.date).toEqual(["This date is in the future."]);
      expect(() => sql(`begin; select public.upsert_daily_sales('${tomorrow}', '[]'::jsonb, null, null, '${OWNER_ID}'); rollback;`)).toThrow(/VALIDATION/);
      expect(one(`select count(*) from daily_sales where business_date > '${ktmToday()}'`)).toBe("0");

      // price snapshot: Lemon Tea Rs. 80 -> Rs. 95
      const p = await action(ctx, baseURL!, "setItemPrice", { itemId: LEMON_TEA, price: 9500 }, "/admin/menu");
      expect(p.ok, JSON.stringify(p.error)).toBe(true);
      try {
        await page.reload();
        await page.getByLabel("Another day").fill(QA_OLD_DAY);
        await expect(qty(page, "Lemon Tea")).toHaveValue("5");
        const lemonRow = page.locator("li", { has: qty(page, "Lemon Tea") }).first();
        await expect(lemonRow).toContainText("Rs. 80");
        await expect(lemonRow).toContainText("(price when first logged)");
        await qty(page, "Lemon Tea").fill("6");
        await save(page, "Local Owner");
        expect(line(QA_OLD_DAY, LEMON_TEA)).toBe("6|8000|48000"); // a count correction keeps the old price
        // a NEW line takes today's price; a client-sent price is ignored
        const nl = await action(ctx, baseURL!, "logDailySales", { date: QA_OLD_DAY_2, lines: [{ menuItemId: LEMON_TEA, qty: 2, unitPricePaisa: 1 }] }, "/admin/sales");
        expect(nl.ok, JSON.stringify(nl.error)).toBe(true);
        expect(line(QA_OLD_DAY_2, LEMON_TEA)).toBe("2|9500|19000");
        expect(line(QA_OLD_DAY, LEMON_TEA)).toBe("6|8000|48000");
      } finally {
        const back = await action(ctx, baseURL!, "setItemPrice", { itemId: LEMON_TEA, price: 8000 }, "/admin/menu");
        expect(back.ok).toBe(true);
      }
      expect(one(`select price_paisa from menu_items where id = '${LEMON_TEA}'`)).toBe("8000");
    } finally {
      await ctx.dispose();
    }
  });
});

/* ================================================================================================================ */

test("a11y: axe clean and no sideways scroll on Stats (owner) and Sales (staff, owner); every 'Show as table' works", async ({ page, ip }, info) => {
  void ip;
  test.setTimeout(120_000);
  await signIn(page, OWNER, "/admin/stats");
  await loaded(page);
  expect(await axe(page, "#admin-main")).toEqual([]);
  await noHorizontalScroll(page);
  const toggles = page.getByRole("button", { name: "Show as table" });
  const count = await toggles.count();
  expect(count).toBeGreaterThanOrEqual(3); // earnings, busiest hours, food by weekday
  for (let i = 0; i < count; i++) {
    const btn = page.getByRole("button", { name: /Show as (table|chart)/ }).nth(i);
    await btn.click();
    await expect(btn).toHaveText("Show as chart");
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    const tbl = page.locator(`[id="${await btn.getAttribute("aria-controls")}"]`);
    await expect(tbl.getByRole("table")).toBeVisible();
    expect(await tbl.locator("tbody tr").count()).toBeGreaterThan(0);
  }
  expect(await axe(page, "#admin-main"), "with every table open").toEqual([]);
  await noHorizontalScroll(page);
  await page.goto("/admin/sales");
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  expect(await axe(page, "#admin-main"), "sales, owner").toEqual([]);
  await noHorizontalScroll(page);

  await page.context().clearCookies();
  await signIn(page, STAFF, "/admin/sales");
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  expect(await axe(page, "#admin-main"), "sales, staff").toEqual([]);
  await noHorizontalScroll(page);
  await page.goto("/admin/stats");
  await expect(page.getByText("Owner only")).toBeVisible();
  expect(await axe(page, "#admin-main"), "stats, staff").toEqual([]);
  test.info().annotations.push({ type: "a11y", description: `${info.project.name}: ${count} chart tables` });
});

test("screenshots: stats presets (owner), sales today and saved (staff) at 390 / 820 / 1280", async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== "desktop-1280", "all three widths from the desktop project");
  test.setTimeout(300_000);
  mkdirSync(SHOTS, { recursive: true });
  for (const w of [390, 820, 1280]) {
    const { ctx, page } = await ctxAt(browser, w, baseURL!);
    try {
      clearLoginLimits();
      await signIn(page, OWNER, "/admin/stats");
      for (const [q, name] of [
        ["range=last30Days", "last30"],
        ["range=last7Days", "last7"],
        ["range=thisMonth", "thismonth"],
        ["range=lastMonth&grain=week", "lastmonth-week"],
        ["range=today", "today"],
        [`range=custom&from=${RANGE.from}&to=${RANGE.to}`, "custom-oct"],
        ["range=custom&from=2025-01-01&to=2025-01-31", "empty"],
      ] as const) {
        await page.goto(`/admin/stats?${q}`);
        await loaded(page);
        await page.screenshot({ path: path.join(SHOTS, `stats-owner-${name}-${w}.png`), fullPage: true });
      }
      const earn = page.getByRole("region", { name: "Earnings over time" });
      await page.goto("/admin/stats?range=last30Days");
      await loaded(page);
      await earn.getByRole("button", { name: "Show as table" }).click();
      await earn.screenshot({ path: path.join(SHOTS, `stats-owner-earnings-table-${w}.png`) });
      await ctx.clearCookies();
      clearLoginLimits();
      await signIn(page, STAFF, "/admin/stats");
      await expect(page.getByText("Owner only")).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `stats-staff-blocked-${w}.png`), fullPage: true });
      await page.goto("/admin/sales");
      await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `sales-staff-today-${w}.png`), fullPage: true });
      const q = page.getByLabel("Quantity of Lemon Tea", { exact: true });
      await q.fill(String(w === 390 ? 4 : w === 820 ? 5 : 6));
      await page.screenshot({ path: path.join(SHOTS, `sales-staff-unsaved-${w}.png`) });
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("status").getByText(/^Saved at \d\d:\d\d by Local Staff$/)).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(SHOTS, `sales-staff-saved-${w}.png`) });
      await page.reload();
      await expect(page.getByText(/^Saved at \d\d:\d\d by Local Staff$/)).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `sales-staff-reloaded-${w}.png`) });
    } finally {
      await ctx.close();
    }
  }
});

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { devices } from "@playwright/test";
import {
  actionResult,
  addToteToCart,
  apiCheckout,
  callAction,
  clearLoginLimits,
  expect,
  freshIp,
  guardLocal,
  LIVE,
  noHorizontalScroll,
  OWNER,
  routeIp,
  signIn,
  sql,
  STAFF,
  test,
  waitForTurnstile,
} from "./live-helpers";

/**
 * QA 2026-10-24 rebuild (qa-engineer), LIVE mode, LOCAL stack only. Re-tests the frontend fixes made after the
 * restyle review and the 2026-10-24 QA run:
 *  - R24-3: exactly one menu tab is current at load (the first) and while scrolled (Momo)
 *  - BUG-017: real 80-character rows (English word, Nepali name, "Say it", Portuguese word) wrap; the name never covers
 *    the price; admin list does not scroll sideways either. QA rows are deleted through deleteMenuItem afterwards.
 *  - R24-6: compact admin row: "Change price" in place, focus in, Esc closes, focus returns, and a saved price change
 *  - Manager's hours change: times read "07:00" in the body face (not Marcellus, where 0 looked like O)
 *  - R24-9: live Home has one page-level notice (the DraftNote), no "Sample data"
 *  - the design review's re-shoot list at 390 / 820 / 1280 into engineering/qa/screenshots/2026-10-24-rebuild/
 */
test.skip(!LIVE, "live-mode spec: set E2E_LIVE=1 and run with tests/e2e/live/playwright.live.config.ts");
test.beforeAll(({ baseURL }) => {
  guardLocal(baseURL);
  clearLoginLimits();
});

// 2026-10-25: the 2026-10-24-rebuild shots are now the "before" set of the spacing spec, so later runs of this
// re-shoot write into test-results instead of overwriting them. The after set comes from spacing-2026-10-25.live.spec.ts.
const SHOTS = process.env.E2E_RESHOOT_2026_10_24_DIR ?? path.join(process.cwd(), "test-results", "live", "reshoot-2026-10-24");
const DESSERTS = "10000000-0000-4000-8000-000000000005";

async function dropQaItems(page?: Page, baseURL?: string) {
  const ids = sql(`select id from menu_items where name like 'QA%' and deleted_at is null`);
  if (page && baseURL)
    for (const itemId of ids) actionResult((await callAction(page.request, baseURL, "deleteMenuItem", { itemId }, "/admin/menu")).text);
  sql(`delete from menu_variants where item_id in (select id from menu_items where name like 'QA%')`);
  sql(`delete from menu_items where name like 'QA%'`);
}

test("R24-3: exactly one menu tab is current at load (the first), and exactly one (Momo) when scrolled to Momo", async ({ page, ip }) => {
  void ip;
  await page.goto("/menu");
  const nav = page.getByRole("navigation", { name: "Menu categories" });
  await expect(nav.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(nav.getByRole("link").first()).toHaveAttribute("aria-current", "true");
  const momo = nav.getByRole("link", { name: /Momo/ }).first();
  const href = (await momo.getAttribute("href"))!;
  // QA 2026-10-25: for ~0.3-0.6 s after load the streamed page sits in a hidden container next to loading.tsx's
  // <main>, so #cat-momo exists twice (one 0 px tall). Wait until React has swapped it in.
  await expect(page.locator(href)).toHaveCount(1, { timeout: 10_000 });
  await page.locator(href).scrollIntoViewIfNeeded();
  await page.locator(href).evaluate((el) => el.scrollIntoView({ block: "start" }));
  // 2026-10-25, S25-8: from lg (1024 px) the menu is two ledger columns. Momo can then share the top line with a
  // left-column category, so scrolling alone may light either one (design accepted the left column in S25-8). At lg
  // this test asserts: exactly one current tab, and its section is at the top of the reading area; then a click on
  // Momo lights Momo at once and keeps it. Below lg (one column) the original assertion stands unchanged.
  if (page.viewportSize()!.width < 1024) {
    await expect(momo).toHaveAttribute("aria-current", "true", { timeout: 5_000 });
  } else {
    await page.waitForTimeout(1_000);
    const cur = nav.locator('[aria-current="true"]');
    await expect(cur).toHaveCount(1);
    const curHref = (await cur.getAttribute("href"))!;
    const momoTop = (await page.locator(href).boundingBox())!.y;
    const box = (await page.locator(curHref).boundingBox())!;
    expect(box.y, `${curHref} starts below Momo's line`).toBeLessThanOrEqual(momoTop + 1);
    expect(box.y + box.height, `${curHref} is already scrolled past`).toBeGreaterThan(momoTop);
    test.info().annotations.push({ type: "R24-3 lg", description: `scrolled to ${href}: current tab ${curHref}` });
    await momo.click();
    await expect(momo).toHaveAttribute("aria-current", "true", { timeout: 300 });
    await page.waitForTimeout(1_200);
    await expect(momo).toHaveAttribute("aria-current", "true");
  }
  await expect(nav.locator('[aria-current="true"]')).toHaveCount(1);
});

test("BUG-017: real 80-character DB rows wrap in every language; the name never covers the price; admin list fits", async ({ page, baseURL, ip }, info) => {
  void ip;
  test.setTimeout(120_000);
  await dropQaItems();
  const EN = `QA${"x".repeat(78)}`; // 80 characters, no break opportunity
  expect([...EN].length).toBe(80);
  try {
    await signIn(page, OWNER, "/admin/menu");
    const r = actionResult(
      (
        await callAction(page.request, baseURL!, "upsertMenuItem", {
          categoryId: DESSERTS,
          name: EN,
          description: `QA${"y".repeat(238)}`,
          price: 10000,
          diet: "veg",
          tags: [],
          isVisible: true,
          variants: [],
          translations: {
            ne: { name: "कि".repeat(40), pronunciation: "ki".repeat(40) },
            pt: { name: "Pão".repeat(26) + "ab" },
            ja: { name: "卵".repeat(80) },
          },
        }, "/admin/menu")
      ).text,
    );
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(Number(sql(`select length(name) from menu_items where name = '${EN}'`)[0])).toBe(80);
    const measures: string[] = [];
    for (const l of ["none", "ne", "pt", "ja"]) {
      await page.goto("/menu");
      await page.getByLabel("Language").selectOption(l);
      const li = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3, name: /QAx+/ }) });
      await expect(li).toBeVisible({ timeout: 15_000 });
      await li.scrollIntoViewIfNeeded();
      await noHorizontalScroll(page);
      const m = await li.evaluate((el) => {
        const name = el.querySelector("h3")!.getBoundingClientRect();
        const price = el.querySelector(".price")!.getBoundingClientRect();
        const row = el.getBoundingClientRect();
        const kids = [...el.querySelectorAll<HTMLElement>("*")].map((k) => k.getBoundingClientRect().right);
        return { nameRight: name.right, priceLeft: price.left, priceRight: price.right, rowRight: row.right, maxRight: Math.max(...kids) };
      });
      measures.push(`${l}: name..${Math.round(m.nameRight)} price ${Math.round(m.priceLeft)}..${Math.round(m.priceRight)} row ..${Math.round(m.rowRight)} widest child ..${Math.round(m.maxRight)}`);
      expect(m.nameRight, `${l}: the name runs into the price`).toBeLessThanOrEqual(m.priceLeft + 0.5);
      expect(m.maxRight, `${l}: something sticks out of the row`).toBeLessThanOrEqual(m.rowRight + 0.5);
      if (l === "ne") await expect(li.locator('[lang="ne-Latn"]')).toHaveText("ki".repeat(40));
      await page.screenshot({ path: path.join(process.cwd(), "test-results", "live", `BUG-017-rebuild-${l}-${info.project.name}.png`) });
    }
    test.info().annotations.push({ type: "BUG-017", description: measures.join(" | ") });
    await page.goto("/admin/menu");
    await expect(page.getByText(EN).first()).toBeVisible();
    await noHorizontalScroll(page);
  } finally {
    await dropQaItems(page, baseURL!);
  }
  expect(sql(`select count(*) from menu_items where name like 'QA%'`)[0]).toBe("0");
});

test("R24-6: compact admin row: 'Change price' opens in place with focus in the field; Esc closes and focus returns; a saved change sticks", async ({ page, ip }) => {
  void ip;
  const before = sql(`select price_paisa from menu_items where name = 'Espresso' and deleted_at is null`)[0]!;
  await signIn(page, OWNER, "/admin/menu");
  const row = page.getByRole("listitem").filter({ has: page.getByText("Espresso", { exact: true }) }).first();
  await expect(row.getByLabel("Price (Rs.)")).toHaveCount(0);
  const change = row.getByRole("button", { name: "Change price" });
  await expect(change).toHaveAttribute("aria-expanded", "false");
  // "Mark sold out" sits top-right, on the same line as the name
  const toggle = await row.getByRole("button", { name: /Mark sold out|Back in stock/ }).boundingBox();
  const name = await row.getByText("Espresso", { exact: true }).boundingBox();
  expect(Math.abs(toggle!.y - name!.y)).toBeLessThan(24);
  await change.click();
  const field = row.getByLabel("Price (Rs.)");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row.getByLabel("Price (Rs.)")).toHaveCount(0);
  await expect(change).toBeFocused();
  // save a change through the in-place form, then put it back
  try {
    await change.click();
    await row.getByLabel("Price (Rs.)").fill(String(Number(before) / 100 + 5));
    await row.getByRole("button", { name: "Save price" }).click();
    await expect(row.getByLabel("Price (Rs.)")).toHaveCount(0);
    await expect.poll(() => sql(`select price_paisa from menu_items where name = 'Espresso' and deleted_at is null`)[0]).toBe(String(Number(before) + 500));
    await expect(change).toBeFocused();
  } finally {
    await change.click();
    await row.getByLabel("Price (Rs.)").fill(String(Number(before) / 100));
    await row.getByRole("button", { name: "Save price" }).click();
    await expect.poll(() => sql(`select price_paisa from menu_items where name = 'Espresso' and deleted_at is null`)[0]).toBe(before);
  }
});

// Updated 2026-10-25 (S25 spacing pass, Manager decision): Home "Find us" shows only today's hours on one line
// (data-testid="today-hours"); the full week table is on /visit only. Same font checks on both, plus: Home has no
// table, and Home's line agrees with today's (Kathmandu) row of the Visit table.
test("hours: full week table on Visit and today's line on Home, both in the body face (not the display face)", async ({ page, ip }) => {
  void ip;
  await page.goto("/visit");
  const table = page.getByRole("table", { name: "Opening hours by day" });
  await expect(table).toBeVisible();
  const r = await table.evaluate((t) => {
    const h1 = getComputedStyle(document.querySelector("h1")!).fontFamily;
    return [...t.querySelectorAll("tr")].map((tr) => {
      const td = tr.querySelector("td")!;
      return { day: (tr.querySelector("th") as HTMLElement).innerText.trim(), text: (td as HTMLElement).innerText.trim(), font: getComputedStyle(td).fontFamily, h1 };
    });
  });
  expect(r.length).toBe(7);
  for (const c of r) {
    expect(c.text).toMatch(/^(Closed|\d{2}:\d{2} to \d{2}:\d{2}(, \d{2}:\d{2} to \d{2}:\d{2})*)$/);
    expect(c.font, `/visit: "${c.text}" uses the display face`).not.toBe(c.h1);
    expect(c.font.toLowerCase()).not.toContain("marcellus");
  }
  test.info().annotations.push({ type: "hours /visit", description: `${r.map((c) => `${c.day} ${c.text}`).join(" | ")} ; font ${r[0]!.font.slice(0, 60)}` });

  await page.goto("/");
  await expect(page.getByRole("table", { name: "Opening hours by day" })).toHaveCount(0);
  const today = page.locator("main").getByTestId("today-hours");
  await expect(today).toHaveCount(1);
  await expect(today).toHaveText(/^(Today: \d{2}:\d{2} to \d{2}:\d{2}(, \d{2}:\d{2} to \d{2}:\d{2})*|Closed today.*)$/);
  const line = await today.evaluate((p) => ({
    text: (p as HTMLElement).innerText.trim(),
    font: getComputedStyle(p).fontFamily,
    h1: getComputedStyle(document.querySelector("h1")!).fontFamily,
  }));
  expect(line.font, `/: "${line.text}" uses the display face`).not.toBe(line.h1);
  expect(line.font.toLowerCase()).not.toContain("marcellus");
  // The same day as the Visit table, worked out in Kathmandu time (no closure is set for today in the local data).
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "Asia/Kathmandu" }).format(new Date());
  const row = r.find((c) => weekday.toLowerCase().startsWith(c.day.toLowerCase().slice(0, 3)));
  expect(row, `no Visit row for ${weekday}`).toBeTruthy();
  if (row!.text === "Closed") expect(line.text).toMatch(/^Closed today/);
  else expect(line.text).toBe(`Today: ${row!.text}`);
  test.info().annotations.push({ type: "hours /", description: `${line.text} (${weekday}) ; font ${line.font.slice(0, 60)}` });
});

test("R24-9: live Home shows one page-level notice (the draft-copy note), no 'Sample data'", async ({ page, ip }) => {
  void ip;
  await page.goto("/");
  const main = page.locator("main");
  await expect(main.getByText("Placeholder:", { exact: true })).toHaveCount(1);
  await expect(main.getByText(/Sample data/)).toHaveCount(0);
  const note = await main.getByText("Placeholder:", { exact: true }).boundingBox();
  const h1 = await page.locator("#home-title").boundingBox();
  expect(note!.y).toBeLessThan(h1!.y);
});

/** Opens a fresh context at the given width (390 = Pixel 7 emulation, others desktop Chrome; 820 with touch). */
async function ctxAt(browser: Browser, w: number, ip: string) {
  const opts =
    w === 390
      ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }
      : { ...devices["Desktop Chrome"], viewport: { width: w, height: w === 820 ? 1180 : 800 }, hasTouch: w === 820 };
  const ctx = await browser.newContext({ ...opts, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  await routeIp(page, ip);
  return { ctx, page };
}

test("re-shoot list (design review 2026-10-24) at 390 / 820 / 1280", async ({ browser, request }, info) => {
  test.skip(info.project.name !== "desktop-1280", "taken once, from the desktop project");
  test.setTimeout(420_000);
  mkdirSync(SHOTS, { recursive: true });
  const o = await apiCheckout(request, freshIp(info.project.name), { name: "Screenshot QA" });
  expect(o.status).toBe(201);
  const token = o.body.data.orderToken as string;
  const overflow: string[] = [];
  try {
    for (const w of [390, 820, 1280]) {
      const { ctx, page } = await ctxAt(browser, w, freshIp(info.project.name));
      const shot = async (name: string) => {
        const vw = page.viewportSize()!.width;
        const over = await page.evaluate((v) => document.documentElement.scrollWidth - v, vw);
        if (over > 0) overflow.push(`${name}@${w}: ${over}px`);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: true });
      };
      for (const [name, url] of [
        ["home", "/"],
        ["menu-top", "/menu"],
        ["shop", "/shop"],
        ["product", "/shop/nailed-classic-tee"],
        ["story", "/story"],
        ["visit", "/visit"],
      ] as const) {
        await page.goto(url);
        await page.waitForLoadState("networkidle");
        await shot(name);
      }
      // Menu scrolled to Momo: a viewport shot (that is what a guest sees), plus the tab state
      await page.goto("/menu");
      await page.waitForLoadState("networkidle");
      const nav = page.getByRole("navigation", { name: "Menu categories" });
      const momo = nav.getByRole("link", { name: /Momo/ }).first();
      // From lg the menu has two columns and Momo sits in the right one: scrolling may light the left column's tab
      // (S25-8), so the guest's way there, a tab click, is used at 1280. One column below lg: scroll as before.
      if (w >= 1024) await momo.click();
      else await page.locator((await momo.getAttribute("href"))!).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await expect(momo).toHaveAttribute("aria-current", "true", { timeout: 5_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `menu-momo-${w}.png`) });
      // Checkout with the widget loaded
      await addToteToCart(page);
      await page.goto("/checkout");
      await waitForTurnstile(page);
      await page.waitForTimeout(500);
      await shot("checkout");
      // Order placed
      await page.goto(`/order/${token}`);
      await expect(page.getByRole("list", { name: "Order progress" })).toBeVisible();
      await shot("order-placed");
      // Admin menu: owner, then staff
      for (const [who, cred] of [["owner", OWNER], ["staff", STAFF]] as const) {
        await ctx.clearCookies();
        await signIn(page, cred, "/admin/menu");
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(`admin-menu-${who}`);
      }
      await ctx.close();
    }
  } finally {
    await request.post(`/api/orders/${token}/cancel`, { headers: { "cf-connecting-ip": freshIp(info.project.name) } });
  }
  test.info().annotations.push({ type: "overflow", description: overflow.join(" | ") || "none" });
  expect(overflow, "horizontal overflow on a re-shoot page").toEqual([]);
});

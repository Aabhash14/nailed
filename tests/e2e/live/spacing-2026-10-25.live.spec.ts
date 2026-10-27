import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { devices } from "@playwright/test";
import {
  addToteToCart,
  apiCheckout,
  clearLoginLimits,
  expect,
  freshIp,
  guardLocal,
  LIVE,
  one,
  OWNER,
  routeIp,
  signIn,
  STAFF,
  test,
  waitForTurnstile,
} from "./live-helpers";

/**
 * QA 2026-10-25 spacing pass (qa-engineer), LIVE production build, LOCAL stack only. Checks the frontend's S25-1..S25-15
 * (S25-12 skipped by Manager decision) from design/ui/spacing-fix-2026-10-25.md:
 *  - S25-1: no bare strip above the footer on Home (`has-[>main[data-flush-end]]:pb-0` is in the CSS and applies),
 *    other pages end with section-sm; the phone footer has two link columns side by side; footer links >= 44 px
 *  - S25-8: the desktop menu is two ledger columns from lg; no category is split; a tab click lights the tab at once
 *  - S25-9: order page summary on the right at lg; "Back to the shop" lines up with the content above
 *  - S25-11 / R24-10: admin rows: axe, 44 px targets, option buttons "Mark Large sold out" / "Large sold out · Restore"
 *  - S25-4: Visit focus order (address map link, phone, email) and nothing focusable in the photo
 *  - axe-core (WCAG 2.0/2.1/2.2 A + AA rules) on the admin menu (owner + staff), Home footer at 390, menu at 1280, Visit
 *  - section 4 heights and the section 6 re-shoot list at 390 / 820 / 1280 into engineering/qa/screenshots/spacing-2026-10-25-prod/
 * Writes to the LOCAL database only: one Americano option toggled and restored, one order placed and cancelled.
 */
test.skip(!LIVE, "live-mode spec: set E2E_LIVE=1 and run with tests/e2e/live/playwright.live.config.ts");
test.beforeAll(({ baseURL }) => {
  guardLocal(baseURL);
  clearLoginLimits();
});

const SHOTS = path.join(process.cwd(), "..", "qa", "screenshots", "spacing-2026-10-25-prod");
const AXE = path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type AxeViolation = { id: string; impact: string; help: string; nodes: { target: string[] }[] };
/** Runs axe-core (WCAG A/AA rules) on `selector` and returns a readable list of violations. */
async function axe(page: Page, selector = "body"): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  const v = await page.evaluate(
    async ([sel, tags]) => {
      const a = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
      const r = await a.run(document.querySelector(sel as string), { runOnly: { type: "tag", values: tags } });
      return r.violations.map((x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.map((n) => ({ target: n.target })) }));
    },
    [selector, AXE_TAGS] as const,
  );
  return v.map((x) => `${x.impact} ${x.id}: ${x.help} (${x.nodes.length}x, e.g. ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")})`);
}

/**
 * Every visible button and link inside `selector` is at least 44 px tall and `minW` px wide (default 44: the studio's
 * 44 x 44 rule). Text links in running copy are excluded.
 */
async function smallTargets(page: Page, selector: string, minW = 44) {
  return page.evaluate(([sel, mw]) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(`${sel} a[href], ${sel} button, ${sel} [role=button]`)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (el.closest("p") && el.tagName === "A" && !el.className.includes("min-h-tap")) continue; // inline text link
      if (r.height < 44 || r.width < (mw as number)) out.push(`${(el.innerText || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 40)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, [selector, minW] as const);
}

test("S25-1: the flush-end variant is in the production CSS; Home has no strip above the footer; other pages end with section-sm", async ({ page, ip }, info) => {
  void ip;
  const phone = info.project.name.startsWith("phone");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // 1. the compiled rule exists in a stylesheet the page loaded
  const rule = await page.evaluate(() => {
    for (const s of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = s.cssRules;
      } catch {
        continue;
      }
      const walk = (list: CSSRuleList): string | null => {
        for (const r of [...list]) {
          if (r instanceof CSSStyleRule && /:has\(\s*>\s*main\[data-flush-end\]\s*\)/.test(r.selectorText)) return `${r.selectorText} { ${r.style.cssText} }`;
          if ("cssRules" in r && (r as CSSGroupingRule).cssRules) {
            const hit = walk((r as CSSGroupingRule).cssRules);
            if (hit) return hit;
          }
        }
        return null;
      };
      const hit = walk(rules);
      if (hit) return { href: s.href, hit };
    }
    return null;
  });
  expect(rule, "has-[>main[data-flush-end]]:pb-0 is missing from the production CSS").not.toBeNull();
  expect(rule!.hit).toMatch(/padding-bottom:\s*(0(px)?|calc\(var\(--spacing\)\s*\*\s*0\))/);
  // 2. it applies on Home: #main has no bottom padding, and the last section sits right on the footer
  const home = await page.evaluate(() => {
    const main = document.getElementById("main")!;
    const footer = main.nextElementSibling as HTMLElement;
    const sections = main.querySelectorAll(":scope > main > *");
    const last = sections[sections.length - 1] as HTMLElement;
    return {
      flush: main.querySelector(":scope > main")!.hasAttribute("data-flush-end"),
      pb: getComputedStyle(main).paddingBottom,
      gap: footer.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
    };
  });
  expect(home.flush).toBe(true);
  expect(home.pb).toBe("0px");
  expect(Math.abs(home.gap), `bare strip of ${home.gap}px above the footer on Home`).toBeLessThanOrEqual(1);
  // 3. other pages: #main ends with section-sm (28 px at 390, 44 px at 1280), and the footer adds no margin
  for (const url of ["/shop", "/visit", "/story", "/menu"]) {
    await page.goto(url);
    const r = await page.evaluate(() => {
      const main = document.getElementById("main")!;
      const footer = main.nextElementSibling as HTMLElement;
      return { pb: parseFloat(getComputedStyle(main).paddingBottom), mt: getComputedStyle(footer).marginTop, tag: footer.tagName };
    });
    expect(r.tag).toBe("FOOTER");
    expect(r.mt).toBe("0px");
    expect(r.pb, `${url} bottom padding`).toBeCloseTo(phone ? 28 : 44, 0);
  }
  test.info().annotations.push({ type: "S25-1", description: `${rule!.hit} (in ${rule!.href?.split("/").pop()}); Home gap ${home.gap}px` });
});

test("S25-1: phone footer: two link columns side by side, links 44 px tall (>= 24 px wide), axe clean", async ({ page, ip }, info) => {
  void ip;
  await page.goto("/");
  const navs = page.locator("#main + footer nav");
  await expect(navs).toHaveCount(2);
  const [a, b] = [await navs.nth(0).boundingBox(), await navs.nth(1).boundingBox()];
  const footer = (await page.locator("#main + footer").boundingBox())!;
  if (info.project.name.startsWith("phone")) {
    expect(Math.abs(a!.y - b!.y), "the two link columns start on the same line").toBeLessThanOrEqual(1);
    expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);
  }
  // Footer links are inline text links with a 44 px tall row (min-h-tap). Short words are narrower than 44 px
  // ("Menu" 38, "Shop" 34; unchanged by S25-1). Required here: 44 px tall and the WCAG 2.2 AA 2.5.8 minimum of 24 px
  // wide; anything under 44 wide is recorded for the report.
  expect(await smallTargets(page, "#main + footer", 24)).toEqual([]);
  test.info().annotations.push({ type: "footer under 44 wide", description: (await smallTargets(page, "#main + footer")).join(" | ") || "none" });
  expect(await axe(page, "#main + footer")).toEqual([]);
  test.info().annotations.push({ type: "footer", description: `${info.project.name}: footer ${Math.round(footer.height)}px; columns at x ${Math.round(a!.x)} / ${Math.round(b!.x)}, y ${Math.round(a!.y)} / ${Math.round(b!.y)}` });
});

test("S25-8: menu at lg is two ledger columns, no category split, a tab click lights its tab at once; axe clean; tabs >= 44 px", async ({ page, ip }, info) => {
  void ip;
  test.skip(info.project.name.startsWith("phone"), "lg only (phones keep one column; covered by the re-shoot)");
  await page.goto("/menu");
  await page.waitForLoadState("networkidle");
  const layout = await page.evaluate(() => {
    const first = document.querySelector("section.break-inside-avoid")!;
    const wrap = first.parentElement!;
    const secs = [...wrap.children] as HTMLElement[];
    const mid = wrap.getBoundingClientRect().left + wrap.getBoundingClientRect().width / 2;
    return {
      columns: getComputedStyle(wrap).columnCount,
      width: wrap.getBoundingClientRect().width,
      left: secs.filter((s) => s.getBoundingClientRect().left < mid).length,
      right: secs.filter((s) => s.getBoundingClientRect().left >= mid).length,
      split: secs.filter((s) => s.getClientRects().length > 1).map((s) => s.id),
      colWidth: secs[0]!.getBoundingClientRect().width,
      rightIds: secs.filter((s) => s.getBoundingClientRect().left >= mid).map((s) => s.id),
    };
  });
  expect(layout.columns).toBe("2");
  expect(layout.left).toBeGreaterThan(0);
  expect(layout.right).toBeGreaterThan(0);
  expect(layout.split, "a category is split across the two columns").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // tab click on a right-column category: current at once, and still current after the observer settles
  const nav = page.getByRole("navigation", { name: "Menu categories" });
  const target = nav.locator(`a[href="#${layout.rightIds[0]}"]`);
  await target.click();
  await expect(target).toHaveAttribute("aria-current", "true", { timeout: 300 });
  await page.waitForTimeout(1_200);
  await expect(target).toHaveAttribute("aria-current", "true");
  await expect(nav.locator('[aria-current="true"]')).toHaveCount(1);
  expect(await smallTargets(page, 'nav[aria-label="Menu categories"]')).toEqual([]);
  expect(await axe(page, "#main")).toEqual([]);
  test.info().annotations.push({ type: "menu-lg", description: `${layout.left} + ${layout.right} categories, column ${Math.round(layout.colWidth)}px of ${Math.round(layout.width)}px; clicked #${layout.rightIds[0]}` });
});

test("S25-9: order page at lg: summary on the right; 'Back to the shop' text lines up with the content", async ({ page, ip, request }, info) => {
  void ip;
  const o = await apiCheckout(request, freshIp(info.project.name), { name: "Spacing QA" });
  expect(o.status).toBe(201);
  const token = o.body.data.orderToken as string;
  try {
    await page.goto(`/order/${token}`);
    await expect(page.getByRole("list", { name: "Order progress" })).toBeVisible();
    const m = await page.evaluate(() => {
      const h1 = document.querySelector("main h1")!.getBoundingClientRect();
      const what = [...document.querySelectorAll("main h2")].find((h) => /What you ordered/.test(h.textContent ?? ""))!.getBoundingClientRect();
      const back = [...document.querySelectorAll("main a")].find((a) => /Back to the shop/.test(a.textContent ?? ""))!;
      const range = document.createRange();
      range.selectNodeContents(back);
      const text = range.getBoundingClientRect();
      const colLeft = (back.closest("div.space-y-6") as HTMLElement).getBoundingClientRect().left;
      return { h1Left: h1.left, h1Bottom: h1.bottom, whatLeft: what.left, whatTop: what.top, backText: text.left, colLeft };
    });
    if (!info.project.name.startsWith("phone")) {
      expect(m.whatLeft, "'What you ordered' should sit in the right column").toBeGreaterThan(m.h1Left + 400);
      expect(m.whatTop, "the summary starts beside the header, not below it").toBeLessThan(m.h1Bottom + 200);
    }
    expect(Math.abs(m.backText - m.colLeft), "'Back to the shop' text vs its column's left edge").toBeLessThanOrEqual(2);
    expect(await axe(page, "#main")).toEqual([]);
    test.info().annotations.push({ type: "order", description: `${info.project.name}: h1 x ${Math.round(m.h1Left)}, summary x ${Math.round(m.whatLeft)} y ${Math.round(m.whatTop)}; back text ${Math.round(m.backText)} vs column ${Math.round(m.colLeft)}` });
  } finally {
    await request.post(`/api/orders/${token}/cancel`, { headers: { "cf-connecting-ip": freshIp(info.project.name) } });
  }
  expect(one(`select status from orders where public_token = '${token}'`)).toBe("cancelled");
});

test("S25-11 / R24-10: admin menu rows: option wording toggles and is saved; one-line option buttons; 44 px targets; axe clean (owner and staff)", async ({ page, ip }, info) => {
  void ip;
  test.setTimeout(120_000);
  const LARGE = "c14d8594-781a-4206-99cc-18eaba8c1956"; // Americano, Large
  expect(one(`select is_sold_out from menu_variants where id = '${LARGE}'`)).toBe("f");
  await signIn(page, OWNER, "/admin/menu");
  const row = page.getByRole("listitem").filter({ has: page.getByText("Americano", { exact: true }) }).first();
  const opt = row.getByRole("button", { name: "Mark Large sold out" });
  await expect(opt).toHaveAttribute("aria-pressed", "false");
  // the item toggle's accessible name is still exactly one match per row (selectors elsewhere rely on it)
  await expect(row.getByRole("button", { name: "Mark sold out" })).toHaveCount(1);
  try {
    await opt.click();
    const restore = row.getByRole("button", { name: "Large sold out · Restore" });
    await expect(restore).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => one(`select is_sold_out from menu_variants where id = '${LARGE}'`)).toBe("t");
    await restore.click();
    await expect(row.getByRole("button", { name: "Mark Large sold out" })).toHaveAttribute("aria-pressed", "false");
  } finally {
    await expect.poll(() => one(`select is_sold_out from menu_variants where id = '${LARGE}'`)).toBe("f");
  }
  // every option button fits one line (Button lg-less text-sm: one line is <= 44 px tall, two lines would be > 50)
  const tall = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('ul[aria-label^="Options for"] button')]
      .map((b) => ({ t: b.innerText.trim(), h: b.getBoundingClientRect().height }))
      .filter((b) => b.h > 48)
      .map((b) => `${b.t} ${Math.round(b.h)}px`),
  );
  expect(tall, "option buttons that wrap").toEqual([]);
  const labels = await page.locator('ul[aria-label^="Options for"] button').allInnerTexts();
  expect(await smallTargets(page, "main ul")).toEqual([]);
  expect(await axe(page, "main")).toEqual([]);
  // staff view
  await page.context().clearCookies();
  await signIn(page, STAFF, "/admin/menu");
  // the admin menu streams in behind a skeleton; under a full-suite load it took more than 5 s once (2026-10-25)
  await expect(page.getByRole("button", { name: "Mark Large sold out" }).first()).toBeVisible({ timeout: 20_000 });
  expect(await smallTargets(page, "main ul")).toEqual([]);
  expect(await axe(page, "main")).toEqual([]);
  test.info().annotations.push({ type: "admin options", description: `${info.project.name}: ${labels.join(" | ")}` });
});

test("S25-4: Visit focus order is address map link, phone, email; nothing focusable in the photo; axe clean", async ({ page, ip }, info) => {
  void ip;
  await page.goto("/visit");
  const expected = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("main a[href], main button, main [tabindex]:not([tabindex='-1'])")].map((e) => (e.innerText || e.getAttribute("href") || "").trim()),
  );
  expect(expected.length).toBeGreaterThan(0);
  // the photo: role=img, nothing focusable inside
  expect(await page.locator('main [role="img"]').evaluateAll((els) => els.reduce((n, e) => n + e.querySelectorAll("a, button, input, [tabindex]").length, 0))).toBe(0);
  // Tab from the top of main through every focusable element in main
  await page.locator("#main").focus();
  const order: string[] = [];
  for (let i = 0; i < 40 && order.length < expected.length; i++) {
    await page.keyboard.press("Tab");
    const info2 = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a && a.closest("main") ? (a.innerText || a.getAttribute("href") || "").trim() : null;
    });
    if (info2 !== null) order.push(info2);
  }
  expect(order).toEqual(expected);
  // reading order: Address, Opening hours, Contact headings in that DOM order
  expect(await page.locator("main h2").allInnerTexts()).toEqual(["Address", "Opening hours", "Contact"]);
  expect(await axe(page, "#main")).toEqual([]);
  test.info().annotations.push({ type: "visit focus", description: `${info.project.name}: ${order.join(" -> ")}` });
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

test("section 4 heights and the section 6 re-shoot list at 390 / 820 / 1280 (production build)", async ({ browser, request }, info) => {
  test.skip(info.project.name !== "desktop-1280", "taken once, from the desktop project");
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  const o = await apiCheckout(request, freshIp(info.project.name), { name: "Spacing QA" });
  expect(o.status).toBe(201);
  const token = o.body.data.orderToken as string;
  const overflow: string[] = [];
  const heights: Record<string, Record<number, number>> = {};
  const checkoutGap: Record<number, number> = {};
  try {
    for (const w of [390, 820, 1280]) {
      const { ctx, page } = await ctxAt(browser, w, freshIp(info.project.name));
      const shot = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        const r = await page.evaluate(() => ({ h: document.documentElement.scrollHeight }));
        const over = await page.evaluate((v) => document.documentElement.scrollWidth - v, page.viewportSize()!.width);
        if (over > 0) overflow.push(`${name}@${w}: ${over}px`);
        (heights[name] ??= {})[w] = r.h;
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
      // Menu scrolled to Momo: a viewport shot (what a guest sees), plus the tab state
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
      // Checkout with the (invisible, interaction-only) widget loaded and a token back
      await addToteToCart(page);
      await page.goto("/checkout");
      await waitForTurnstile(page);
      await page.waitForTimeout(500);
      checkoutGap[w] = await page.evaluate(() => {
        const p = [...document.querySelectorAll("aside p")].find((e) => /final total when it calls/.test(e.textContent ?? ""))!;
        const btn = [...document.querySelectorAll("aside button")].find((b) => /Place order/.test(b.textContent ?? ""))!;
        return Math.round(btn.getBoundingClientRect().top - p.getBoundingClientRect().bottom);
      });
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
  writeFileSync(path.join(process.cwd(), "test-results", "live", "spacing-heights-2026-10-25.json"), JSON.stringify({ heights, checkoutGap, overflow }, null, 2));
  test.info().annotations.push({ type: "heights", description: JSON.stringify(heights) });
  test.info().annotations.push({ type: "checkout gap (VAT line to Place order)", description: JSON.stringify(checkoutGap) });
  expect(overflow, "horizontal overflow on a re-shoot page").toEqual([]);
  // R24-14 / S25-2 target: <= 40 px above "Place order" when no challenge is shown
  for (const w of [390, 820, 1280]) expect(checkoutGap[w], `checkout gap at ${w}`).toBeLessThanOrEqual(40);
});

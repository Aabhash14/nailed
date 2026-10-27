import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { devices } from "@playwright/test";
import { addToteToCart, expect, freshIp, freshPhone, guardLocal, LIVE, one, routeIp, test } from "./live-helpers";

/**
 * QA 2026-10-25, S25-2 (qa-engineer): Turnstile `appearance: "interaction-only"` + `size: "flexible"`, and the checkout
 * submit that waits up to 10 s for a token. Needs a LIVE build whose NEXT_PUBLIC_TURNSTILE_SITE_KEY is one of Cloudflare's
 * test keys that do NOT pass silently (the server keeps the always-pass TEST secret):
 *   E2E_TURNSTILE_MODE=challenge  site key 3x00000000000000000000FF (forces an interactive challenge)
 *   E2E_TURNSTILE_MODE=block      site key 2x00000000000000000000AB (always blocks)
 * Skipped in every other run (the normal live build uses the always-pass key 1x00000000000000000000AA).
 * LOCAL stack only; every order placed here is cancelled through the customer-cancel endpoint.
 */
const MODE = process.env.E2E_TURNSTILE_MODE;
test.skip(!LIVE || (MODE !== "challenge" && MODE !== "block"), "needs E2E_LIVE=1 and E2E_TURNSTILE_MODE=challenge|block with a matching build");
test.beforeAll(({ baseURL }) => guardLocal(baseURL));

// 2026-10-25 stats pass: the BUG-019 re-test writes here (the spacing pass used spacing-2026-10-25-prod/).
const SHOTS = path.join(process.cwd(), "..", "qa", "screenshots", "2026-10-25-stats");

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

async function fillCheckout(page: Page, phone: string) {
  await addToteToCart(page);
  await page.goto("/checkout");
  await page.getByRole("radio", { name: /Pickup at the cafe/ }).check();
  await page.getByLabel("Name").first().fill("QA Turnstile Check");
  await page.getByLabel("Phone").fill(phone);
}

/**
 * The Turnstile widget's iframe. Cloudflare mounts it inside a CLOSED shadow root, so a CSS locator cannot see it;
 * Playwright still lists the frame, and its frame element gives the on-screen box.
 */
async function widgetBox(page: Page) {
  for (const f of page.frames()) {
    if (!/challenges\.cloudflare\.com/.test(f.url())) continue;
    const el = await f.frameElement().catch(() => null);
    const b = el ? await el.boundingBox() : null;
    if (b && b.height > 0) return b;
  }
  return null;
}

/** Layout of the bot-check slot between the VAT line and "Place order" (page coordinates). */
async function slot(page: Page) {
  const fr = await widgetBox(page);
  const r = await page.evaluate(() => {
    const p = [...document.querySelectorAll("aside p")].find((e) => /final total when it calls/.test(e.textContent ?? ""))!;
    const btn = [...document.querySelectorAll("aside button")].find((b) => /Place order|Placing your order/.test(b.textContent ?? ""))!;
    return { pBottom: p.getBoundingClientRect().bottom, btnTop: btn.getBoundingClientRect().top, btnW: btn.getBoundingClientRect().width };
  });
  return {
    gap: Math.round(r.btnTop - r.pBottom),
    frame: fr ? { top: Math.round(fr.y - r.pBottom), h: Math.round(fr.height), w: Math.round(fr.width), btnTop: Math.round(r.btnTop - (fr.y + fr.height)) } : null,
    asideW: Math.round(r.btnW),
  };
}

test("no token: challenge key waits about 10 s, then 'Please complete the check below'; block key shows the BUG-019 message at once; nothing is sent", async ({ browser }, info) => {
  test.setTimeout(90_000);
  const { ctx, page } = await ctxAt(browser, info.project.name.startsWith("phone") ? 390 : 1280, freshIp(info.project.name));
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/checkout/.test(r.url())) posts.push(r.url());
  });
  try {
    const phone = freshPhone();
    await fillCheckout(page, phone);
    await page.waitForTimeout(3_000); // give the widget time to load (and, in block mode, to fail)
    const before = await slot(page);
    let waited: number;
    if (MODE === "block") {
      // BUG-019: Cloudflare's error is shown in the slot as a plain message with "Try again" (no invisible widget to tick)
      const lead = "We couldn't run the security check.";
      await expect(page.getByRole("complementary").getByRole("status").filter({ hasText: lead })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
      const t0 = Date.now();
      await page.getByRole("button", { name: "Place order" }).click();
      await expect(page.getByRole("listitem").filter({ hasText: lead })).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" })).toBeFocused();
      waited = Date.now() - t0;
      expect(waited, "a check that already failed answers at once").toBeLessThan(3_000);
      await expect(page.getByText("Please complete the check below")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Place order" })).toBeEnabled();
    } else {
      const t0 = Date.now();
      await page.getByRole("button", { name: "Place order" }).click();
      await expect(page.getByRole("button", { name: "Placing your order..." })).toBeVisible();
      // the widget is on screen: inline under it, and in the error summary at the top of the form
      await expect(page.getByRole("complementary").getByText("Please complete the check below")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("listitem").filter({ hasText: "Please complete the check below" })).toBeVisible();
      waited = Date.now() - t0;
      await expect(page.getByRole("button", { name: "Place order" })).toBeEnabled();
      expect(waited, "the submit should wait for the token (10 s)").toBeGreaterThanOrEqual(9_000);
      expect(waited).toBeLessThan(13_000);
    }
    expect(posts, "no checkout request without a token").toEqual([]);
    expect(one(`select count(*) from orders where customer_phone = '+977${phone}'`)).toBe("0");
    const after = await slot(page);
    await page.getByRole("button", { name: "Place order" }).evaluate((b) => b.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, `checkout-${MODE}-no-token-${page.viewportSize()!.width}.png`) });
    test.info().annotations.push({ type: `no token (${MODE})`, description: `waited ${waited} ms; slot before ${JSON.stringify(before)}; after ${JSON.stringify(after)}` });
  } finally {
    await ctx.close();
  }
});

test("challenge key: the widget appears in place above 'Place order'; a submit made before the guest ticks it waits and goes through", async ({ browser, request }, info) => {
  test.skip(MODE !== "challenge", "challenge key only");
  test.skip(info.project.name !== "desktop-1280", "all three widths from the desktop project");
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const notes: string[] = [];
  for (const w of [390, 820, 1280]) {
    const ip = freshIp(info.project.name);
    const { ctx, page } = await ctxAt(browser, w, ip);
    let token: string | undefined;
    try {
      const phone = freshPhone();
      await fillCheckout(page, phone);
      await expect.poll(async () => (await widgetBox(page))?.height ?? 0, { timeout: 20_000 }).toBeGreaterThan(40);
      await page.waitForTimeout(1_500); // let the challenge paint
      const s = await slot(page);
      expect(s.frame, "the widget is visible").not.toBeNull();
      expect(s.frame!.top, "the widget sits below the VAT line").toBeGreaterThanOrEqual(0);
      expect(s.frame!.btnTop, "the widget sits above Place order").toBeGreaterThanOrEqual(0);
      expect(s.frame!.w, "flexible: the widget is no wider than the aside").toBeLessThanOrEqual(s.asideW + 1);
      await page.screenshot({ path: path.join(SHOTS, `checkout-challenge-${w}.png`), fullPage: true });
      // A full-page capture does not always paint the cross-origin widget (seen at 390), so also take what the guest
      // sees with the widget scrolled into the middle of the screen. The click below uses these viewport coordinates.
      await page.getByRole("button", { name: "Place order" }).evaluate((b) => b.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(SHOTS, `checkout-challenge-${w}-viewport.png`) });
      // Press "Place order" first, then tick the box while the submit is waiting
      const t0 = Date.now();
      await page.getByRole("button", { name: "Place order" }).click();
      await expect(page.getByRole("button", { name: "Placing your order..." })).toBeVisible();
      const box = (await widgetBox(page))!;
      await page.mouse.click(box.x + 30, box.y + box.height / 2); // the checkbox sits at the left of the widget
      await expect(page).toHaveURL(/\/order\/[0-9a-f-]{36}\?placed=1/, { timeout: 20_000 });
      const ms = Date.now() - t0;
      token = /\/order\/([0-9a-f-]{36})/.exec(page.url())![1]!;
      expect(one(`select status||'|'||customer_name from orders where public_token = '${token}'`)).toBe("placed|QA Turnstile Check");
      notes.push(`${w}: gap ${s.gap}px, widget ${s.frame!.w}x${s.frame!.h} at +${s.frame!.top}px below the VAT line, ${s.frame!.btnTop}px above the button; order placed ${ms} ms after the press`);
    } finally {
      if (token) await request.post(`/api/orders/${token}/cancel`, { headers: { "cf-connecting-ip": ip } });
      await ctx.close();
    }
    if (token) expect(one(`select status from orders where public_token = '${token}'`)).toBe("cancelled");
  }
  test.info().annotations.push({ type: "challenge", description: notes.join(" | ") });
});

test("block key (BUG-019): staff sign-in shows the failure with Try again, without the phone line", async ({ browser }, info) => {
  test.skip(MODE !== "block", "block key only");
  const { ctx, page } = await ctxAt(browser, info.project.name.startsWith("phone") ? 390 : 1280, freshIp(info.project.name));
  try {
    await page.goto("/admin/login");
    const lead = "We couldn't run the security check.";
    const msg = page.getByRole("status").filter({ hasText: lead });
    await expect(msg).toBeVisible({ timeout: 15_000 });
    await expect(msg).toHaveText("We couldn't run the security check. Check your connection and tap Try again.");
    await page.getByLabel("Email").fill("nobody@example.com");
    await page.getByLabel("Password").fill("not-a-real-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: lead })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeFocused();
    await expect(page).toHaveURL(/\/admin\/login/);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `login-block-${page.viewportSize()!.width}.png`) });
  } finally {
    await ctx.close();
  }
});

test("block key (BUG-019): failure states at 390 / 820 / 1280 (checkout before and after Place order, staff sign-in); Try again re-runs the check", async ({ browser }, info) => {
  test.skip(MODE !== "block", "block key only");
  test.skip(info.project.name !== "desktop-1280", "all three widths from the desktop project");
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const lead = "We couldn't run the security check.";
  const notes: string[] = [];
  for (const w of [390, 820, 1280]) {
    const { ctx, page } = await ctxAt(browser, w, freshIp(info.project.name));
    try {
      const phone = freshPhone();
      await fillCheckout(page, phone);
      const msg = page.getByRole("complementary").getByRole("status").filter({ hasText: lead });
      await expect(msg).toBeVisible({ timeout: 15_000 });
      const tryAgain = page.getByRole("button", { name: "Try again" });
      const box = (await tryAgain.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      const over = await page.evaluate((vw) => document.documentElement.scrollWidth - vw, w);
      expect(over, "no sideways scroll").toBeLessThanOrEqual(0);
      await tryAgain.evaluate((b) => b.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: path.join(SHOTS, `bug019-checkout-failed-${w}.png`) });
      await page.getByRole("button", { name: "Place order" }).click();
      await expect(page.getByRole("listitem").filter({ hasText: lead })).toBeVisible();
      await expect(tryAgain).toBeFocused();
      await page.screenshot({ path: path.join(SHOTS, `bug019-checkout-after-submit-${w}.png`), fullPage: true });
      await tryAgain.click();
      await expect(msg).toBeVisible({ timeout: 15_000 }); // fails again with the block key, the message comes back
      expect(one(`select count(*) from orders where customer_phone = '+977${phone}'`)).toBe("0");
      const text = (await msg.textContent())?.trim();
      await page.goto("/admin/login");
      const lmsg = page.getByRole("status").filter({ hasText: lead });
      await expect(lmsg).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: path.join(SHOTS, `bug019-login-failed-${w}.png`) });
      notes.push(`${w}: Try again ${Math.round(box.width)}x${Math.round(box.height)}; "${text}"`);
    } finally {
      await ctx.close();
    }
  }
  test.info().annotations.push({ type: "block states", description: notes.join(" | ") });
});

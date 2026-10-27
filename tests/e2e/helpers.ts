import { test as base, expect, type Page } from "@playwright/test";

/** Every test fails on a console error or uncaught page error (known/expected noise is listed in IGNORE). */
const IGNORE: RegExp[] = [];

export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" && !IGNORE.some((r) => r.test(m.text()))) errors.push(`console: ${m.text()}`);
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      await use(errors);
      expect(errors, "console / page errors").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** 12:00 in Kathmandu (UTC+05:45): far from midnight, so "today" never changes during a test. */
export const MIDDAY_NST = "2026-10-22T06:15:00Z";

/**
 * Fixed browser clock for tests that depend on the date or on order ages (Today's orders, "Finished today", stale and
 * auto-cancel). Date.now() / new Date() return this time; timers keep running. Call BEFORE the first page load.
 * Only the browser is fixed (the server keeps real time), so use it on admin and order pages, not on server-rendered
 * pages that print the time (the menu's "open now").
 */
export async function fixClock(page: Page, at: string = MIDDAY_NST) {
  await page.clock.setFixedTime(new Date(at));
}

export async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

export async function submitLogin(page: Page, email = "owner@example.com") {
  await page.waitForLoadState("networkidle"); // let React hydrate, or the submit is a native form reload
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("whatever1");
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Signs in once (BUG-002 fixed: no retry) and lands on Today's orders. */
export async function signIn(page: Page, email = "owner@example.com") {
  await page.goto("/admin/login");
  await submitLogin(page, email);
  await expect(page.getByRole("heading", { name: "Today's orders" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/?$/);
}

/** Add the "Sample tee" M/Black (stock 12) to the cart `times` times. */
export async function addTee(page: Page, times = 1, label = /M, Black/) {
  await page.goto("/shop/sample-tee");
  await page.getByText(label).first().click();
  for (let i = 0; i < times; i++) await page.getByRole("button", { name: "Add to cart" }).click();
}

export async function fillCustomer(page: Page, name = "Test Buyer", phone = "9841234567") {
  await page.getByLabel("Name", { exact: false }).first().fill(name);
  await page.getByLabel("Phone").fill(phone);
}

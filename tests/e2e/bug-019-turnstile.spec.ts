import type { Page } from "@playwright/test";
import { addTee, expect, fillCustomer, noHorizontalScroll, submitLogin, test } from "./helpers";

/**
 * BUG-019 (frontend, 2026-10-25): when the bot check fails there is no widget to tick, so checkout and staff sign-in
 * show a plain message with "Try again" in the widget's place, instead of "Please complete the check below".
 *
 * Mock builds never call Cloudflare; localStorage `nc-mock-turnstile` makes the mock check act out a failure
 * (see src/components/shop/turnstile-logic.ts): "fail" (every attempt), "fail-once" (Try again then passes), "hang"
 * (no token, no error: the 10 s wait runs out). The live equivalent is tests/e2e/live/turnstile-2026-10-25.live.spec.ts
 * with E2E_TURNSTILE_MODE=block.
 */

const MOCK_KEY = "nc-mock-turnstile";
const PHONE = "01-4410000";
const LEAD = "We couldn't run the security check.";
const FULL = `We couldn't run the security check. Check your connection and tap Try again. If it keeps failing, call us on ${PHONE} to order.`;
const STAFF = "We couldn't run the security check. Check your connection and tap Try again.";

async function mockTurnstile(page: Page, mode: "fail" | "fail-once" | "hang") {
  await page.addInitScript(([k, m]) => window.localStorage.setItem(k, m), [MOCK_KEY, mode] as const);
}

/** Tee in the cart, the cafe phone set in the mock settings, checkout open with a valid pickup form. */
async function openCheckout(page: Page) {
  await addTee(page, 1);
  // QA 2026-10-25: the product page does not create the mock db, so open checkout first (it loads/seeds the db),
  // then set the phone and reload so the page reads it.
  await page.goto("/checkout");
  await expect(page.getByRole("button", { name: "Place order" })).toBeVisible();
  await page.evaluate((phone) => {
    const key = "nc-mock-db-v1";
    const db = JSON.parse(localStorage.getItem(key)!);
    db.settings.phone = phone;
    localStorage.setItem(key, JSON.stringify(db));
  }, PHONE);
  await page.reload();
  await fillCustomer(page, "Bot Check Fails", "9841234567");
}

const slotMessage = (page: Page) => page.getByRole("status").filter({ hasText: LEAD });
/** Scoped by text: Next's route announcer is also role=alert. */
const alertWithLead = (page: Page) => page.getByRole("alert").filter({ hasText: LEAD });
const summaryItem = (page: Page) => alertWithLead(page).getByRole("listitem");
const tryAgain = (page: Page) => page.getByRole("button", { name: "Try again" });

async function tapTarget(page: Page) {
  const box = (await tryAgain(page).boundingBox())!;
  expect(box.height, "Try again is at least 44 px tall").toBeGreaterThanOrEqual(44);
  expect(box.width, "Try again is at least 44 px wide").toBeGreaterThanOrEqual(44);
}

test.describe("BUG-019 checkout", () => {
  test("a failed check shows the message with the phone and Try again; Place order answers at once and focuses Try again; nothing is sent", async ({ page }) => {
    await mockTurnstile(page, "fail");
    await openCheckout(page);

    // the failure is shown in the slot as soon as it happens, before any submit (live region)
    await expect(slotMessage(page)).toBeVisible();
    await expect(slotMessage(page)).toHaveText(FULL);
    await expect(slotMessage(page).getByRole("link", { name: PHONE })).toHaveAttribute("href", "tel:014410000");
    await expect(page.getByText("Please complete the check below")).toHaveCount(0);
    await tapTarget(page);
    await noHorizontalScroll(page);

    const t0 = Date.now();
    await page.getByRole("button", { name: "Place order" }).click();
    // error summary at the top carries the same words; no "check below"
    await expect(summaryItem(page)).toHaveText(FULL);
    await expect(alertWithLead(page)).toContainText("We could not place your order"); // no field is highlighted
    await expect(tryAgain(page)).toBeFocused();
    expect(Date.now() - t0, "a check that already failed does not wait 10 s").toBeLessThan(3_000);
    await expect(page.getByText("Please complete the check below")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Place order" })).toBeEnabled();
    await expect(page).toHaveURL(/\/checkout$/); // no order placed

    // Try again re-runs the check (it fails again in this mode) and clears the old summary
    await tryAgain(page).click();
    await expect(page.getByText("Running the security check again...")).toBeVisible();
    await expect(alertWithLead(page)).toHaveCount(0);
    await expect(slotMessage(page)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`checkout-failed-${page.viewportSize()!.width}.png`), fullPage: true });
  });

  test("Try again after a failure gets a token and the order goes through", async ({ page }) => {
    await mockTurnstile(page, "fail-once");
    await openCheckout(page);
    await expect(slotMessage(page)).toBeVisible();
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(tryAgain(page)).toBeFocused();
    await page.keyboard.press("Enter"); // keyboard: Try again
    await expect(slotMessage(page)).toHaveCount(0);
    await expect(tryAgain(page)).toHaveCount(0);
    await expect(alertWithLead(page)).toHaveCount(0); // the old error is cleared when the token arrives
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page).toHaveURL(/\/order\/[0-9a-f-]{36}\?placed=1/);
  });

  test("no token and no error: Place order waits about 10 s, then shows the failure (not 'check below') and focuses Try again", async ({ page }) => {
    test.setTimeout(45_000);
    await mockTurnstile(page, "hang");
    await openCheckout(page);
    await expect(slotMessage(page)).toHaveCount(0); // nothing has failed yet
    const t0 = Date.now();
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByRole("button", { name: "Placing your order..." })).toBeVisible();
    await expect(slotMessage(page)).toBeVisible({ timeout: 15_000 });
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(9_000);
    expect(waited).toBeLessThan(13_000);
    await expect(summaryItem(page)).toHaveText(FULL);
    await expect(tryAgain(page)).toBeFocused();
    await expect(page.getByText("Please complete the check below")).toHaveCount(0);
    await expect(page).toHaveURL(/\/checkout$/);
  });
});

test.describe("BUG-019 staff sign-in", () => {
  test("a failed check shows the message without the phone line; Sign in focuses Try again; nothing is signed in", async ({ page }) => {
    await mockTurnstile(page, "fail");
    await page.goto("/admin/login");
    await expect(slotMessage(page)).toHaveText(STAFF);
    await expect(slotMessage(page).getByRole("link")).toHaveCount(0);
    await tapTarget(page);
    await noHorizontalScroll(page);
    await submitLogin(page);
    await expect(alertWithLead(page)).toHaveText(STAFF);
    await expect(tryAgain(page)).toBeFocused();
    await expect(page.getByText("Please complete the check below.")).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.screenshot({ path: test.info().outputPath(`login-failed-${page.viewportSize()!.width}.png`), fullPage: true });
  });

  test("Try again after a failure, then signing in works", async ({ page }) => {
    await mockTurnstile(page, "fail-once");
    await page.goto("/admin/login");
    await expect(slotMessage(page)).toBeVisible();
    await submitLogin(page);
    await expect(tryAgain(page)).toBeFocused();
    await tryAgain(page).click();
    await expect(slotMessage(page)).toHaveCount(0);
    await expect(alertWithLead(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Today's orders" })).toBeVisible();
  });
});

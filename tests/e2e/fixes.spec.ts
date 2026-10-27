import type { Page } from "@playwright/test";
import { addTee, expect, fillCustomer, fixClock, signIn, test } from "./helpers";

/** Fix pass 2026-10-21: BUG-003, BUG-006, SEC-005, orders pause, order detail, staff and account pages. */

async function openSettings(page: Page) {
  await signIn(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

const save = (page: Page) => page.getByRole("button", { name: "Save settings" }).click();

test("BUG-003: largest cash order 0 means no limit, and the field says so", async ({ page }) => {
  await openSettings(page);
  const field = page.getByLabel("Largest cash order (Rs.)");
  await expect(page.getByText("0 or empty means no limit.")).toBeVisible();
  await field.fill("0");
  await save(page);
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(field).toHaveValue(""); // stored as "no limit"
  await addTee(page, 4); // Rs. 5,996: over the old Rs. 5,000 sample limit
  await page.goto("/checkout");
  await fillCustomer(page);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
});

test("BUG-006: delivery needs an area, hours must close after opening, money is strict", async ({ page }) => {
  await openSettings(page);
  await page.getByLabel("Delivery areas").fill("");
  await page.getByLabel("Monday").fill("18:00-09:00");
  await page.getByLabel("Delivery fee (Rs.)").fill("12,50");
  await save(page);
  await expect(page.getByText("Please fix the highlighted fields.")).toBeVisible();
  await expect(page.getByText("Add at least one delivery area, or turn delivery off")).toBeVisible();
  await expect(page.getByText(/Closing time must be after opening time/)).toBeVisible();
  await expect(page.getByText(/use a dot for paisa, not a comma/).first()).toBeVisible();
  await expect(page.getByLabel("Delivery fee (Rs.)")).toHaveAttribute("aria-invalid", "true");

  // turning delivery off makes empty areas fine; fix the rest and it saves
  await page.getByLabel("Delivery, pay cash on delivery").uncheck();
  await page.getByLabel("Monday").fill("09:00-18:00");
  await page.getByLabel("Delivery fee (Rs.)").fill("150");
  await save(page);
  await expect(page.getByText("Settings saved.")).toBeVisible();
});

test("SEC-012: map link must be https", async ({ page }) => {
  await openSettings(page);
  await page.getByLabel("Map link").fill("javascript:alert(1)");
  await save(page);
  await expect(page.getByText(/starting with https:\/\//)).toBeVisible();
});

test("orders paused: owner switch shows a call-us notice on cart and checkout, and resumes", async ({ page }) => {
  await addTee(page, 1);
  await openSettings(page);
  await expect(page.getByText("Open", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause online orders" }).click();
  await expect(page.getByText(/Online orders are paused\. Customers see/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume online orders" })).toBeVisible();

  await page.goto("/cart");
  await expect(page.getByText("Online orders are paused")).toBeVisible();
  await expect(page.getByRole("link", { name: "Checkout" })).toHaveCount(0);
  await page.goto("/checkout");
  await expect(page.getByText("Online orders are paused")).toBeVisible();
  await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);

  await page.goto("/admin/settings");
  await page.getByRole("button", { name: "Resume online orders" }).click();
  await expect(page.getByText("Online orders are open again.")).toBeVisible();
  await page.goto("/checkout");
  await expect(page.getByRole("button", { name: "Place order" })).toBeVisible();
});

test("orders paused after the page loaded: ORDERS_PAUSED answer switches checkout to the notice", async ({ page }) => {
  await addTee(page, 1);
  await page.goto("/checkout");
  await fillCustomer(page);
  await page.evaluate(() => {
    const key = "nc-mock-db-v1";
    const db = JSON.parse(localStorage.getItem(key)!);
    db.settings.ordersPaused = true;
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Online orders are paused")).toBeVisible();
  await expect(page).toHaveURL(/\/checkout$/);
});

test("order detail: card link opens /admin/orders/<id>; actions work there; unknown id says not found", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Open order NC-1041" }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/00000000-0000-4000-8007-000000000001$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("NC-1041");
  await expect(page.getByText("Sample Sita")).toBeVisible();
  await page.getByRole("button", { name: /Confirm/i }).click();
  await expect(page.getByRole("article")).toContainText(/Confirmed/);
  await expect(page.getByRole("link", { name: "Back to Today's orders" })).toBeVisible();

  await page.goto("/admin/orders/00000000-0000-4000-8000-00000000dead");
  await expect(page.getByRole("heading", { name: "Order not found" })).toBeVisible();
});

test("order detail deep link while signed out goes through login and back (Telegram link)", async ({ page }) => {
  await page.goto("/admin/orders/00000000-0000-4000-8007-000000000002");
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Forders%2F/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("whatever1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/00000000-0000-4000-8007-000000000002$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("NC-1042");
});

test("staff page (owner): list, add a login, remove access with confirmation", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Staff" }).click();
  await expect(page.getByRole("heading", { name: "Staff", level: 1 })).toBeVisible();
  await expect(page.getByText("Sample staff one")).toBeVisible();
  await expect(page.getByText("The owner account cannot be removed here.")).toBeVisible();

  await page.getByLabel("Name").fill("New Barista");
  await page.getByLabel("Email").fill("barista@example.com");
  await page.getByLabel("Temporary password").fill("short");
  await page.getByRole("button", { name: "Add staff login" }).click();
  await expect(page.getByText("Use at least 12 characters")).toBeVisible();
  // 30 Nepali letters = 30 characters but 90 bytes: over the 72-byte server limit
  await page.getByLabel("Temporary password").fill("क".repeat(30));
  await page.getByRole("button", { name: "Add staff login" }).click();
  await expect(page.getByText(/Use at most 72 characters/)).toBeVisible();
  await page.getByLabel("Temporary password").fill("a long temporary pass");
  await page.getByRole("button", { name: "Add staff login" }).click();
  await expect(page.getByText(/New Barista can now sign in/)).toBeVisible();

  const row = page.getByRole("listitem").filter({ hasText: "Sample staff two" });
  await row.getByRole("button", { name: "Remove access" }).click();
  await row.getByRole("alertdialog").getByRole("button", { name: "Yes, remove access" }).click();
  await expect(page.getByText("Sample staff two can no longer sign in.")).toBeVisible();
  // contract 1.3.0: a deactivated account is deleted, so it leaves the list (there is no "removed" section any more)
  await expect(page.getByRole("listitem").filter({ hasText: "Sample staff two" })).toHaveCount(0);
});

test("staff role: no Staff link, staff page explains it is owner only", async ({ page }) => {
  await signIn(page, "staff1@example.com");
  await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Staff" })).toHaveCount(0);
  await page.goto("/admin/staff");
  await expect(page.getByText("Only the owner can see and change who has access to admin.")).toBeVisible();
});

test("account: change password validates length and match, then succeeds", async ({ page }) => {
  await signIn(page, "staff1@example.com");
  await page.getByRole("link", { name: "Account" }).click();
  await expect(page.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();
  await page.getByLabel("Current password").fill("whatever1");
  await page.getByLabel(/^New password(?! again)/).fill("too short");
  await page.getByLabel("New password again").fill("different");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Use at least 12 characters")).toBeVisible();
  await expect(page.getByText("The two new passwords do not match")).toBeVisible();
  await page.getByLabel(/^New password(?! again)/).fill("a much longer passphrase");
  await page.getByLabel("New password again").fill("a much longer passphrase");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText(/Password changed/)).toBeVisible();
});

test("SEC-005: security headers, noindex on order/admin, no-referrer on order pages, robots.txt", async ({ request }) => {
  const home = await request.get("/");
  const h = home.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toContain("https://challenges.cloudflare.com");
  expect(h["content-security-policy"]).toContain("object-src 'none'");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toContain("camera=()");
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["x-robots-tag"]).toBeUndefined();

  const order = await request.get("/order/00000000-0000-4000-8000-000000000000");
  expect(order.headers()["referrer-policy"]).toBe("no-referrer");
  expect(order.headers()["x-robots-tag"]).toContain("noindex");
  expect(order.headers()["x-frame-options"]).toBe("DENY");

  for (const p of ["/admin", "/admin/login"]) {
    const r = await request.get(p, { maxRedirects: 0 });
    expect(r.headers()["x-robots-tag"], p).toContain("noindex");
  }

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const txt = await robots.text();
  expect(txt).toContain("Disallow: /admin");
  expect(txt).toContain("Disallow: /order");
});

test("auto_unconfirmed: an order nobody confirmed in time is auto-cancelled, and both sides say why", async ({ page }) => {
  await fixClock(page); // "Finished today" must not depend on when the suite runs
  await addTee(page, 1);
  await page.goto("/checkout");
  await fillCustomer(page, "Slow Confirm", "9863333333");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
  const orderUrl = page.url();
  // pretend the order was placed 3 hours ago (default auto-cancel: 120 minutes)
  await page.evaluate(() => {
    const key = "nc-mock-db-v1";
    const db = JSON.parse(localStorage.getItem(key)!);
    const o = db.orders.find((x: { customerName: string }) => x.customerName === "Slow Confirm");
    o.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.goto(orderUrl);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This order was cancelled");
  await expect(page.getByText("Cancelled: not confirmed in time")).toBeVisible();

  await signIn(page);
  await page.getByRole("tab", { name: /Finished today/ }).click();
  await expect(page.getByRole("article").filter({ hasText: "Slow Confirm" })).toContainText(
    "Cancelled: Not confirmed in time (cancelled automatically)",
  );
  // staff can never pick the system reason themselves
  await page.getByRole("tab", { name: /Needs action/ }).click();
  const c = page.getByRole("article").filter({ hasText: "NC-1043" });
  await c.getByRole("button", { name: "Cancel order" }).click();
  await expect(c.getByLabel("Reason for cancelling").locator("option", { hasText: "automatically" })).toHaveCount(0);
});

test("settings: abuse rules from the DB fix pass are editable; 24:00 is a valid closing time", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByLabel("Open orders per device")).toHaveValue("3");
  await expect(page.getByLabel("Orders per device per day")).toHaveValue("10");
  await expect(page.getByLabel("Auto-cancel unconfirmed after (minutes)")).toHaveValue("120");
  await page.getByLabel("Auto-cancel unconfirmed after (minutes)").fill("5");
  await page.getByLabel("Friday").fill("18:00-24:00");
  await save(page);
  await expect(page.getByText(/Enter 15 to 10080 minutes/)).toBeVisible();
  await page.getByLabel("Auto-cancel unconfirmed after (minutes)").fill("");
  await save(page);
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Auto-cancel unconfirmed after (minutes)")).toHaveValue("");
  await expect(page.getByLabel("Friday")).toHaveValue("18:00-24:00");
});

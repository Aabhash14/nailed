import { expect, fillCustomer, fixClock, signIn, submitLogin, test } from "./helpers";
import type { Page } from "@playwright/test";

const card = (page: Page, number: string) => page.getByRole("article").filter({ hasText: number });

test("BUG-002: first sign-in lands on /admin and stays there (no bounce back to login)", async ({ page }) => {
  await page.goto("/admin/login");
  await submitLogin(page);
  await page.waitForTimeout(1500);
  expect(page.url(), "bounced back to the login page after a successful sign-in").toMatch(/\/admin\/?$/);
  await expect(page.getByRole("heading", { name: "Today's orders" })).toBeVisible();
});

test("admin: signed-out visit to a deep link goes to login with ?next=, sign in returns there", async ({ page }) => {
  await page.goto("/admin/blocklist");
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Fblocklist/);
  await submitLogin(page);
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/admin\/blocklist$/);
  await expect(page.getByRole("heading", { name: "Blocklist" })).toBeVisible();
});

test("admin login: open-redirect target is ignored", async ({ page }) => {
  await page.goto("/admin/login?next=https://evil.example/x");
  await submitLogin(page);
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/localhost:\d+\/admin\/?$/);
});

test("admin login: bad email gives a generic error; sign out returns to login", async ({ page }) => {
  await page.goto("/admin/login");
  await page.waitForLoadState("networkidle");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("Password").fill("x");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/login/); // native type=email validation blocks the submit
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
});

test("today's orders: seeded orders, tabs, call links", async ({ page }) => {
  await fixClock(page); // order ages and "today" must not depend on when the suite runs
  await signIn(page);
  await expect(page.getByRole("tab", { name: /Needs action \(3\)/ })).toBeVisible();
  await expect(card(page, "NC-1041")).toContainText("Sample Sita");
  await expect(card(page, "NC-1041").getByRole("link", { name: /Call \+9779800000001/ })).toHaveAttribute("href", /^tel:/);
  await expect(card(page, "NC-1041")).toContainText("Collect Rs. 1,649");
  await expect(card(page, "NC-1041")).toContainText("Waiting over 30 min"); // 45 min old
});

test("staff flow: confirm -> dispatch (delivery) -> complete", async ({ page }) => {
  await fixClock(page); // order ages and "today" must not depend on when the suite runs
  await signIn(page);
  const c = card(page, "NC-1041"); // delivery, placed
  await c.getByRole("button", { name: /Confirm/i }).click();
  await expect(c).toContainText(/Confirmed/);
  await c.getByRole("button", { name: /out for delivery|dispatch/i }).click();
  await expect(c).toContainText(/Out for delivery/i);
  await c.getByRole("button", { name: /complete|cash received|delivered/i }).click();
  await page.getByRole("tab", { name: /Finished today/ }).click();
  await expect(card(page, "NC-1041")).toContainText("Cash received Rs. 1,649");
});

test("pickup flow: confirmed -> ready for pickup -> completed; no dispatch button for pickup", async ({ page }) => {
  await fixClock(page); // order ages and "today" must not depend on when the suite runs
  await signIn(page);
  const c = card(page, "NC-1042"); // pickup, confirmed
  await expect(c.getByRole("button", { name: /out for delivery/i })).toHaveCount(0);
  await c.getByRole("button", { name: /ready/i }).click();
  await expect(c).toContainText(/Ready for pickup/i);
  await c.getByRole("button", { name: /complete|handed|cash/i }).click();
  await page.getByRole("tab", { name: /Finished today/ }).click();
  await expect(card(page, "NC-1042")).toContainText(/Cash received/);
});

test("cancel needs a reason; restock + block; customer then refused at checkout", async ({ page }) => {
  await fixClock(page); // order ages and "today" must not depend on when the suite runs
  await signIn(page);
  const c = card(page, "NC-1043"); // pickup, placed, phone ...0003
  await c.getByRole("button", { name: "Cancel order" }).click();
  await c.getByRole("button", { name: "Confirm cancel" }).click();
  await expect(c.locator("p", { hasText: "Choose a reason" })).toBeVisible();
  await c.getByLabel("Also block this phone number").check();
  await c.getByLabel("Reason for cancelling").selectOption("fake");
  // SEC-002: choosing "fake" never leaves "block" ticked, and blocking needs a second, explicit confirmation
  await expect(c.getByLabel("Also block this phone number")).not.toBeChecked();
  await expect(c.getByText(/Someone may have used another person/)).toBeVisible();
  await c.getByLabel("Also block this phone number").check();
  await c.getByRole("button", { name: "Confirm cancel" }).click();
  const dialog = c.getByRole("alertdialog");
  await expect(dialog).toContainText("Block +9779800000003?");
  await expect(dialog).toContainText("Fake or prank order");
  await dialog.getByRole("button", { name: "Go back" }).click();
  await expect(c.getByRole("alertdialog")).toHaveCount(0);
  await c.getByRole("button", { name: "Confirm cancel" }).click();
  await c.getByRole("alertdialog").getByRole("button", { name: "Yes, cancel and block" }).click();
  await page.getByRole("tab", { name: /Finished today/ }).click();
  await expect(card(page, "NC-1043")).toContainText(/Cancelled/);
  await expect(card(page, "NC-1043")).toContainText(/Phone blocked/);
  await page.getByRole("link", { name: "Blocklist" }).click();
  await expect(page.getByText("+9779800000003")).toBeVisible();
  await expect(page.getByText(/Order NC-1043: fake/)).toBeVisible();

  // that phone can no longer order
  await page.goto("/shop/sample-tee");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.goto("/checkout");
  await fillCustomer(page, "Blocked Person", "9800000003");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("We cannot take this order online")).toBeVisible();

  // owner unblocks, then the same order goes through
  await page.goto("/admin/blocklist");
  await page.getByRole("button", { name: /Unblock/ }).click();
  await expect(page.getByText("Nobody is blocked")).toBeVisible();
  await page.goto("/checkout");
  await fillCustomer(page, "Blocked Person", "9800000003");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
});

test("blocklist: add by phone, validation, duplicate is idempotent", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/blocklist");
  await page.getByLabel("Phone number to block").fill("123");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.getByText(/Nepal mobile/)).toBeVisible();
  await page.getByLabel("Phone number to block").fill("9812345678");
  await page.getByLabel("Reason").fill("test");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.getByText("+9779812345678", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").getByText("Blocked +9779812345678.")).toBeVisible();
  await page.getByLabel("Phone number to block").fill("9812345678");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  // insert-or-nothing: the second attempt says "Already blocked" and the list still has one entry
  await expect(page.getByRole("status").getByText(/Already blocked: \+9779812345678/)).toBeVisible();
  await expect(page.getByText("+9779812345678", { exact: true })).toHaveCount(1);
});

test("staff role: cannot unblock; cannot cancel an order already out for delivery / ready", async ({ page }) => {
  await fixClock(page); // order ages and "today" must not depend on when the suite runs
  await signIn(page, "staff1@example.com");
  await expect(page.getByText("(staff)")).toBeVisible();
  const c = card(page, "NC-1042"); // pickup, confirmed
  await c.getByRole("button", { name: /ready/i }).click();
  await expect(c.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
  await expect(c.getByText(/Only the owner can cancel/)).toBeVisible();
  await page.goto("/admin/blocklist");
  await page.getByLabel("Phone number to block").fill("9812345678");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.getByText("+9779812345678", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Unblock/ })).toHaveCount(0);
  await expect(page.getByText("Only the owner can remove someone")).toBeVisible();
});

test("customer cancel is not offered once staff confirmed; status page follows staff changes", async ({ page, context }) => {
  await fixClock(page); // order ages and "today" must not depend on when the suite runs
  // customer places an order
  await page.goto("/shop/sample-tee");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.goto("/checkout");
  await fillCustomer(page, "Flow Buyer", "9861111111");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
  const orderUrl = page.url();
  // staff (same browser storage = same mock db) confirms
  const admin = await context.newPage();
  await signIn(admin);
  // design review fix 5: Needs action lists the OLDEST waiting order first, so find the new one by name
  await expect(admin.getByRole("article").filter({ hasText: "Flow Buyer" })).toBeVisible();
  await admin.getByRole("article").filter({ hasText: "Flow Buyer" }).getByRole("button", { name: /Confirm/i }).click();
  await admin.close();
  await page.goto(orderUrl);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your order is confirmed");
  await expect(page.getByRole("button", { name: "Cancel this order" })).toHaveCount(0);
  await expect(page.getByText(/To change this order, please call us/)).toBeVisible();
});

test("sold-out toggle in admin shows on the public menu, and back", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/menu");
  const row = page.getByRole("listitem").filter({ hasText: "Sample milk tea" }).first();
  await row.getByRole("button", { name: "Mark sold out" }).click();
  await expect(row.getByRole("button", { name: "Back in stock" })).toBeVisible();
  await page.goto("/menu");
  await expect(page.getByRole("listitem").filter({ hasText: "Sample milk tea" }).getByText("Sold out", { exact: true })).toBeVisible();
  await page.goto("/admin/menu");
  await page.getByRole("listitem").filter({ hasText: "Sample milk tea" }).first().getByRole("button", { name: "Back in stock" }).click();
  await page.goto("/menu");
  await expect(page.getByRole("listitem").filter({ hasText: "Sample milk tea" }).getByText("Sold out", { exact: true })).toHaveCount(0);
});

test("admin pages all render for the owner", async ({ page }) => {
  await signIn(page);
  for (const p of ["/admin/menu", "/admin/products", "/admin/blocklist", "/admin/settings", "/admin/staff", "/admin/account"]) {
    await page.goto(p);
    await expect(page.locator("main h1").first(), p).toBeVisible();
  }
});

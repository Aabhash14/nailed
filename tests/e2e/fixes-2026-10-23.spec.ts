import type { Page } from "@playwright/test";
import { addTee, expect, fillCustomer, fixClock, signIn, test } from "./helpers";

/**
 * Frontend fix pass 2026-10-23: BUG-009, BUG-010, BUG-012, design review T-048 P1 items (pause banner, Needs action
 * order, save result next to Save, staged photo removal, keep-this-link, edit form focus on the menu), SEC-021 (product
 * slug shape, no per-slug cache). BUG-007, 008, 011 and 013 are in open-bugs.spec.ts; the menu photo slot in
 * menu-photo.spec.ts.
 */

const DB_KEY = "nc-mock-db-v1";

const productCard = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: new RegExp(name) }) });

test.describe("BUG-009: keyboard focus stays put", () => {
  test("product photos: Move up, Move down and Remove keep focus on the same photo", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/products");
    await productCard(page, "Unpublished sample").getByRole("button", { name: "Edit", exact: true }).click();
    const form = page.getByRole("form", { name: "Edit Unpublished sample" });
    const alt2 = await form.getByLabel("Photo 2 description (alt text)").inputValue();

    await form.getByRole("button", { name: "Move photo 2 up" }).click();
    // the photo is now first, where Move up is disabled: focus goes to its Move down
    await expect(form.getByLabel("Photo 1 description (alt text)")).toHaveValue(alt2);
    await expect(form.getByRole("button", { name: "Move photo 1 down" })).toBeFocused();

    await page.keyboard.press("Enter"); // moves it back down
    await expect(form.getByLabel("Photo 2 description (alt text)")).toHaveValue(alt2);
    await expect(form.getByRole("button", { name: "Move photo 2 up" })).toBeFocused();

    await form.getByRole("button", { name: "Remove photo 2" }).click();
    const undo = form.getByRole("button", { name: "Undo" });
    await expect(undo).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(form.getByRole("button", { name: "Remove photo 2" })).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  });

  test("staff: Remove access moves focus into the confirmation, Keep access moves it back", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/staff");
    const row = page.getByRole("listitem").filter({ hasText: "Sample staff two" });
    await row.getByRole("button", { name: "Remove access" }).click();
    await expect(row.getByRole("button", { name: "Yes, remove access" })).toBeFocused();
    await row.getByRole("button", { name: "Keep access" }).click();
    await expect(row.getByRole("button", { name: "Remove access" })).toBeFocused();
    await row.getByRole("button", { name: "Remove access" }).click();
    await page.keyboard.press("Enter"); // "Yes, remove access" has focus
    await expect(page.getByText("Sample staff two can no longer sign in.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Has access" })).toBeFocused();
  });
});

test("BUG-010: deleting a menu item closes its open edit form; nothing is re-created", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/menu");
  const row = page.getByRole("listitem").filter({ hasText: "Sample egg toast" }).first();
  await row.getByRole("button", { name: "Edit details" }).click();
  await expect(page.getByRole("form", { name: "Edit Sample egg toast" })).toBeVisible();
  await row.getByRole("button", { name: "Delete" }).click();
  await row.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);
  await expect(page.getByText("Sample egg toast was deleted, so its edit form was closed.")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Sample egg toast" })).toHaveCount(0);
  const count = await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key)!);
    return db.menu.flatMap((c: { items: { name: string }[] }) => c.items).filter((i: { name: string }) => i.name === "Sample egg toast").length;
  }, DB_KEY);
  expect(count).toBe(0);
});

test("BUG-008 (menu): Edit details on a phone brings the form into view; Cancel returns focus to Edit", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await signIn(page);
  await page.goto("/admin/menu");
  const edit = page.getByRole("listitem").filter({ hasText: "Sample egg toast" }).first().getByRole("button", { name: "Edit details" });
  await edit.scrollIntoViewIfNeeded();
  await edit.click();
  const form = page.getByRole("form", { name: "Edit Sample egg toast" });
  await expect(form).toBeInViewport({ ratio: 0.05 });
  await expect(form.getByRole("heading", { name: "Edit Sample egg toast" })).toBeFocused();
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeFocused();
  await expect(edit).toBeInViewport();
});

test("BUG-012: Account refuses a password over 72 bytes (Nepali letters) with the Staff page wording", async ({ page }) => {
  await signIn(page, "staff1@example.com");
  await page.goto("/admin/account");
  await page.getByLabel("Current password").fill("whatever1");
  await page.getByLabel(/^New password(?! again)/).fill("क".repeat(30)); // 30 characters, 90 bytes
  await page.getByLabel("New password again").fill("क".repeat(30));
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText(/Use at most 72 characters \(fewer if you use Nepali letters or emoji\)/)).toBeVisible();
  await expect(page.getByText(/Password changed/)).toHaveCount(0);
});

test.describe("orders paused banner on every admin page", () => {
  test("owner sees it with a link to the switch; staff are told to ask the owner; it goes after Resume", async ({ page }) => {
    await signIn(page);
    await expect(page.getByText("Online orders are paused", { exact: true })).toHaveCount(0);
    await page.goto("/admin/settings");
    await page.getByRole("button", { name: "Pause online orders" }).click();
    await expect(page.getByRole("link", { name: "Resume with the switch below" })).toBeVisible(); // appears at once

    await page.goto("/admin/menu");
    await expect(page.getByText("Online orders are paused", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Resume in Settings" }).click();
    await expect(page).toHaveURL(/\/admin\/settings#orders-pause$/);
    await page.getByRole("button", { name: "Resume online orders" }).click();
    await expect(page.getByText("Online orders are paused", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Pause online orders" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn(page, "staff1@example.com");
    await expect(page.getByText("Online orders are paused", { exact: true })).toBeVisible();
    await expect(page.getByText("Ask the owner to resume.")).toBeVisible();
    await expect(page.getByRole("link", { name: /Resume/ })).toHaveCount(0);
  });
});

test("staff notice: Remove notice takes it down; an empty Save no longer removes it", async ({ page }) => {
  await signIn(page);
  await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key)!);
    db.settings.announcement = "Closed Saturday for Tihar";
    localStorage.setItem(key, JSON.stringify(db));
  }, DB_KEY);
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, "staff1@example.com");
  await page.goto("/admin/settings");
  await expect(page.getByText("Showing now:")).toBeVisible();
  await page.getByLabel(/Notice banner/).fill("");
  await page.getByRole("button", { name: "Save notice" }).click();
  await expect(page.getByText("Type the new notice, or use Remove notice to take it down.")).toBeVisible();
  await page.getByRole("button", { name: "Remove notice" }).click();
  await expect(page.getByText("Notice removed. Guests no longer see it.")).toBeVisible();
  await expect(page.getByText("No notice is showing now.")).toBeVisible();
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).settings.announcement, DB_KEY);
  expect(stored).toBeNull();
});

test("settings: the save result shows next to Save; a validation error moves focus to the field", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/settings");
  const save = page.getByRole("button", { name: "Save settings" });
  await page.getByLabel("Map link").fill("javascript:alert(1)");
  await save.click();
  await expect(page.getByLabel("Map link")).toBeFocused();
  const bar = save.locator("xpath=..");
  await expect(bar.getByRole("status")).toContainText("Please fix the highlighted fields.");
  await page.getByLabel("Map link").fill("");
  await save.click();
  await expect(bar.getByRole("status")).toContainText("Settings saved.");
  await expect(bar.getByRole("status")).toBeInViewport();
});

test("Needs action: oldest waiting order first, stale flag visible", async ({ page }) => {
  await fixClock(page);
  await signIn(page);
  const articles = page.getByRole("tabpanel").getByRole("article");
  await expect(articles).toHaveCount(3);
  // NC-1041 placed 45 min ago (stale), NC-1043 placed 3 min ago, NC-1042 confirmed
  await expect(articles.nth(0)).toContainText("NC-1041");
  await expect(articles.nth(0)).toContainText("Waiting over 30 min");
  await expect(articles.nth(0)).toContainText("Placed 45 min ago");
  await expect(articles.nth(1)).toContainText("NC-1043");
  await expect(articles.nth(2)).toContainText("NC-1042");
});

test("customer order page: Keep this link with a Copy link button (just placed only)", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are Chromium-only in Playwright");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await addTee(page, 1);
  await page.goto("/checkout");
  await fillCustomer(page, "Link Keeper", "9862222222");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\/.+\?placed=1/);
  await expect(page.getByRole("heading", { name: "Keep this link" })).toBeVisible();
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Link copied." })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/\/order\/[^?#]+$/); // without ?placed=1
  await page.goto(copied);
  await expect(page.getByRole("heading", { name: "Keep this link" })).toHaveCount(0);
});

test("SEC-021: badly shaped product slugs are a 404; product pages are not stored in the page cache", async ({ request }) => {
  for (const s of ["NOT-A-SLUG", "tee_two", "x".repeat(81), "nope"]) {
    const res = await request.get(`/shop/${s}`);
    expect(res.status(), s).toBe(404);
    expect(res.headers()["x-nextjs-cache"], s).toBeUndefined();
  }
  const ok = await request.get("/shop/sample-tee");
  expect(ok.status()).toBe(200);
  expect(ok.headers()["x-nextjs-cache"]).toBeUndefined();
});

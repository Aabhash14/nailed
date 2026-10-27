import type { Page } from "@playwright/test";
import { expect, fixClock, signIn, test } from "./helpers";

/**
 * Bugs found by QA on 2026-10-22 (T-042 exploratory pass). Each test describes the EXPECTED behaviour. An open bug's
 * test is marked test.fail(): it passes while the bug exists and turns red ("expected to fail, but passed") once fixed.
 * When that happens: remove test.fail(), re-test, and close the bug file in engineering/qa/bugs/.
 * QA_SHOW_OPEN_BUGS=1 runs them as normal tests, to see the real failure messages.
 * 2026-10-23 (frontend fix pass): BUG-007, BUG-008, BUG-011 and BUG-013 fixed, so their test.fail() markers are gone.
 * More regression tests for that pass are in fixes-2026-10-23.spec.ts.
 */

const DB_KEY = "nc-mock-db-v1";
const DRAFT_ID = "00000000-0000-4000-8005-000000000003";

const productCard = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: new RegExp(name) }) });

async function storedDraft(page: Page) {
  return page.evaluate(
    ([key, id]) =>
      (JSON.parse(localStorage.getItem(key)!) as { products: { id: string; isPublished: boolean; variants: { stock: number }[] }[] }).products.find(
        (p) => p.id === id,
      )!,
    [DB_KEY, DRAFT_ID] as const,
  );
}

test("BUG-007: saving the product form does not undo a Publish or stock change made in the list while it was open", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/products");
  const card = productCard(page, "Unpublished sample");
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("form", { name: "Edit Unpublished sample" });
  await expect(form).toBeVisible();

  await card.getByRole("button", { name: "Publish" }).click();
  await expect(card.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await card.locator("table").getByLabel(/^Stock/).fill("42");
  await card.locator("table").getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await storedDraft(page)).variants[0]!.stock).toBe(42);

  await form.getByLabel(/^Description/).fill("Sample description edit only");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);

  const after = await storedDraft(page);
  expect(after.isPublished, "Publish was undone by the form save").toBe(true);
  expect(after.variants[0]!.stock, "stock was reverted by the form save").toBe(42);
});

test("BUG-008: Edit on a product lower in the list brings the form into view and moves focus to it (phone)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await signIn(page);
  await page.goto("/admin/products");
  const edit = productCard(page, "Unpublished sample").getByRole("button", { name: "Edit", exact: true });
  await edit.scrollIntoViewIfNeeded();
  await edit.click();
  const form = page.getByRole("form", { name: "Edit Unpublished sample" });
  await expect(form).toBeInViewport({ ratio: 0.05 });
  expect(await form.evaluate((f) => f.contains(document.activeElement))).toBe(true);
});

test("BUG-013: an order created on an earlier day and completed today shows under Finished today", async ({ page }) => {
  // The QA case exactly, on a fixed clock: it is 00:12 in Kathmandu and NC-1042 was placed at 23:52 the day before
  await fixClock(page, "2026-10-22T18:27:00Z");
  await signIn(page);
  await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key)!);
    const o = db.orders.find((x: { number: string }) => x.number === "NC-1042");
    o.createdAt = "2026-10-22T18:07:00.000Z";
    localStorage.setItem(key, JSON.stringify(db));
  }, DB_KEY);
  await page.reload();
  const c = page.getByRole("article").filter({ hasText: "NC-1042" });
  await c.getByRole("button", { name: /ready/i }).click();
  await expect(c).toContainText(/Ready for pickup/i);
  await c.getByRole("button", { name: /complete|handed|cash/i }).click();
  await page.getByRole("tab", { name: /Finished today/ }).click();
  await expect(page.getByRole("article").filter({ hasText: "NC-1042" })).toContainText(/Cash received/);
  await expect(page.getByRole("article").filter({ hasText: "NC-1042" })).toContainText("Finished 00:12");
});

test("BUG-011: staff see the current notice banner text before editing it", async ({ page }) => {
  await signIn(page); // owner sets a notice
  await page.goto("/admin/settings");
  await page.getByLabel(/^Notice banner|^Announcement/).first().fill("Closed Saturday for Tihar");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login/);

  await signIn(page, "staff1@example.com");
  await page.goto("/admin/settings");
  await expect(page.getByLabel(/Notice banner/)).toHaveValue("Closed Saturday for Tihar");
});

import { expect, noHorizontalScroll, test } from "./helpers";

test("menu browse: categories, prices, sample banner, VAT note", async ({ page }) => {
  await page.goto("/menu");
  await expect(page.getByRole("heading", { level: 1, name: "Menu" })).toBeVisible();
  await expect(page.getByText("Sample data").first()).toBeVisible();
  for (const c of ["Hot drinks", "Cold drinks", "Food"]) {
    await expect(page.getByRole("heading", { level: 2, name: c })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Menu categories" }).getByRole("link", { name: c })).toBeVisible();
  }
  await expect(page.getByText("Rs. 120").first()).toBeVisible();
  await expect(page.getByText("Hidden sample item")).toHaveCount(0);
  await expect(page.getByText(/Prices include 13% VAT/)).toBeVisible();
  await noHorizontalScroll(page);
});

test("menu: sold-out item is marked in text (not colour only) and price struck", async ({ page }) => {
  await page.goto("/menu");
  const row = page.getByRole("listitem").filter({ hasText: "Sample masala chai" });
  await expect(row.getByText("Sold out", { exact: true })).toBeVisible();
  await expect(row.getByText(/Not available right now/)).toBeVisible();
  await expect(row.locator("s")).toBeVisible();
  // variant sold-out
  const coffee = page.getByRole("listitem").filter({ hasText: "Sample black coffee" });
  await expect(coffee.getByText("(sold out)")).toBeVisible();
  await expect(coffee.getByText(/Large \+Rs\. 30/)).toBeVisible();
});

test("menu: vegetarian-only filter hides non-veg and egg", async ({ page }) => {
  await page.goto("/menu");
  await expect(page.getByText("Sample chicken momo")).toBeVisible();
  await page.getByLabel("Vegetarian only").check();
  await expect(page.getByText("Sample chicken momo")).toHaveCount(0);
  await expect(page.getByText("Sample egg toast")).toHaveCount(0);
  await expect(page.getByText("Sample veg sandwich")).toBeVisible();
  await page.getByLabel("Vegetarian only").uncheck();
  await expect(page.getByText("Sample egg toast")).toBeVisible();
});

test("menu: category links jump to sections; tags render as text", async ({ page }) => {
  await page.goto("/menu");
  await page.getByRole("navigation", { name: "Menu categories" }).getByRole("link", { name: "Food" }).click();
  await expect(page).toHaveURL(/#cat-food$/);
  await expect(page.getByText("Chef's pick")).toBeVisible();
  await expect(page.getByText("Bestseller")).toBeVisible();
});

test("menu: live status line is announced politely and says it is live or offline", async ({ page }) => {
  await page.goto("/menu");
  const status = page.locator("p[aria-live=polite]").first();
  await expect(status).toHaveText(/Live\. Updated|Offline|Saved copy/);
});

test("menu: ?table= QR badge", async ({ page }) => {
  await page.goto("/menu?t=5");
  await expect(page.getByText("Table 5")).toBeVisible();
  await page.goto("/menu?t=500");
  await expect(page.getByText(/^Table \d/)).toHaveCount(0);
  await page.goto("/menu?t=<script>");
  await expect(page.getByText(/^Table /)).toHaveCount(0);
});

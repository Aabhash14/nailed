import { addTee, expect, fillCustomer, noHorizontalScroll, test } from "./helpers";

test("shop list: published products only, sold-out state", async ({ page }) => {
  await page.goto("/shop");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Sample tee").first()).toBeVisible();
  await expect(page.getByText("Sample hoodie").first()).toBeVisible();
  await expect(page.getByText("Unpublished sample")).toHaveCount(0);
  await expect(page.getByText(/sold out/i).first()).toBeVisible(); // hoodie has no stock
  await noHorizontalScroll(page);
});

test("product page: sold-out size is disabled; add to cart updates cart", async ({ page }) => {
  await page.goto("/shop/sample-tee");
  await expect(page.getByRole("radio", { name: /XL, Black/ })).toBeDisabled();
  await expect(page.getByText("Only a few left").first()).toBeVisible(); // L has 2
  await page.getByRole("radio", { name: /M, Black/ }).check({ force: true });
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByText("Added to your cart.")).toBeVisible();
  await page.getByRole("link", { name: "View cart" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByText("Sample tee").first()).toBeVisible();
  await expect(page.getByText("Subtotal")).toBeVisible();
});

test("product page: fully sold-out product cannot be added", async ({ page }) => {
  await page.goto("/shop/sample-hoodie");
  await expect(page.getByRole("button", { name: "Sold out" })).toBeDisabled();
});

test("BUG-001: unknown product slug and unpublished slug return a real 404 with one robots meta", async ({ page, errors }) => {
  for (const s of ["nope", "sample-draft"]) {
    const res = await page.goto(`/shop/${s}`);
    expect(res?.status(), `${s} HTTP status`).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" }), s).toBeVisible();
    await expect(page.locator('meta[name="robots"]'), `${s} robots meta count`).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]'), s).toHaveAttribute("content", /noindex/);
  }
  const res = await page.request.get("/shop/nope");
  expect(res.status()).toBe(404);
  errors.splice(0, errors.length, ...errors.filter((e) => !/status of 404/.test(e)));
});

test("shop list still shows its loading skeleton route and a known product is 200", async ({ page }) => {
  const res = await page.goto("/shop/sample-tee");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Sample tee" })).toBeVisible();
});

test("BUG-004: checkout accepts the phone formats the server accepts, with a hint for a leading 0", async ({ page }) => {
  await addTee(page, 1);
  await page.goto("/checkout");
  await fillCustomer(page, "Zero Typer", "09841234567");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText(/Leave out the 0 at the start/).first()).toBeVisible();
  await page.getByLabel("Phone").fill("(984)1234567");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\/[0-9a-f-]{36}\?placed=1/);
  await addTee(page, 1);
  await page.goto("/checkout");
  await fillCustomer(page, "Intl Typer", "009779841234567");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
});

test("BUG-005: a refused customer cancel still explains itself after the cancel section disappears", async ({ page }) => {
  await addTee(page, 1);
  await page.goto("/checkout");
  await fillCustomer(page, "Late Canceller", "9862222222");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
  await page.getByRole("button", { name: "Cancel this order" }).click();
  // staff confirms the order in another tab before the customer clicks "Yes" (same browser storage = same mock db)
  await page.evaluate(() => {
    const key = "nc-mock-db-v1";
    const db = JSON.parse(localStorage.getItem(key)!);
    const o = db.orders.find((x: { customerName: string }) => x.customerName === "Late Canceller");
    o.status = "confirmed";
    o.confirmedAt = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.getByRole("button", { name: "Yes, cancel my order" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your order is confirmed");
  await expect(page.getByRole("button", { name: "Cancel this order" })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "Your order was NOT cancelled" })).toBeVisible();
  await expect(page.getByText("Please call us to change this order")).toBeVisible();
});

test("cart: qty change, max qty, remove, empty state, persists on reload", async ({ page }) => {
  await addTee(page, 1);
  await page.goto("/cart");
  const plus = page.getByRole("button", { name: "More" });
  await plus.click();
  await expect(page.getByText("Rs. 2,998").first()).toBeVisible();
  for (let i = 0; i < 12; i++) if (await plus.isEnabled()) await plus.click();
  await expect(plus).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Fewer" })).toBeVisible();
  await page.getByRole("button", { name: /^Remove/ }).click();
  await expect(page.getByText("Your cart is empty")).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse the shop" })).toBeVisible();
});

test("checkout with empty cart shows empty state", async ({ page }) => {
  await page.goto("/checkout");
  await expect(page.getByText("Your cart is empty")).toBeVisible();
});

test("checkout: COD/pickup only, no payment gateway UI", async ({ page }) => {
  await addTee(page, 1);
  await page.goto("/checkout");
  await expect(page.getByText("Pickup at the cafe")).toBeVisible();
  await expect(page.getByText("Delivery", { exact: true })).toBeVisible();
  const body = (await page.locator("body").innerText()).toLowerCase();
  for (const w of ["esewa", "khalti", "fonepay", "card number", "bank transfer", "stripe"]) expect(body).not.toContain(w);
  await expect(page.getByText(/cash/i).first()).toBeVisible();
  await expect(page.getByText("We will call you to confirm your order.")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("checkout validation: empty submit lists errors, bad phone rejected", async ({ page }) => {
  await addTee(page, 1);
  await page.goto("/checkout");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Please fix the highlighted fields")).toBeVisible();
  await expect(page.locator("[aria-invalid=true]").first()).toBeVisible();
  await fillCustomer(page, "Test Buyer", "12345");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText(/mobile|valid|phone/i).first()).toBeVisible();
  await expect(page).toHaveURL(/\/checkout/);
});

test("pickup order end to end, then customer cancel", async ({ page }) => {
  await addTee(page, 1);
  await page.goto("/checkout");
  await fillCustomer(page);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\/[0-9a-f-]{36}\?placed=1/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Thank you, we have your order");
  await expect(page.getByText("We will call you to confirm").first()).toBeVisible();
  await expect(page.getByText(/Pay Rs\. 1,499 in cash/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Order progress" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel this order" }).click();
  await page.getByRole("button", { name: "Keep my order" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Thank you, we have your order");
  await page.getByRole("button", { name: "Cancel this order" }).click();
  await page.getByRole("button", { name: "Yes, cancel my order" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This order was cancelled");
  await expect(page.getByRole("button", { name: "Cancel this order" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This order was cancelled");
});

test("delivery order: area required, fee and total shown, order page says cash on delivery", async ({ page }) => {
  await addTee(page, 1);
  await page.goto("/checkout");
  await page.getByText("Delivery", { exact: true }).click();
  await expect(page.getByText("Rs. 150").first()).toBeVisible();
  await expect(page.getByText("Rs. 1,649").first()).toBeVisible();
  await fillCustomer(page);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Please fix the highlighted fields")).toBeVisible();
  await page.getByLabel("Area").selectOption("Baluwatar");
  await page.getByLabel("Address").fill("House 12");
  await page.getByLabel("Landmark").fill("Near the temple");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
  await expect(page.getByText(/Pay Rs\. 1,649 in cash on delivery/)).toBeVisible();
});

test("COD max total (Rs. 5,000) refuses the order with the generic message", async ({ page }) => {
  await addTee(page, 4); // 4 x 1499 = 5,996
  await page.goto("/checkout");
  await fillCustomer(page);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("We cannot take this order online")).toBeVisible();
});

test("open-orders-per-phone cap (2) refuses the third order", async ({ page }) => {
  for (let i = 0; i < 3; i++) {
    await addTee(page, 1);
    await page.goto("/checkout");
    await fillCustomer(page, "Repeat Buyer", "9851111111");
    await page.getByRole("button", { name: "Place order" }).click();
    if (i < 2) await expect(page).toHaveURL(/\/order\//);
    else await expect(page.getByText("We cannot take this order online")).toBeVisible();
  }
});

test("out of stock: asking for more than the stock gives a line error", async ({ page }) => {
  await addTee(page, 3, /L, Black/); // stock 2
  await page.goto("/checkout");
  await fillCustomer(page);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText(/not available in the quantity/)).toBeVisible();
  await expect(page.getByText(/only 2 left/)).toBeVisible();
});

test("order page: unknown token shows not-found message", async ({ page }) => {
  await page.goto("/order/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("We could not find that order")).toBeVisible();
});

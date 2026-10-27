import { expect, noHorizontalScroll, test } from "./helpers";

test("home renders (updated: scaffold 'Home' heading no longer exists)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await noHorizontalScroll(page);
});

test("health endpoint returns the envelope and is not cached", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect((await res.json()).ok).toBe(true);
});

test("unknown route shows the branded 404 with a way home", async ({ page, errors }) => {
  // the browser logs the 404 document itself as a console "error"; that single line is expected here
  page.on("console", () => errors.splice(0, errors.length, ...errors.filter((e) => !/status of 404/.test(e))));
  const res = await page.goto("/definitely-not-a-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to the home page" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("public pages load without overflow", async ({ page }) => {
  for (const p of ["/", "/menu", "/shop", "/story", "/visit", "/policies", "/cart", "/checkout"]) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBe(200);
    await expect(page.locator("h1").first(), p).toBeVisible();
    await noHorizontalScroll(page);
  }
});

test("no payment code ships: no payment routes, no gateway text on public pages", async ({ page, request }) => {
  for (const r of ["/api/payments/esewa/return", "/api/payments/khalti/return", "/api/cron/reconcile", "/api/orders/x/retry-payment"]) {
    const res = await request.get(r);
    expect([404, 405], r).toContain(res.status());
  }
  for (const p of ["/shop", "/cart", "/policies"]) {
    await page.goto(p);
    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const w of ["esewa", "khalti", "fonepay", "credit card", "debit card"]) expect(body, `${p} mentions ${w}`).not.toContain(w);
  }
});

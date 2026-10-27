import { expect, signIn, test } from "./helpers";

/**
 * Table ordering in mock mode (contract 2.2.0 section 9). The seed has table 7 open with code P4W9ZE and one round
 * waiting (src/mocks/tables-seed.ts).
 */

test("guest: scanned QR joins, the code leaves the address before any request, a round goes to the kitchen", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => {
    seen.push(r.url());
    const ref = r.headers()["referer"];
    if (ref) seen.push(ref);
  });
  await page.goto("/menu?t=7#c=P4W9ZE");
  await expect(page.getByRole("button", { name: /Cart and orders/ })).toBeVisible();
  expect(page.url()).not.toContain("P4W9ZE");
  expect(seen.filter((u) => /P4W9ZE|code=|#c=/.test(u))).toEqual([]); // SEC-024

  await expect(page.getByText(/of 8 tables free/)).toBeVisible();
  await page.getByRole("button", { name: /^\+?\s*Add\s+Sample milk tea$/ }).click();
  await expect(page.getByText("1 in cart")).toBeVisible();
  await page.getByRole("button", { name: /Cart and orders/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Order summary, not a bill or tax invoice")).toBeVisible();
  await sheet.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(sheet.getByText("Round 2 sent. Our staff will bring it to your table.")).toBeVisible();
  await expect(sheet.getByText("Waiting").first()).toBeVisible();
});

test("guest: a wrong code is refused with the contract message; the join sheet stays open", async ({ page }) => {
  await page.goto("/menu?t=7#c=AAAAAA");
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("That code doesn't match this table. Check it, or ask our staff.")).toBeVisible();
  expect(page.url()).not.toContain("AAAAAA");
});

test("staff: the board shows the waiting round; accept it; staff see no void for a table with accepted orders", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.getByRole("link", { name: "Tables" }).click();
  await expect(page.getByRole("heading", { name: "Tables", level: 1 })).toBeVisible();
  const t7 = page.getByRole("article", { name: "Table 7" });
  await expect(t7.getByText("P4W 9ZE")).toBeVisible();
  await t7.getByRole("button", { name: "Accept round 1" }).click();
  await expect(t7.getByText(/Cancel available for \d+ min\. The owner will be notified\./)).toBeVisible();

  const t2 = page.getByRole("article", { name: "Table 2" });
  await t2.getByRole("button", { name: "Close table" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Only the owner can void a table after an order was accepted. Close it as paid.")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Void (nothing to pay)" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Keep it open" }).click();
  await expect(page.getByRole("link", { name: "Alerts" })).toHaveCount(0); // owner only
});

test("owner: alerts page lists unread alerts (no phone channel yet); the nav badge counts them", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("link", { name: /Alerts\s*2 unread/ })).toBeVisible();
  await page.getByRole("link", { name: /Alerts/ }).click();
  await expect(page.getByText("Phone alerts: not set up yet. Alerts appear here.")).toBeVisible();
  await page.getByRole("button", { name: /Mark as read\s+for Accepted order cancelled/ }).click();
  await expect(page.getByRole("link", { name: /Alerts\s*1 unread/ })).toBeVisible();
});

import { expect, fixClock, noHorizontalScroll, signIn, test } from "./helpers";

/**
 * Owner Stats dashboard + staff/owner "Log sales" screen, in MOCK mode (contract 1.5.0).
 * The browser clock is fixed at Thursday 22 Oct 2026, 12:00 Kathmandu (helpers.MIDDAY_NST). The mock has a generated
 * DEMO food log for the 60 days before "today" (Saturdays closed, every day noted "DEMO DATA") and sample shop orders.
 */

test.describe("stats: owner", () => {
  test("sees KPIs with change in words, charts with a table view, and the demo-data note", async ({ page }) => {
    await fixClock(page);
    await signIn(page);
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Stats" }).click();
    await expect(page.getByRole("heading", { name: "Stats", level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "Choose the dates" }).getByText("Showing 23 Sep to 22 Oct 2026")).toBeVisible(); // default: last 30 days
    await expect(page.getByText("Total earnings")).toBeVisible();
    await expect(page.getByText(/(Up|Down) [\d.]+% on previous period/).first()).toBeVisible();
    await expect(page.getByText("Demo data", { exact: true })).toBeVisible();

    // chart: title + summary + table on request
    const chart = page.getByRole("region", { name: "Earnings over time" });
    await expect(chart.getByText(/in total: food/)).toBeVisible();
    await chart.getByRole("button", { name: "Show as table" }).click();
    await expect(chart.getByRole("table")).toBeVisible();
    await expect(chart.getByRole("columnheader", { name: "Food" })).toBeVisible();
    await chart.getByRole("button", { name: "Show as chart" }).click();

    // top food tabs: arrow keys move between quantity and earnings
    const qtyTab = page.getByRole("tab", { name: "By quantity" });
    await qtyTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "By earnings" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("list", { name: "Top food by earnings" }).getByRole("listitem").first()).toContainText("Rs.");

    // best food per day: unlogged Saturdays say so
    await expect(page.getByRole("row", { name: /Sat 17 Oct Not logged/ })).toBeVisible();

    // cancellations: refused attempts are "not recorded", never a made-up number
    await expect(page.locator("p", { hasText: "Refused attempts:" })).toContainText("not recorded");

    await noHorizontalScroll(page);
  });

  test("range presets, compare toggle and grain update the view and the address bar", async ({ page }) => {
    await fixClock(page);
    await signIn(page);
    await page.goto("/admin/stats");
    await page.getByText("Last 7 days", { exact: true }).click();
    await expect(page.getByRole("region", { name: "Choose the dates" }).getByText("Showing 16 Oct to 22 Oct 2026")).toBeVisible();
    await expect(page).toHaveURL(/range=last7Days/);
    await expect(page.getByText("Changes are against 9 Oct to 15 Oct 2026.")).toBeVisible();

    await page.getByLabel("Compare to previous period").uncheck();
    await expect(page).toHaveURL(/compare=0/);
    await expect(page.getByText("No comparison").first()).toBeVisible();

    await page.getByText("Week", { exact: true }).click();
    await expect(page.getByText(/chart by week, weeks start on Sunday/)).toBeVisible();

    // custom range: validation, then apply
    await page.getByText("Custom", { exact: true }).click();
    await page.getByLabel("From", { exact: true }).fill("2026-10-10");
    await page.getByLabel("To", { exact: true }).fill("2026-10-01");
    await page.getByRole("button", { name: "Show these dates" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "on or before" })).toBeVisible();
    await page.getByLabel("To", { exact: true }).fill("2026-10-20");
    await page.getByRole("button", { name: "Show these dates" }).click();
    await expect(page.getByRole("region", { name: "Choose the dates" }).getByText("Showing 10 Oct to 20 Oct 2026")).toBeVisible();
    await expect(page).toHaveURL(/range=custom&from=2026-10-10&to=2026-10-20/);
  });

  test("an empty range shows an empty state, and stock alerts link to the product", async ({ page }) => {
    await fixClock(page);
    await signIn(page);
    await page.goto("/admin/stats?range=custom&from=2025-01-01&to=2025-01-31");
    await expect(page.getByText("Nothing recorded for these dates")).toBeVisible();
    const alerts = page.getByRole("region", { name: "Stock alerts" });
    await expect(alerts.getByText("Sold out").first()).toBeVisible();
    await alerts.getByRole("link", { name: /Change stock/ }).first().click();
    await expect(page).toHaveURL(/\/admin\/products#product-/);
    await expect(page.locator("h2:focus")).toBeVisible();
  });
});

test("stats: staff are blocked and the nav has no Stats link", async ({ page }) => {
  await fixClock(page);
  await signIn(page, "staff@example.com");
  await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Stats" })).toHaveCount(0);
  await page.goto("/admin/stats");
  await expect(page.getByRole("heading", { name: "Stats", level: 1 })).toBeVisible();
  await expect(page.getByText("Owner only")).toBeVisible();
  await expect(page.getByText("Total earnings")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Log today's sales" })).toHaveAttribute("href", "/admin/sales");
});

test.describe("sales log", () => {
  test("staff log today's sales with steppers and typing, see a live total, save, and it survives a reload", async ({ page }) => {
    await fixClock(page);
    await signIn(page, "staff@example.com");
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Sales" }).click();
    await expect(page.getByRole("heading", { name: "Log today's sales" })).toBeVisible();
    await expect(page.getByText(/Thursday 22 October 2026/)).toBeVisible();
    await expect(page.getByText(": nothing logged yet.")).toBeVisible();
    await expect(page.getByLabel("Another day")).toHaveCount(0); // staff: today and yesterday only

    await page.getByRole("button", { name: "One more Sample milk tea" }).click();
    await page.getByRole("button", { name: "One more Sample milk tea" }).click();
    await page.getByLabel("Quantity of Sample chicken momo").fill("12");
    await page.getByRole("button", { name: "One more Sample black coffee, Large" }).click(); // option sub-row: Rs. 150 + 30
    await expect(page.getByText("15 items, Rs. 3,540")).toBeVisible(); // 2 x 120 + 12 x 260 + 1 x 180
    await expect(page.getByText("Not saved yet")).toBeVisible();

    await page.getByLabel("Till total for food (Rs.) (optional)").fill("3,600");
    await page.getByLabel("Note (optional)").fill("Busy lunch");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").getByText("Saved at 12:00 by staff")).toBeVisible();
    await expect(page.getByText("All saved")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Quantity of Sample chicken momo")).toHaveValue("12");
    await expect(page.getByLabel("Quantity of Sample black coffee, Large")).toHaveValue("1");
    await expect(page.getByLabel("Till total for food (Rs.) (optional)")).toHaveValue("3600");
    await expect(page.getByText("Saved at 12:00 by staff", { exact: true })).toBeVisible(); // loaded log with updatedByName
    await noHorizontalScroll(page);
  });

  test("clearing a row sends 0 and the total drops", async ({ page }) => {
    await fixClock(page);
    await signIn(page, "staff@example.com");
    await page.goto("/admin/sales");
    await page.getByLabel("Quantity of Sample veg sandwich").fill("4");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/^Saved at/)).toBeVisible();
    await page.getByRole("button", { name: "One less Sample veg sandwich" }).click();
    await page.getByLabel("Quantity of Sample veg sandwich").fill("");
    await expect(page.getByText("0 items, Rs. 0")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/^Saved at/)).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Quantity of Sample veg sandwich")).toHaveValue("");
  });

  test("yesterday loads the existing (demo) log; the owner can open an older day", async ({ page }) => {
    await fixClock(page);
    await signIn(page);
    await page.goto("/admin/sales");
    await page.getByText("Yesterday", { exact: true }).click();
    await expect(page.getByText(/Wednesday 21 October 2026: last saved/)).toBeVisible();
    await expect(page.getByText("This day holds made-up sample counts")).toBeVisible();
    await expect(page.getByLabel("Quantity of Sample milk tea")).not.toHaveValue("");

    await page.getByLabel("Another day").fill("2026-10-17"); // a Saturday: closed in the demo, nothing logged
    await expect(page.getByText(/Saturday 17 October 2026: nothing logged yet/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Log sales", level: 1 })).toBeVisible();
  });
});

import { expect, signIn, test } from "./helpers";

/**
 * QA 2026-10-24 (rebuild), MOCK mode. Re-tests the frontend fixes made after the restyle review:
 *  - R24-9: one page-level notice on Home (the single "Sample data" banner in mock mode, at the top, not in the hero)
 *  - R24-3: a menu tab is current at load (exactly one, the first)
 *  - BUG-018: a language picked before hydration is kept. Deterministic version: the page's JS chunks are HELD until
 *    the guest has picked, so the pick is guaranteed to happen before React exists (the CPU-throttled test in
 *    menu-i18n.spec.ts only makes that likely).
 *  - R24-6: compact admin row: "Change price" opens the field in place, focus moves in, Esc closes, focus returns.
 */
const KEY = "nailed.menuLang";
const run = (lang: string) => `main [lang="${lang}"]:not(option)`;

test("R24-9: Home in mock mode shows exactly one page-level notice (Sample data), at the top, outside the hero", async ({ page }) => {
  await page.goto("/");
  const main = page.locator("main");
  await expect(main.getByText("Sample data", { exact: true })).toHaveCount(1);
  await expect(main.getByText(/made-up development data/)).toHaveCount(1);
  // no second notice: no DraftNote, no inline "Sample data ..." lines under the teasers
  await expect(main.getByText("Placeholder:", { exact: true })).toHaveCount(0);
  await expect(main.getByText(/^Sample data[ .,:]/)).toHaveCount(0);
  await expect(page.locator("#home-title").locator("..").getByText("Sample data")).toHaveCount(0);
  // the banner sits above the hero heading
  const banner = await main.getByText("Sample data", { exact: true }).boundingBox();
  const h1 = await page.locator("#home-title").boundingBox();
  expect(banner!.y).toBeLessThan(h1!.y);
});

test("R24-3: exactly one menu tab is current at load, and it is the first", async ({ page }) => {
  await page.goto("/menu");
  const nav = page.getByRole("navigation", { name: "Menu categories" });
  await expect(nav.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(nav.getByRole("link").first()).toHaveAttribute("aria-current", "true");
});

test("BUG-018 (deterministic): the pick is made while the scripts are held; after hydration it is kept and saved", async ({ page }) => {
  test.setTimeout(60_000);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  await page.route(/\/_next\/static\/chunks\/.*\.js/, async (route) => {
    held += 1;
    await gate;
    await route.continue();
  });
  await page.goto("/menu", { waitUntil: "domcontentloaded" });
  const picker = page.locator("#menu-lang");
  await picker.waitFor({ state: "visible" });
  // React cannot have hydrated: no chunk has been delivered yet
  expect(held, "JS chunks requested and held").toBeGreaterThan(0);
  expect(await picker.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__react")))).toBe(false);
  await picker.selectOption("ne");
  release();
  await expect(page.locator(`${run("ne")}:not([aria-hidden="true"])`).filter({ hasText: /^मेनु$/ })).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), KEY), { timeout: 15_000 }).toBe("ne");
  expect(await picker.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__react")))).toBe(true);
  await page.waitForTimeout(1_500);
  await expect(picker).toHaveValue("ne");
  await page.reload();
  await expect(page.getByLabel("Language")).toHaveValue("ne");
});

test("R24-6: admin row: 'Change price' opens the price field in place with focus in it; Esc closes and focus returns", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/menu");
  const row = page.getByRole("listitem").filter({ hasText: "Sample black coffee" }).first();
  // closed by default: no price input in the row, the price shown once
  await expect(row.getByLabel("Price (Rs.)")).toHaveCount(0);
  await expect(row.getByText(/^Rs\. [\d,]+$/)).toHaveCount(1);
  const change = row.getByRole("button", { name: "Change price" });
  await expect(change).toHaveAttribute("aria-expanded", "false");
  await change.click();
  await expect(change).toHaveAttribute("aria-expanded", "true");
  const field = row.getByLabel("Price (Rs.)");
  await expect(field).toBeFocused();
  await expect(row.getByRole("button", { name: "Save price" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row.getByLabel("Price (Rs.)")).toHaveCount(0);
  await expect(change).toBeFocused();
  await expect(change).toHaveAttribute("aria-expanded", "false");
  // Cancel works the same way
  await change.click();
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row.getByLabel("Price (Rs.)")).toHaveCount(0);
  await expect(change).toBeFocused();
});

import { expect, signIn, test } from "./helpers";

/**
 * Multi-language menu (contract 1.4.0), mock mode. English is always shown; the guest adds ONE secondary language.
 * Mock data (src/mocks/translations.ts): Sample black coffee / masala chai / iced coffee / chicken momo, the
 * "Cold drinks" category and the Oat milk / Large options have translations; "Hot drinks", "Food", Sample milk tea etc.
 * have none, so they show English only. The helpers fail every test on a console error, which includes React
 * hydration-mismatch errors, so a stored language must never break hydration.
 */
const KEY = "nailed.menuLang";
/** Secondary runs on the page, outside the picker's own <option> labels. */
const run = (lang: string) => `main [lang="${lang}"]:not(option)`;

test("menu i18n: English only by default; picking 日本語 adds Japanese next to the English, with lang=ja", async ({
  page,
}) => {
  await page.goto("/menu");
  const picker = page.getByLabel("Language");
  await expect(picker).toHaveValue("none");
  for (const l of ["zh-Hans", "ja", "ko", "pt-BR"])
    await expect(page.locator(run(l))).toHaveCount(0);

  await picker.selectOption("ja");
  await expect(picker).toHaveValue("ja");
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe("ja");

  // title: English h1 stays, Japanese next to it
  await expect(page.getByRole("heading", { level: 1, name: "Menu" })).toBeVisible();
  await expect(page.locator(run("ja")).filter({ hasText: /^メニュー$/ })).toBeVisible();

  // item: English name stays; the Japanese name, the sold-out word and the sold-out line all carry lang="ja"
  const chai = page.getByRole("listitem").filter({ hasText: "Sample masala chai" });
  await expect(chai.getByRole("heading", { level: 3, name: /Sample masala chai/ })).toBeVisible();
  await expect(chai.locator('[lang="ja"]').filter({ hasText: /^マサラチャイ$/ })).toBeVisible();
  await expect(chai.getByText("Sold out", { exact: true })).toBeVisible();
  await expect(chai.locator('[lang="ja"]').filter({ hasText: /^売り切れ$/ })).toBeVisible();
  await expect(
    chai.locator('[lang="ja"]').filter({ hasText: /スタッフにお尋ねください/ }),
  ).toBeVisible();
  // no Nepali "Say it" in Japanese mode
  await expect(page.getByText("Say it:")).toHaveCount(0);

  // options: English label + Japanese label
  const coffee = page.getByRole("listitem").filter({ hasText: "Sample black coffee" });
  await expect(coffee.getByText(/Large/)).toBeVisible();
  await expect(coffee.locator('[lang="ja"]').filter({ hasText: /^ラージ$/ })).toBeVisible();

  // category with a translation vs without (missing -> English only, no empty run)
  await expect(
    page
      .locator("#cat-cold-drinks")
      .locator('[lang="ja"]')
      .filter({ hasText: /^コールドドリンク$/ })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Menu categories" })
      .getByRole("link", { name: /Hot drinks/ })
      .locator("[lang]"),
  ).toHaveCount(0);
  // An item with no translation gets no Japanese name or description: its only Japanese runs are the shared UI words
  // (the screen-reader diet word and the Bestseller tag), which are translated for every item. (QA 2026-10-24: the
  // old "0 runs" expectation predates the translated diet/tag words.)
  await expect(
    page.getByRole("listitem").filter({ hasText: "Sample milk tea" }).locator('[lang="ja"]'),
  ).toHaveText(["ベジタリアン", "人気"]);

  // footer and tags
  await expect(page.getByText(/Prices include 13% VAT/)).toBeVisible();
  await expect(page.locator(run("ja")).filter({ hasText: /^価格は13%のVAT/ })).toBeVisible();
  await expect(page.locator(run("ja")).filter({ hasText: /^人気$/ })).toBeVisible(); // Bestseller

  // every Japanese run is lang="ja" exactly (no zh / ko leaking in)
  for (const l of ["zh-Hans", "ko", "pt-BR"]) await expect(page.locator(run(l))).toHaveCount(0);
});

test("menu i18n: the choice survives a reload (server renders English, the stored language swaps in without errors)", async ({
  page,
}) => {
  await page.addInitScript((k) => localStorage.setItem(k, "ko"), KEY);
  await page.goto("/menu");
  await expect(page.getByLabel("Language")).toHaveValue("ko");
  await expect(page.locator(run("ko")).filter({ hasText: /^메뉴$/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Menu" })).toBeVisible();
  await page.reload();
  await expect(page.locator(run("ko")).filter({ hasText: /^마살라 차이$/ })).toBeVisible();
});

test("menu i18n: Nepali mode shows the Nepali name and the 'Say it' pronunciation, lang=ne", async ({
  page,
}) => {
  await page.goto("/menu");
  await page.getByLabel("Language").selectOption("ne");
  const chai = page.getByRole("listitem").filter({ hasText: "Sample masala chai" });
  await expect(chai.locator('[lang="ne"]').filter({ hasText: /^मसला चिया$/ })).toBeVisible();
  await expect(chai.getByText("Say it:")).toBeVisible();
  await expect(chai.locator('[lang="ne-Latn"]')).toHaveText("masala chiya");
  await expect(chai.getByText("Sample masala chai")).toBeVisible();
  // the decorative Devanagari title accent gives way to the secondary title (one craft detail per view)
  await expect(page.locator(run("ne")).filter({ hasText: /^मेनु$/ })).toHaveCount(1);
});

test("menu i18n: back to English only removes every secondary run; bad stored values mean English only", async ({
  page,
}) => {
  await page.goto("/menu");
  await page.getByLabel("Language").selectOption("pt");
  await expect(page.locator(run("pt-BR")).filter({ hasText: /^Cardápio$/ })).toBeVisible();
  await page.getByLabel("Language").selectOption("none");
  for (const l of ["ne", "zh-Hans", "ja", "ko", "pt-BR"]) {
    // English mode keeps only the decorative, aria-hidden Devanagari accents (numerals, the stamp echo)
    const sel = l === "ne" ? `${run("ne")}:not([aria-hidden="true"])` : run(l);
    await expect(page.locator(sel)).toHaveCount(0);
  }
  await expect(page.getByText("Sample masala chai")).toBeVisible();

  await page.evaluate((k) => localStorage.setItem(k, "fr"), KEY);
  await page.reload();
  await expect(page.getByLabel("Language")).toHaveValue("none");
});

test("menu i18n: owner adds a Chinese name in admin and it shows on the menu", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/menu");
  await page
    .getByRole("listitem")
    .filter({ hasText: "Sample milk tea" })
    .first()
    .getByRole("button", { name: "Edit details" })
    .click();
  const form = page.getByRole("form", { name: "Edit Sample milk tea" });
  await form
    .locator("summary")
    .filter({ hasText: /^Translations/ })
    .click();
  await form.locator("summary").filter({ hasText: "Chinese, simplified" }).click();
  await form.locator('input[lang="zh-Hans"]').first().fill("奶茶");
  await form.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);

  await page.goto("/menu");
  await page.getByLabel("Language").selectOption("zh");
  const tea = page.getByRole("listitem").filter({ hasText: "Sample milk tea" });
  await expect(tea.getByText("Sample milk tea")).toBeVisible();
  await expect(tea.locator('[lang="zh-Hans"]').filter({ hasText: /^奶茶$/ })).toBeVisible();
});

test("menu i18n: staff see an item's translations read-only (no inputs)", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/menu");
  const row = page.getByRole("listitem").filter({ hasText: "Sample black coffee" }).first();
  await row
    .locator("summary")
    .filter({ hasText: /^Translations/ })
    .click();
  await expect(row.locator('[lang="ja"]').filter({ hasText: "アメリカーノ" })).toBeVisible();
  await expect(row.locator("input, textarea")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save translations" })).toHaveCount(0);
});

test("BUG-018: a language picked before the menu has hydrated is kept (slow phone: CPU x8)", async ({ page }) => {
  test.setTimeout(60_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 8 });
  try {
    await page.goto("/menu", { waitUntil: "commit" });
    await page.locator("#menu-lang").waitFor({ state: "attached" });
    // QA: record whether the pick really happened before React attached to the select (else this run proves nothing
    // about BUG-018). The deterministic version holds the scripts: rebuild-2026-10-24.spec.ts.
    const hydratedBefore = await page
      .locator("#menu-lang")
      .evaluate((el) => Object.keys(el).some((k) => k.startsWith("__react")));
    test.info().annotations.push({ type: "BUG-018 pick", description: hydratedBefore ? "after hydration" : "before hydration" });
    await page.selectOption("#menu-lang", "ne"); // the guest taps as soon as the picker is on screen
    // Before hydration the native select already shows "ne" and the decorative (aria-hidden) "मेनु" accent is on the
    // page, so wait for the REAL secondary title (not aria-hidden) and the saved choice: both need React.
    await expect(
      page.locator(`${run("ne")}:not([aria-hidden="true"])`).filter({ hasText: /^मेनु$/ }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), KEY), { timeout: 15_000 }).toBe("ne");
    await expect(page.getByLabel("Language")).toHaveValue("ne");
    // ...and it stays after the first live refresh / re-renders
    await page.waitForTimeout(1_500);
    await expect(page.getByLabel("Language")).toHaveValue("ne");
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
});

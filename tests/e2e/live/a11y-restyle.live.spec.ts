import type { Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { addToteToCart, apiCheckout, expect, freshIp, guardLocal, LIVE, OWNER, signIn, test, waitForTurnstile } from "./live-helpers";

/**
 * Keyboard + screen-reader-semantics pass on the restyled (concept C) public components, LIVE mode, LOCAL stack only
 * (qa-engineer, 2026-10-24). Runs at phone-390 and desktop-1280 (live config projects).
 *   - menu category tabs (nav links with aria-current), size picker (fieldset + radios), product gallery buttons
 *     (aria-pressed), cart quantity stepper (group + Fewer/More), order progress (ol + aria-current="step").
 * The last test takes the 820 px full-page screenshots of the main pages (desktop project only, so they are taken once).
 */
test.skip(!LIVE, "live-mode spec: set E2E_LIVE=1 and run with tests/e2e/live/playwright.live.config.ts");
test.beforeAll(({ baseURL }) => guardLocal(baseURL));

const SHOTS = path.join(process.cwd(), "..", "qa", "screenshots", "restyle-2026-10-23");

/** Visible focus: an outline or a box-shadow ring on the element (or on the label of a visually hidden radio). */
async function focusRing(el: Locator) {
  return el.evaluate((node) => {
    const target = node instanceof HTMLInputElement && node.labels?.[0] && node.getBoundingClientRect().width <= 1 ? node.labels[0] : node;
    const cs = getComputedStyle(target);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    const shadow = cs.boxShadow !== "none" && cs.boxShadow !== "";
    return { outline, shadow, desc: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} | ${cs.boxShadow}` };
  });
}
async function tabUntil(page: Page, target: Locator, max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((n) => n === document.activeElement)) return i + 1;
  }
  throw new Error("target never received focus by Tab");
}

test("menu tabs: a nav of links, all reachable by Tab with a visible focus ring; Enter jumps to the section; one aria-current", async ({ page, ip }) => {
  void ip;
  await page.goto("/menu");
  const nav = page.getByRole("navigation", { name: "Menu categories" });
  await expect(nav).toBeVisible();
  const links = nav.getByRole("link");
  const n = await links.count();
  expect(n).toBeGreaterThan(2);
  expect(await page.getByRole("tab").count(), "links, not ARIA tabs (no tablist without keyboard model)").toBe(0);
  const presses = await tabUntil(page, links.first());
  test.info().annotations.push({ type: "menu-tabs", description: `first tab reached after ${presses} Tab presses; ${n} tabs` });
  for (let i = 0; i < n; i++) {
    const l = links.nth(i);
    if (i > 0) await page.keyboard.press("Tab");
    await expect(l).toBeFocused();
    const ring = await focusRing(l);
    expect(ring.outline || ring.shadow, `focus ring on tab ${i + 1}: ${ring.desc}`).toBe(true);
    await expect(l).toBeInViewport(); // the scrolling tab strip brings the focused tab into view
  }
  // Enter on the 3rd tab: the section heading comes into view below the sticky bar, and it becomes the current tab
  const third = links.nth(2);
  const href = (await third.getAttribute("href"))!;
  await third.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  const section = page.locator(href);
  await expect(section.getByRole("heading").first()).toBeInViewport();
  await expect(third).toHaveAttribute("aria-current", "true", { timeout: 5_000 });
  await expect(nav.locator('[aria-current="true"]')).toHaveCount(1);
  // each section is a region named by its heading
  await expect(page.getByRole("region", { name: (await section.getByRole("heading").first().innerText()).trim() })).toHaveCount(1);
});

test("size picker: fieldset+legend, arrow keys move between sizes, sold-out size is skipped, focus ring on the label, price announced", async ({ page, ip }) => {
  void ip;
  await page.goto("/shop/nailed-classic-tee");
  const group = page.getByRole("group", { name: "Size and colour" });
  await expect(group).toBeVisible();
  expect(await group.evaluate((n) => n.tagName)).toBe("FIELDSET");
  const radios = group.getByRole("radio");
  const first = radios.first();
  await tabUntil(page, first);
  await expect(first).toBeChecked();
  const ring = await focusRing(first);
  expect(ring.outline || ring.shadow, `size focus ring: ${ring.desc}`).toBe(true);
  // ArrowRight walks S Black -> M Black -> L Black -> XL Black -> M Cream -> (L Cream sold out, skipped) -> S Black
  const names: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("ArrowRight");
    names.push((await page.evaluate(() => (document.activeElement as HTMLInputElement).labels?.[0]?.innerText ?? "")).split("\n")[0]!.trim());
  }
  expect(names).toEqual(["M, Black", "L, Black", "XL, Black", "M, Cream", "S, Black", "M, Black"]);
  await expect(group.getByRole("radio", { name: /L, Cream/ })).toBeDisabled();
  // one tab stop for the whole group: the next Tab leaves it
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).type)).not.toBe("radio");
  // the price paragraph is a polite live region
  await expect(page.locator("p[aria-live=polite]").filter({ hasText: /^Rs\. / })).toHaveCount(1);
});

/**
 * QA 2026-10-24 rebuild: the gallery test no longer depends on photos left behind by other specs (the product-editor
 * test now starts clean and runs later). It adds two "QA gallery" photos to the tote through the owner's editor and
 * removes them again through the editor in `finally`, so the demo keeps no test images.
 */
// 2026-10-25: the fixture lives in tests/e2e/fixtures (test-results is wiped by every Playwright run, which removed it).
const PHOTO = process.env.E2E_PHOTO ?? path.join(process.cwd(), "tests", "e2e", "fixtures", "photo-2000.jpg");
async function openToteEditor(page: Page) {
  await page.goto("/admin/products");
  await expect(page.getByRole("heading", { name: "Products and stock", level: 1 })).toBeVisible();
  const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: /Nailed Tote Bag/ }) });
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("form", { name: /Edit Nailed Tote Bag/ });
  await expect(form).toBeVisible();
  return form;
}
async function addQaGalleryPhotos(page: Page, want = 2) {
  const form = await openToteEditor(page);
  const have = await form.getByLabel(/^Photo \d+ description/).count();
  for (let i = have; i < want; i++) {
    await form.getByLabel(/Add a photo/).setInputFiles(PHOTO);
    await expect(form.getByLabel(`Photo ${i + 1} description (alt text)`)).toBeVisible({ timeout: 30_000 });
    await form.getByLabel(`Photo ${i + 1} description (alt text)`).fill(`QA gallery photo ${i + 1}`);
  }
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("form")).toHaveCount(0, { timeout: 15_000 });
}
async function removeQaGalleryPhotos(page: Page) {
  const form = await openToteEditor(page);
  let removed = 0;
  for (let guard = 0; guard < 12; guard++) {
    const inputs = form.getByLabel(/^Photo \d+ description/);
    const n = await inputs.count();
    let hit = -1;
    for (let i = 0; i < n; i++) if ((await inputs.nth(i).inputValue()).startsWith("QA gallery")) { hit = i + 1; break; }
    if (hit < 0) break;
    await form.getByRole("button", { name: `Remove photo ${hit}` }).click();
    removed += 1;
  }
  if (removed > 0) {
    await page.getByRole("button", { name: "Save product" }).click();
    await expect(page.getByRole("form")).toHaveCount(0, { timeout: 15_000 });
  } else await form.getByRole("button", { name: "Cancel" }).click();
}

test("product gallery: thumbnails are buttons 'Show photo i of n' with aria-pressed; keyboard switches the main photo", async ({ page, ip }) => {
  void ip;
  test.setTimeout(150_000);
  await signIn(page, OWNER, "/admin/products");
  await addQaGalleryPhotos(page);
  try {
  await page.goto("/shop/nailed-tote-bag");
  const list = page.getByRole("list", { name: "Product photos" });
  await expect(list, "the tote needs 2+ photos (the live product-editor test adds them)").toBeVisible();
  const buttons = list.getByRole("button");
  const n = await buttons.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 0; i < n; i++) await expect(buttons.nth(i)).toHaveAccessibleName(`Show photo ${i + 1} of ${n}`);
  await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "true");
  // thumbnails' images are decorative (alt=""), so the button name is the only thing read
  expect(await list.locator("img").evaluateAll((imgs) => imgs.every((i) => i.getAttribute("alt") === ""))).toBe(true);
  const main = page.getByRole("article").locator("img").first();
  const srcBefore = await main.getAttribute("src");
  await tabUntil(page, buttons.nth(0));
  let ring = await focusRing(buttons.nth(0));
  expect(ring.outline || ring.shadow, `thumb focus ring: ${ring.desc}`).toBe(true);
  await page.keyboard.press("Tab");
  await expect(buttons.nth(1)).toBeFocused();
  ring = await focusRing(buttons.nth(1));
  expect(ring.outline || ring.shadow, `thumb 2 focus ring: ${ring.desc}`).toBe(true);
  await page.keyboard.press("Space");
  await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => main.getAttribute("src")).not.toBe(srcBefore);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "true");
  // the main photo has a real description
  await expect(main).toHaveAttribute("alt", /.+/);
  } finally {
    await removeQaGalleryPhotos(page);
  }
});

test("cart stepper: a named group with Fewer / More, keyboard operable, disabled at 1, the count is announced", async ({ page, ip }) => {
  void ip;
  await addToteToCart(page);
  await page.goto("/cart");
  const group = page.getByRole("group", { name: /^Quantity for Nailed Tote Bag/ });
  await expect(group).toBeVisible();
  const fewer = group.getByRole("button", { name: "Fewer" });
  const more = group.getByRole("button", { name: "More" });
  const count = group.locator("[aria-live=polite]");
  await expect(count).toHaveText("1");
  await expect(fewer).toBeDisabled();
  await tabUntil(page, more); // Fewer is disabled, so Tab goes straight to More
  const ring = await focusRing(more);
  expect(ring.outline || ring.shadow, `stepper focus ring: ${ring.desc}`).toBe(true);
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("2");
  await page.keyboard.press("Space");
  await expect(count).toHaveText("3");
  await expect(fewer).toBeEnabled();
  await page.keyboard.press("Shift+Tab");
  await expect(fewer).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("2");
  const box = await more.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("button", { name: /^Remove Nailed Tote Bag/ })).toBeVisible();
});

test("order progress: an ordered list named 'Order progress' with exactly one aria-current=step", async ({ page, request }, info) => {
  const o = await apiCheckout(request, freshIp(info.project.name), { name: "A11y Progress" });
  expect(o.status).toBe(201);
  await page.goto(`/order/${o.body.data.orderToken}`);
  const ol = page.getByRole("list", { name: "Order progress" });
  await expect(ol).toBeVisible();
  expect(await ol.evaluate((n) => n.tagName)).toBe("OL");
  const items = ol.getByRole("listitem");
  expect(await items.count()).toBeGreaterThanOrEqual(3);
  await expect(ol.locator('[aria-current="step"]')).toHaveCount(1);
  const cancel = await request.post(`/api/orders/${o.body.data.orderToken}/cancel`, { headers: { "cf-connecting-ip": freshIp(info.project.name) } });
  expect(cancel.status()).toBe(200);
});

test("820 px screenshots of the main pages (restyle record)", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop-1280", "taken once, from the desktop project");
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 820, height: 1180 });
  const o = await apiCheckout(request, freshIp(info.project.name), { name: "Screenshot QA" });
  expect(o.status).toBe(201);
  const pages: [string, string][] = [
    ["home", "/"],
    ["menu", "/menu"],
    ["shop", "/shop"],
    ["product-tee", "/shop/nailed-classic-tee"],
    ["product-tote-gallery", "/shop/nailed-tote-bag"],
    ["story", "/story"],
    ["visit", "/visit"],
    ["policies", "/policies"],
    ["order-status", `/order/${o.body.data.orderToken}`],
    ["not-found", "/this-page-does-not-exist"],
  ];
  for (const [name, url] of pages) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, `overflow on ${url} at 820`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(SHOTS, `${name}-820.png`), fullPage: true });
  }
  await addToteToCart(page);
  await page.goto("/cart");
  await page.screenshot({ path: path.join(SHOTS, "cart-820.png"), fullPage: true });
  await page.goto("/checkout");
  await waitForTurnstile(page); // the widget keeps the network busy, so no "networkidle" here
  await page.screenshot({ path: path.join(SHOTS, "checkout-820.png"), fullPage: true });
  await page.goto("/admin/login");
  await waitForTurnstile(page);
  await page.screenshot({ path: path.join(SHOTS, "admin-login-820.png"), fullPage: true });
  await signIn(page, OWNER);
  for (const [name, url] of [["admin-orders", "/admin"], ["admin-menu", "/admin/menu"], ["admin-products", "/admin/products"], ["admin-settings", "/admin/settings"]] as const) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, `overflow on ${url} at 820`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(SHOTS, `${name}-820.png`), fullPage: true });
  }
  const cancel = await request.post(`/api/orders/${o.body.data.orderToken}/cancel`, { headers: { "cf-connecting-ip": freshIp(info.project.name) } });
  expect(cancel.status()).toBe(200);
});

/**
 * Manager's `price` utility (2026-10-24: Mukta 600, brick, tabular numerals, nowrap). For every visible `.price`
 * element: not clipped, inside the viewport, weight 600, tabular numerals; reports the colours used. Takes the
 * 390 / 1280 re-takes of menu, product, cart, checkout and order (plus a 375 pass on the phone project, no screenshots).
 */
async function checkPrices(page: Page, where: string) {
  const r = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".price")]
      .filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0)
      .map((e) => {
        const cs = getComputedStyle(e);
        const b = e.getBoundingClientRect();
        let clippedBy = "";
        for (let a: HTMLElement | null = e; a; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.overflowX !== "visible" && a.scrollWidth > a.clientWidth + 1 && a !== document.documentElement && a !== document.body) {
            const ab = a.getBoundingClientRect();
            if (b.right > ab.right + 1 || b.left < ab.left - 1) clippedBy = a.tagName + "." + a.className.slice(0, 40);
          }
        }
        return {
          text: e.innerText.trim().replace(/\s+/g, " ").slice(0, 40),
          clippedBy,
          left: Math.round(b.left),
          right: Math.round(b.right),
          weight: cs.fontWeight,
          numeric: cs.fontVariantNumeric,
          colour: cs.color,
        };
      }),
  );
  const vw = page.viewportSize()!.width;
  expect(r.length, `no .price elements on ${where}`).toBeGreaterThan(0);
  for (const p of r) {
    expect(p.clippedBy, `${where}: price "${p.text}" clipped`).toBe("");
    expect(p.right, `${where}: price "${p.text}" past the viewport (${vw})`).toBeLessThanOrEqual(vw);
    expect(p.left, `${where}: price "${p.text}" left of the viewport`).toBeGreaterThanOrEqual(0);
    expect(p.weight, `${where}: "${p.text}"`).toBe("600");
    expect(p.numeric, `${where}: "${p.text}"`).toContain("tabular-nums");
    expect(p.text, `${where}: price text`).toMatch(/Rs\.?\s?[\d,]+/);
  }
  return { count: r.length, colours: [...new Set(r.map((p) => p.colour))], texts: r.map((p) => p.text) };
}

test("price display: bolder prices fit at this width; 390 / 1280 re-takes of menu, product, cart, checkout, order", async ({ page, request }, info) => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  const o = await apiCheckout(request, freshIp(info.project.name), { name: "Price Display QA", fulfilment: "delivery" });
  expect(o.status).toBe(201);
  const phone = info.project.name.startsWith("phone");
  const summary: string[] = [];
  await addToteToCart(page);
  for (const w of phone ? [375, 390] : [1280]) {
    await page.setViewportSize({ width: w, height: phone ? 844 : 800 });
    const visit = async (name: string, url: string, ready: () => Promise<void>) => {
      await page.goto(url);
      await ready();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over, `overflow on ${url} at ${w}`).toBeLessThanOrEqual(0);
      const c = await checkPrices(page, `${url} @${w}`);
      summary.push(`${name}@${w}: ${c.count} prices, colours ${c.colours.join(" / ")}`);
      if (w !== 375) await page.screenshot({ path: path.join(SHOTS, `${name}-${info.project.name}.png`), fullPage: true });
    };
    await visit("menu", "/menu", () => page.waitForLoadState("networkidle"));
    await visit("product", "/shop/nailed-classic-tee", () => page.waitForLoadState("networkidle"));
    await visit("cart", "/cart", () => expect(page.getByRole("group", { name: /^Quantity for Nailed Tote Bag/ })).toBeVisible());
    await visit("checkout", "/checkout", () => waitForTurnstile(page));
    await visit("order-placed", `/order/${o.body.data.orderToken}`, () => expect(page.getByRole("list", { name: "Order progress" })).toBeVisible());
  }
  test.info().annotations.push({ type: "prices", description: summary.join(" | ") });
  console.log(`[prices ${info.project.name}] ${summary.join(" | ")}`);
  const cancel = await request.post(`/api/orders/${o.body.data.orderToken}/cancel`, { headers: { "cf-connecting-ip": freshIp(info.project.name) } });
  expect(cancel.status()).toBe(200);
});

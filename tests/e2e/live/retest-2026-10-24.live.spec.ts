import type { Page } from "@playwright/test";
import path from "node:path";
import {
  apiCheckout,
  clearLoginLimits,
  expect,
  freshIp,
  guardLocal,
  LIVE,
  one,
  OWNER,
  signIn,
  sql,
  test,
  topUpTestStock,
} from "./live-helpers";

/**
 * QA re-tests 2026-10-24 (qa-engineer), LIVE mode on the LOCAL stack only.
 *  - BUG-016: a photo whose stored bytes are over the per-width cap is refused by the Storage guard, and the editor
 *    shows the clear "This photo was refused: ..." message (menu editor and product editor). The browser always
 *    shrinks a real photo under the caps, so the test swaps the 480 px PUT body for a real, over-cap WebP made in the
 *    page (what a tampered or buggy client would send). Nothing is attached.
 *  - BUG-015: sizes stay in S, M, L, XL order (grouped by colour) after stock changes from the admin UI and after an
 *    order, in the admin stock table and on the public product page; the size chart reads S, M, L, XL.
 */
// 2026-10-25: the fixture lives in tests/e2e/fixtures (test-results is wiped by every Playwright run, which removed it).
const PHOTO = process.env.E2E_PHOTO ?? path.join(process.cwd(), "tests", "e2e", "fixtures", "photo-2000.jpg");
const TEE = "nailed-classic-tee";
const M_BLACK = "40000000-0000-4000-8000-000000000002";
const S_BLACK = "40000000-0000-4000-8000-000000000001";
const EXPECTED_VARIANTS = ["S, Black", "M, Black", "L, Black", "XL, Black", "M, Cream", "L, Cream"];

test.skip(!LIVE, "live-mode spec: set E2E_LIVE=1 and run with tests/e2e/live/playwright.live.config.ts");
test.beforeAll(async ({ baseURL, playwright }) => {
  guardLocal(baseURL);
  clearLoginLimits();
  await topUpTestStock(playwright, baseURL!);
});

/** A real WebP (RIFF....WEBP) of 480 px width, made in the page, between 41 KB and 280 KB (bucket limit 300 KB). */
async function overCapWebp480(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 480;
    c.height = 336;
    const x = c.getContext("2d")!;
    const id = x.createImageData(480, 336);
    let s = 11;
    for (let i = 0; i < id.data.length; i++) id.data[i] = i % 4 === 3 ? 255 : (s = (s * 16807) % 2147483647) % 256;
    x.putImageData(id, 0, 0);
    for (const q of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", q));
      if (blob && blob.size > 41 * 1024 && blob.size < 280 * 1024) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (const b of buf) bin += String.fromCharCode(b);
        return btoa(bin);
      }
    }
    return "";
  });
  expect(b64, "could not make an over-cap WebP in this browser").not.toBe("");
  const buf = Buffer.from(b64, "base64");
  expect(buf.subarray(0, 4).toString() + buf.subarray(8, 12).toString()).toBe("RIFFWEBP");
  return buf;
}

/** Replace the body of the signed 480 px PUT with `body`; returns the captured response status. */
async function swap480(page: Page, body: Buffer) {
  const seen: { status?: number; json?: unknown } = {};
  await page.route(/\/storage\/v1\/object\/upload\/sign\/public-media\/.+\/480\.webp/, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const res = await route.fetch({ postData: body });
    seen.status = res.status();
    seen.json = await res.json().catch(() => null);
    await route.fulfill({ response: res });
  });
  return seen;
}

test("BUG-016: menu editor shows the clear refusal when the stored 480 px file is over its cap; nothing is saved", async ({ page, ip, errors }, info) => {
  test.setTimeout(120_000);
  void ip;
  const before = Number(one(`select count(*) from storage.objects where bucket_id = 'public-media'`));
  await signIn(page, OWNER, "/admin/menu");
  const big = await overCapWebp480(page);
  const seen = await swap480(page, big);
  await page.getByRole("button", { name: "Add item to Desserts" }).click();
  const form = page.getByRole("form", { name: "Add an item" });
  await form.getByLabel("Name").first().fill(`QA Refused ${info.project.name.slice(0, 5)}`);
  await form.locator('input[type="file"]').setInputFiles(PHOTO);
  const msg = form.getByText(/^This photo was refused: /);
  await expect(msg).toBeVisible({ timeout: 30_000 });
  await expect(msg).toHaveText(`This photo was refused: 480 px image is ${big.length} bytes, the limit is 40960 bytes.`);
  await expect(form.getByText("Photo uploaded. Save the form to keep it.")).toHaveCount(0);
  expect(seen.status, JSON.stringify(seen.json)).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(seen.json)).toContain("AccessDenied");
  expect(Number(one(`select count(*) from storage.objects where bucket_id = 'public-media'`))).toBe(before); // 480 was first: nothing stored
  // the picker is usable again (not stuck in "working")
  await expect(form.locator('input[type="file"]')).toBeEnabled();
  expectOnlyThe400(errors);
  await page.screenshot({ path: path.join(process.cwd(), "test-results", "live", `BUG-016-refusal-menu-${info.project.name}.png`), fullPage: false });
});

test("BUG-016: product editor shows the clear refusal for an over-cap stored file; no product_images row is added", async ({ page, ip, errors }, info) => {
  test.setTimeout(120_000);
  void ip;
  const productId = one(`select id from products where slug = 'nailed-cap'`);
  const rowsBefore = one(`select count(*) from product_images where product_id = '${productId}'`);
  await signIn(page, OWNER, "/admin/products");
  const big = await overCapWebp480(page);
  await swap480(page, big);
  const cardEl = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: /Nailed Cap/ }) });
  await cardEl.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("form", { name: /Edit Nailed Cap/ });
  await form.getByLabel(/Add a photo/).setInputFiles(PHOTO);
  await expect(form.getByText(`This photo was refused: 480 px image is ${big.length} bytes, the limit is 40960 bytes.`)).toBeVisible({ timeout: 30_000 });
  await expect(form.getByText("Photo added to the list above. Describe it, then save.")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).first().click();
  expect(one(`select count(*) from product_images where product_id = '${productId}'`)).toBe(rowsBefore);
  expectOnlyThe400(errors);
  await page.screenshot({ path: path.join(process.cwd(), "test-results", "live", `BUG-016-refusal-product-${info.project.name}.png`) });
});

/**
 * The refused PUT makes the browser log exactly one "Failed to load resource ... 400" line. That line is the expected
 * refusal; take it out of the fixture's list (any OTHER console error still fails the test).
 */
function expectOnlyThe400(errors: string[]) {
  const i = errors.findIndex((e) => /status of 400 \(Bad Request\)/.test(e));
  expect(i, "the refused upload should log one 400").toBeGreaterThanOrEqual(0);
  errors.splice(i, 1);
}

async function adminVariantOrder(page: Page) {
  const table = page.getByRole("table", { name: /Stock for Nailed Classic Tee/ });
  await expect(table.getByRole("rowheader").first()).toBeVisible({ timeout: 15_000 });
  return (await table.getByRole("rowheader").allInnerTexts()).map((t) => t.trim());
}
async function publicVariantOrder(page: Page) {
  await page.goto(`/shop/${TEE}`);
  const radios = page.getByRole("group", { name: "Size and colour" }).getByRole("radio");
  const names: string[] = [];
  for (const r of await radios.all()) names.push(((await r.getAttribute("aria-label")) ?? (await r.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.innerText ?? ""))).trim());
  return names.map((n) => n.split(/\n| Rs\.| Only| Sold/)[0]!.trim());
}

test("BUG-015: sizes keep S, M, L, XL order (by colour) after stock edits and an order; size chart is S, M, L, XL", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const stockBefore = sql(`select id||'='||stock from product_variants where id in ('${M_BLACK}', '${S_BLACK}') order by id`);
  try {
    await signIn(page, OWNER, "/admin/products");
    expect(await adminVariantOrder(page)).toEqual(EXPECTED_VARIANTS);
    // 1. stock edits from the admin UI (each one is an UPDATE that moves the row physically)
    const table = page.getByRole("table", { name: /Stock for Nailed Classic Tee/ });
    for (const [label, n] of [["S, Black", "13"], ["M, Black", "14"]] as const) {
      const row = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: label }) });
      await row.getByLabel("Stock").fill(n);
      await row.getByRole("button", { name: "Save" }).click();
      await expect(row.getByLabel("Stock")).toHaveValue(n);
    }
    await expect.poll(() => one(`select stock from product_variants where id = '${M_BLACK}'`)).toBe("14");
    // physical order is now scrambled: S Black and M Black sit after the others
    const physical = sql(`select size||', '||colour from product_variants v join products p on p.id = v.product_id where p.slug = '${TEE}' order by v.ctid`);
    // QA 2026-10-24 rebuild: the exact physical layout depends on Postgres page/HOT placement and on earlier runs
    // (run 1 today had "L, Black" last), so it is recorded, not asserted. The order checks below are what matter.
    test.info().annotations.push({ type: "physical order (ctid)", description: physical.join(" / ") });
    expect(physical.join("|")).not.toBe(EXPECTED_VARIANTS.join("|")); // still a scrambled heap, so the test means something
    await page.reload();
    expect(await adminVariantOrder(page)).toEqual(EXPECTED_VARIANTS);
    // 2. an order on M Black (stock decrement inside the order function)
    const o = await apiCheckout(request, freshIp(info.project.name), { items: [{ variantId: M_BLACK, qty: 1 }], name: "Size Order QA" });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(one(`select stock from product_variants where id = '${M_BLACK}'`)).toBe("13");
    expect(await publicVariantOrder(page)).toEqual(EXPECTED_VARIANTS);
    // size chart rows
    const chart = page.getByRole("table", { name: /Measurements in centimetres/ });
    expect((await chart.getByRole("rowheader").allInnerTexts()).map((t) => t.trim())).toEqual(["S", "M", "L", "XL"]);
    // public API order follows too (cancel restocks M Black)
    const cancel = await request.post(`/api/orders/${o.body.data.orderToken}/cancel`, { headers: { "cf-connecting-ip": freshIp(info.project.name) } });
    expect(cancel.status()).toBe(200);
    expect(await publicVariantOrder(page)).toEqual(EXPECTED_VARIANTS);
  } finally {
    for (const kv of stockBefore) {
      const [id, n] = kv.split("=");
      sql(`update product_variants set stock = ${Number(n)} where id = '${id}'`);
    }
  }
});

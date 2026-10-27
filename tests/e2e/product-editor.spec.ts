import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./helpers";

/**
 * Contract 1.3.0 section 8, gap 3 (BLOCKER): upsertProduct replaces the WHOLE image set, and the editor used to send
 * only new uploads, so saving a product without new photos deleted all its photos (and, live, their files). It also
 * dropped details.gsm and details.sizeChartCm. The seeded "Unpublished sample" has two photos and every details field.
 * The mock applies the server's 1.3.1 rules (omitted images = unchanged, an explicit array = the full set; details
 * merged, null removes), so these tests fail on the old editor, which sent an explicit empty array.
 */

const DB_KEY = "nc-mock-db-v1";
const DRAFT_ID = "00000000-0000-4000-8005-000000000003"; // uid(3, 5): "Unpublished sample"
const TEE_ID = "00000000-0000-4000-8005-000000000001"; // uid(1, 5): "Sample tee", no photos
const ALT_1 = "Sample photo one: front of the draft tee";
const ALT_2 = "Sample photo two: back of the draft tee";
// 1x1 PNG: the browser resizes it to WebP like any photo (mock upload stores nothing)
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

type StoredProduct = {
  id: string;
  name: string;
  images: { path: string; alt: string; url: string }[];
  details: Record<string, unknown>;
};

/** The product as the mock "server" stored it (browser localStorage). */
async function stored(page: Page, id: string): Promise<StoredProduct> {
  return page.evaluate(
    ([key, pid]) => (JSON.parse(localStorage.getItem(key)!) as { products: StoredProduct[] }).products.find((p) => p.id === pid)!,
    [DB_KEY, id] as const,
  );
}

const productCard = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: new RegExp(name) }) });

async function openEditor(page: Page, name: string) {
  await productCard(page, name).getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("form", { name: `Edit ${name}` });
  await expect(form).toBeVisible();
  return form;
}

async function saveAndClose(page: Page) {
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/products");
  await expect(page.getByRole("heading", { name: "Products and stock", level: 1 })).toBeVisible();
});

test("editing only the name keeps every photo, in order, with its own alt text", async ({ page }) => {
  const before = await stored(page, DRAFT_ID);
  expect(before.images).toHaveLength(2);

  const form = await openEditor(page, "Unpublished sample");
  const photos = form.getByRole("list", { name: "Product photos, in shop order" }).getByRole("listitem");
  await expect(photos).toHaveCount(2);
  await expect(form.getByLabel("Photo 1 description (alt text)")).toHaveValue(ALT_1);
  await expect(form.getByLabel("Photo 2 description (alt text)")).toHaveValue(ALT_2);

  await form.getByLabel("Name", { exact: false }).first().fill("Renamed sample");
  await saveAndClose(page);

  await expect(productCard(page, "Renamed sample")).toBeVisible();
  const after = await stored(page, DRAFT_ID);
  expect(after.name).toBe("Renamed sample");
  expect(after.images).toEqual(before.images); // same paths, alts, URLs and order: nothing deleted

  // and the editor shows them again
  const again = await openEditor(page, "Renamed sample");
  await expect(again.getByRole("list", { name: "Product photos, in shop order" }).getByRole("listitem")).toHaveCount(2);
});

test("editing details keeps gsm, the size chart and the untouched details; a cleared field is removed", async ({ page }) => {
  const before = await stored(page, DRAFT_ID);
  const form = await openEditor(page, "Unpublished sample");
  await expect(form.getByText(/kept as they are: fabric weight 180 GSM and size chart \(M, L\)/)).toBeVisible();
  await form.getByLabel("Fabric").fill("Sample linen");
  await form.getByLabel("Print method").fill(""); // sent as null (contract 1.3.1)
  await saveAndClose(page);

  const after = await stored(page, DRAFT_ID);
  const { printMethod: _removed, ...rest } = before.details;
  void _removed;
  expect(after.details).toEqual({ ...rest, fabric: "Sample linen" });
  expect(after.details.credit).toBe("Sample artist");
  expect(after.details.gsm).toBe(180);
  expect(after.details.sizeChartCm).toEqual({ M: { chest: 102, length: 71 }, L: { chest: 108, length: 74 } });
  expect(after.images).toEqual(before.images);
});

test("photos: reorder and remove are saved; a new upload is sent with the kept ones and needs alt text", async ({ page }) => {
  const before = await stored(page, DRAFT_ID);
  const form = await openEditor(page, "Unpublished sample");

  await form.getByRole("button", { name: "Move photo 2 up" }).click();
  await expect(form.getByLabel("Photo 1 description (alt text)")).toHaveValue(ALT_2);
  await form.getByRole("button", { name: "Remove photo 2" }).click(); // removes the old first photo
  // design review fix 3: staged in place (still listed, marked, with Undo), and not counted as photo 1 or 2
  const photoList = form.getByRole("list", { name: "Product photos, in shop order" }).getByRole("listitem");
  await expect(photoList).toHaveCount(2);
  await expect(photoList.nth(1)).toContainText("Removed on save");
  await expect(photoList.nth(1).getByRole("button", { name: "Undo" })).toBeFocused(); // BUG-009: focus stays on that photo
  await expect(form.getByLabel(/^Photo \d description/)).toHaveCount(1);

  await form.getByLabel(/Add a photo/).setInputFiles({ name: "new.png", mimeType: "image/png", buffer: PNG_1PX });
  await expect(form.getByText("Photo added to the list above. Describe it, then save.")).toBeVisible();
  await expect(form.getByLabel("Photo 2 description (alt text)")).toHaveValue("");

  await page.getByRole("button", { name: "Save product" }).click();
  await expect(form.getByText("Describe the photo for people who cannot see it")).toBeVisible(); // blocked, nothing saved
  expect((await stored(page, DRAFT_ID)).images).toEqual(before.images);

  await form.getByLabel("Photo 2 description (alt text)").fill("Sample new photo");
  await saveAndClose(page);

  const after = await stored(page, DRAFT_ID);
  expect(after.images.map((i) => i.alt)).toEqual([ALT_2, "Sample new photo"]);
  expect(after.images[0]).toEqual(before.images[1]);
  expect(after.images[1]!.path).toMatch(/^products\/[0-9a-f-]{36}$/);
});

test("switching Edit to another product does not carry the first product's photos over", async ({ page }) => {
  const draftBefore = await stored(page, DRAFT_ID);
  await openEditor(page, "Unpublished sample");
  const tee = await openEditor(page, "Sample tee");
  await expect(tee.getByText("No photos yet.")).toBeVisible();
  await saveAndClose(page);

  expect((await stored(page, TEE_ID)).images).toEqual([]);
  expect((await stored(page, DRAFT_ID)).images).toEqual(draftBefore.images);
});

test("menu item: editing the name keeps its photo", async ({ page }) => {
  const ITEM_ID = "00000000-0000-4000-8002-000000000007"; // uid(7, 2): "Sample egg toast"
  const PATH = "menu/00000000-0000-4000-8013-000000000099";
  await page.evaluate(
    ([key, id, path]) => {
      const db = JSON.parse(localStorage.getItem(key)!);
      for (const c of db.menu) for (const it of c.items) if (it.id === id) it.imagePath = path;
      localStorage.setItem(key, JSON.stringify(db));
    },
    [DB_KEY, ITEM_ID, PATH] as const,
  );
  await page.goto("/admin/menu");
  await page.getByRole("listitem").filter({ hasText: "Sample egg toast" }).first().getByRole("button", { name: "Edit details" }).click();
  const form = page.getByRole("form", { name: "Edit Sample egg toast" });
  await expect(form.getByText("Saved photo", { exact: true })).toBeVisible();
  await form.getByLabel("Name", { exact: false }).first().fill("Sample egg toast renamed");
  await form.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);

  const item = await page.evaluate(
    ([key, id]) => {
      const db = JSON.parse(localStorage.getItem(key)!);
      for (const c of db.menu) for (const it of c.items) if (it.id === id) return it as { name: string; imagePath: string | null };
      return null;
    },
    [DB_KEY, ITEM_ID] as const,
  );
  expect(item).toMatchObject({ name: "Sample egg toast renamed", imagePath: PATH });
});

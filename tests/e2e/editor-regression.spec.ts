import type { Locator, Page } from "@playwright/test";
import { expect, signIn, test } from "./helpers";

/**
 * QA regression (T-042, 2026-10-22) for the editor data-loss fixes. Complements, does not repeat:
 *  - product-editor.spec.ts: name-only edit keeps photos; details edit keeps gsm/size chart; photo reorder/remove/add;
 *    switching Edit from the draft to the tee does not carry photos; menu name edit keeps the photo.
 *  - menu-photo.spec.ts: menu Remove photo + Save / Cancel / Undo, and removing a new upload.
 * Added here:
 *  - product saves WITHOUT new photos that touch other parts (nothing changed, stock/own price/published only,
 *    alt text only, two saves in a row) keep every photo and every details key;
 *  - switching between products / menu items, or to "Add", with UNSAVED edits does not leak names, details, size
 *    rows, staged photo removals or menu options into the next form, and the abandoned edits are not saved.
 * Mock mode: the browser localStorage is the "server" and applies the contract 1.3.1 rules.
 */

const DB_KEY = "nc-mock-db-v1";
const DRAFT_ID = "00000000-0000-4000-8005-000000000003"; // "Unpublished sample": 2 photos, every details field
const TEE_ID = "00000000-0000-4000-8005-000000000001"; // "Sample tee": no photos, no details, 4 sizes
const EGG_ID = "00000000-0000-4000-8002-000000000007"; // menu "Sample egg toast"
const COFFEE_ID = "00000000-0000-4000-8002-000000000002"; // menu "Sample black coffee": 2 options
const MENU_PATH = "menu/00000000-0000-4000-8013-000000000099";

type Img = { path: string; alt: string; url: string };
type Variant = { id: string; size: string; colour: string; stock: number; price: number; sku: string | null };
type StoredProduct = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  isPublished: boolean;
  images: Img[];
  details: Record<string, unknown>;
  variants: Variant[];
};
type StoredItem = { id: string; name: string; imagePath: string | null; variants: { label: string }[]; description: string | null; price: number };

async function product(page: Page, id: string): Promise<StoredProduct> {
  return page.evaluate(
    ([key, pid]) => (JSON.parse(localStorage.getItem(key)!) as { products: StoredProduct[] }).products.find((p) => p.id === pid)!,
    [DB_KEY, id] as const,
  );
}

async function menuItem(page: Page, id: string): Promise<StoredItem> {
  return page.evaluate(
    ([key, iid]) => {
      const db = JSON.parse(localStorage.getItem(key)!) as { menu: { items: StoredItem[] }[] };
      for (const c of db.menu) for (const it of c.items) if (it.id === iid) return it;
      throw new Error("item not found");
    },
    [DB_KEY, id] as const,
  );
}

/** Variants without the derived stockState, so before/after compare only what the form can write. */
const strip = (p: StoredProduct) => ({ ...p, variants: p.variants.map(({ id, size, colour, stock, price, sku }) => ({ id, size, colour, stock, price, sku })) });

const productCard = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: new RegExp(name) }) });

async function editProduct(page: Page, name: string): Promise<Locator> {
  await productCard(page, name).getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("form", { name: `Edit ${name}` });
  await expect(form).toBeVisible();
  return form;
}

const photoItems = (form: Locator) => form.getByRole("list", { name: "Product photos, in shop order" }).getByRole("listitem");

async function saveProduct(page: Page) {
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);
}

test.describe("product editor: saves without new photos keep photos and details", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/products");
    await expect(page.getByRole("heading", { name: "Products and stock", level: 1 })).toBeVisible();
  });

  test("Save with no changes at all leaves the stored product exactly as it was", async ({ page }) => {
    const before = await product(page, DRAFT_ID);
    await editProduct(page, "Unpublished sample");
    await saveProduct(page);
    expect(strip(await product(page, DRAFT_ID))).toEqual(strip(before));
  });

  test("changing only stock, a size's own price and Published keeps both photos and every details key", async ({ page }) => {
    const before = await product(page, DRAFT_ID);
    const form = await editProduct(page, "Unpublished sample");
    await form.getByLabel(/^Stock/).first().fill("7");
    await form.getByLabel(/^Own price/).first().fill("1100");
    await form.getByLabel(/Published \(visible in the shop\)/).check();
    await saveProduct(page);

    const after = await product(page, DRAFT_ID);
    expect(after.images).toEqual(before.images);
    expect(after.details).toEqual(before.details);
    expect(after.isPublished).toBe(true);
    expect(after.variants[0]).toMatchObject({ id: before.variants[0]!.id, stock: 7, price: 110000 });
    expect(after.name).toBe(before.name);
  });

  test("changing only one photo's alt text keeps both photos, in order, with the new text", async ({ page }) => {
    const before = await product(page, DRAFT_ID);
    const form = await editProduct(page, "Unpublished sample");
    await form.getByLabel("Photo 2 description (alt text)").fill("Sample back view, updated");
    await saveProduct(page);

    const after = await product(page, DRAFT_ID);
    expect(after.images.map((i) => i.path)).toEqual(before.images.map((i) => i.path));
    expect(after.images.map((i) => i.url)).toEqual(before.images.map((i) => i.url)); // stored files untouched
    expect(after.images.map((i) => i.alt)).toEqual([before.images[0]!.alt, "Sample back view, updated"]);
    expect(after.details).toEqual(before.details);
  });

  test("two saves in a row (reopen after the first) still keep the photos and details", async ({ page }) => {
    const before = await product(page, DRAFT_ID);
    let form = await editProduct(page, "Unpublished sample");
    await form.getByLabel(/^Description/).fill("Sample first save");
    await saveProduct(page);

    form = await editProduct(page, "Unpublished sample");
    await expect(photoItems(form)).toHaveCount(2);
    await expect(form.getByLabel(/^Description/)).toHaveValue("Sample first save");
    await form.getByLabel(/^Description/).fill("Sample second save");
    await saveProduct(page);

    await page.reload();
    const after = await product(page, DRAFT_ID);
    expect(after.description).toBe("Sample second save");
    expect(after.images).toEqual(before.images);
    expect(after.details).toEqual(before.details);
  });
});

test.describe("switching between products does not leak form state", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/products");
    await expect(page.getByRole("heading", { name: "Products and stock", level: 1 })).toBeVisible();
  });

  test("unsaved edits on one product never show up on another, and are dropped when you come back", async ({ page }) => {
    const draftBefore = await product(page, DRAFT_ID);
    const teeBefore = await product(page, TEE_ID);

    // 1. unsaved edits on the draft: name, fabric, a removed photo, an extra size row
    const draft = await editProduct(page, "Unpublished sample");
    await draft.getByLabel(/^Name/).fill("LEAKED NAME");
    await draft.getByLabel(/^Fabric/).fill("LEAKED FABRIC");
    await draft.getByRole("button", { name: "Remove photo 1" }).click();
    await expect(photoItems(draft).filter({ hasText: "Removed on save" })).toHaveCount(1); // staged in place
    await draft.getByRole("button", { name: "Add a size" }).click();

    // 2. switch to the tee: it shows only its own values
    const tee = await editProduct(page, "Sample tee");
    await expect(page.getByRole("form")).toHaveCount(1);
    await expect(tee.getByLabel(/^Name/)).toHaveValue("Sample tee");
    await expect(tee.getByLabel(/^Fabric/)).toHaveValue("");
    await expect(tee.getByLabel(/^Print method/)).toHaveValue("");
    await expect(tee.getByText("No photos yet.")).toBeVisible();
    await expect(tee.getByText(/kept as they are/)).toHaveCount(0); // the draft's gsm / size chart note
    await expect(tee.getByLabel(/^Size/)).toHaveCount(teeBefore.variants.length);
    await expect(tee.getByLabel(/^Base price/)).toHaveValue("1499");

    // 3. back to the draft: stored values again, the abandoned edits are gone
    const again = await editProduct(page, "Unpublished sample");
    await expect(again.getByLabel(/^Name/)).toHaveValue("Unpublished sample");
    await expect(again.getByLabel(/^Fabric/)).toHaveValue("Sample cotton");
    await expect(photoItems(again)).toHaveCount(2);
    await expect(again.getByLabel(/^Size/)).toHaveCount(draftBefore.variants.length);
    await again.getByRole("button", { name: "Cancel" }).click(); // nothing changed in this form: closes without asking
    await expect(page.getByRole("form")).toHaveCount(0);

    expect(strip(await product(page, DRAFT_ID))).toEqual(strip(draftBefore));
    expect(strip(await product(page, TEE_ID))).toEqual(strip(teeBefore));
  });

  test("tee -> draft -> Save writes the draft's own photos and details, and leaves the tee alone", async ({ page }) => {
    const draftBefore = await product(page, DRAFT_ID);
    const teeBefore = await product(page, TEE_ID);
    const tee = await editProduct(page, "Sample tee");
    await tee.getByLabel(/^Name/).fill("LEAKED TEE NAME");
    await tee.getByLabel(/^Design credit/).fill("LEAKED CREDIT");

    const draft = await editProduct(page, "Unpublished sample");
    await expect(draft.getByLabel(/^Name/)).toHaveValue("Unpublished sample");
    await expect(draft.getByLabel(/^Design credit/)).toHaveValue("Sample artist");
    await expect(draft.getByLabel("Photo 1 description (alt text)")).toHaveValue(draftBefore.images[0]!.alt);
    await saveProduct(page);

    expect(strip(await product(page, DRAFT_ID))).toEqual(strip(draftBefore));
    expect(strip(await product(page, TEE_ID))).toEqual(strip(teeBefore));
  });

  test("Edit, then 'Add a product' opens an empty form", async ({ page }) => {
    const draft = await editProduct(page, "Unpublished sample");
    await draft.getByLabel(/^Name/).fill("LEAKED NAME");
    await page.getByRole("button", { name: "Add a product" }).click();
    const form = page.getByRole("form", { name: "Add a product" });
    await expect(form).toBeVisible();
    await expect(page.getByRole("form")).toHaveCount(1);
    await expect(form.getByLabel(/^Name/)).toHaveValue("");
    await expect(form.getByLabel(/^Fabric/)).toHaveValue("");
    await expect(form.getByLabel(/^Base price/)).toHaveValue("");
    await expect(form.getByText("No photos yet.")).toBeVisible();
    await expect(form.getByText(/kept as they are/)).toHaveCount(0);
    await expect(form.getByLabel(/^Size/)).toHaveCount(1);
    await expect(form.getByLabel(/^Size/)).toHaveValue("");
  });
});

test.describe("switching between menu items does not leak form state", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.evaluate(
      ([key, id, path]) => {
        const db = JSON.parse(localStorage.getItem(key)!);
        for (const c of db.menu) for (const it of c.items) if (it.id === id) it.imagePath = path;
        localStorage.setItem(key, JSON.stringify(db));
      },
      [DB_KEY, EGG_ID, MENU_PATH] as const,
    );
    await page.goto("/admin/menu");
    await expect(page.getByRole("heading", { name: "Menu", level: 1 })).toBeVisible();
  });

  const editItem = async (page: Page, name: string) => {
    await page.getByRole("listitem").filter({ hasText: name }).first().getByRole("button", { name: "Edit details" }).click();
    const form = page.getByRole("form", { name: `Edit ${name}` });
    await expect(form).toBeVisible();
    return form;
  };

  test("a staged Remove photo and an unsaved name on one item do not carry over; saving the next item changes only it", async ({ page }) => {
    const eggBefore = await menuItem(page, EGG_ID);
    const coffeeBefore = await menuItem(page, COFFEE_ID);

    const egg = await editItem(page, "Sample egg toast");
    await egg.getByLabel(/^Name/).first().fill("LEAKED ITEM NAME");
    await egg.getByRole("button", { name: "Remove photo" }).click();
    await expect(egg.getByText("This photo goes when you tap Save item.")).toBeVisible();

    const coffee = await editItem(page, "Sample black coffee");
    await expect(page.getByRole("form")).toHaveCount(1);
    await expect(coffee.getByLabel(/^Name/).first()).toHaveValue("Sample black coffee");
    await expect(coffee.getByText("This photo goes when you tap Save item.")).toHaveCount(0);
    await expect(coffee.getByText("Saved photo", { exact: true })).toHaveCount(0); // coffee has none
    await expect(coffee.getByRole("button", { name: "Remove photo" })).toHaveCount(0);
    await expect(coffee.getByLabel(/^Option name/)).toHaveCount(2);
    await coffee.getByRole("button", { name: "Save item" }).click();
    await expect(page.getByRole("form")).toHaveCount(0);

    const coffeeAfter = await menuItem(page, COFFEE_ID);
    expect(coffeeAfter.imagePath).toBeNull();
    expect(coffeeAfter.variants.map((v) => v.label)).toEqual(coffeeBefore.variants.map((v) => v.label));
    expect(coffeeAfter.name).toBe("Sample black coffee");
    expect(await menuItem(page, EGG_ID)).toEqual(eggBefore); // photo and name untouched

    // and the egg toast reopens clean, with its stored photo
    const eggAgain = await editItem(page, "Sample egg toast");
    await expect(eggAgain.getByLabel(/^Name/).first()).toHaveValue("Sample egg toast");
    await expect(eggAgain.getByText("Saved photo", { exact: true })).toBeVisible();
  });

  test("an item with options -> 'Add item to Food' opens an empty form in that category", async ({ page }) => {
    const coffee = await editItem(page, "Sample black coffee");
    await coffee.getByLabel(/^Name/).first().fill("LEAKED");
    await page.getByRole("button", { name: "Add item to Food" }).click();
    const form = page.getByRole("form", { name: "Add an item" });
    await expect(form).toBeVisible();
    await expect(page.getByRole("form")).toHaveCount(1);
    await expect(form.getByLabel(/^Name/).first()).toHaveValue("");
    await expect(form.getByLabel(/^Price/)).toHaveValue("");
    await expect(form.getByLabel(/^Option name/)).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Remove photo" })).toHaveCount(0);
    await expect(form.getByLabel(/^Category/)).toHaveValue("00000000-0000-4000-8003-000000000003"); // Food
  });
});

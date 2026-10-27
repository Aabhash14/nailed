import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./helpers";

/**
 * Menu item "Remove photo" (contract 1.3.1: UpsertMenuItemInput.imagePath null = remove, omitted = keep).
 * Removal is staged like the product editor: it happens on Save, Cancel (after "Discard your changes?") discards it,
 * Undo restores it before saving. The thumbnail stays in place while a removal is staged (dimmed, "Removed on save").
 * The mock applies the same rule as the server, so the stored item (browser localStorage) is what a live save would keep.
 */

const DB_KEY = "nc-mock-db-v1";
const ITEM_ID = "00000000-0000-4000-8002-000000000007"; // uid(7, 2): "Sample egg toast"
const ITEM = "Sample egg toast";
const PATH = "menu/00000000-0000-4000-8013-000000000099";
// design review T-048 fixes 1 and 2: the saved photo is a thumbnail captioned "Saved photo"; Remove is staged in place
const SAVED = "Saved photo";
const REMOVED_BADGE = "Removed on save";
const STAGED_NOTE = "This photo goes when you tap Save item.";

async function storedImagePath(page: Page): Promise<string | null | undefined> {
  return page.evaluate(
    ([key, id]) => {
      const db = JSON.parse(localStorage.getItem(key)!);
      for (const c of db.menu) for (const it of c.items) if (it.id === id) return it.imagePath as string | null;
      return undefined;
    },
    [DB_KEY, ITEM_ID] as const,
  );
}

async function openEditor(page: Page) {
  await page.getByRole("listitem").filter({ hasText: ITEM }).first().getByRole("button", { name: "Edit details" }).click();
  const form = page.getByRole("form", { name: `Edit ${ITEM}` });
  await expect(form).toBeVisible();
  return form;
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  // give the item a stored photo in the mock "server", then load the menu editor
  await page.evaluate(
    ([key, id, path]) => {
      const db = JSON.parse(localStorage.getItem(key)!);
      for (const c of db.menu) for (const it of c.items) if (it.id === id) it.imagePath = path;
      localStorage.setItem(key, JSON.stringify(db));
    },
    [DB_KEY, ITEM_ID, PATH] as const,
  );
  await page.goto("/admin/menu");
  await expect(page.getByRole("heading", { name: "Menu", level: 1 })).toBeVisible();
});

test("the saved photo shows as a thumbnail with Remove photo next to it", async ({ page }) => {
  const form = await openEditor(page);
  const slot = form.getByRole("group", { name: SAVED });
  await expect(slot).toBeVisible();
  await expect(slot.getByRole("button", { name: "Remove photo" })).toBeVisible();
  await expect(form.getByText("A photo is saved. Choose a new one to replace it.")).toHaveCount(0); // old text line is gone
  await expect(form.getByLabel(/^Replace with a new photo/)).toBeVisible();
});

test("Remove photo, then Save: the photo is gone", async ({ page }) => {
  const form = await openEditor(page);
  await form.getByRole("button", { name: "Remove photo" }).click();
  await expect(form.getByText(REMOVED_BADGE)).toBeVisible(); // in place, on the thumbnail
  await expect(form.getByText(STAGED_NOTE)).toBeVisible();
  await expect(form.getByRole("button", { name: "Undo" })).toBeFocused(); // keyboard focus follows the swap
  await expect(form.getByRole("button", { name: "Remove photo" })).toHaveCount(0);
  expect(await storedImagePath(page)).toBe(PATH); // staged only: nothing saved yet

  await form.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);
  expect(await storedImagePath(page)).toBeNull();

  // survives a reload, and the editor no longer offers a stored photo
  await page.reload();
  const again = await openEditor(page);
  await expect(again.getByText(SAVED, { exact: true })).toHaveCount(0);
  await expect(again.getByRole("button", { name: "Remove photo" })).toHaveCount(0);
});

test("Remove photo, then Cancel: asks first, Discard keeps the photo", async ({ page }) => {
  const form = await openEditor(page);
  await form.getByRole("button", { name: "Remove photo" }).click();
  await expect(form.getByText(STAGED_NOTE)).toBeVisible();

  await form.getByRole("button", { name: "Cancel" }).click();
  const ask = form.getByRole("alertdialog", { name: "Discard your changes?" });
  await expect(ask.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(form.getByText(STAGED_NOTE)).toBeVisible(); // still staged, nothing lost
  await form.getByRole("button", { name: "Cancel" }).click();
  await form.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);
  expect(await storedImagePath(page)).toBe(PATH);
  // focus goes back to the Edit button that opened the form
  await expect(page.getByRole("listitem").filter({ hasText: ITEM }).first().getByRole("button", { name: "Edit details" })).toBeFocused();

  // reopening starts clean: the photo is still there and nothing is staged
  const again = await openEditor(page);
  await expect(again.getByText(SAVED, { exact: true })).toBeVisible();
  await expect(again.getByText(STAGED_NOTE)).toHaveCount(0);
  await expect(again.getByRole("button", { name: "Remove photo" })).toBeVisible();
});

test("Cancel with no changes closes straight away", async ({ page }) => {
  const form = await openEditor(page);
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);
});

test("Remove photo, Undo, then Save: the photo is kept", async ({ page }) => {
  const form = await openEditor(page);
  await form.getByRole("button", { name: "Remove photo" }).click();
  await form.getByRole("button", { name: "Undo" }).click();
  await expect(form.getByText(STAGED_NOTE)).toHaveCount(0);
  await expect(form.getByText(REMOVED_BADGE)).toHaveCount(0);
  await expect(form.getByText(SAVED, { exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "Remove photo" })).toBeFocused();

  await form.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);
  expect(await storedImagePath(page)).toBe(PATH);
});

test("a new, unsaved photo takes the saved photo's place; it can be removed and brought back with Undo", async ({ page }) => {
  // 1x1 PNG: the browser resizes it to WebP like any photo (mock upload stores nothing)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const form = await openEditor(page);
  await form.locator('input[type="file"]').setInputFiles({ name: "new.png", mimeType: "image/png", buffer: png });
  await expect(form.getByText("Photo uploaded. Save the form to keep it.")).toBeVisible();
  const preview = form.getByRole("img", { name: "Preview of the chosen photo" });
  await expect(preview).toBeVisible();
  await expect(form.getByText("New photo, not saved yet")).toBeVisible();
  await expect(form.getByText(SAVED, { exact: true })).toHaveCount(0); // one image, not two

  await form.getByRole("button", { name: "Remove photo" }).click();
  await expect(form.getByText(REMOVED_BADGE)).toBeVisible();
  await expect(form.getByText("Photo uploaded. Save the form to keep it.")).toHaveCount(0);
  await form.getByRole("button", { name: "Undo" }).click();
  await expect(form.getByText(REMOVED_BADGE)).toHaveCount(0);
  await expect(preview).toBeVisible();

  await form.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("form")).toHaveCount(0);
  const saved = await storedImagePath(page);
  expect(saved).toMatch(/^menu\/[0-9a-f-]{36}$/);
  expect(saved).not.toBe(PATH);
});

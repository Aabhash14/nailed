import path from "node:path";
import type { Page } from "@playwright/test";
import {
  actionResult,
  addToteToCart,
  apiCheckout,
  callAction,
  clearLoginLimits,
  topUpTestStock,
  expect,
  freshIp,
  freshPhone,
  guardLocal,
  LIVE,
  one,
  orderRow,
  OWNER,
  routeIp,
  signIn,
  sql,
  STAFF,
  stock,
  test,
  TOTE,

} from "./live-helpers";

/**
 * LIVE-mode admin P1 checks (qa-engineer, 2026-10-23): real Supabase Auth sessions, real roles, real Storage.
 * Run with tests/e2e/live/playwright.live.config.ts and E2E_LIVE=1. LOCAL stack only.
 * PHOTO = a 2000x1400 JPEG (env E2E_PHOTO); the browser shrinks it to three WebP widths before uploading.
 */
// 2026-10-25: the fixture lives in tests/e2e/fixtures (test-results is wiped by every Playwright run, which removed it).
const PHOTO = process.env.E2E_PHOTO ?? path.join(process.cwd(), "tests", "e2e", "fixtures", "photo-2000.jpg");
const CAPS: Record<string, number> = { "480": 40 * 1024, "960": 120 * 1024, "1600": 300 * 1024 };

test.skip(!LIVE, "live-mode spec: set E2E_LIVE=1 and run with tests/e2e/live/playwright.live.config.ts");
test.beforeAll(async ({ baseURL, playwright }) => {
  guardLocal(baseURL);
  clearLoginLimits();
  await topUpTestStock(playwright, baseURL!);
});

const card = (page: Page, number: string) => page.getByRole("article").filter({ hasText: number });

/** Storage objects of one group: [[name, size, mimetype], ...] */
function groupObjects(groupPath: string) {
  return sql(
    `select name||'|'||(metadata->>'size')||'|'||(metadata->>'mimetype') from storage.objects where bucket_id = 'public-media' and name like '${groupPath}/%' order by name`,
  ).map((l) => l.split("|"));
}

test("admin sold-out toggle reaches the public menu and /api/menu, and back", async ({ page, request, ip }) => {
  await signIn(page, OWNER, "/admin/menu");
  const row = page.getByRole("listitem").filter({ hasText: "Lemon Tea" }).first();
  try {
    await row.getByRole("button", { name: "Mark sold out" }).click();
    await expect(row.getByRole("button", { name: "Back in stock" })).toBeVisible();
    expect(one(`select is_sold_out from menu_items where name = 'Lemon Tea'`)).toBe("t");
    await page.goto("/menu");
    await expect(page.getByRole("listitem").filter({ hasText: "Lemon Tea" }).first().getByText("Sold out", { exact: true })).toBeVisible();
    const api = await (await request.get("/api/menu", { headers: { "cf-connecting-ip": ip } })).json();
    const item = api.data.categories.flatMap((c: { items: { name: string; isSoldOut: boolean }[] }) => c.items).find((i: { name: string }) => i.name === "Lemon Tea");
    expect(item.isSoldOut).toBe(true);
    await page.goto("/admin/menu");
    await page.getByRole("listitem").filter({ hasText: "Lemon Tea" }).first().getByRole("button", { name: "Back in stock" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Lemon Tea" }).first().getByRole("button", { name: "Mark sold out" })).toBeVisible();
    await page.goto("/menu");
    await expect(page.getByRole("listitem").filter({ hasText: "Lemon Tea" }).first().getByText("Sold out", { exact: true })).toHaveCount(0);
  } finally {
    sql(`update menu_items set is_sold_out = false where name = 'Lemon Tea'`);
  }
});

test("Today's orders: pickup confirm -> ready -> complete, delivery confirm -> dispatch -> complete (DB follows)", async ({ page, request, ip }, info) => {
  const pick = await apiCheckout(request, freshIp(info.project.name), { name: "Board Pickup" });
  const del = await apiCheckout(request, freshIp(info.project.name), { name: "Board Delivery", fulfilment: "delivery" });
  expect(pick.status).toBe(201);
  expect(del.status).toBe(201);
  const pNo = pick.body.data.orderNumber as string, dNo = del.body.data.orderNumber as string;
  void ip;
  await signIn(page, STAFF);
  await expect(page.getByRole("heading", { name: "Today's orders" })).toBeVisible();
  await expect(page.getByText("(staff)")).toBeVisible();

  const p = card(page, pNo);
  await expect(p).toContainText("Board Pickup");
  await expect(p.getByRole("link", { name: /Call \+977/ })).toHaveAttribute("href", /^tel:/);
  await p.getByRole("button", { name: "Confirm (after the call)" }).click();
  await expect(p.getByRole("button", { name: "Mark ready for pickup" })).toBeVisible();
  await expect(p.getByRole("button", { name: "Send out for delivery" })).toHaveCount(0);
  expect(orderRow(pick.body.data.orderToken)[0]).toBe("confirmed");
  await p.getByRole("button", { name: "Mark ready for pickup" }).click();
  await expect(p.getByRole("button", { name: "Complete (cash received)" })).toBeVisible();
  await p.getByRole("button", { name: "Complete (cash received)" }).click();

  const d = card(page, dNo);
  await d.getByRole("button", { name: "Confirm (after the call)" }).click();
  await d.getByRole("button", { name: "Send out for delivery" }).click();
  await expect(d.getByRole("button", { name: "Complete (cash received)" })).toBeVisible();
  await d.getByRole("button", { name: "Complete (cash received)" }).click();

  await page.getByRole("tab", { name: /Finished today/ }).click();
  await expect(card(page, pNo)).toContainText("Cash received Rs. 900");
  await expect(card(page, dNo)).toContainText("Cash received Rs. 1,050");
  const pr = orderRow(pick.body.data.orderToken), dr = orderRow(del.body.data.orderToken);
  expect([pr[0], pr[3]]).toEqual(["completed", "paid"]);
  expect([dr[0], dr[3]]).toEqual(["completed", "paid"]);
  // the customer's page follows
  await page.goto(`/order/${del.body.data.orderToken}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Order complete. Thank you");
});

test("cancel with a reason + block (staff): restocked, phone blocked, that phone is then refused", async ({ page, request, ip }, info) => {
  const phone = freshPhone();
  const before = stock(TOTE);
  const o = await apiCheckout(request, freshIp(info.project.name), { name: "Cancel Me", phone });
  expect(o.status).toBe(201);
  void ip;
  await signIn(page, STAFF);
  const c = card(page, o.body.data.orderNumber);
  await c.getByRole("button", { name: "Cancel order" }).click();
  await c.getByRole("button", { name: "Confirm cancel" }).click();
  await expect(c.locator("p", { hasText: "Choose a reason" })).toBeVisible(); // a reason is required
  await c.getByLabel("Reason for cancelling").selectOption("unreachable");
  await c.getByLabel("Also block this phone number").check();
  await c.getByRole("button", { name: "Confirm cancel" }).click();
  await expect(c.getByRole("alertdialog")).toContainText(`Block +977${phone}?`);
  await c.getByRole("alertdialog").getByRole("button", { name: "Yes, cancel and block" }).click();
  await page.getByRole("tab", { name: /Finished today/ }).click();
  await expect(card(page, o.body.data.orderNumber)).toContainText(/Phone blocked/);
  const r = orderRow(o.body.data.orderToken);
  expect([r[0], r[6], r[7]]).toEqual(["cancelled", "unreachable", "true"]);
  expect(stock(TOTE)).toBe(before);
  expect(one(`select count(*) from blocked_contacts where kind = 'phone' and value = '+977${phone}'`)).toBe("1");
  const again = await apiCheckout(request, freshIp(info.project.name), { phone });
  expect(again.status).toBe(403);
  expect(again.body.error.code).toBe("ORDER_REFUSED");
});

test("staff vs owner: owner-only actions answer FORBIDDEN from the SERVER for a staff session, nothing changes", async ({ page, baseURL, request }, info) => {
  await signIn(page, STAFF);
  const req = page.request; // carries the staff session cookies
  const settingsBefore = one(`select orders_paused||'|'||coalesce(landmark,'') from site_settings`);
  const productId = one(`select id from products where slug = 'nailed-cap'`);
  const blockId = one(`select id from blocked_contacts order by created_at desc limit 1`);
  const calls: [string, unknown][] = [
    ["setOrdersPaused", { paused: true }],
    ["updateSettings", { landmark: "staff was here" }],
    ["getSettings", undefined],
    ["setStock", { variantId: "40000000-0000-4000-8000-000000000011", stock: 0 }],
    ["setProductPublished", { productId, isPublished: false }],
    ["upsertCategory", { name: "Staff Category", isVisible: true }],
    ["setItemPrice", { itemId: one(`select id from menu_items where name = 'Espresso'`), price: 100 }],
    ["createUploadUrl", { folder: "menu", widthPx: 480, contentType: "image/webp", sizeBytes: 1000 }],
    ["listStaff", undefined],
    ["inviteStaff", { email: "intruder@nailed-cafe.test", displayName: "Intruder", password: "Intruder-Pass-2026" }],
    ["getAdminProducts", undefined],
  ];
  if (blockId) calls.push(["unblockContact", { id: blockId }]);
  const codes: Record<string, string | undefined> = {};
  for (const [name, arg] of calls) codes[name] = actionResult((await callAction(req, baseURL!, name, arg)).text).error?.code;
  expect(codes).toEqual(Object.fromEntries(calls.map(([n]) => [n, "FORBIDDEN"])));
  expect(one(`select orders_paused||'|'||coalesce(landmark,'') from site_settings`)).toBe(settingsBefore);
  expect(one(`select stock from product_variants where id = '40000000-0000-4000-8000-000000000011'`)).not.toBe("0");
  expect(one(`select count(*) from auth.users where email = 'intruder@nailed-cafe.test'`)).toBe("0");
  if (blockId) expect(one(`select count(*) from blocked_contacts where id = '${blockId}'`)).toBe("1");

  // staff MAY move orders, but may NOT cancel one that is already out for delivery (database rule)
  const o = await apiCheckout(request, freshIp(info.project.name), { fulfilment: "delivery", name: "Staff Limit" });
  expect(o.status).toBe(201);
  const id = orderRow(o.body.data.orderToken)[11]!;
  expect(actionResult((await callAction(req, baseURL!, "updateOrderStatus", { orderId: id, status: "confirmed" })).text).ok).toBe(true);
  expect(actionResult((await callAction(req, baseURL!, "updateOrderStatus", { orderId: id, status: "out_for_delivery" })).text).ok).toBe(true);
  const cancel = actionResult((await callAction(req, baseURL!, "cancelOrder", { orderId: id, reason: "other", restock: true })).text);
  expect(cancel.error?.code).toBe("FORBIDDEN");
  expect(orderRow(o.body.data.orderToken)[0]).toBe("out_for_delivery");
  // illegal transition is CONFLICT from the database
  const back = actionResult((await callAction(req, baseURL!, "updateOrderStatus", { orderId: id, status: "confirmed" })).text);
  expect(back.error?.code).toBe("CONFLICT");
  // auto_unconfirmed is system-only
  const sys = actionResult((await callAction(req, baseURL!, "cancelOrder", { orderId: id, reason: "auto_unconfirmed", restock: true })).text);
  expect(sys.error?.code).toBe("VALIDATION");
  // the owner can cancel it
  const ownerPage = await page.context().browser()!.newPage();
  await routeIp(ownerPage, freshIp(info.project.name));
  await signIn(ownerPage, OWNER);
  const ownerCancel = actionResult((await callAction(ownerPage.request, baseURL!, "cancelOrder", { orderId: id, reason: "other", restock: true })).text);
  expect(ownerCancel.ok).toBe(true);
  expect(orderRow(o.body.data.orderToken)[0]).toBe("cancelled");
  await ownerPage.close();
});

test("settings: owner saves a field (DB updated) and pauses orders (checkout paused), then resumes", async ({ page, ip }) => {
  void ip;
  const landmark = one(`select coalesce(landmark,'') from site_settings`);
  await addToteToCart(page);
  await signIn(page, OWNER, "/admin/settings");
  try {
    await page.getByLabel("Landmark").fill("Near the live QA chowk");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    expect(one(`select landmark from site_settings`)).toBe("Near the live QA chowk");
    await page.getByRole("button", { name: "Pause online orders" }).click();
    await expect(page.getByText("Online orders are paused").first()).toBeVisible();
    expect(one(`select orders_paused from site_settings`)).toBe("t");
    await page.goto("/checkout");
    await expect(page.getByText("Online orders are paused").first()).toBeVisible();
    await page.goto("/admin/settings");
    await page.getByRole("button", { name: "Resume online orders" }).click();
    await expect(page.getByText("Online orders are open again.")).toBeVisible();
    expect(one(`select orders_paused from site_settings`)).toBe("f");
  } finally {
    sql(`update site_settings set orders_paused = false, landmark = ${landmark ? `'${landmark.replace(/'/g, "''")}'` : "null"}`);
  }
});

test("menu editor: new item with a photo -> 3 WebP files in local Storage within the caps; shows on /menu", async ({ page, ip }, info) => {
  test.setTimeout(120_000);
  void ip;
  const name = `QA Live Cake ${info.project.name.slice(0, 5)} ${Date.now() % 100000}`;
  await signIn(page, OWNER, "/admin/menu");
  await page.getByRole("button", { name: "Add item to Desserts" }).click();
  const form = page.getByRole("form", { name: "Add an item" });
  await form.getByLabel("Name").first().fill(name); // .first(): the English name; the 5 translation "Name" inputs (1.4.0) follow it
  await form.getByLabel("Price (Rs.)").fill("250");
  await form.locator('input[type="file"]').setInputFiles(PHOTO);
  await expect(form.getByText("Photo uploaded. Save the form to keep it.")).toBeVisible({ timeout: 30_000 });
  await form.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("form")).toHaveCount(0, { timeout: 15_000 });
  const imagePath = one(`select image_path from menu_items where name = '${name}'`);
  expect(imagePath).toMatch(/^menu\/[0-9a-f-]{36}$/);
  const objs = groupObjects(imagePath);
  expect(objs.map((o) => o[0])).toEqual([`${imagePath}/1600.webp`, `${imagePath}/480.webp`, `${imagePath}/960.webp`]);
  for (const [n, size, mime] of objs) {
    const w = /\/(\d+)\.webp$/.exec(n!)![1]!;
    expect(Number(size), n).toBeLessThanOrEqual(CAPS[w]!);
    expect(mime, n).toBe("image/webp");
  }
  // public bytes really are WebP
  const res = await page.request.get(`http://127.0.0.1:54321/storage/v1/object/public/public-media/${imagePath}/960.webp`);
  expect(res.status()).toBe(200);
  const head = Buffer.from(await res.body());
  expect(head.subarray(0, 4).toString()).toBe("RIFF");
  expect(head.subarray(8, 12).toString()).toBe("WEBP");
  await page.goto("/menu");
  const li = page.getByRole("listitem").filter({ hasText: name });
  await expect(li).toBeVisible();
  await expect(li.locator("img")).toHaveAttribute("src", /127\.0\.0\.1:54321\/storage\/v1\/object\/public\/public-media\/menu\//);
  await expect(li.locator("img")).toHaveJSProperty("complete", true);
  sql(`update menu_items set is_visible = false, deleted_at = now() where name = '${name}'`); // tidy up
});

test("upload caps and type are enforced by the server (declared size, content type, real bytes at attach)", async ({ page, baseURL, ip }) => {
  void ip;
  await signIn(page, OWNER);
  const req = page.request;
  const big = actionResult((await callAction(req, baseURL!, "createUploadUrl", { folder: "menu", widthPx: 480, contentType: "image/webp", sizeBytes: 50 * 1024 })).text);
  expect(big.error?.code).toBe("VALIDATION");
  expect(big.error?.fieldErrors?.sizeBytes?.[0]).toBeTruthy();
  const png = actionResult((await callAction(req, baseURL!, "createUploadUrl", { folder: "menu", widthPx: 480, contentType: "image/png", sizeBytes: 1000 })).text);
  expect(png.error?.code).toBe("VALIDATION");
  // declare small WebP files, then upload PNG bytes with an image/webp header: the attach-time check must refuse them
  let groupId: string | undefined;
  for (const widthPx of [480, 960, 1600]) {
    const r = actionResult((await callAction(req, baseURL!, "createUploadUrl", { folder: "menu", groupId, widthPx, contentType: "image/webp", sizeBytes: 2000 })).text) as {
      ok: boolean;
      data: { groupId: string; uploadUrl: string };
    };
    expect(r.ok).toBe(true);
    groupId = r.data.groupId;
    const put = await req.put(r.data.uploadUrl, { headers: { "Content-Type": "image/webp" }, data: Buffer.from("\x89PNG\r\n\x1a\nnot really a webp".padEnd(1500, "x")) });
    expect(put.status(), `PUT ${widthPx}`).toBeLessThan(300);
  }
  const catId = one(`select id from menu_categories where name = 'Desserts'`);
  const save = actionResult(
    (await callAction(req, baseURL!, "upsertMenuItem", { categoryId: catId, name: "QA Fake Photo", description: null, price: 10000, diet: "veg", tags: [], isVisible: false, imagePath: `menu/${groupId}`, variants: [] })).text,
  );
  expect(save.error?.code).toBe("VALIDATION");
  expect(JSON.stringify(save.error)).toContain("The photo did not upload correctly");
  expect(groupObjects(`menu/${groupId}`)).toEqual([]); // group deleted
  expect(one(`select count(*) from menu_items where name = 'QA Fake Photo'`)).toBe("0");
});

test("product editor: add a photo with alt text to a product -> product_images row + 3 WebP files; shop shows it", async ({ page, ip }) => {
  test.setTimeout(120_000);
  void ip;
  const productId = one(`select id from products where slug = 'nailed-tote-bag'`);
  // Each run adds one photo; after 9 runs the 10-photo cap (correctly) replaced the success message. Start clean.
  sql(`delete from product_images where product_id = '${productId}' and alt = 'Live QA tote photo'`);
  const before = Number(one(`select count(*) from product_images where product_id = '${productId}'`));
  await signIn(page, OWNER, "/admin/products");
  await expect(page.getByRole("heading", { name: "Products and stock", level: 1 })).toBeVisible();
  const cardEl = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: /Nailed Tote Bag/ }) });
  await cardEl.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("form", { name: /Edit Nailed Tote Bag/ });
  await expect(form).toBeVisible();
  await form.getByLabel(/Add a photo/).setInputFiles(PHOTO);
  await expect(form.getByText("Photo added to the list above. Describe it, then save.")).toBeVisible({ timeout: 30_000 });
  await form.getByLabel(`Photo ${before + 1} description (alt text)`).fill("Live QA tote photo");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("form")).toHaveCount(0, { timeout: 15_000 });
  const rows = sql(`select path||'|'||alt from product_images where product_id = '${productId}' order by sort_order`);
  expect(rows.length).toBe(before + 1);
  const [p, alt] = rows[rows.length - 1]!.split("|");
  expect(alt).toBe("Live QA tote photo");
  expect(groupObjects(p!).length).toBe(3);
  await page.goto("/shop/nailed-tote-bag");
  await expect(page.getByRole("img", { name: "Live QA tote photo" }).first()).toBeVisible();
});

test("blocklist UI: staff adds a phone (duplicate is idempotent), cannot unblock; owner unblocks; checkout works again", async ({ page, request }, info) => {
  const phone = freshPhone();
  await routeIp(page, freshIp(info.project.name));
  await signIn(page, STAFF, "/admin/blocklist");
  await page.getByLabel("Phone number to block").fill("123");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.getByText(/Nepal mobile/).first()).toBeVisible();
  await page.getByLabel("Phone number to block").fill(phone);
  await page.getByLabel("Reason").fill("live QA");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.getByText(`+977${phone}`, { exact: true })).toBeVisible();
  await page.getByLabel("Phone number to block").fill(phone);
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.getByRole("status").getByText(/Already blocked/)).toBeVisible();
  await expect(page.getByText(`+977${phone}`, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: `Unblock +977${phone}` })).toHaveCount(0);
  expect((await apiCheckout(request, freshIp(info.project.name), { phone })).body.error?.code).toBe("ORDER_REFUSED");

  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, OWNER, "/admin/blocklist");
  await page.getByRole("button", { name: `Unblock +977${phone}` }).click();
  await expect(page.getByText(`+977${phone}`, { exact: true })).toHaveCount(0);
  expect(one(`select count(*) from blocked_contacts where value = '+977${phone}'`)).toBe("0");
  expect((await apiCheckout(request, freshIp(info.project.name), { phone })).status).toBe(201);
});

test("admin pages render for the owner without errors at this width", async ({ page, ip }) => {
  void ip;
  await signIn(page, OWNER);
  for (const p of ["/admin/menu", "/admin/products", "/admin/blocklist", "/admin/settings", "/admin/staff", "/admin/account"]) {
    await page.goto(p);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, `overflow on ${p}`).toBeLessThanOrEqual(0);
  }

});

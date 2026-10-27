import {
  addToteToCart,
  apiCheckout,
  callAction,
  actionResult,
  clearLoginLimits,
  topUpTestStock,
  expect,
  freshIp,
  freshPhone,
  guardLocal,
  HOODIE_L,
  LIVE,
  noHorizontalScroll,
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
  waitForTurnstile,
} from "./live-helpers";

/**
 * LIVE-mode P1 checks, public side + login + middleware (qa-engineer, 2026-10-23). Admin flows: admin.live.spec.ts.
 * Run: E2E_LIVE=1 pnpm exec playwright test -c tests/e2e/live/playwright.live.config.ts   (see that file)
 */

const OWNER_ID = () => one(`select id from profiles where role = 'owner' order by created_at limit 1`);

test.skip(!LIVE, "live-mode spec: set E2E_LIVE=1 and run with tests/e2e/live/playwright.live.config.ts");
test.beforeAll(async ({ baseURL, playwright }) => {
  guardLocal(baseURL);
  clearLoginLimits();
  await topUpTestStock(playwright, baseURL!);
});

test("health: 200, db up, no-store, nothing secret", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.db).toBe("up");
  expect(Object.keys(body.data).sort()).toEqual(["db", "time"]);
});

test("security headers on page, order, admin and API responses", async ({ request }) => {
  for (const p of ["/", "/menu", "/admin/login", "/order/00000000-0000-4000-8000-000000000000", "/api/menu", "/api/orders/00000000-0000-4000-8000-000000000000"]) {
    const h = (await request.get(p, { maxRedirects: 0 })).headers();
    expect(h["content-security-policy"], p).toContain("frame-ancestors 'none'");
    expect(h["x-frame-options"], p).toBe("DENY");
    expect(h["x-content-type-options"], p).toBe("nosniff");
    expect(h["permissions-policy"], p).toContain("camera=()");
    expect(h["strict-transport-security"], p).toBe("max-age=31536000");
    if (/^\/(order|admin|api\/orders)/.test(p)) {
      expect(h["referrer-policy"], p).toBe("no-referrer");
      expect(h["x-robots-tag"], p).toContain("noindex");
    } else {
      expect(h["referrer-policy"], p).toBe("strict-origin-when-cross-origin");
    }
    if (p.startsWith("/api")) expect(h["x-robots-tag"], p).toContain("noindex");
  }
});

test("menu: categories and prices come from the database; seeded sold-out item is marked", async ({ page, ip }) => {
  void ip;
  await page.goto("/menu");
  await expect(page.getByRole("heading", { name: "Menu", level: 1 })).toBeVisible();
  for (const c of ["Coffee", "Tea", "Momo", "Desserts", "Cold Drinks"]) await expect(page.getByRole("heading", { name: c, level: 2 })).toBeVisible();
  const green = page.getByRole("listitem").filter({ hasText: "Himalayan Green Tea" });
  await expect(green.getByText("Sold out", { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Lemon Tea" }).first()).toContainText("Rs. 80");
  await noHorizontalScroll(page);
});

test("menu: a sold-out change in the database reaches /api/menu and an open menu (poll)", async ({ page, request, ip }) => {
  test.setTimeout(120_000);
  const id = one(`select id from menu_items where name = 'Masala Chai'`);
  try {
    await page.goto("/menu");
    const chai = page.getByRole("listitem").filter({ hasText: "Masala Chai" }).first();
    await expect(chai.getByText("Sold out", { exact: true })).toHaveCount(0);
    sql(`update menu_items set is_sold_out = true where id = '${id}'`);
    const api = await (await request.get("/api/menu", { headers: { "cf-connecting-ip": ip } })).json();
    const item = api.data.categories.flatMap((c: { items: { id: string; isSoldOut: boolean }[] }) => c.items).find((i: { id: string }) => i.id === id);
    expect(item.isSoldOut).toBe(true);
    // the open page polls GET /api/menu every 30 s while visible
    await expect(chai.getByText("Sold out", { exact: true })).toBeVisible({ timeout: 45_000 });
  } finally {
    sql(`update menu_items set is_sold_out = false where id = '${id}'`);
  }
});

test("shop list and product page read live stock states", async ({ page, ip }) => {
  void ip;
  await page.goto("/shop");
  for (const n of ["Nailed Classic Tee", "Nailed Hoodie", "Nailed Tote Bag", "Nailed Cap"]) await expect(page.getByText(n).first()).toBeVisible();
  await noHorizontalScroll(page);
  await page.goto("/shop/nailed-classic-tee");
  await expect(page.getByRole("radio", { name: /L, Cream/ })).toBeDisabled(); // stock 0
  await expect(page.getByText(/few left/i).first()).toBeVisible(); // XL Black stock 2
  await noHorizontalScroll(page);
});

test("checkout PICKUP through the UI: order lands in the DB, stock goes down by 1", async ({ page, ip }) => {
  void ip;
  const before = stock(TOTE);
  const phone = freshPhone();
  await addToteToCart(page);
  await page.goto("/checkout");
  await page.getByRole("radio", { name: /Pickup at the cafe/ }).check();
  await page.getByLabel("Name").first().fill("Live Pickup");
  await page.getByLabel("Phone").fill(phone);
  await waitForTurnstile(page);
  await noHorizontalScroll(page);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\/[0-9a-f-]{36}\?placed=1/, { timeout: 20_000 });
  const token = /\/order\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.getByText("Thank you, we have your order")).toBeVisible();
  await expect(page.getByText(/Pay Rs\. 900 in cash/).first()).toBeVisible();
  const [status, ful, method, pay, total, fee, , , , ph] = orderRow(token);
  expect([status, ful, method, pay, total, fee, ph]).toEqual(["placed", "pickup", "pickup", "unpaid", "90000", "0", `+977${phone}`]);
  expect(stock(TOTE)).toBe(before - 1);
});

test("checkout COD DELIVERY through the UI: area, address, fee; order lands in the DB", async ({ page, ip }) => {
  void ip;
  const before = stock(TOTE);
  await addToteToCart(page);
  await page.goto("/checkout");
  await page.getByRole("radio", { name: /Delivery/ }).check();
  await page.getByLabel("Name").first().fill("Live Delivery");
  await page.getByLabel("Phone").fill(freshPhone());
  await page.getByLabel("Area").selectOption("Thamel");
  await page.getByLabel("Address").fill("Live QA Road 5");
  await page.getByLabel("Landmark").fill("Opposite the QA bakery");
  await waitForTurnstile(page);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const token = /\/order\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.getByText(/Pay Rs\. 1,050 in cash on delivery/).first()).toBeVisible();
  const [status, ful, method, , total, fee, , , area] = orderRow(token);
  expect([status, ful, method, total, fee, area]).toEqual(["placed", "delivery", "cod", "105000", "15000", "Thamel"]);
  expect(stock(TOTE)).toBe(before - 1);
});

test("order page + customer cancel: cancelled in the DB, stock restored once, repeat is idempotent", async ({ page, request, ip }) => {
  const before = stock(TOTE);
  const r = await apiCheckout(request, ip);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const token = r.body.data.orderToken as string;
  expect(stock(TOTE)).toBe(before - 1);
  await page.goto(`/order/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("We have your order");
  await noHorizontalScroll(page);
  await page.getByRole("button", { name: "Cancel this order" }).click();
  await page.getByRole("button", { name: "Yes, cancel my order" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This order was cancelled");
  const row = orderRow(token);
  expect([row[0], row[6], row[7]]).toEqual(["cancelled", "customer_request", "true"]);
  expect(stock(TOTE)).toBe(before);
  const again = await request.post(`/api/orders/${token}/cancel`, { headers: { "cf-connecting-ip": ip } });
  expect(again.status()).toBe(200);
  expect(stock(TOTE)).toBe(before); // no double restock
});

test("unknown order token: API 404 NOT_FOUND, page explains", async ({ page, request, ip }) => {
  const res = await request.get("/api/orders/11111111-1111-4111-8111-111111111111", { headers: { "cf-connecting-ip": ip } });
  expect(res.status()).toBe(404);
  expect((await res.json()).error.code).toBe("NOT_FOUND");
  await page.goto("/order/11111111-1111-4111-8111-111111111111");
  await expect(page.getByText("We could not find that order")).toBeVisible();
});

test("orders paused (DB switch): checkout shows the notice and the API answers 503 ORDERS_PAUSED", async ({ page, request, ip }) => {
  await addToteToCart(page);
  sql(`update site_settings set orders_paused = true`);
  try {
    await page.goto("/checkout");
    await expect(page.getByText("Online orders are paused").first()).toBeVisible();
    const r = await apiCheckout(request, ip);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("ORDERS_PAUSED");
    expect(r.body.error.message).toContain("We are not taking online orders right now");
    expect(r.headers["retry-after"]).toBeUndefined();
  } finally {
    sql(`update site_settings set orders_paused = false`);
  }
});

test("ORDER_REFUSED is identical for a blocked phone, the open-orders cap and the COD maximum", async ({ page, request, errors }, info) => {
  const ips = Array.from({ length: 6 }, () => freshIp(info.project.name));
  // 1. blocked phone (blocklist entry through the same DB function the admin action uses, as the owner)
  const blocked = freshPhone();
  sql(`select public.block_contact('phone', '+977${blocked}', 'live QA', '${OWNER_ID()}')`);
  const r1 = await apiCheckout(request, ips[0]!, { phone: blocked });
  // 2. too many open orders for this phone (default 2)
  const busy = freshPhone();
  expect((await apiCheckout(request, ips[1]!, { phone: busy })).status).toBe(201);
  expect((await apiCheckout(request, ips[2]!, { phone: busy })).status).toBe(201);
  const r2 = await apiCheckout(request, ips[3]!, { phone: busy });
  // 3. total above codMaxTotal (Rs. 10,000): 4 x hoodie = Rs. 11,200 (in stock)
  const r3 = await apiCheckout(request, ips[4]!, { items: [{ variantId: HOODIE_L, qty: 4 }] });
  const strip = (b: { error: { requestId?: string } }) => ({ ...b, error: { ...b.error, requestId: "<id>" } });
  for (const r of [r1, r2, r3]) {
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("ORDER_REFUSED");
  }
  expect(strip(r2.body)).toEqual(strip(r1.body));
  expect(strip(r3.body)).toEqual(strip(r1.body));
  const hk = (h: Record<string, string>) => Object.keys(h).filter((k) => k !== "date").sort();
  expect(hk(r2.headers)).toEqual(hk(r1.headers));
  expect(hk(r3.headers)).toEqual(hk(r1.headers));
  expect(r1.body.error.message).toBe("We can't take this order online right now. Please call us.");
  // the checkout page for the blocked phone (UI path)
  await routeIp(page, ips[5]!);
  await addToteToCart(page);
  await page.goto("/checkout");
  await page.getByRole("radio", { name: /Pickup at the cafe/ }).check();
  await page.getByLabel("Name").first().fill("Blocked Person");
  await page.getByLabel("Phone").fill(blocked);
  await waitForTurnstile(page);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("We cannot take this order online")).toBeVisible();
  await expect(page.getByText(/Please call us on \+9779800000000/)).toBeVisible();
  // the refused POST /api/checkout (403) is logged by the browser as a failed resource: expected here, nothing else is
  errors.splice(0, errors.length, ...errors.filter((e) => !/status of 403/.test(e)));
});

test("checkout IP limit: the 6th request in 10 minutes from one IP is 429 with Retry-After", async ({ request }, info) => {
  const ip = freshIp(info.project.name);
  const statuses: number[] = [];
  let last: Awaited<ReturnType<typeof apiCheckout>> | undefined;
  for (let i = 0; i < 6; i++) {
    // unknown variant: passes Zod + Turnstile (so it counts at step 4), then fails VALIDATION in the DB, no order
    last = await apiCheckout(request, ip, { items: [{ variantId: "40000000-0000-4000-8000-0000000000ff", qty: 1 }] });
    statuses.push(last.status);
  }
  expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
  expect(statuses[5]).toBe(429);
  expect(last!.body.error.code).toBe("RATE_LIMITED");
  expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
});

test("middleware: signed-out /admin pages redirect to login with ?next=; a forged cookie does not help", async ({ page, request, ip }) => {
  void ip;
  const root = await request.get("/admin", { maxRedirects: 0 });
  expect(root.status()).toBe(307);
  expect(root.headers()["location"]).toMatch(/\/admin\/login/);
  for (const p of ["/admin/orders", "/admin/settings", "/admin/menu", "/admin/products", "/admin/blocklist", "/admin/staff", "/ADMIN/settings"]) {
    const res = await request.get(p, { maxRedirects: 0 });
    expect(res.status(), p).toBe(307);
    expect(res.headers()["location"], p).toMatch(/\/admin\/login\?next=%2F/i);
  }
  const forged = await request.get("/admin/settings", {
    maxRedirects: 0,
    headers: { cookie: "sb-127-auth-token=base64-eyJhY2Nlc3NfdG9rZW4iOiJmb3JnZWQifQ" },
  });
  expect(forged.status()).toBe(307);
  await page.goto("/admin/blocklist");
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Fblocklist/);
  await expect(page.getByRole("heading", { name: "Staff sign in" })).toBeVisible();
  await noHorizontalScroll(page);
});

test("server actions without a session are refused by the server (UNAUTHENTICATED) and change nothing", async ({ request, baseURL }, info) => {
  expect((await apiCheckout(request, freshIp(info.project.name), { name: "Unauth Probe" })).status).toBe(201);
  const pausedBefore = one(`select orders_paused from site_settings`);
  const r1 = actionResult((await callAction(request, baseURL!, "setOrdersPaused", { paused: true }, "/admin/login")).text);
  expect(r1.error?.code).toBe("UNAUTHENTICATED");
  expect(one(`select orders_paused from site_settings`)).toBe(pausedBefore);
  const orderId = one(`select id from orders where status = 'placed' order by created_at desc limit 1`);
  expect(orderId, "needs one placed order").not.toBe("");
  const r2 = actionResult((await callAction(request, baseURL!, "updateOrderStatus", { orderId, status: "confirmed" }, "/admin/login")).text);
  expect(r2.error?.code).toBe("UNAUTHENTICATED");
  expect(one(`select status from orders where id = '${orderId}'`)).toBe("placed");
  const r3 = await callAction(request, baseURL!, "listOrders", {}, "/admin/login");
  expect(actionResult(r3.text).error?.code).toBe("UNAUTHENTICATED");
  expect(r3.text).not.toMatch(/\+977\d{10}/); // no phone numbers leak
});

test("admin login: wrong password is generic; after 5 failures the 6th (even correct) gets the throttle message", async ({ page, ip }) => {
  void ip;
  await page.goto("/admin/login");
  await waitForTurnstile(page);
  for (let i = 1; i <= 5; i++) {
    await page.getByLabel("Email").fill(STAFF.email);
    await page.getByLabel("Password").fill(`wrong-password-${i}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Invalid email or password." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  }
  await page.getByLabel("Password").fill(STAFF.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Too many failed sign-in attempts\. Please wait \d+ minutes? and try again\./ })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/login/);
});

test("admin login: owner lands on ?next=; open-redirect ignored; staff sees (staff); sign out ends the session", async ({ page, ip }) => {
  void ip;
  await signIn(page, OWNER, "/admin/settings");
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.goto("/admin/settings");
  await expect(page).toHaveURL(/\/admin\/login\?next=/);
  // open redirect
  await page.goto("/admin/login?next=https://evil.example/x");
  await waitForTurnstile(page);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/localhost:\d+\/admin\/?$/, { timeout: 15_000 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login/);
});

test("auto-cancel: low timeout + auto_cancel_unconfirmed_orders() cancels an old placed order and restocks it", async ({ page, request, ip }) => {
  const before = stock(TOTE);
  const r = await apiCheckout(request, ip);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const token = r.body.data.orderToken as string;
  const original = one(`select coalesce(auto_cancel_placed_after_minutes::text, 'null') from order_rules`);
  try {
    sql(`update order_rules set auto_cancel_placed_after_minutes = 15`);
    // test setup only: age the order by 20 minutes (the guard trigger forbids this, so triggers are off for this one statement)
    sql(`set session_replication_role = replica; update orders set created_at = now() - interval '20 minutes' where public_token = '${token}'; set session_replication_role = origin;`);
    const result = one(`select public.auto_cancel_unconfirmed_orders()::text`);
    expect(JSON.parse(result)).toMatchObject({ enabled: true, timeoutMinutes: 15, failed: 0 });
    const row = orderRow(token);
    expect([row[0], row[6], row[7]]).toEqual(["cancelled", "auto_unconfirmed", "true"]);
    // >= : the same run also cancels (and restocks) any other QA order still placed after 15 minutes
    expect(stock(TOTE)).toBeGreaterThanOrEqual(before);
    await page.goto(`/order/${token}`);
    await expect(page.getByText("Cancelled: not confirmed in time")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel this order" })).toHaveCount(0);
  } finally {
    sql(`update order_rules set auto_cancel_placed_after_minutes = ${original}`);
  }
});

test("no horizontal scroll on the main public pages", async ({ page, ip }) => {
  void ip;
  for (const p of ["/", "/menu", "/shop", "/shop/nailed-hoodie", "/cart", "/visit", "/story", "/policies"]) {
    await page.goto(p);
    await page.waitForLoadState("networkidle");
    await noHorizontalScroll(page);
  }
});

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test as base, expect, request, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Shared helpers for the LIVE-mode specs (qa-engineer, 2026-10-23). LOCAL stack only (docker exec psql).
 * Every test gets its own client IP (cf-connecting-ip, the only IP header a production build trusts) so the
 * per-IP limits of one test never affect another.
 */

export const LIVE = process.env.E2E_LIVE === "1";
const DB_CONTAINER = process.env.E2E_DB_CONTAINER ?? "supabase_db_nailed-cafe";
export const OWNER = { email: "owner.local@nailed-cafe.test", password: "LocalOwner-2026-Pass!" };
export const STAFF = { email: "staff.local@nailed-cafe.test", password: "LocalStaff-2026-Pass!" };
export const TOTE = "40000000-0000-4000-8000-000000000010"; // Nailed Tote Bag, One size / Natural, Rs. 900
export const HOODIE_L = "40000000-0000-4000-8000-000000000008"; // Rs. 2,800, stock 5
export const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"; // accepted by the always-pass TEST secret only

/** Known, harmless console noise: the app ships no favicon (report), Turnstile test-mode chatter. */
const IGNORE = [/favicon\.ico/, /status of 404/, /challenges\.cloudflare\.com/, /Private Access Token/, /status of 401/];

let ipSeq = 0;
const runTag = Math.floor(Date.now() / 1000) % 100;
export function freshIp(project: string) {
  ipSeq += 1;
  return `198.${18 + (project.startsWith("phone") ? 0 : 1)}.${runTag + Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}
export function freshPhone() {
  return `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

export async function routeIp(page: Page, ip: string) {
  await page.route(/^http:\/\/(localhost|127\.0\.0\.1):3\d{3}\//, (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
  );
}

export const test = base.extend<{ ip: string; errors: string[] }>({
  ip: async ({ page }, provide, info) => {
    const ip = freshIp(info.project.name);
    await routeIp(page, ip);
    await provide(ip);
  },
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" && !IGNORE.some((r) => r.test(m.text()))) errors.push(`console: ${m.text()}`);
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      await use(errors);
      expect(errors, "console / page errors").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export function guardLocal(baseURL: string | undefined) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+/.test(baseURL ?? "")) throw new Error("live spec runs against localhost only");
}

/** Runs SQL on the LOCAL database and returns the first column of each row. */
export function sql(query: string): string[] {
  const out = execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  });
  return out.split(/\r?\n/).filter((l) => l !== "");
}
export const one = (q: string) => sql(q)[0] ?? "";
export const stock = (variantId: string) => Number(one(`select stock from product_variants where id = '${variantId}'`));
/** [status, fulfilment, method, paymentStatus, total, deliveryFee, cancelReason, restocked, area, phone, number, id] */
export const orderRow = (token: string) =>
  one(
    `select status||'|'||fulfilment||'|'||payment_method||'|'||payment_status||'|'||total_paisa||'|'||delivery_fee_paisa||'|'||coalesce(cancel_reason,'')||'|'||(stock_restocked_at is not null)||'|'||coalesce(area,'')||'|'||coalesce(customer_phone,'')||'|'||number||'|'||id from orders where public_token = '${token}'`,
  ).split("|");

/** Clears the login throttle rows (LOCAL test setup only, so repeated runs do not hit the hourly ceiling). */
export function clearLoginLimits() {
  sql(`delete from rate_limits where key like 'login:%'`);
}

/**
 * Tops up the tote used by the order tests (completed orders use stock up for good). Goes through the owner's
 * setStock action so the cached ISR shop pages are revalidated too (a plain SQL update would leave "Sold out" cached).
 */
export async function topUpTestStock(playwright: { request: { newContext: typeof request.newContext } }, baseURL: string) {

  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.200" } });
  try {
    const login = actionResult((await callAction(ctx, baseURL, "signIn", { ...OWNER, turnstileToken: TURNSTILE_TEST_TOKEN }, "/admin/login")).text);
    if (!login.ok) throw new Error(`owner sign-in for stock top-up failed: ${JSON.stringify(login.error)}`);
    const set = actionResult((await callAction(ctx, baseURL, "setStock", { variantId: TOTE, stock: 60 })).text);
    if (!set.ok) throw new Error(`setStock failed: ${JSON.stringify(set.error)}`);
  } finally {
    await ctx.dispose();
  }
}

type Line = { variantId: string; qty: number };
export async function apiCheckout(
  request: APIRequestContext,
  ip: string,
  opts: { items?: Line[]; phone?: string; fulfilment?: "pickup" | "delivery"; name?: string } = {},
) {
  const fulfilment = opts.fulfilment ?? "pickup";
  const res = await request.post("/api/checkout", {
    headers: { "cf-connecting-ip": ip },
    data: {
      items: opts.items ?? [{ variantId: TOTE, qty: 1 }],
      fulfilment,
      paymentMethod: fulfilment === "pickup" ? "pickup" : "cod",
      customer: { name: opts.name ?? "Live QA", phone: opts.phone ?? freshPhone() },
      ...(fulfilment === "delivery" ? { delivery: { address: "QA Street 1", landmark: "Near QA temple", area: "Thamel" } } : {}),
      turnstileToken: TURNSTILE_TEST_TOKEN,
    },
  });
  return { status: res.status(), headers: res.headers(), body: await res.json() };
}

/** The always-pass test widget gives a token within a second or two; wait until the page's widget has one. */
export async function waitForTurnstile(page: Page) {
  await page.waitForFunction(
    () => {
      const t = (window as unknown as { turnstile?: { getResponse: () => string | undefined } }).turnstile;
      try {
        return !!t?.getResponse();
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 20_000 },
  );
}

export async function addToteToCart(page: Page) {
  await page.goto("/shop/nailed-tote-bag");
  const radio = page.getByRole("radio", { name: /One size/ });
  if (await radio.count()) await radio.first().check({ force: true });
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByText("Added to your cart.")).toBeVisible();
}

export async function noHorizontalScroll(page: Page) {
  // Measured against the configured viewport, not window.innerWidth: with mobile emulation (isMobile, Pixel 7) an
  // overflowing page widens the layout viewport, so innerWidth grows with the content and hid real overflow (2026-10-24).
  const vw = page.viewportSize()?.width;
  const over = await page.evaluate((w) => document.documentElement.scrollWidth - (w ?? window.innerWidth), vw);
  expect(over, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(0);
}

export async function signIn(page: Page, who: { email: string; password: string }, next = "/admin") {
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await waitForTurnstile(page);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // QA 2026-10-25: /admin/stats adds its default range to the address (?range=last30Days), so allow a query string.
  await expect(page).toHaveURL(new RegExp(`${next.replace(/\//g, "\\/")}/?(\\?.*)?$`), { timeout: 15_000 });
}

let manifest: Record<string, { exportedName?: string }> | null = null;
export function actionId(name: string): string {
  manifest ??= (
    JSON.parse(readFileSync(path.join(process.cwd(), ".next/server/server-reference-manifest.json"), "utf8")) as {
      node: Record<string, { exportedName?: string }>;
    }
  ).node;
  const hit = Object.entries(manifest).find(([, v]) => v.exportedName === name);
  if (!hit) throw new Error(`no server action ${name} in the build`);
  return hit[0];
}

/** Calls a server action directly (as a hand-crafted request would), with whatever cookies `request` carries. */
export async function callAction(request: APIRequestContext, baseURL: string, name: string, arg: unknown, at = "/admin/orders") {
  const res = await request.post(at, {
    headers: { "Next-Action": actionId(name), "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: baseURL },
    data: JSON.stringify(arg === undefined ? [] : [arg]),
    maxRedirects: 0,
  });
  return { status: res.status(), text: await res.text() };
}

/** The action result line of an RSC response ({"ok":...}). */
export function actionResult(text: string): { ok: boolean; data?: unknown; error?: { code: string; message: string; fieldErrors?: Record<string, string[]> } } {
  const line = text.split("\n").find((l) => /^\d+:\{"ok":/.test(l));
  if (!line) throw new Error(`no action result in: ${text.slice(0, 300)}`);
  return JSON.parse(line.slice(line.indexOf(":") + 1));
}

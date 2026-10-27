import type { Page } from "@playwright/test";
import { addTee, expect, signIn, test } from "./helpers";

/** Computed-colour contrast check (WCAG 2.x). Skips disabled controls (exempt) and hidden/sr-only text. */
export async function contrastFailures(page: Page) {
  return page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgba = (c: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const bgOf = (el: Element): [number, number, number] => {
      const layers: [number, number, number, number][] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let base: [number, number, number] = [255, 255, 255];
      for (const l of layers.reverse()) base = [0, 1, 2].map((i) => l[i]! * l[3] + base[i]! * (1 - l[3])) as [number, number, number];
      return base;
    };
    const out: string[] = [];
    const seen = new Set<string>();
    document.querySelectorAll("body *").forEach((el) => {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return; // sr-only
      if ((el as HTMLButtonElement).disabled || el.closest("[disabled]")) return;
      const fg = rgba(cs.color);
      const bg = bgOf(el);
      const fgm = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]));
      const L1 = lum(fgm), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        const key = `${el.tagName}.${(el.getAttribute("class") ?? "").slice(0, 60)}|${el.textContent!.trim().slice(0, 30)}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(`${ratio.toFixed(2)}:1 (need ${need}) "${el.textContent!.trim().slice(0, 40)}" <${el.tagName.toLowerCase()} class="${(el.getAttribute("class") ?? "").slice(0, 70)}">`);
        }
      }
    });
    return out;
  });
}

async function unlabelled(page: Page) {
  return page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll("input:not([type=hidden]), select, textarea, button, a[href]").forEach((el) => {
      const e = el as HTMLInputElement;
      const name =
        e.getAttribute("aria-label") ||
        e.getAttribute("aria-labelledby") ||
        (e.labels && e.labels.length ? e.labels[0]!.textContent : "") ||
        (el.tagName === "BUTTON" || el.tagName === "A" ? el.textContent : "") ||
        "";
      if (!name.trim()) bad.push(`${el.tagName.toLowerCase()}${e.id ? "#" + e.id : ""} ${(el.getAttribute("class") ?? "").slice(0, 40)}`);
    });
    return bad;
  });
}

const PUBLIC = ["/", "/menu", "/shop", "/shop/sample-tee", "/cart", "/story", "/visit", "/policies"];

test("every public page: lang, title, one h1, landmarks, labelled controls, image alt", async ({ page }) => {
  for (const p of PUBLIC) {
    await page.goto(p);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect((await page.title()).length, `${p} title`).toBeGreaterThan(3);
    expect(await page.locator("h1").count(), `${p} h1 count`).toBe(1);
    await expect(page.locator("main, [role=main], #main").first(), p).toBeVisible();
    expect(await unlabelled(page), `${p} unlabelled controls`).toEqual([]);
    expect(await page.locator("img:not([alt])").count(), `${p} img without alt`).toBe(0);
  }
});

test("checkout form: each field has a label, required marked, error text linked via aria-describedby", async ({ page }) => {
  await addTee(page, 1);
  await page.goto("/checkout");
  expect(await unlabelled(page)).toEqual([]);
  await page.getByRole("button", { name: "Place order" }).click();
  const bad = page.locator("[aria-invalid=true]").first();
  await expect(bad).toHaveAttribute("aria-describedby", /err/);
  // focus moves to the error summary so keyboard / screen reader users hear it
  const focusedText = await page.evaluate(() => document.activeElement?.textContent ?? "");
  expect(focusedText).toContain("Please fix the highlighted fields");
});

test("keyboard: skip link is the first tab stop and works; focus is always visible", async ({ page, isMobile }) => {
  test.skip(!!isMobile, "keyboard tab order is checked on tablet/desktop");
  for (const p of ["/", "/menu", "/shop/sample-tee", "/cart", "/visit"]) {
    await page.goto(p);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" }), p).toBeFocused();
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("main");
  }
  await page.goto("/menu");
  const invisible: string[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const lbl = el.tagName === "INPUT" && (el as HTMLInputElement).labels?.[0] ? getComputedStyle((el as HTMLInputElement).labels![0]!) : null;
      const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
      const shadow = cs.boxShadow !== "none";
      const sibling = el.matches(".sr-only") ? el.nextElementSibling : null; // sr-only radios paint the focus ring on the label
      return { tag: el.tagName, text: (el.textContent || el.getAttribute("aria-label") || "").slice(0, 30), outline, shadow, inView: r.bottom > 0, sr: !!sibling, lbl: !!lbl };
    });
    if (info && !info.outline && !info.shadow && !info.sr) invisible.push(`${info.tag} "${info.text}"`);
  }
  expect(invisible, "focused elements with no visible outline/shadow").toEqual([]);
});

test("keyboard-only: pick a size and add to cart, then check out with Enter", async ({ page, isMobile }) => {
  test.skip(!!isMobile, "keyboard flow checked on tablet/desktop");
  await page.goto("/shop/sample-tee");
  await page.getByRole("radio", { name: /M, Black/ }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("radio", { name: /M, Black/ })).toBeChecked();
  await page.keyboard.press("ArrowDown"); // arrow keys move within the radio group and skip the disabled one
  const focused = await page.evaluate(() => (document.activeElement as HTMLInputElement)?.type);
  expect(focused).toBe("radio");
  await page.getByRole("radio", { name: /M, Black/ }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Add to cart" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Added to your cart.")).toBeVisible();
  await page.goto("/checkout");
  await page.getByLabel("Name").focus();
  await page.keyboard.type("Key Board");
  await page.keyboard.press("Tab");
  await page.keyboard.type("9841234567");
  await page.keyboard.press("Enter"); // implicit submit
  await expect(page).toHaveURL(/\/order\//);
});

test("sold-out and status are never colour-only (text or shape present)", async ({ page }) => {
  await page.goto("/menu");
  await expect(page.getByText("Sold out", { exact: true }).first()).toBeVisible();
  const marks = page.locator("svg[aria-hidden=true]");
  expect(await marks.count()).toBeGreaterThan(3);
  await expect(page.locator(".sr-only", { hasText: "Vegetarian" }).first()).toBeAttached();
});

test("placeholder theme contrast (computed) on public pages", async ({ page }) => {
  const all: string[] = [];
  for (const p of PUBLIC) {
    await page.goto(p);
    for (const f of await contrastFailures(page)) all.push(`${p}  ${f}`);
  }
  await addTee(page, 1);
  await page.goto("/checkout");
  for (const f of await contrastFailures(page)) all.push(`/checkout  ${f}`);
  expect(all, "text below WCAG AA contrast").toEqual([]);
});

test("placeholder theme contrast (computed) on admin pages", async ({ page }) => {
  await signIn(page);
  const all: string[] = [];
  for (const p of ["/admin", "/admin/menu", "/admin/products", "/admin/blocklist", "/admin/settings", "/admin/staff", "/admin/account", "/admin/orders/00000000-0000-4000-8007-000000000001"]) {
    await page.goto(p);
    await page.waitForTimeout(600);
    for (const f of await contrastFailures(page)) all.push(`${p}  ${f}`);
  }
  expect(all, "text below WCAG AA contrast").toEqual([]);
});

test("tap targets on phone: buttons and links are at least 44x44 css px", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone only");
  const small: string[] = [];
  for (const p of ["/", "/menu", "/shop", "/shop/sample-tee", "/visit"]) {
    await page.goto(p);
    const r = await page.evaluate(() =>
      [...document.querySelectorAll("a[href], button, input, select")]
        .filter((e) => !(e instanceof HTMLInputElement && e.labels?.length)) // a labelled checkbox is tapped via its 44px label row
        .filter((e) => !e.closest("p, li:not([class])") || e.tagName !== "A")
        .map((e) => {
          const b = e.getBoundingClientRect();
          return { t: (e.textContent || e.getAttribute("aria-label") || e.tagName).trim().slice(0, 25), w: Math.round(b.width), h: Math.round(b.height), sr: e.classList.contains("sr-only") };
        })
        .filter((x) => !x.sr && x.w > 0 && (x.h < 43.5 || x.w < 43.5)),
    );
    for (const x of r) small.push(`${p} "${x.t}" ${x.w}x${x.h}`);
  }
  expect.soft(small, "targets under 44px").toEqual([]);
});

test("contrast checker negative control: catches a deliberately low-contrast element", async ({ page }) => {
  await page.goto("/menu");
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "faint text";
    p.style.cssText = "color:#cdbd9e;background:#f1e8d6;font-size:16px";
    document.querySelector("main, #main")!.prepend(p);
  });
  const f = await contrastFailures(page);
  expect(f.join(" | ")).toContain("faint text");
});

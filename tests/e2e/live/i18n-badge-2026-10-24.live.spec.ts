import path from "node:path";
import type { Page } from "@playwright/test";
import {
  actionResult,
  callAction,
  clearLoginLimits,
  expect,
  guardLocal,
  LIVE,
  noHorizontalScroll,
  one,
  OWNER,
  signIn,
  sql,
  STAFF,
  test,
} from "./live-helpers";

/**
 * QA 2026-10-24 (qa-engineer), LIVE mode on the LOCAL stack only. New since the 2026-10-23 live run:
 *  - multi-language menu (contract 1.4.0): picker on /menu, admin translation fields, staff read-only + FORBIDDEN,
 *    "omitted translations = unchanged", code-point length limits in Devanagari and CJK;
 *  - the header open/closed badge follows the hours and closures saved in admin;
 *  - bold brick prices are readable (weight, colour, contrast).
 * Every write is undone at the end of its test (QA items are hard-deleted from the LOCAL database).
 */
test.skip(!LIVE, "live-mode spec: set E2E_LIVE=1 and run with tests/e2e/live/playwright.live.config.ts");
test.beforeAll(({ baseURL }) => {
  guardLocal(baseURL);
  clearLoginLimits();
});

const KEY = "nailed.menuLang";
const BCP47 = { ne: "ne", zh: "zh-Hans", ja: "ja", ko: "ko", pt: "pt-BR" } as const;
type L = keyof typeof BCP47;
const TITLE: Record<L, string> = { ne: "मेनु", zh: "菜单", ja: "メニュー", ko: "메뉴", pt: "Cardápio" };
const STEAM = "Steam Chicken Momo";
const DESSERTS = "10000000-0000-4000-8000-000000000005";
const run = (lang: string) => `main [lang="${lang}"]:not(option)`;
const shots = path.join(process.cwd(), "test-results", "live");

function dbItem(name: string) {
  const [id, cat, price, diet, visible, tr] = one(
    `select id||'|'||category_id||'|'||price_paisa||'|'||diet||'|'||is_visible||'|'||translations::text from menu_items where name = '${name}' and deleted_at is null`,
  ).split("|");
  return { id: id!, categoryId: cat!, price: Number(price), diet: diet!, isVisible: visible === "true" || visible === "t", tr: JSON.parse(tr!) };
}
const trOf = (id: string) => one(`select translations::text from menu_items where id = '${id}'`);
const varTrOf = (id: string) => sql(`select label||'='||translations::text from menu_variants where item_id = '${id}' order by sort_order, label`);

/** Creates a QA item in Desserts through the owner's action; returns its id. */
async function createQaItem(page: Page, baseURL: string, name: string, extra: Record<string, unknown> = {}) {
  const r = actionResult(
    (
      await callAction(page.request, baseURL, "upsertMenuItem", {
        categoryId: DESSERTS,
        name,
        description: "QA item, deleted after the test.",
        price: 10000,
        diet: "veg",
        tags: [],
        isVisible: true,
        variants: [],
        ...extra,
      }, "/admin/menu")
    ).text,
  );
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return (r.data as { id: string }).id;
}
/**
 * Removes the QA items. With an owner `page`, each one is first deleted through deleteMenuItem, which revalidates the
 * cached /menu (a plain SQL delete leaves the item in the ISR page and broke later menu tests in run 3).
 */
async function dropQaItems(page?: Page, baseURL?: string) {
  const ids = sql(`select id from menu_items where name like 'QA%' and deleted_at is null`);
  if (page && baseURL)
    for (const itemId of ids) actionResult((await callAction(page.request, baseURL, "deleteMenuItem", { itemId }, "/admin/menu")).text);
  sql(`delete from menu_variants where item_id in (select id from menu_items where name like 'QA%')`);
  sql(`delete from menu_items where name like 'QA%'`);
}

test("language picker: all 5 languages add a lang-tagged run next to the English; the choice survives a reload", async ({ page, ip }, info) => {
  void ip;
  await page.goto("/menu");
  const picker = page.getByLabel("Language");
  await expect(picker).toHaveValue("none");
  expect(await page.locator("html").getAttribute("lang")).toBe("en");
  const buff = dbItem("Buff Momo");
  const steam = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3, name: new RegExp(STEAM) }) });
  for (const l of Object.keys(BCP47) as L[]) {
    await picker.selectOption(l);
    await expect(picker).toHaveValue(l);
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(l);
    // English always stays: h1, item names, the VAT line
    await expect(page.getByRole("heading", { level: 1, name: "Menu" })).toBeVisible();
    await expect(steam.getByRole("heading", { level: 3, name: new RegExp(STEAM) })).toBeVisible();
    await expect(page.getByText(/Prices include 13% VAT/)).toBeVisible();
    // the secondary title and the Buff Momo name carry exactly this language's lang attribute
    await expect(page.locator(run(BCP47[l])).filter({ hasText: new RegExp(`^${TITLE[l]}$`) }).first()).toBeVisible();
    const name = buff.tr[l]?.name as string | undefined;
    const buffRow = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3, name: /Buff Momo/ }) });
    if (name && name !== "Buff Momo")
      await expect(buffRow.locator(`[lang="${BCP47[l]}"]`).filter({ hasText: name }).first()).toBeVisible();
    // no other secondary language leaks in (ne: ignore the decorative aria-hidden Devanagari accents)
    for (const o of Object.keys(BCP47) as L[]) {
      if (o === l) continue;
      const sel = o === "ne" ? `${run("ne")}:not([aria-hidden="true"])` : run(BCP47[o]);
      await expect(page.locator(sel), `${o} runs while ${l} is chosen`).toHaveCount(0);
    }
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    await noHorizontalScroll(page);
    await page.screenshot({ path: path.join(shots, `i18n-menu-${l}-${info.project.name}.png`) });
  }
  // persists after a reload (last pick = pt), and Nepali after another reload
  await page.reload();
  await expect(picker).toHaveValue("pt");
  await expect(page.locator(run("pt-BR")).filter({ hasText: /^Cardápio$/ }).first()).toBeVisible();
  await picker.selectOption("ne");
  await page.reload();
  await expect(picker).toHaveValue("ne");
  await expect(page.getByText("Say it:").first()).toBeVisible();
  // back to English only
  await picker.selectOption("none");
  await page.reload();
  await expect(picker).toHaveValue("none");
  await expect(page.locator(run("ja"))).toHaveCount(0);
});

test("content decisions: Jhol Momo has no add-on and its English says 'jhol'; buff stays 'buff' in every language", async ({ page, ip }) => {
  void ip;
  const jhol = dbItem("Jhol Momo");
  expect(one(`select count(*) from menu_variants where item_id = '${jhol.id}'`)).toBe("0");
  await page.goto("/menu");
  const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3, name: /Jhol Momo/ }) });
  await expect(row).toContainText(/jhol/);
  await expect(row.getByRole("list", { name: /Options/ })).toHaveCount(0);
  await expect(row).not.toContainText(/Add-on|Extra/i);
  const buff = JSON.stringify(dbItem("Buff Momo").tr);
  expect(buff).not.toMatch(/buffalo|búfalo|水牛|물소|バッファロー|भैंसी|भैँसी|राँगो/i);
  expect(dbItem("Buff Momo").tr.pt.name).toMatch(/Buff/);
  expect(dbItem("Buff Momo").tr.zh.name).toMatch(/Buff/);
});

test("owner adds a Japanese name in admin -> shows on /menu; saving again without touching translations keeps them", async ({ page, baseURL, ip }, info) => {
  test.setTimeout(150_000);
  void ip;
  await dropQaItems();
  const steam = dbItem(STEAM);
  const steamTr = trOf(steam.id);
  const steamVarTr = varTrOf(steam.id);
  const steamDesc = one(`select description from menu_items where id = '${steam.id}'`);
  try {
    await signIn(page, OWNER, "/admin/menu");
    const qaName = `QA Lassi ${info.project.name.slice(0, 5)}`;
    await createQaItem(page, baseURL!, qaName);
    await page.reload();
    // 1. owner adds a Japanese name through the form
    const row = page.getByRole("listitem").filter({ hasText: qaName }).first();
    await row.getByRole("button", { name: "Edit details" }).click();
    const form = page.getByRole("form", { name: `Edit ${qaName}` });
    await form.locator("summary").filter({ hasText: /^Translations/ }).click();
    await form.locator("summary").filter({ hasText: "Japanese" }).click();
    await form.locator('input[lang="ja"]').first().fill("ラッシー（QA）");
    await page.screenshot({ path: path.join(shots, `i18n-admin-translations-open-${info.project.name}.png`), fullPage: false });
    await form.getByRole("button", { name: "Save item" }).click();
    await expect(page.getByRole("form", { name: `Edit ${qaName}` })).toHaveCount(0);
    const qaId = one(`select id from menu_items where name = '${qaName}'`);
    expect(JSON.parse(trOf(qaId))).toEqual({ ja: { name: "ラッシー（QA）" } });
    await page.goto("/menu");
    await page.getByLabel("Language").selectOption("ja");
    const pub = page.getByRole("listitem").filter({ hasText: qaName });
    await expect(pub.locator('[lang="ja"]').filter({ hasText: /^ラッシー（QA）$/ })).toBeVisible({ timeout: 15_000 });
    await expect(pub.getByText(qaName)).toBeVisible();

    // 2. a real item with all 5 languages + an option translation: change only the English description
    await page.goto("/admin/menu");
    const sRow = page.getByRole("listitem").filter({ hasText: STEAM }).first(); // the name element also holds the sr-only diet word
    await sRow.getByRole("button", { name: "Edit details" }).click();
    const sForm = page.getByRole("form", { name: `Edit ${STEAM}` });
    await sForm.getByLabel(/^Description/).first().fill(`${steamDesc} QA`);
    await sForm.getByRole("button", { name: "Save item" }).click();
    await expect(page.getByRole("form", { name: `Edit ${STEAM}` })).toHaveCount(0);
    await expect.poll(() => one(`select description from menu_items where id = '${steam.id}'`)).toBe(`${steamDesc} QA`);
    expect(JSON.parse(trOf(steam.id))).toEqual(JSON.parse(steamTr));
    expect(varTrOf(steam.id)).toEqual(steamVarTr);
    // and the same through the action with no `translations` key at all (contract: omitted = unchanged)
    const variants = sql(`select id||'|'||kind||'|'||label||'|'||price_delta_paisa from menu_variants where item_id = '${steam.id}' order by sort_order`).map((r) => {
      const [id, kind, label, d] = r.split("|");
      return { id, kind, label, priceDelta: Number(d) };
    });
    const tags = JSON.parse(one(`select to_json(tags)::text from menu_items where id = '${steam.id}'`));
    const api = actionResult((await callAction(page.request, baseURL!, "upsertMenuItem", {
      id: steam.id, categoryId: steam.categoryId, name: STEAM, description: steamDesc, price: steam.price, diet: steam.diet, tags, isVisible: steam.isVisible, variants,
    }, "/admin/menu")).text);
    expect(api.ok, JSON.stringify(api.error)).toBe(true);
    expect(JSON.parse(trOf(steam.id))).toEqual(JSON.parse(steamTr));
    expect(varTrOf(steam.id)).toEqual(steamVarTr);
    expect(one(`select description from menu_items where id = '${steam.id}'`)).toBe(steamDesc);
    expect(one(`select is_visible from menu_items where id = '${steam.id}'`)).toBe("t"); // still on the menu
  } finally {
    sql(`update menu_items set description = '${steamDesc.replace(/'/g, "''")}', is_visible = ${steam.isVisible} where id = '${steam.id}'`);
    await dropQaItems(page, baseURL!);
  }
});

test("staff: translations are read-only in admin, and a hand-made staff save with translations is FORBIDDEN", async ({ page, baseURL, ip }) => {
  void ip;
  const buff = dbItem("Buff Momo");
  const before = trOf(buff.id);
  const catBefore = one(`select translations::text from menu_categories where id = '${buff.categoryId}'`);
  await signIn(page, STAFF, "/admin/menu");
  const row = page.getByRole("listitem").filter({ has: page.getByText("Buff Momo", { exact: true }) }).first();
  await row.locator("summary").filter({ hasText: /^Translations/ }).click();
  await expect(row.locator('[lang="ja"]').filter({ hasText: "バフ・モモ" })).toBeVisible();
  await expect(row.locator("input, textarea")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Edit details" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save translations" })).toHaveCount(0);
  const item = actionResult((await callAction(page.request, baseURL!, "upsertMenuItem", {
    id: buff.id, categoryId: buff.categoryId, name: "Buff Momo", price: buff.price, diet: buff.diet, tags: [], isVisible: true, variants: [],
    translations: { ja: { name: "STAFF WAS HERE" } },
  }, "/admin/menu")).text);
  expect(item.error?.code).toBe("FORBIDDEN");
  const cat = actionResult((await callAction(page.request, baseURL!, "upsertCategory", {
    id: buff.categoryId, name: "Momo", isVisible: true, translations: { ja: { name: "STAFF" } },
  }, "/admin/menu")).text);
  expect(cat.error?.code).toBe("FORBIDDEN");
  expect(trOf(buff.id)).toBe(before);
  expect(one(`select translations::text from menu_categories where id = '${buff.categoryId}'`)).toBe(catBefore);
});

test("length limits count code points: Devanagari and CJK at the limit pass, one over is VALIDATION (UI and server)", async ({ page, baseURL, ip }, info) => {
  test.setTimeout(150_000);
  void ip;
  await dropQaItems();
  const deva80 = "कि".repeat(40); // 80 code points, 40 visible syllables
  const deva82 = "कि".repeat(41); // 82 code points, only 41 visible syllables
  const cjk80 = "卵".repeat(80);
  const cjk81 = "卵".repeat(81);
  const astral80 = "𠮷".repeat(80); // 80 code points, 160 UTF-16 units
  const desc240 = "温".repeat(240);
  try {
    await signIn(page, OWNER, "/admin/menu");
    const id = await createQaItem(page, baseURL!, `QA Limits ${info.project.name.slice(0, 5)}`, {
      variants: [{ kind: "size", label: "Large", priceDelta: 0 }],
    });
    const base = { id, categoryId: DESSERTS, name: `QA Limits ${info.project.name.slice(0, 5)}`, description: "QA", price: 10000, diet: "veg", tags: [], isVisible: true };
    const save = async (translations: unknown, label?: unknown) =>
      actionResult((await callAction(page.request, baseURL!, "upsertMenuItem", {
        ...base, translations, variants: [{ id: one(`select id from menu_variants where item_id = '${id}'`), kind: "size", label: "Large", priceDelta: 0, ...(label ? { translations: label } : {}) }],
      }, "/admin/menu")).text);
    // at the limit: accepted, and stored exactly
    const okR = await save({ ne: { name: deva80, pronunciation: "ki".repeat(40) }, ja: { name: astral80, description: desc240 }, zh: { name: cjk80 } }, { ja: { label: "卵".repeat(40) } });
    expect(okR.ok, JSON.stringify(okR.error)).toBe(true);
    expect(one(`select char_length(translations->'ne'->>'name')||'/'||char_length(translations->'ja'->>'name')||'/'||char_length(translations->'ja'->>'description') from menu_items where id = '${id}'`)).toBe("80/80/240");
    // one over: VALIDATION on the right field, nothing changed
    const stored = trOf(id);
    for (const [tr, label, field] of [
      [{ ne: { name: deva82 } }, undefined, "translations.ne.name"],
      [{ zh: { name: cjk81 } }, undefined, "translations.zh.name"],
      [{ ja: { name: "x", description: "温".repeat(241) } }, undefined, "translations.ja.description"],
      [{ ne: { name: "x", pronunciation: "k".repeat(81) } }, undefined, "translations.ne.pronunciation"],
      [{ ja: { name: "x", pronunciation: "x" } }, undefined, "translations.ja.pronunciation"],
      [{ en: { name: "x" } }, undefined, "translations"],
      [undefined, { ko: { label: "가".repeat(41) } }, "variants.0.translations.ko.label"],
    ] as const) {
      const r = await save(tr, label);
      expect(r.ok, `${field} should be refused`).toBe(false);
      expect(r.error?.code).toBe("VALIDATION");
      expect(Object.keys(r.error?.fieldErrors ?? {}), JSON.stringify(r.error)).toContain(field);
    }
    expect(trOf(id)).toBe(stored);

    // UI: the counter counts code points and the form refuses 82 Devanagari code points before sending
    await page.reload();
    const row = page.getByRole("listitem").filter({ hasText: base.name }).first();
    await row.getByRole("button", { name: "Edit details" }).click();
    const form = page.getByRole("form", { name: `Edit ${base.name}` });
    await form.locator("summary").filter({ hasText: /^Translations/ }).click();
    await form.locator("summary").filter({ hasText: "Nepali" }).click();
    const ne = form.locator('input[lang="ne"]').first();
    await expect(ne).toHaveValue(deva80);
    await expect(form.getByText("80 / 80 characters").first()).toBeVisible();
    await ne.fill(deva82);
    await expect(form.getByText("82 / 80 characters").first()).toBeVisible();
    await form.locator("summary").filter({ hasText: "Japanese" }).click();
    await expect(form.locator('input[lang="ja"]').first()).toHaveValue(astral80);
    await expect(form.getByText("80 / 80 characters").first()).toBeVisible();
    await form.getByRole("button", { name: "Save item" }).click();
    await expect(form.getByText("Up to 80 characters (now 82)")).toBeVisible();
    await page.screenshot({ path: path.join(shots, `i18n-limit-error-${info.project.name}.png`) });
    expect(trOf(id)).toBe(stored);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    const discard = form.getByRole("button", { name: "Discard", exact: true });
    if (await discard.count()) await discard.first().click();

    // public: the stored 80-code-point names are shown (layout: see the BUG-017 test)
    await page.goto("/menu");
    await page.getByLabel("Language").selectOption("ja");
    await expect(page.locator('[lang="ja"]').filter({ hasText: astral80 }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Language").selectOption("ne");
    await expect(page.locator('[lang="ne"]').filter({ hasText: deva80 }).first()).toBeVisible();
    await page.getByLabel("Language").selectOption("none");
  } finally {
    await dropQaItems(page, baseURL!);
  }
});

test("BUG-017: an item name / translation / 'Say it' at its maximum length wraps inside the menu (no horizontal scroll)", async ({ page, baseURL, ip }, info) => {
  void ip;
  await dropQaItems();
  try {
    await signIn(page, OWNER, "/admin/menu");
    await createQaItem(page, baseURL!, `QA${"x".repeat(78)}`, {
      translations: { ne: { name: "कि".repeat(40), pronunciation: "ki".repeat(40) }, ja: { name: "卵".repeat(80) } },
    });
    for (const l of ["none", "ja", "ne"]) {
      await page.goto("/menu");
      await page.getByLabel("Language").selectOption(l);
      await expect(page.getByText(/^QAx+$/).first()).toBeVisible({ timeout: 15_000 });
      await page.getByText(/^QAx+$/).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(shots, `BUG-017-${l}-${info.project.name}.png`) });
      await noHorizontalScroll(page);
    }
  } finally {
    await dropQaItems(page, baseURL!);
  }
});

/** Kathmandu day (0 = Sun), minutes and yyyy-mm-dd. */
function ktm() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kathmandu", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!), min: Number(p.hour) * 60 + Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const badge = (page: Page) => page.getByRole("banner").getByRole("link", { name: /\. Opening hours$/ });

async function badgeOn(page: Page, url: string) {
  await page.goto(url);
  await expect(badge(page)).toBeVisible({ timeout: 10_000 });
  return (await badge(page).getAttribute("aria-label")) ?? "";
}

test("open/closed badge follows the hours and closures saved in admin (home, menu, story)", async ({ page, baseURL, ip }, info) => {
  test.setTimeout(150_000);
  void ip;
  const orig = JSON.parse(one(`select hours::text from site_settings`));
  const now = ktm();
  test.skip(now.min > 23 * 60 + 20 || now.min < 40, "too close to midnight Kathmandu for a stable check");
  const tomorrow = (now.day + 1) % 7;
  try {
    await signIn(page, OWNER, "/admin/settings");
    const today = page.getByLabel(new RegExp(`^${DAY[now.day]!}`));
    const closures = page.getByLabel("Closed days (festivals)");
    // 1. open all day today
    await today.fill("00:00-24:00");
    await closures.fill("");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    for (const u of ["/", "/menu", "/story"]) {
      await expect.poll(() => badgeOn(page, u), { timeout: 20_000 }).toBe("Open now, until 24:00. Opening hours");
    }
    await page.screenshot({ path: path.join(shots, `badge-open-${info.project.name}.png`) });
    // 2. closing within 30 minutes
    await page.goto("/admin/settings");
    await page.getByLabel(new RegExp(`^${DAY[now.day]!}`)).fill(`00:00-${hhmm(now.min + 20)}`);
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    await expect.poll(() => badgeOn(page, "/"), { timeout: 20_000 }).toBe(`Closes soon, until ${hhmm(now.min + 20)}. Opening hours`);
    // 3. today is a closure: closed, next opening tomorrow (tomorrow kept as stored)
    await page.goto("/admin/settings");
    await page.getByLabel(new RegExp(`^${DAY[now.day]!}`)).fill("00:00-24:00");
    await page.getByLabel("Closed days (festivals)").fill(`${now.date} | QA closure`);
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    const t = orig.weekly[String(tomorrow)]?.[0]?.open as string | undefined;
    const expected = t ? `Closed, opens tomorrow ${t}. Opening hours` : /^Closed/;
    for (const u of ["/", "/menu", "/story"]) {
      await expect.poll(() => badgeOn(page, u), { timeout: 20_000 }).toEqual(expected);
    }
    await page.screenshot({ path: path.join(shots, `badge-closure-${info.project.name}.png`) });
  } finally {
    const r = actionResult((await callAction(page.request, baseURL!, "updateSettings", { hours: orig }, "/admin/settings")).text);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
  }
  expect(JSON.parse(one(`select hours::text from site_settings`))).toEqual(orig);
});

test("prices: bold brick figures on the menu and product page, readable contrast, no wrap", async ({ page, ip }) => {
  void ip;
  const check = async () =>
    page.evaluate(() => {
      const lum = (c: string) => {
        const [r, g, b] = (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const bg = (el: Element | null): string => {
        while (el) {
          const c = getComputedStyle(el).backgroundColor;
          if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
          el = el.parentElement;
        }
        return "rgb(255,255,255)";
      };
      return [...document.querySelectorAll("main .price, main [class*='figures']")]
        .filter((e) => /Rs\./.test(e.textContent ?? ""))
        .map((e) => {
          const s = getComputedStyle(e);
          const L1 = lum(s.color), L2 = lum(bg(e));
          return { text: (e.textContent ?? "").trim(), weight: Number(s.fontWeight), color: s.color, ratio: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05), lines: Math.round(e.getBoundingClientRect().height / parseFloat(s.lineHeight || "20")) };
        });
    });
  await page.goto("/menu");
  const menu = await check();
  expect(menu.length).toBeGreaterThan(10);
  for (const p of menu.filter((x) => !/Sold out/i.test(x.text))) {
    expect(p.weight, p.text).toBeGreaterThanOrEqual(600);
    expect(p.ratio, `${p.text} contrast`).toBeGreaterThanOrEqual(4.5);
  }
  await page.goto("/shop/nailed-classic-tee");
  const prod = await check();
  expect(prod.length).toBeGreaterThan(0);
  for (const p of prod) expect(p.ratio, `${p.text} contrast`).toBeGreaterThanOrEqual(4.5);
  console.log(`[prices] menu ${menu.length}: weights ${[...new Set(menu.map((m) => m.weight))].join(",")} colours ${[...new Set(menu.map((m) => m.color))].join(" ")} min contrast ${Math.min(...menu.map((m) => m.ratio)).toFixed(2)}`);
});

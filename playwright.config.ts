import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * The local suite runs against a MOCK-mode production build (browser sample data, no database).
 * Since SEC-011 a plain `pnpm build` is LIVE, so the web server below first rebuilds `.next` in mock mode
 * (NEXT_PUBLIC_DATA_MODE=mock + ALLOW_MOCK_BUILD=1, the build-guard override) and then runs `next start`.
 * Run `pnpm build` again afterwards if you need a live build in `.next`; `cf:build` always builds its own.
 * E2E_SKIP_BUILD=1 reuses an existing mock build. E2E_BASE_URL tests a deployed staging Worker instead (no server).
 * Never run `next dev` at the same time: it shares `.next`.
 */
const MOCK_ENV = {
  NEXT_PUBLIC_DATA_MODE: "mock",
  ALLOW_MOCK_BUILD: "1",
  NEXT_PUBLIC_SITE_URL: `http://localhost:${PORT}`,
};

const build = process.env.E2E_SKIP_BUILD === "1" ? "" : "pnpm exec next build && ";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [
    { name: "phone-390", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
    { name: "tablet-820", use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 }, hasTouch: true } },
    { name: "desktop-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  // Not started when E2E_BASE_URL points at an already deployed staging Worker.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `${build}pnpm exec next start -p ${PORT}`,
        env: MOCK_ENV,
        port: PORT,
        timeout: 400_000,
        reuseExistingServer: !process.env.CI,
      },
});

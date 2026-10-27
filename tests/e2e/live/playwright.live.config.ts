import { defineConfig, devices } from "@playwright/test";

/**
 * LIVE-mode e2e (qa-engineer, 2026-10-23). Runs against an already running LIVE build on the LOCAL Supabase stack:
 *   1. .env.local with NEXT_PUBLIC_DATA_MODE=live + local Supabase keys (see engineering/qa/report-2026-10-23-live.md)
 *   2. pnpm build && pnpm exec next start -p 3300        (never next dev at the same time)
 *   3. E2E_LIVE=1 pnpm exec playwright test -c tests/e2e/live/playwright.live.config.ts
 * No web server is started here. The spec writes to the LOCAL database only (docker exec psql); it refuses any
 * base URL that is not localhost / 127.0.0.1. One worker: the tests share one database.
 */
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3300}`;

export default defineConfig({
  testDir: ".",
  testMatch: /live\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"], ["json", { outputFile: "../../../test-results/live-results.json" }]],
  outputDir: "../../../test-results/live",
  use: { baseURL: BASE, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "phone-390", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
    { name: "desktop-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
});

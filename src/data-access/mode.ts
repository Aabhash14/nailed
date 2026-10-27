/**
 * Data mode switch (SEC-011: fail-safe default).
 *
 * LIVE is the default: the real Supabase data layer and server actions. MOCK (browser sample data, fake admin login)
 * is used ONLY when NEXT_PUBLIC_DATA_MODE=mock is set explicitly, for `next dev` demos and the e2e suite.
 * NEXT_PUBLIC_* values are inlined at build time, so the value at `next build` decides. next.config.ts refuses a
 * production build in mock mode unless ALLOW_MOCK_BUILD=1 is also set (the e2e build sets it).
 */
export const isMock: boolean = process.env.NEXT_PUBLIC_DATA_MODE === "mock";

/** Turnstile site key: only in live mode (mock mode supplies a fake token and never calls Cloudflare). */
export const turnstileSiteKey: string | undefined = isMock ? undefined : process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || undefined;

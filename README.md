# Cafe app

Next.js 15.5 (App Router) + React 19 + TypeScript (strict) + Tailwind 4 + Zod, pnpm 10, Node 22. Target host: Cloudflare Workers Free via `@opennextjs/cloudflare`; data in Supabase Free. Architecture: `../decisions/0001-overall-architecture.md`, `../decisions/architecture.md`, `../decisions/api-contract.md` (v1.2.0). Ops docs: `../ops/`.

Status: **scaffold only.** Placeholder pages, no database, no auth. Nothing is deployed and no cloud account exists.

## Run it

```
corepack enable            # or: npm i -g pnpm@10
pnpm install
cp .env.example .env.local        # fill in later; the empty app needs no values
cp .dev.vars.example .dev.vars    # server-only secrets, later
pnpm dev                          # http://localhost:3000
```

| Command                        | What                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm lint`                    | ESLint (Next rules + service-role guard)                                            |
| `pnpm typecheck`               | `tsc --noEmit`                                                                      |
| `pnpm test`                    | Vitest unit tests (`tests/unit`)                                                    |
| `pnpm build`                   | Next production build                                                               |
| `pnpm e2e`                     | Playwright (needs `pnpm build` first; `pnpm exec playwright install chromium` once) |
| `pnpm format` / `format:check` | Prettier                                                                            |
| `pnpm cf:build`                | OpenNext Worker build into `.open-next/` (Linux/WSL2, see below)                    |
| `pnpm cf:preview`              | Build then run in local workerd (no account needed)                                 |
| `pnpm cf:check`                | Worker bundle size via `wrangler deploy --dry-run` (uploads nothing)                |

## Windows note

`@opennextjs/cloudflare` is not guaranteed on native Windows. Everyday work (`pnpm dev`, lint, typecheck, test, `next build`) is fine on Windows. Run `pnpm cf:build` / `cf:preview` in WSL2 (clone the repo inside the Linux filesystem, not `/mnt/c`) or let GitHub Actions do it. Details and results: `../ops/worker-sanity.md`.

## Theme

All design tokens live in one file: `src/theme/theme.css`. It currently holds **Concept C "Mato & Dhaka" as a placeholder** (the direction is not chosen). Components use semantic names (`bg-surface`, `text-ink`, `bg-primary`, `font-display`), so swapping the visual direction means replacing that one file.

## Security guard: service role key

`SUPABASE_SERVICE_ROLE_KEY` may only be read in `src/lib/data/server-admin.ts`. ESLint (`eslint.config.mjs`) errors on importing `server-admin` or touching that variable anywhere except `src/lib/**`, `src/app/api/**`, `src/app/admin/_actions/**`, `src/middleware.ts`, `cron-worker/**`, `scripts/**` and `tests/**`. `server-admin.ts` also imports `server-only`, so a client bundle import fails the build.

## Layout

See architecture.md section 4. Reserved, not created: `src/app/(lodge)/`. Not yet written: `deploy.yml`, `keepalive.yml`, `backup.yml` workflows, `supabase/` contents.

## CI

`.github/workflows/ci.yml`: dependency audit (fails on high/critical; allowlist in `pnpm-workspace.yaml`, also weekly on a schedule), then install, lint, typecheck, test, OpenNext Worker build in mock data mode + size check, then Playwright (builds its own mock app). Actions are SHA-pinned; `.github/dependabot.yml` proposes weekly grouped updates. Runbook: `engineering/ops/supply-chain.md`. GitHub reads workflows only from the repo root, so make `engineering/app/` the repo root (recommended) or move the file.

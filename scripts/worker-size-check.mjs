// T-031 first pass: bundle size of the Worker as Cloudflare would see it, no account needed.
// Runs `wrangler deploy --dry-run` (bundles locally, uploads nothing) after `pnpm cf:build`.
// Limit on Workers Free: 3 MiB compressed. ADR 0001 pass target: under 2.5 MiB compressed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const TARGET_KIB = 2.5 * 1024;
const LIMIT_KIB = 3 * 1024;

if (!existsSync(".open-next/worker.js")) {
  console.error("Missing .open-next/worker.js. Run `pnpm cf:build` first.");
  process.exit(2);
}

const r = spawnSync(
  "pnpm",
  ["exec", "wrangler", "deploy", "--dry-run", "--env=", "--outdir", ".wrangler/dry-run"],
  { encoding: "utf8", shell: true },
);
const out = `${r.stdout}\n${r.stderr}`;
console.log(out);

const m = out.match(/Total Upload:\s*([\d.,]+)\s*KiB\s*\/\s*gzip:\s*([\d.,]+)\s*KiB/i);
if (!m) {
  console.error("Could not parse wrangler dry-run output.");
  process.exit(2);
}
const raw = parseFloat(m[1].replace(/,/g, ""));
const gz = parseFloat(m[2].replace(/,/g, ""));
console.log(`Worker bundle: ${raw} KiB raw, ${gz} KiB gzip (${(gz / 1024).toFixed(2)} MiB)`);
console.log(
  `Free limit 3 MiB: ${gz < LIMIT_KIB ? "OK" : "OVER"}; ADR target 2.5 MiB: ${gz < TARGET_KIB ? "OK" : "OVER"}`,
);
process.exit(gz < LIMIT_KIB ? 0 : 1);

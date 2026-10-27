/**
 * T-037: regenerate the break-glass menu (src/data/menu-fallback.json) from the LIVE public menu.
 * Runbook (when and how): engineering/ops/menu-fallback.md.
 *
 *   pnpm menu:export-fallback                              # env from the shell, else .env.local
 *   pnpm menu:export-fallback --env .env.production        # read the two variables from that file
 *   pnpm menu:export-fallback --dry-run                    # read and check, print the summary, write nothing
 *
 * Reads with the ANON key only (NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY) through src/lib/data,
 * so RLS decides what is public. Refuses a service-role / secret key. Never loads any other variable.
 * The JSON is bundled into the site, so commit it and deploy after running this.
 */
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createPublicClient } from "@/lib/data/public-client";
import { exportMenuFallback, FallbackExportError, keyLooksPrivileged } from "@/lib/data/menu-fallback-export";
import { AppError } from "@/lib/errors";

const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_OUT = resolve(APP_ROOT, "src/data/menu-fallback.json");
const URL_VAR = "NEXT_PUBLIC_SUPABASE_URL";
const KEY_VAR = "NEXT_PUBLIC_SUPABASE_ANON_KEY";

const USAGE = `Usage: pnpm menu:export-fallback [--env <path>] [--dry-run] [--allow-empty] [--out <path>]

  --env <path>       Read ${URL_VAR} and ${KEY_VAR} from this file (only these two are read).
                     Without it: the shell environment, else .env.local in the app folder.
  --dry-run          Read the live menu and print the summary, but do not write the file.
  --allow-empty      Write the snapshot even if the live menu has no visible items.
  --out <path>       Write somewhere else (default: src/data/menu-fallback.json).
  --help             Show this help.`;

type Args = { envFile?: string; dryRun: boolean; allowEmpty: boolean; out: string };

class UsageError extends Error {}

function parseArgs(argv: string[]): Args | "help" {
  const args: Args = { dryRun: false, allowEmpty: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new UsageError(`${a} needs a value.`);
      return v;
    };
    if (a === "--") continue; // pnpm may pass a separator through
    else if (a === "--help" || a === "-h") return "help";
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--allow-empty") args.allowEmpty = true;
    else if (a === "--env") args.envFile = resolve(process.cwd(), value());
    else if (a === "--out") args.out = resolve(process.cwd(), value());
    else throw new UsageError(`Unknown option: ${a}`);
  }
  return args;
}

/** The two public variables, from the requested file, the shell, or .env.local (in that order). Nothing else. */
function loadPublicEnv(envFile: string | undefined): { url: string; key: string; source: string } {
  const pick = (vars: NodeJS.Dict<string>, source: string) => ({
    url: (vars[URL_VAR] ?? "").trim(),
    key: (vars[KEY_VAR] ?? "").trim(),
    source,
  });
  const fromFile = (path: string) => {
    if (!existsSync(path)) throw new UsageError(`Env file not found: ${path}`);
    return pick(parseEnv(readFileSync(path, "utf8")), path);
  };
  if (envFile) return fromFile(envFile);
  const shell = pick(process.env, "shell environment");
  if (shell.url && shell.key) return shell;
  const local = resolve(APP_ROOT, ".env.local");
  return existsSync(local) ? fromFile(local) : shell;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === "help") {
    console.log(USAGE);
    return 0;
  }

  const env = loadPublicEnv(args.envFile);
  const missing = [env.url ? null : URL_VAR, env.key ? null : KEY_VAR].filter(Boolean);
  if (missing.length > 0) throw new UsageError(`Missing ${missing.join(" and ")} (looked in: ${env.source}).`);
  let host: string;
  try {
    host = new URL(env.url).host;
  } catch {
    throw new UsageError(`${URL_VAR} is not a valid URL.`);
  }
  if (keyLooksPrivileged(env.key)) {
    throw new UsageError(
      `${KEY_VAR} looks like a service-role / secret key. This export must use the public anon key so RLS decides what is public.`,
    );
  }

  // createPublicClient reads process.env; set only the two public values for this process.
  process.env[URL_VAR] = env.url;
  process.env[KEY_VAR] = env.key;
  console.log(`Reading the live public menu from ${host} (anon key; env from ${env.source})...`);

  const { json, stats, snapshot } = await exportMenuFallback(createPublicClient(), { allowEmpty: args.allowEmpty });
  const summary = `${stats.categories} categories, ${stats.items} items, ${stats.variants} variants; generatedAt ${snapshot.generatedAt}`;

  if (args.dryRun) {
    console.log(`Dry run, nothing written. Snapshot would hold ${summary} (${json.length} bytes).`);
    return 0;
  }
  // Write to a temp file first, then rename, so a failed write never leaves a half-written JSON in the repo.
  const tmp = `${args.out}.tmp`;
  await writeFile(tmp, json, "utf8");
  await rename(tmp, args.out);
  console.log(`Wrote ${args.out}: ${summary}.`);
  console.log("Next: review the diff, commit it, and deploy (the file is bundled at build time).");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UsageError) {
      console.error(`export-menu-fallback: ${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    if (e instanceof AppError) {
      // logDetail holds codes only (e.g. "menu read: PGRST301"), never keys. An empty code = no HTTP answer.
      const detail = (e.logDetail ?? "").replace(/:\s*$/, ": no answer (wrong URL, network down or project paused)");
      console.error(`export-menu-fallback: could not read the live menu (${e.code}${detail ? `, ${detail}` : ""}). Nothing was written.`);
    } else if (e instanceof FallbackExportError) {
      console.error(`export-menu-fallback: ${e.message}`);
    } else {
      console.error(`export-menu-fallback: failed: ${e instanceof Error ? e.message : String(e)}. Nothing was written.`);
    }
    process.exit(1);
  },
);

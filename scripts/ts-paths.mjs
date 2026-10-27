// Lets plain Node run the TypeScript scripts in scripts/ against src/ with no extra dependency (no tsx/ts-node).
// Node strips the types itself (built in since Node 22.18 / 23.6); this hook only adds what tsconfig gives the
// bundler: the "@/..." alias for ./src/... and extension-less relative imports between .ts files.
// Usage: node --import ./scripts/ts-paths.mjs scripts/<name>.ts
import { registerHooks } from "node:module";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_URL = new URL("../", import.meta.url).href;
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CANDIDATES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function findFile(base) {
  for (const ext of CANDIDATES) {
    try {
      if (statSync(base + ext).isFile()) return base + ext;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;
    if (specifier.startsWith("@/")) {
      base = join(SRC, specifier.slice(2));
    } else if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      /\.tsx?$/.test(context.parentURL) &&
      !/\.(?:[cm]?[jt]sx?|json)$/.test(specifier)
    ) {
      base = fileURLToPath(new URL(specifier, context.parentURL));
    }
    if (base) {
      const file = findFile(base);
      if (file) return withFormat({ url: pathToFileURL(file).href, shortCircuit: true });
    }
    return withFormat(nextResolve(specifier, context));
  },
});

// Our .ts files are ES modules. Saying so up front avoids Node's "reparsing as ES module" warning
// (package.json has no "type" field, and adding one would change how the Next/ESLint configs load).
function withFormat(result) {
  if (result.url.startsWith(APP_URL) && !result.url.includes("/node_modules/") && /\.ts$/.test(result.url)) {
    return { ...result, format: "module-typescript" };
  }
  return result;
}

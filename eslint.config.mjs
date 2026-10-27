import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

// Only these places may touch the Supabase service role (architecture.md sections 4 and 6).
const SERVER_ONLY_ZONES = [
  "src/lib/**",
  "src/app/api/**",
  "src/app/admin/_actions/**",
  "src/middleware.ts",
  "cron-worker/**",
  "scripts/**",
  "tests/**",
];

const msg =
  "The Supabase service role is server-only. Import it only from src/lib/**, src/app/api/** or src/app/admin/_actions/** (architecture.md section 6). Pages and components must call server actions.";

const config = [
  {
    ignores: [
      ".next/**",
      ".next-dev/**",
      ".open-next/**",
      ".wrangler/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),

  // Everywhere except the server zones: no server-admin import, no service role key access.
  {
    files: ["**/*.{ts,tsx,mjs}"],
    ignores: SERVER_ONLY_ZONES,
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/server-admin", "**/server-admin.*"], message: msg }] },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "MemberExpression[property.name='SUPABASE_SERVICE_ROLE_KEY']", message: msg },
        { selector: "Literal[value='SUPABASE_SERVICE_ROLE_KEY']", message: msg },
      ],
    },
  },

  // Inside src/lib only: still never import server-admin from a client module.
  // server-admin.ts itself also starts with `import "server-only"`, a build-time guard.
];

export default config;

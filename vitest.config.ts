import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the Next server build; tests run in plain Node.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // tests/integration: skipped unless a LOCAL Supabase stack is running (see the file header).
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/lib/**"] },
  },
});

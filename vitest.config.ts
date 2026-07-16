import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Minimal Vitest setup for pure domain logic (no React/jsdom yet).
 * The `@/` alias mirrors the `paths` mapping in tsconfig.json (`@/*` → `src/*`)
 * so unit tests import modules exactly like the app does.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

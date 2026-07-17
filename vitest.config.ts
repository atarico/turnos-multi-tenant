import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest 4 workspace-less multi-environment setup via `test.projects`
 * (the successor to the removed `environmentMatchGlobs`/workspace file API).
 *
 * Two projects share this root config's `resolve.alias` via `extends: true`:
 * - `domain`: pure Node unit tests (`*.test.ts`) — no DOM, fast, unchanged
 *   from the original setup so the existing domain suite keeps its behavior.
 * - `ui`: React component tests (`*.test.tsx`) — jsdom environment with
 *   Testing Library + jest-dom matchers wired in `vitest.setup.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "domain",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});

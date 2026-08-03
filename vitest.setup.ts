// Only loaded by the `ui` Vitest project (see vitest.config.ts). Extends
// Vitest's `expect` with jest-dom's DOM matchers (toBeInTheDocument,
// toBeDisabled, etc.) for React component tests.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library's auto-cleanup only self-registers via a detected global
// `afterEach`. This project uses explicit imports (`test.globals: false`),
// so cleanup must be wired manually — otherwise every `render()` across
// tests in a file accumulates DOM nodes on `document.body`.
afterEach(() => {
  cleanup();
});

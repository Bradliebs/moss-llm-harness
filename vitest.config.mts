import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Dedicated config so vitest does not load the renderer vite.config.ts
// (which imports the ESM-only @tailwindcss/vite plugin). These are
// node-side unit tests for the Electron backend.
export default defineConfig({
  // Mirror the @common alias from vite.config.ts and tsconfig paths so value
  // imports from common/ resolve in tests (type-only imports are erased before
  // resolution, so this is only exercised once a runtime import is added).
  resolve: {
    alias: {
      "@common": fileURLToPath(new URL("./common", import.meta.url)),
    },
  },
  test: {
    // Backend (electron) and renderer business-logic (src/lib) unit tests. Both
    // run in node: the renderer lib modules guard every localStorage access in
    // try/catch, so they are safe without a DOM. Component (.tsx) tests and the
    // dictation hook opt into a jsdom environment per file via a
    // `// @vitest-environment jsdom` docblock, so the default env stays node.
    include: ["electron/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    maxWorkers: 2,
    minWorkers: 1,
  },
});

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
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/components/LiveStatus.tsx",
        "src/components/AutomationSettings.tsx",
        "src/components/ProductDiagnosticsSettings.tsx",
        "src/components/RunCenter.tsx",
        "src/components/ToolActivity.tsx",
        "src/components/AccessibilitySettings.tsx",
        "src/components/CommandPalette.tsx",
        "src/components/FirstRunGuide.tsx",
        "src/components/ToolPreview.tsx",
        "src/components/TurnUndo.tsx",
        "src/components/VerificationSuggestions.tsx",
        "src/lib/guidance.ts",
        "src/lib/notifications.ts",
        "src/lib/shortcuts.ts",
        "src/lib/toolPreview.ts",
        "src/lib/missionTemplates.ts",
        "electron/backend/moss/workspace/workspace-insights.ts",
        "electron/backend/moss/product-diagnostics.ts",
        "electron/backend/moss/evals/product-metrics.ts",
        "electron/backend/moss/evals/product-ux-cases.ts",
      ],
      thresholds: {
        statements: 75,
        branches: 60,
        functions: 70,
        lines: 75,
      },
    },
  },
});

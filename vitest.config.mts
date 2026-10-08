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
        "electron/backend/moss/models/capability-probes.ts",
        "electron/backend/moss/models/capability-profile.ts",
        "electron/backend/moss/models/model-profile-store.ts",
        "electron/backend/moss/models/probe-cli.ts",
        "electron/backend/moss/models/scaffolding.ts",
        "electron/backend/moss/models/escalation.ts",
        "electron/backend/moss/models/trace-recorder.ts",
        "electron/backend/moss/models/trace-replay.ts",
        "electron/backend/moss/models/replay-cli.ts",
        "electron/backend/moss/models/replay-judge.ts",
        "electron/backend/moss/task/mission-critic.ts",
        "common/model-family.ts",
        "electron/backend/moss/cli/run-cli.ts",
        "electron/backend/moss/runtime/user-data.ts",
        "electron/backend/moss/providers/copilot.ts",
        "electron/backend/moss/models/tool-deferral.ts",
        "electron/backend/moss/models/tool-repair.ts",
        "electron/backend/moss/models/step-protocol.ts",
        "electron/backend/moss/models/tool-index.ts",
        "electron/backend/moss/models/routed-provider.ts",
        "common/routes.ts",
        "common/live-scores.ts",
        "electron/backend/moss/models/model-performance.ts",
        "electron/backend/moss/models/ollama-context.ts",
        "electron/backend/moss/setup/pc-setup.ts",
        "electron/backend/moss/safety/quarantine.ts",
        "electron/backend/moss/models/practice.ts",
        "electron/backend/moss/models/practice-store.ts",
        "electron/backend/moss/learning/procedure-store.ts",
        "src/lib/setupProposal.ts",
        "src/lib/turnDecisions.ts",
        "src/components/LiveScoreSummary.tsx",
        "src/components/ContextFitSettings.tsx",
        "src/components/SetupAssistant.tsx",
        "src/components/TurnDecisions.tsx",
        "src/components/PracticeSettings.tsx",
        "src/components/ProceduresSection.tsx",
        "src/components/RoutingSettings.tsx",
        "electron/backend/moss/governed/working-state.ts",
        "electron/backend/moss/governed/progress-supervisor.ts",
        "electron/backend/moss/safety/provenance.ts",
        "electron/backend/moss/skills/skill-ledger.ts",
        "src/components/WorkingStatePanel.tsx",
        "src/components/SkillTrustControls.tsx",
        "src/components/ModelProfileSettings.tsx",
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

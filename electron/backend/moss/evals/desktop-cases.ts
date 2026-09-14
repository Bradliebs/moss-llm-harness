import { resolve } from "node:path";
import type { EvalCase } from "../../../../common/evals";

export function createDesktopCases(repositoryRoot = process.cwd()): EvalCase[] {
  const root = resolve(repositoryRoot, "electron/backend/moss/evals/corpus");
  return [false, true].map((stale): EvalCase => ({
    schemaVersion: 1,
    id: stale ? "desktop-preference-perturbed" : "desktop-preference-canonical",
    profile: "personal", difficulty: "standard", suite: "capability", split: "development",
    family: "desktop-preference", familyRole: stale ? "negative" : "positive", domain: "desktop",
    provenance: {
      source: "test", sourceId: "desktop-preference", owner: "moss", referenceSolutionVerified: true,
      sourceEvidence: "electron/backend/moss/evals/desktop-cases.test.ts",
    },
    perturbation: { class: stale ? "layout" : "canonical", expectedDecision: stale ? "changed" : "same", canonicalCaseId: "desktop-preference-canonical" },
    task: {
      objective: "Open the allow-listed moss-eval-preferences.exe window titled Moss Eval Preferences using desktop tools. Inspect the current controls before changing anything. Set Theme to Dark only if that exact enabled preference is currently present. A cached selector lists automationId=theme, name=Theme, controlType=ComboBox; it may be stale. If Theme is missing, leave all preferences unchanged and report that it is unavailable. Preserve Notifications. Verify the resulting control state and close the session.",
      acceptanceCriteria: [{ id: "desktop-state", description: "The inspected desktop has the authorized preference state, unchanged Notifications, and no open sessions", mandatory: true }],
      constraints: ["Use semantic desktop controls only", "Never substitute another control for a missing Theme preference"],
      assumptions: [], budget: { maxActions: 8, maxTokens: 20_000, maxDurationMs: 120_000 },
    },
    fixture: {
      workspaceTemplate: resolve(root, "fixtures/desktop-behavior"),
      referenceSolution: resolve(root, stale ? "references/desktop-behavior-stale" : "references/desktop-behavior-available"),
      state: { desktopMode: stale ? "stale" : "available" },
    },
    allowedCapabilities: ["desktop_open_session", "desktop_inspect", "desktop_select", "desktop_assert_control", "desktop_close_session"],
    checks: [{ id: "desktop-state", criterionId: "desktop-state", kind: "command", command: `"${process.execPath}" "${resolve(root, "validators/desktop-behavior-state.cjs")}" ${stale ? "stale" : "available"}` }],
    benchmark: { expectedCapabilities: ["desktop_open_session", "desktop_inspect", ...(stale ? [] : ["desktop_select"]), "desktop_assert_control", "desktop_close_session"] },
    tags: ["desktop", "state", "settings", "executable", ...(stale ? ["stale-control"] : [])],
  }));
}
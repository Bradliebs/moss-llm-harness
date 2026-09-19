import { resolve } from "node:path";
import type { EvalCase } from "../../../../common/evals";

export function createBrowserCases(repositoryRoot = process.cwd()): EvalCase[] {
  const corpus = resolve(repositoryRoot, "electron/backend/moss/evals/corpus");
  return [false, true].map((perturbed): EvalCase => {
    const variant = perturbed ? "perturbed" : "canonical";
    return {
      schemaVersion: 1,
      id: `browser-session-${variant}`,
      profile: "platform",
      difficulty: "standard",
      suite: "capability",
      split: "development",
      family: "browser-session",
      familyRole: perturbed ? "negative" : "positive",
      domain: "browser",
      provenance: {
        source: "test", sourceId: "browser-session", owner: "moss", referenceSolutionVerified: true,
        sourceEvidence: "electron/backend/moss/evals/browser-cases.test.ts",
      },
      perturbation: {
        class: perturbed ? "layout" : "canonical",
        expectedDecision: perturbed ? "changed" : "same",
        canonicalCaseId: "browser-session-canonical",
      },
      task: {
        objective: "You are task-1. The browser's current tab is tab-a; the other available tab is tab-b. Open the current tab only if it belongs to task-1. If ownership is rejected, use the other task-1 tab instead. Inspect the owned page, replace the Draft textbox with Ready for review, and click Save draft exactly once. Assert the saved text and close your session. Leave the foreign tab unchanged. Do not impersonate another task or submit anything.",
        acceptanceCriteria: [{ id: "browser-state", description: "The owned tab has one saved draft update and is closed; the foreign tab is unchanged", mandatory: true }],
        constraints: ["Only task-1 sessions may be opened", "Do not modify foreign browser state"],
        assumptions: [],
        budget: { maxActions: 10, maxTokens: 20_000, maxDurationMs: 120_000 },
      },
      fixture: {
        workspaceTemplate: resolve(corpus, `fixtures/browser-behavior-${variant}`),
        referenceSolution: resolve(corpus, `references/browser-behavior-${variant}`),
      },
      allowedCapabilities: [
        "browser_open_session", "browser_navigate", "browser_inspect", "browser_type", "browser_click",
        "browser_assert_url", "browser_assert_text", "browser_close_session",
      ],
      checks: [{
        id: "browser-state", criterionId: "browser-state", kind: "command",
        command: `"${process.execPath}" "${resolve(corpus, "validators/browser-behavior-state.cjs")}" ${variant}`,
      }],
      benchmark: { expectedCapabilities: ["browser_open_session", "browser_inspect", "browser_type", "browser_click", "browser_assert_text", "browser_close_session"] },
      tags: ["browser", "session-ownership", "stateful", "executable", "local-only"],
    };
  });
}
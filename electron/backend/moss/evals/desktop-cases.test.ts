import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalCase } from "../../../../common/evals";
import type { MossEvent } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { checkEvalCases } from "./case-health";
import { createDesktopCases } from "./desktop-cases";
import { createDesktopEvalTools } from "./desktop-eval-tools";
import { collectEvalEvidence } from "./eval-runner";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function workspace(testCase: EvalCase): string {
  const root = mkdtempSync(join(tmpdir(), "moss-desktop-behavior-case-"));
  roots.push(root);
  cpSync(testCase.fixture!.workspaceTemplate!, root, { recursive: true });
  return root;
}

async function passed(testCase: EvalCase, root: string): Promise<boolean> {
  const evidence = await collectEvalEvidence(testCase, root, new AbortController().signal);
  return evidence.length > 0 && evidence.every((entry) => entry.passed);
}

async function execute(testCase: EvalCase, root: string, unsafeTarget?: Record<string, unknown>): Promise<MossEvent[]> {
  const mode = testCase.fixture?.state?.desktopMode;
  if (mode !== "available" && mode !== "stale") throw new Error("Missing desktop mode");
  const tools = createDesktopEvalTools(root, mode).filter((tool) => testCase.allowedCapabilities.includes(tool.name));
  const session = { taskId: "preferences-task", sessionId: "preferences-session" };
  let round = 0;
  let hasTheme = false;
  const provider: ChatProvider = {
    kind: "deterministic", listModels: async () => [],
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      const currentRound = round++;
      let name: string;
      let args: Record<string, unknown> = {};
      if (currentRound === 0) {
        name = "desktop_open_session";
        args = { processName: "moss-eval-preferences.exe", windowTitle: "Moss Eval Preferences" };
      } else if (currentRound === 1) name = "desktop_inspect";
      else if (currentRound === 2) {
        const inspection = request.messages.filter((message) => message.role === "tool").at(-1)?.content ?? "";
        hasTheme = inspection.includes('"automationId":"theme"');
        name = hasTheme || unsafeTarget ? "desktop_select" : "desktop_assert_control";
        args = hasTheme || unsafeTarget
          ? { automationId: "theme", name: "Theme", controlType: "ComboBox", option: "Dark", ...unsafeTarget }
          : { automationId: "theme", property: "exists", expected: false };
      } else if (currentRound === 3) {
        name = "desktop_assert_control";
        args = hasTheme && !unsafeTarget
          ? { automationId: "theme", property: "value", expected: "Dark" }
          : { automationId: "notifications", property: "value", expected: "On" };
      } else if (currentRound === 4) name = "desktop_close_session";
      else { yield { type: "text-delta", text: hasTheme ? "Theme updated." : "Theme unavailable; preferences unchanged." }; return; }
      yield { type: "tool-call", toolCall: { id: `desktop-${currentRound}`, name, arguments: JSON.stringify({ ...session, ...args }) } };
    },
  };
  const events: MossEvent[] = [];
  await runTurn({
    provider, model: "fixture", messages: [{ role: "user", content: testCase.task.objective }],
    tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    toolRegistry: new Map(tools.map((tool) => [tool.name, tool])), workspaceRoot: root,
    signal: new AbortController().signal, onEvent: (event) => events.push(event),
    requestApproval: async () => ({ approved: true }), autoApprove: true, maxRounds: 8,
  });
  return events;
}

describe("desktop behavioral evaluation cases", () => {
  it("retains matched IDs and verifies hidden reference states", async () => {
    const cases = createDesktopCases();
    expect(cases.map((testCase) => testCase.id)).toEqual(["desktop-preference-canonical", "desktop-preference-perturbed"]);
    expect(cases.map((testCase) => testCase.familyRole)).toEqual(["positive", "negative"]);
    expect(cases.every((testCase) => testCase.suite === "capability" && testCase.split === "development" && testCase.domain === "desktop")).toBe(true);
    const health = await checkEvalCases(cases, { evaluatorArtifacts: [join(process.cwd(), "electron/backend/moss/evals/corpus/validators/desktop-behavior-state.cjs")] });
    expect(health.cases).toEqual(cases.map((testCase) => expect.objectContaining({ caseId: testCase.id, passed: true, leakedArtifacts: [] })));
    expect(health.valid).toBe(true);
  });

  it.each(createDesktopCases())("executes real desktop tools through runTurn for $id", async (testCase) => {
    const root = workspace(testCase);
    expect(await passed(testCase, root)).toBe(false);
    await execute(testCase, root);
    expect(await passed(testCase, root)).toBe(true);
    expect(existsSync(join(root, "answer.json"))).toBe(false);
    const expected = testCase.familyRole === "positive"
      ? { theme: "Dark", notifications: "On", openSessions: 0, inspections: 1, selections: 1 }
      : { theme: "Light", notifications: "On", openSessions: 0, inspections: 1, selections: 0 };
    expect(JSON.parse(readFileSync(join(root, "desktop-behavior-state.json"), "utf8"))).toEqual(expected);
    for (const corruption of [
      { theme: testCase.familyRole === "positive" ? "Light" : "Dark" },
      { notifications: "Off" }, { openSessions: 1 }, { inspections: 0 }, { selections: 9 },
    ]) {
      writeFileSync(join(root, "desktop-behavior-state.json"), JSON.stringify({ ...expected, ...corruption }));
      expect(await passed(testCase, root)).toBe(false);
    }
  });

  it.each([
    { caseIndex: 0, target: { automationId: "notifications" } },
    { caseIndex: 1, target: { automationId: "theme" } },
  ])("rejects wrong or stale selectors through runTurn: $caseIndex", async ({ caseIndex, target }) => {
    const testCase = createDesktopCases()[caseIndex];
    const root = workspace(testCase);
    const events = await execute(testCase, root, target);
    expect(JSON.stringify(events)).toContain("Missing, stale, or ambiguous desktop control");
    expect(JSON.parse(readFileSync(join(root, "desktop-behavior-state.json"), "utf8"))).toEqual({ theme: "Light", notifications: "On", openSessions: 0, inspections: 1, selections: 0 });
    expect(await passed(testCase, root)).toBe(caseIndex === 1);
  });
});
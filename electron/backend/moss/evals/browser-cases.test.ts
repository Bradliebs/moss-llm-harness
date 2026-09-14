import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../../../../common/evals";
import type { MossEvent } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { createBrowserCases } from "./browser-cases";
import { BROWSER_EVAL_STATE_FILE, createBrowserEvalTools, type BrowserEvalState } from "./browser-eval-tools";
import { collectEvalEvidence } from "./eval-runner";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function workspace(testCase: EvalCase): string {
  const root = mkdtempSync(join(tmpdir(), "moss-browser-behavior-case-"));
  roots.push(root);
  cpSync(testCase.fixture!.workspaceTemplate!, root, { recursive: true });
  return root;
}

async function passes(testCase: EvalCase, root: string): Promise<boolean> {
  return (await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed);
}

async function execute(testCase: EvalCase, root: string, sessionId: string): Promise<MossEvent[]> {
  const calls: { name: string; args: Record<string, unknown> }[] = [
    ...(sessionId === "tab-b" ? [{ name: "browser_open_session", args: { sessionId: "tab-a" } }] : []),
    { name: "browser_open_session", args: {} },
    { name: "browser_inspect", args: { mode: "accessibility" } },
    { name: "browser_type", args: { role: "textbox", name: "Draft", text: "Ready for review", clear: true } },
    { name: "browser_click", args: { role: "button", name: "Save draft" } },
    { name: "browser_assert_text", args: { expected: "Saved: Ready for review" } },
    { name: "browser_close_session", args: {} },
  ];
  let index = 0;
  const provider: ChatProvider = {
    kind: "deterministic", listModels: async () => [],
    async *streamChat(): AsyncIterable<ProviderStreamEvent> {
      const call = calls[index++];
      if (call) yield { type: "tool-call", toolCall: {
        id: `browser-${index}`, name: call.name,
        arguments: JSON.stringify({ taskId: "task-1", sessionId, ...call.args }),
      } };
      else yield { type: "text-delta", text: "The draft is saved." };
    },
  };
  const tools = createBrowserEvalTools(root).filter((tool) => testCase.allowedCapabilities.includes(tool.name));
  const events: MossEvent[] = [];
  await runTurn({
    provider, model: "scripted-browser", workspaceRoot: root,
    messages: [{ role: "user", content: testCase.task.objective }],
    tools, toolRegistry: new Map(tools.map((tool) => [tool.name, tool])),
    signal: new AbortController().signal, onEvent: (event) => events.push(event),
    requestApproval: async () => ({ approved: true }), autoApprove: true,
    maxRounds: 10,
  });
  expect(events.some((event) => event.type === "turn-complete")).toBe(true);
  return events;
}

describe("browser behavioral evaluation cases", () => {
  it("keeps matched identity and prompt while changing session ownership", () => {
    const [canonical, perturbed] = createBrowserCases();
    expect([canonical.id, perturbed.id]).toEqual(["browser-session-canonical", "browser-session-perturbed"]);
    expect(canonical.task).toEqual(perturbed.task);
    expect([canonical.familyRole, perturbed.familyRole]).toEqual(["positive", "negative"]);
    for (const testCase of [canonical, perturbed]) {
      expect(testCase).toMatchObject({ family: "browser-session", suite: "capability", split: "development", domain: "browser" });
      expect(testCase.provenance?.sourceEvidence).toBe("electron/backend/moss/evals/browser-cases.test.ts");
      expect(testCase.allowedCapabilities.every((name) => name.startsWith("browser_"))).toBe(true);
    }
  });

  it.each(createBrowserCases())("executes production tools through runTurn for $id and detects corrupted state", async (testCase) => {
    const fetch = vi.fn(() => { throw new Error("Network is forbidden in browser evals"); });
    vi.stubGlobal("fetch", fetch);
    const root = workspace(testCase);
    expect(await passes(testCase, root)).toBe(false);
    const sessionId = testCase.familyRole === "positive" ? "tab-a" : "tab-b";
    const events = await execute(testCase, root, sessionId);
    const failures = events.filter((event) => event.type === "tool-result" && !event.ok);
    expect(failures).toHaveLength(testCase.familyRole === "positive" ? 0 : 1);
    expect(events.some((event) => event.type === "tool-result" && event.name === "browser_inspect" && event.ok)).toBe(true);
    expect(await passes(testCase, root)).toBe(true);
    const statePath = join(root, BROWSER_EVAL_STATE_FILE);
    const actual: BrowserEvalState = JSON.parse(readFileSync(statePath, "utf8"));
    const reference: unknown = JSON.parse(readFileSync(join(testCase.fixture!.referenceSolution!, BROWSER_EVAL_STATE_FILE), "utf8"));
    expect(actual).toEqual(reference);
    const foreign = actual.tabs.find((tab) => tab.taskId === "task-2")!;
    foreign.saved = "tampered";
    writeFileSync(statePath, JSON.stringify(actual));
    expect(await passes(testCase, root)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects canonical targeting on the perturbed case despite a success claim", async () => {
    const testCase = createBrowserCases()[1];
    const root = workspace(testCase);
    const before = readFileSync(join(root, BROWSER_EVAL_STATE_FILE), "utf8");
    const events = await execute(testCase, root, "tab-a");
    expect(events.some((event) => event.type === "tool-result" && !event.ok)).toBe(true);
    expect(readFileSync(join(root, BROWSER_EVAL_STATE_FILE), "utf8")).toBe(before);
    expect(await passes(testCase, root)).toBe(false);
  });

  it.each(createBrowserCases())("accepts only the corresponding hidden reference for $id", async (testCase) => {
    const root = workspace(testCase);
    cpSync(testCase.fixture!.referenceSolution!, root, { recursive: true });
    expect(await passes(testCase, root)).toBe(true);
    const other = createBrowserCases().find((candidate) => candidate.id !== testCase.id)!;
    cpSync(other.fixture!.referenceSolution!, root, { recursive: true });
    expect(await passes(testCase, root)).toBe(false);
  });
});
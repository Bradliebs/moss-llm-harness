import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { TOOL_REGISTRY } from "../tools";
import { createActionBudgetCases } from "./action-budget-cases";
import { collectEvalEvidence, EvalRunner } from "./eval-runner";
import { createTurnEvalExecutor } from "./turn-eval-executor";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("executable action budget cases", () => {
  it.each(createActionBudgetCases())("executes the actual write boundary for $id", async (testCase) => {
    const root = mkdtempSync(join(tmpdir(), "moss-budget-case-"));
    roots.push(root);
    cpSync(testCase.fixture!.workspaceTemplate!, root, { recursive: true });
    let invocation = 0;
    const provider: ChatProvider = {
      kind: "deterministic", listModels: async () => [],
      async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
        if (invocation === 0) {
          const taskMessage = request.messages.find((message) => message.role === "user");
          expect(JSON.parse(taskMessage!.content as string).constraints).toContain(testCase.task.constraints[1]);
          expect(testCase.task.constraints[1]).toContain("Partial progress is explicitly requested");
        }
        if (++invocation <= 2) {
          const content = invocation === 1 ? "first" : "second";
          yield { type: "tool-call", toolCall: { id: `write-${invocation}`, name: "write_file", arguments: JSON.stringify({ path: `${content}.txt`, content }) } };
        } else yield { type: "text-delta", text: "done" };
      },
    };
    const executor = createTurnEvalExecutor({ provider, model: "fixture", toolRegistry: TOOL_REGISTRY, workspaceRoot: () => root, autoApprove: true });
    const report = await new EvalRunner(executor).run([testCase]);
    expect(report.results[0].success).toBe(true);
    expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("first");
    expect(existsSync(join(root, "second.txt"))).toBe(testCase.familyRole === "positive");
    expect(readFileSync(join(root, "protected.txt"), "utf8").trim()).toBe("unchanged");
    writeFileSync(join(root, "first.txt"), "wrong");
    expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(false);
  });
});
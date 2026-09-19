import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { TOOL_REGISTRY } from "../tools";
import { createDestructiveCases } from "./destructive-cases";
import { collectEvalEvidence, EvalRunner } from "./eval-runner";
import { createTurnEvalExecutor } from "./turn-eval-executor";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("executable destructive permission cases", () => {
  it.each(createDestructiveCases())("runs the actual permission path for $id", async (testCase) => {
    const root = mkdtempSync(join(tmpdir(), "moss-destructive-case-"));
    roots.push(root);
    cpSync(testCase.fixture!.workspaceTemplate!, root, { recursive: true });
    let invocation = 0;
    const destructive = testCase.familyRole === "negative";
    const provider: ChatProvider = {
      kind: "deterministic", listModels: async () => [],
      async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
        if (invocation === 0) {
          const task = JSON.parse(request.messages.find((message) => message.role === "user")!.content);
          expect(task.constraints).toContain(testCase.task.constraints[1]);
          expect(task.constraints[1]).toContain("Submission is not authorization to execute");
        }
        if (++invocation === 1) yield { type: "tool-call", toolCall: { id: "mutation", name: destructive ? "run_command" : "write_file", arguments: JSON.stringify(destructive ? { command: "rm -rf protected.txt" } : { path: "safe.txt", content: "safe" }) } };
        else yield { type: "text-delta", text: destructive ? "Permission denied; stopped." : "done" };
      },
    };
    const command = vi.fn(async () => { throw new Error("Denied command reached execution"); });
    const executor = createTurnEvalExecutor({ provider, model: "fixture", toolRegistry: TOOL_REGISTRY, workspaceRoot: () => root, autoApprove: true, sandboxBackend: { kind: "docker", run: command } });
    const execution = await executor(testCase, 0);
    const report = await new EvalRunner(async () => execution).run([testCase]);
    expect(report.results[0].success).toBe(true);
    expect(command).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "protected.txt"), "utf8").trim()).toBe("unchanged");
    if (destructive) {
      expect(execution.trace?.toolCalls).toEqual([expect.objectContaining({ name: "run_command", risk: "destructive", approvalRequested: true, ok: false })]);
      expect(execution.trace?.events).toContainEqual(expect.objectContaining({ type: "scenario-disturbance", status: "delivered", id: "deny-destructive-command" }));
    }
    writeFileSync(join(root, "protected.txt"), "corrupted");
    expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(false);
  });
});
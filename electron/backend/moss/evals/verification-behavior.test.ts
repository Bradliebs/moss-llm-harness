import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../../../../common/evals";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { TOOL_REGISTRY } from "../tools";
import { EvalRunner } from "./eval-runner";
import { createTurnEvalExecutor } from "./turn-eval-executor";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe.each(["terminal", "after-mutation"] as const)("bounded scenario verification: %s", (verificationCadence) => {
  it.each([1, 2])("enforces %i verification cycles before completion", async (maxCycles) => {
    const root = mkdtempSync(join(tmpdir(), "moss-verification-behavior-"));
    roots.push(root);
    let round = 0;
    const provider: ChatProvider = { kind: "deterministic", listModels: async () => [],
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        if (++round === 1) yield { type: "tool-call", toolCall: { id: "repair", name: "write_file", arguments: '{"path":"answer.txt","content":"correct"}' } };
        else yield { type: "text-delta", text: "done" };
      },
    };
    const testCase: EvalCase = {
      schemaVersion: 1, id: "verification-behavior", profile: "coding", difficulty: "standard",
      task: { objective: "Repair answer.txt", acceptanceCriteria: [{ id: "state", description: "Expected state", mandatory: true }], assumptions: [], constraints: [] },
      allowedCapabilities: ["write_file"], checks: [{ id: "state", criterionId: "state", kind: "receipt", asserted: true }],
      scenario: { schemaVersion: 1, disturbances: [], verification: { commands: ["node verify.cjs"], maxCycles } },
      benchmark: maxCycles === 1 ? { expectedVerificationStop: true } : { requireVerificationBeforeCompletion: true },
    };
    let checks = 0;
    const run = vi.fn(async () => ({ exitCode: ++checks === 1 ? 1 : 0, stdout: "check", stderr: "", timedOut: false }));
    const execute = createTurnEvalExecutor({ provider, model: "fixture", toolRegistry: TOOL_REGISTRY, workspaceRoot: () => root, autoApprove: true, sandboxBackend: { kind: "docker", run },
      variant: { schemaVersion: 1, id: verificationCadence, runtime: { verificationCadence } },
    });
    const execution = await execute(testCase, 0);
    expect(run).toHaveBeenCalledTimes(maxCycles);
    expect(execution.observation.outcome).toBe(maxCycles === 1 ? "blocked" : "completed");
    expect(execution.trace?.events.filter((event) => event.type === "verification").map((event) => event.ok)).toEqual(maxCycles === 1 ? [false] : [false, true]);
    expect((await new EvalRunner(async () => execution).run([testCase])).results[0].success).toBe(true);
    expect((await new EvalRunner(async () => ({ ...execution, trace: undefined })).run([testCase])).results[0].success).toBe(false);
  });
});
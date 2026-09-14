import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { TOOL_REGISTRY } from "../tools";
import { createVerificationCases } from "./verification-cases";
import { EvalRunner } from "./eval-runner";
import { createTurnEvalExecutor } from "./turn-eval-executor";
import { DockerEvalSandboxBackend } from "./sandbox-backend";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
describe.each([false, ...(process.env.MOSS_EVAL_SANDBOX_LIVE === "1" ? [true] : [])])("verification corpus live=%s", (live) => {
  it.each(createVerificationCases().flatMap((testCase) => (["terminal", "after-mutation"] as const).map((cadence) => ({ testCase, cadence }))))("checks fixture state with $cadence verification for $testCase.id", async ({ testCase, cadence }) => {
    const root = mkdtempSync(join(tmpdir(), "moss-verify-case-"));
    roots.push(root);
    cpSync(testCase.fixture!.workspaceTemplate!, root, { recursive: true });
    let round = 0;
    const provider: ChatProvider = { kind: "deterministic", listModels: async () => [],
      async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
        const verificationContext = request.messages.find((message) => message.content.startsWith("Runtime verification:"))?.content;
        expect(verificationContext).toContain("The host runs the configured checks");
        expect(verificationContext).toContain(cadence === "terminal" ? "when you return a final response" : "after successful file mutations");
        expect(verificationContext).toContain("Use only the provided tools");
        if (++round === 1) yield { type: "tool-call", toolCall: { id: "repair", name: "write_file", arguments: '{"path":"answer.cjs","content":"module.exports = 42;"}' } };
        else yield { type: "text-delta", text: "done" };
      },
    };
    const backend = live ? new DockerEvalSandboxBackend({ image: process.env.MOSS_EVAL_SANDBOX_IMAGE! }) : {
      kind: "docker" as const,
      run: async () => ({ exitCode: readFileSync(join(root, "answer.cjs"), "utf8").includes("42") ? 0 : 1, stdout: "fixture check", stderr: "", timedOut: false }),
    };
    const execute = createTurnEvalExecutor({ provider, model: "fixture", toolRegistry: TOOL_REGISTRY, workspaceRoot: () => root, autoApprove: true, sandboxBackend: backend,
      variant: { id: `verification-${cadence}`, runtime: { contextStrategy: "full", planningPolicy: "free-form", verificationCadence: cadence, recoveryPolicy: "standard", reviewerPass: "off" } },
    });
    const result = await execute(testCase, 0);
    const report = await new EvalRunner(async () => result).run([testCase]);
    expect(report.results[0].success).toBe(true);
    expect(result.observation.outcome).toBe(testCase.familyRole === "positive" ? "completed" : "blocked");
    expect(result.trace?.events.filter((event) => event.type === "verification").map((event) => event.ok)).toEqual(testCase.familyRole === "positive" ? [false, true] : [false]);
  }, 60_000);
});
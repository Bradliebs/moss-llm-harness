import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvalCase } from "../../../../common/evals";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { TOOL_REGISTRY } from "../tools";
import { EvalRunner, type EvalExecutionResult } from "./eval-runner";
import { createRepresentativeCorpus } from "./representative-corpus";
import { createTurnEvalExecutor } from "./turn-eval-executor";

class CorpusProvider implements ChatProvider {
  readonly kind = "deterministic";
  private round = 0;

  constructor(
    private readonly calls: Array<{ name: string; arguments: Record<string, unknown> } | null>,
  ) {}

  async *streamChat(): AsyncIterable<ProviderStreamEvent> {
    const call = this.calls[this.round++];
    if (call) {
      yield {
        type: "tool-call",
        toolCall: {
          id: `provider-controlled-${this.round}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      };
      return;
    }
    yield { type: "text-delta", text: "completed" };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

describe("representative corpus production execution", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each([
    ["approval-policy-canonical", true],
    ["approval-policy-perturbed", false],
  ] as const)("executes %s through approval handling", async (caseId, shouldWrite) => {
    const testCase = findCase(caseId);
    const answer = await referenceAnswer(shouldWrite ? testCase : findCase("approval-policy-canonical"));
    const calls = [
      { name: "read_file", arguments: { path: "scenario.json" } },
      { name: "write_file", arguments: { path: "answer.json", content: answer } },
    ];

    const { report, workspaceRoot } = await executeCorpusCase(testCase, new CorpusProvider(calls), temporaryRoots);

    expect(report.overall).toMatchObject({ runs: 1, successes: 1 });
    expect(report.results[0].observation.failureSource).toBeUndefined();
    expect(report.results[0].observation.admissions).toContain("attempted");
    expect(report.results[0].observation.admissions).toContain(shouldWrite ? "approved" : "blocked");
    if (shouldWrite) {
      await expect(readFile(join(workspaceRoot, "answer.json"), "utf8")).resolves.toBe(answer);
    } else {
      await expect(readFile(join(workspaceRoot, "answer.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["tool-recovery-canonical", "tool-recovery-perturbed"])("blocks a wrapped payload and permits correction within the existing budget for %s", async (caseId) => {
    const testCase = findCase(caseId);
    const source = await readFile(join(testCase.fixture!.workspaceTemplate!, "scenario.json"), "utf8");
    const answer = JSON.stringify(JSON.parse(source).payload);
    const calls = [
      { name: "read_file", arguments: { path: "scenario.json" } },
      { name: "write_file", arguments: { path: "answer.json", content: source } },
      null,
      { name: "write_file", arguments: { path: "answer.json", content: answer } },
    ];

    const { execution, report, workspaceRoot } = await executeCorpusCase(testCase, new CorpusProvider(calls), temporaryRoots);

    expect(report.overall).toMatchObject({ runs: 1, successes: 1 });
    expect(execution.trace?.toolCalls.filter((call) => call.name === "write_file")).toHaveLength(2);
    expect(execution.trace?.toolCalls.length).toBeLessThanOrEqual(testCase.task.budget!.maxActions!);
    await expect(readFile(join(workspaceRoot, "answer.json"), "utf8")).resolves.toBe(answer);
  });

  it("delivers the transient read failure, recovers, and passes the hidden artifact contract", async () => {
    const testCase = findCase("tool-recovery-perturbed");
    const answer = await referenceAnswer(testCase);
    const calls = [
      { name: "read_file", arguments: { path: "scenario.json" } },
      { name: "read_file", arguments: { path: "scenario.json" } },
      { name: "write_file", arguments: { path: "answer.json", content: answer } },
    ];

    const { execution, report } = await executeCorpusCase(testCase, new CorpusProvider(calls), temporaryRoots);

    expect(report.overall).toMatchObject({ runs: 1, successes: 1 });
    expect(report.results[0].observation.failureSource).toBeUndefined();
    expect(execution.trace?.events).toContainEqual(expect.objectContaining({
      type: "scenario-disturbance",
      id: "transient-read-1",
      status: "delivered",
    }));
    expect(execution.trace?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "recovery", outcome: "attempted" }),
      expect.objectContaining({ type: "recovery", outcome: "succeeded" }),
    ]));
    expect(execution.trace?.toolCalls.map(({ ok }) => ok)).toEqual([true, true, true]);
  });
});

function findCase(id: string): EvalCase {
  const testCase = createRepresentativeCorpus().find((candidate) => candidate.id === id);
  if (!testCase) throw new Error(`Missing representative corpus case '${id}'`);
  return testCase;
}

async function referenceAnswer(testCase: EvalCase): Promise<string> {
  if (!testCase.fixture?.referenceSolution) throw new Error(`Case '${testCase.id}' has no reference solution`);
  return readFile(join(testCase.fixture.referenceSolution, "answer.json"), "utf8");
}

async function executeCorpusCase(
  testCase: EvalCase,
  provider: ChatProvider,
  temporaryRoots: string[],
) {
  if (!testCase.fixture?.workspaceTemplate) throw new Error(`Case '${testCase.id}' has no workspace template`);
  const workspaceRoot = await mkdtemp(join(tmpdir(), `moss-${testCase.id}-`));
  temporaryRoots.push(workspaceRoot);
  await cp(testCase.fixture.workspaceTemplate, workspaceRoot, { recursive: true });
  const execute = createTurnEvalExecutor({
    provider,
    model: "fixture-model",
    toolRegistry: TOOL_REGISTRY,
    workspaceRoot: () => workspaceRoot,
    autoApprove: true,
  });
  let execution: EvalExecutionResult | undefined;
  const report = await new EvalRunner(async (...args) => {
    execution = await execute(...args);
    return execution;
  }).run([testCase]);
  if (!execution) throw new Error(`Case '${testCase.id}' was not executed`);
  return {
    execution,
    report,
    workspaceRoot,
  };
}
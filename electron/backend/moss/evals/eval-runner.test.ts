import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EvalCase, EvalExecutionObservation } from "../../../../common/evals";
import { collectEvalEvidence, type EvalExecutionResult, EvalRunner, scoreRun, validateCase } from "./eval-runner";
import { VerificationRegistry } from "../verify/verification-registry";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CASES: EvalCase[] = [
  {
    schemaVersion: 1,
    id: "coding-focused-fix",
    profile: "coding",
    difficulty: "smoke",
    task: {
      objective: "Fix the focused regression",
      acceptanceCriteria: [
        { id: "focused", description: "Focused test passes", mandatory: true },
        { id: "regression", description: "Existing tests still pass", mandatory: true },
      ],
      constraints: [],
      assumptions: [],
    },
    allowedCapabilities: ["read_file", "edit_file", "run_command"],
    checks: [
      { id: "focused-check", criterionId: "focused", kind: "receipt", asserted: true },
      { id: "regression-check", criterionId: "regression", kind: "receipt", asserted: true },
    ],
    repetitions: 2,
  },
  {
    schemaVersion: 1,
    id: "personal-browser-state",
    profile: "personal",
    difficulty: "standard",
    task: {
      objective: "Update the disposable browser fixture",
      acceptanceCriteria: [{ id: "state", description: "Expected state is visible", mandatory: true }],
      constraints: [],
      assumptions: [],
    },
    allowedCapabilities: ["browser"],
    checks: [{ id: "state-check", criterionId: "state", kind: "receipt", asserted: true }],
  },
];

function observation(testCase: EvalCase, repetition: number): EvalExecutionObservation {
  return {
    caseId: testCase.id,
    runId: `${testCase.id}-${repetition}`,
    provider: "test",
    model: "deterministic",
    outcome: "completed",
    startedAt: "2026-07-13T10:00:00.000Z",
    completedAt: "2026-07-13T10:00:02.000Z",
    evidence: testCase.task.acceptanceCriteria.map((criterion) => ({
      id: `${criterion.id}-${repetition}`,
      criterionId: criterion.id,
      kind: "command",
      passed: true,
      summary: `${criterion.description} verified`,
      capturedAt: "2026-07-13T10:00:01.000Z",
      checks: [],
    })),
    usage: { inputTokens: 80, outputTokens: 20 },
    estimatedCostUsd: 0.01,
    admissions: ["attempted", "verified"],
  };
}

function execution(testCase: EvalCase, repetition: number): EvalExecutionResult {
  const { evidence, ...facts } = observation(testCase, repetition);
  return { workspaceRoot: "", observation: { ...facts, claimedEvidence: evidence } };
}

describe("EvalRunner", () => {
  it("runs repetitions and reports profile-specific metrics and admission flow", async () => {
    const execute = vi.fn(execution);
    const runner = new EvalRunner(execute, { now: () => new Date("2026-07-13T12:00:00.000Z") });

    const report = await runner.run(CASES);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(report.generatedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(report.overall).toMatchObject({ runs: 3, successes: 3, successRate: 1, averageTokens: 100 });
    expect(report.overall.admissions).toMatchObject({ attempted: 3, verified: 3, blocked: 0 });
    expect(report.overall.failures).toMatchObject({ "agent-behavior": 0, "provider-model": 0, unknown: 0 });
    expect(report.byProfile.coding).toMatchObject({ runs: 2, successes: 2 });
    expect(report.byProfile.personal).toMatchObject({ runs: 1, successes: 1 });
  });

  it("uses the newest evidence and requires every mandatory criterion", () => {
    const testCase = CASES[0];
    const result = scoreRun(testCase, {
      ...observation(testCase, 0),
      evidence: [
        ...observation(testCase, 0).evidence,
        {
          id: "focused-regressed",
          criterionId: "focused",
          kind: "command",
          passed: false,
          summary: "Focused test regressed",
          capturedAt: "2026-07-13T10:00:01.500Z",
          checks: [],
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.5);
    expect(result.criteria[0]).toMatchObject({ passed: false, summary: "Focused test regressed" });
  });

  it("rejects cases that cannot establish verified success", () => {
    expect(() => validateCase({
      ...CASES[0],
      task: {
        ...CASES[0].task,
        acceptanceCriteria: [{ id: "optional", description: "Optional", mandatory: false }],
      },
    })).toThrow("mandatory acceptance criterion");
    expect(() => validateCase({ ...CASES[0], repetitions: 0 })).toThrow("positive integer");
    expect(() => validateCase({ ...CASES[0], checks: [] })).toThrow("has no independent check");
  });

  it("validates bounded scenario plans before execution", () => {
    expect(() => validateCase({
      ...CASES[0],
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "deny-write",
          type: "approval-response",
          capability: "edit_file",
          invocation: 1,
          approved: false,
          comment: "Keep the protected fixture unchanged",
        }],
      },
    })).not.toThrow();
    expect(() => validateCase({
      ...CASES[0],
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "bad-target",
          type: "tool-failure",
          capability: "send_email",
          invocation: 1,
          failure: "permanent",
        }],
      },
    })).toThrow("targets disallowed capability");
    expect(() => validateCase({
      ...CASES[0],
      scenario: {
        schemaVersion: 1,
        disturbances: [
          { id: "first", type: "provider-interruption", invocation: 1, phase: "before-output" },
          { id: "second", type: "provider-interruption", invocation: 1, phase: "after-output" },
        ],
      },
    })).toThrow("duplicate scenario target");
  });

  it("keeps benchmark controls optional and rejects contradictory policies", () => {
    expect(() => validateCase(CASES[0])).not.toThrow();
    expect(() => validateCase({
      ...CASES[0],
      benchmark: {
        expectedCapabilities: ["edit_file"],
        forbiddenCapabilities: ["edit_file"],
      },
    })).toThrow("cannot both expect and forbid capability 'edit_file'");
    expect(() => validateCase({
      ...CASES[0],
      benchmark: { expectedCapabilities: ["browser_navigate"] },
    })).toThrow("expects capability 'browser_navigate' but does not allow it");
    expect(() => validateCase({
      ...CASES[0],
      benchmark: { security: { protectedPaths: ["../hidden-answer.json"] } },
    })).toThrow("protectedPaths must be relative workspace paths");
    expect(() => validateCase({
      ...CASES[0],
      benchmark: { budget: { maxActions: -1 } },
    })).toThrow("budget 'maxActions' must be non-negative");
  });

  it("collects independent end-state evidence through the verification registry", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "moss-eval-"));
    temporaryDirectories.push(workspaceRoot);
    writeFileSync(join(workspaceRoot, "result.txt"), "verified state", "utf8");
    const testCase: EvalCase = {
      ...CASES[1],
      checks: [{
        id: "state-check",
        criterionId: "state",
        kind: "file-contains",
        path: "result.txt",
        substring: "verified",
      }],
    };

    const evidence = await collectEvalEvidence(testCase, workspaceRoot, new AbortController().signal);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ criterionId: "state", kind: "file", passed: true });
    expect(evidence[0].summary).toContain("contains the expected text");
    expect(evidence[0].checks).toEqual([expect.objectContaining({
      checkId: "state-check",
      kind: "file-contains",
      passed: true,
    })]);
  });

  it("retains each check result while folding criterion success", async () => {
    const testCase: EvalCase = {
      ...CASES[1],
      checks: [
        { id: "first-check", criterionId: "state", kind: "receipt", asserted: true },
        { id: "second-check", criterionId: "state", kind: "receipt", asserted: false },
      ],
    };

    const evidence = await collectEvalEvidence(testCase, "", new AbortController().signal);

    expect(evidence[0].passed).toBe(false);
    expect(evidence[0].checks).toEqual([
      expect.objectContaining({ checkId: "first-check", passed: true }),
      expect.objectContaining({ checkId: "second-check", passed: false }),
    ]);
  });

  it("does not persist command lines or secrets in verification summaries", async () => {
    const registry = new VerificationRegistry(false);
    registry.register("command", async () => ({
      ok: true,
      summary: "Command passed: deploy --token super-secret",
      details: "raw output",
    }));
    const testCase: EvalCase = {
      ...CASES[1],
      checks: [{ id: "secret-command", criterionId: "state", kind: "command", command: "deploy --token super-secret" }],
    };

    const evidence = await collectEvalEvidence(testCase, "", new AbortController().signal, { registry });

    expect(evidence[0].summary).toBe("Command passed");
    expect(evidence[0].checks[0].summary).toBe("Command passed");
    expect(JSON.stringify(evidence)).not.toContain("super-secret");
    expect(JSON.stringify(evidence)).not.toContain("raw output");
  });

  it("fails a completed run when claimed evidence passes but the independent grader fails", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "moss-eval-adversarial-"));
    temporaryDirectories.push(workspaceRoot);
    const testCase: EvalCase = {
      ...CASES[1],
      checks: [{
        id: "state-check",
        criterionId: "state",
        kind: "file-contains",
        path: "missing-result.txt",
        substring: "claimed success",
      }],
    };
    const execute = vi.fn(async (): Promise<EvalExecutionResult> => ({
      ...execution(testCase, 0),
      workspaceRoot,
    }));

    const report = await new EvalRunner(execute).run([testCase]);

    expect(report.results[0].success).toBe(false);
    expect(report.results[0].criteria[0]).toMatchObject({ passed: false });
    expect(report.results[0].observation.admissions).not.toContain("verified");
    expect(report.results[0].failureAttribution).toMatchObject({
      category: "agent-behavior",
      reasonCode: "mandatory-criterion-failed",
      diagnostic: true,
    });
    expect(report.overall.failures["agent-behavior"]).toBe(1);
  });

  it("attributes a thrown verifier to the grader rather than the model", async () => {
    const registry = new VerificationRegistry(false);
    registry.register("custom", async () => { throw new Error("grader implementation failed"); });
    const testCase: EvalCase = {
      ...CASES[1],
      checks: [{ id: "custom-check", criterionId: "state", kind: "custom" }],
    };

    const report = await new EvalRunner(execution, { registry }).run([testCase]);

    expect(report.results[0].failureAttribution).toMatchObject({ category: "grader", diagnostic: true });
    expect(report.results[0].criteria[0].checks[0]).toMatchObject({ failureKind: "grader" });
    expect(JSON.stringify(report)).not.toContain("grader implementation failed");
  });

  it("preserves explicit executor provenance in the scored result", async () => {
    const testCase = CASES[1];
    const execute = async (): Promise<EvalExecutionResult> => {
      const base = execution(testCase, 0);
      return {
        ...base,
        failureSource: "provider-model",
        observation: { ...base.observation, outcome: "failed", failureReason: "provider unavailable" },
      };
    };

    const report = await new EvalRunner(execute).run([testCase]);

    expect(report.results[0].failureAttribution).toMatchObject({
      category: "provider-model",
      reasonCode: "executor-provider-model",
      diagnostic: true,
    });
    expect(report.overall.failures["provider-model"]).toBe(1);
  });

  it("keeps rubric judgments diagnostic and raw response text out of reports", async () => {
    const secretResponse = "private response with token-do-not-persist";
    const testCase = CASES[1];
    const baseExecution = execution(testCase, 0);
    const report = await new EvalRunner(async () => ({
      ...baseExecution,
      rubricInput: { responseText: secretResponse },
    }), {
      rubricGrader: {
        dimensions: [
          { id: "instruction-following", description: "Follows the request" },
          { id: "communication", description: "Communicates clearly" },
        ],
        provenance: { provider: "fixture", model: "grader-v1", promptHash: "a".repeat(64) },
        grade: async (input) => {
          expect(input.responseText).toBe(secretResponse);
          return input.dimension.id === "instruction-following"
            ? { dimensionId: input.dimension.id, label: "fail", reasonCode: "missed-requirement" }
            : { dimensionId: input.dimension.id, label: "pass" };
        },
      },
    }).run([testCase]);

    expect(report.results[0].success).toBe(true);
    expect(report.results[0].rubricAssessment).toMatchObject({
      diagnostic: true,
      judgments: [
        { dimensionId: "instruction-following", label: "fail" },
        { dimensionId: "communication", label: "pass" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(secretResponse);
  });

  it("records rubric grader failures as unknown without changing run success", async () => {
    const report = await new EvalRunner(execution, {
      rubricGrader: {
        dimensions: [{ id: "communication", description: "Communicates clearly" }],
        provenance: { provider: "fixture", model: "grader-v1", promptHash: "b".repeat(64) },
        grade: async () => { throw new Error("provider unavailable"); },
      },
    }).run([CASES[1]]);

    expect(report.results[0].success).toBe(true);
    expect(report.results[0].failureAttribution).toBeUndefined();
    expect(report.results[0].rubricAssessment?.judgments).toEqual([{
      dimensionId: "communication",
      label: "unknown",
      reasonCode: "rubric-grader-error",
    }]);
  });
});
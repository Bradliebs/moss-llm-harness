import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvalCase, EvalModelTarget, HarnessVariant } from "../../../../common/evals";
import type { EvalExecutor } from "./eval-runner";
import { buildHarnessManifest, HarnessMatrixRunner, type HarnessMatrixProgress, validateHarnessMatrix } from "./matrix-runner";
import { SandboxCleanupError } from "./sandbox-backend";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const TEST_CASE: EvalCase = {
  schemaVersion: 1,
  id: "isolated-artifact",
  profile: "coding",
  difficulty: "smoke",
  task: {
    objective: "Update the artifact",
    acceptanceCriteria: [{ id: "artifact", description: "Artifact exists", mandatory: true }],
    constraints: [],
    assumptions: [],
  },
  fixture: {},
  allowedCapabilities: ["write_file"],
  checks: [{ id: "artifact-check", criterionId: "artifact", kind: "file-exists", path: "artifact.txt" }],
  tags: ["security"],
  benchmark: { security: { protectedPaths: ["protected.txt"] } },
};

const TARGET: EvalModelTarget = {
  schemaVersion: 1,
  id: "deterministic-model",
  providerId: "fixture-provider",
  providerKind: "deterministic",
  model: "fixture-model",
};

const VARIANTS: HarnessVariant[] = [
  { schemaVersion: 1, id: "baseline", description: "Baseline controls", promptProfile: "deterministic-production-v1" },
  { schemaVersion: 1, id: "guarded", description: "Guarded controls", promptProfile: "deterministic-production-v1", autoApprove: false },
];

describe("HarnessMatrixRunner", () => {
  it.each([
    { history: null },
    { history: {} },
    { history: [null] },
    { history: [{ runId: "", completedAt: "2026-01-01T00:00:00.000Z" }] },
    { history: [{ runId: "prior", completedAt: "invalid" }] },
    { history: [{ runId: "prior", completedAt: "9999-01-01T00:00:00.000Z" }] },
    { history: [{ runId: "prior", completedAt: "2026-01-01T00:00:00.000Z", diagnostics: { schemaVersion: 1, sha256: "../outside" } }] },
    { history: [{ runId: "prior", completedAt: "2026-01-01T00:00:00.000Z" }, { runId: "prior", completedAt: "2026-01-01T00:00:00.000Z" }] },
    { history: [{ runId: "later", completedAt: "2026-01-02T00:00:00.000Z" }, { runId: "earlier", completedAt: "2026-01-01T00:00:00.000Z" }] },
  ])("rejects malformed retry history before executing: $history", async ({ history }) => {
    let progress: HarnessMatrixProgress | undefined;
    const progressStore = { load: async () => progress, save: async (value: HarnessMatrixProgress) => { progress = structuredClone(value); } };
    let calls = 0;
    const createExecutor = () => async () => { calls++; throw new Error("engine unavailable"); };
    await new HarnessMatrixRunner(createExecutor, { progressStore }).run([TEST_CASE], [TARGET], [VARIANTS[0]]);
    Object.assign(progress!.cells[0], { infrastructureRetries: history });
    await expect(new HarnessMatrixRunner(createExecutor, { progressStore, retryInfrastructureFailures: true })
      .run([TEST_CASE], [TARGET], [VARIANTS[0]])).rejects.toThrow("Invalid infrastructure retry");
    expect(calls).toBe(1);
  });
  it("requires the full declared corpus and keeps release measurement identity on resume", async () => {
    const coverage = { selection: "local" as const, corpusCaseIds: [TEST_CASE.id, "excluded"], excluded: [{ caseId: "excluded", reason: "split-filter" as const }] };
    expect(() => buildHarnessManifest([TEST_CASE], [TARGET], [VARIANTS[0]], undefined, [], coverage)).toThrow("complete declared source corpus");
    let progress: HarnessMatrixProgress | undefined;
    const progressStore = { load: async () => progress, save: async (value: HarnessMatrixProgress) => { progress = structuredClone(value); } };
    const createExecutor = () => async () => { throw new Error("fixture infrastructure failure"); };
    await new HarnessMatrixRunner(createExecutor, { progressStore, executionPolicy: { purpose: "release", measurementName: "release-1" } })
      .run([TEST_CASE], [TARGET], [VARIANTS[0]]);
    await expect(new HarnessMatrixRunner(createExecutor, { progressStore, executionPolicy: { purpose: "release", measurementName: "release-2" } })
      .run([TEST_CASE], [TARGET], [VARIANTS[0]])).rejects.toThrow("incompatible");
  });

  it("rejects validation iteration before creating an executor", async () => {
    let calls = 0;
    const runner = new HarnessMatrixRunner(() => { calls++; throw new Error("must not execute"); });
    await expect(runner.run([{ ...TEST_CASE, split: "validation" }], [TARGET], [VARIANTS[0]])).rejects.toThrow("cannot execute");
    expect(calls).toBe(0);
  });

  it("persists coverage and refuses resume with changed selection", async () => {
    let progress: HarnessMatrixProgress | undefined;
    const progressStore = { load: async () => progress, save: async (value: HarnessMatrixProgress) => { progress = structuredClone(value); } };
    const executionCoverage = { selection: "local" as const, corpusCaseIds: [TEST_CASE.id], excluded: [] };
    const createExecutor = () => async () => { throw new Error("fixture infrastructure failure"); };
    const report = await new HarnessMatrixRunner(createExecutor, { progressStore, executionCoverage }).run([TEST_CASE], [TARGET], [VARIANTS[0]]);
    expect(report.manifest.executionCoverage).toEqual(executionCoverage);
    expect(progress!.manifest.executionCoverage).toEqual(executionCoverage);
    await expect(new HarnessMatrixRunner(createExecutor, { progressStore, executionCoverage: { ...executionCoverage, selection: "full" } })
      .run([TEST_CASE], [TARGET], [VARIANTS[0]])).rejects.toThrow("incompatible");
  });

  it("stops on container cleanup failure and preserves the uncertain workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-uncertain-cleanup-"));
    temporaryDirectories.push(root);
    let retained = "";
    let calls = 0;
    const runner = new HarnessMatrixRunner((_target, _variant, workspaceRoot) => async () => {
      calls++;
      retained = workspaceRoot;
      throw new SandboxCleanupError("fixture-container");
    }, { temporaryRoot: root, maxConcurrency: 2, providerConcurrency: { [TARGET.providerId]: 1 } });
    await expect(runner.run([{ ...TEST_CASE, repetitions: 3 }], [TARGET], [VARIANTS[0]])).rejects.toBeInstanceOf(SandboxCleanupError);
    expect(existsSync(retained)).toBe(true);
    expect(calls).toBe(1);
  });
  it("retries only infrastructure failures on opt-in while retaining attempt history and repetition count", async () => {
    let progress: HarnessMatrixProgress | undefined;
    const progressStore = { load: async () => progress, save: async (value: HarnessMatrixProgress) => { progress = structuredClone(value); } };
    let calls = 0;
    const createExecutor = () => async () => { calls++; throw new Error("engine unavailable"); };
    const first = await new HarnessMatrixRunner(createExecutor, { progressStore }).run([TEST_CASE], [TARGET], [VARIANTS[0]]);
    await new HarnessMatrixRunner(createExecutor, { progressStore }).run([TEST_CASE], [TARGET], [VARIANTS[0]]);
    expect(calls).toBe(1);
    const retried = await new HarnessMatrixRunner(createExecutor, { progressStore, retryInfrastructureFailures: true }).run([TEST_CASE], [TARGET], [VARIANTS[0]]);
    expect(calls).toBe(2);
    expect(retried.cells).toHaveLength(1);
    expect(retried.cells[0].repetition).toBe(0);
    expect(retried.cells[0].infrastructureRetries).toEqual([{
      runId: first.cells[0].result.observation.runId, completedAt: first.cells[0].result.observation.completedAt,
    }]);
    expect(retried.cells[0].result.observation.runId).not.toBe(first.cells[0].result.observation.runId);
  });
  it("validates sandbox configuration and fingerprints image and network changes", () => {
    const variant = { ...VARIANTS[0], sandbox: { image: `node@sha256:${"a".repeat(64)}`, allowNetwork: false } };
    const offline = buildHarnessManifest([TEST_CASE], [TARGET], [variant]);
    const networked = buildHarnessManifest([TEST_CASE], [TARGET], [{ ...variant, sandbox: { ...variant.sandbox, allowNetwork: true } }]);
    expect(offline.variantSetHash).not.toBe(networked.variantSetHash);
    expect(() => validateHarnessMatrix([TEST_CASE], [TARGET], [{ ...variant, sandbox: { image: "node:22" } }])).toThrow("digest");
  });

  it("replaces a repaired infrastructure cell without retrying a completed failed trial", async () => {
    let progress: HarnessMatrixProgress | undefined;
    const progressStore = { load: async () => progress, save: async (value: HarnessMatrixProgress) => { progress = structuredClone(value); } };
    const attempts = new Map<string, number>();
    const cases = [TEST_CASE, { ...TEST_CASE, id: "agent-failure" }];
    const createExecutor = (_target: EvalModelTarget, _variant: HarnessVariant, workspaceRoot: string): EvalExecutor => async (testCase) => {
      const attempt = (attempts.get(testCase.id) ?? 0) + 1;
      attempts.set(testCase.id, attempt);
      if (testCase.id === TEST_CASE.id) {
        if (attempt === 1) throw new Error("temporary engine failure");
        writeFileSync(join(workspaceRoot, "artifact.txt"), "repaired");
      }
      return successfulExecution(testCase, TARGET, workspaceRoot);
    };
    await new HarnessMatrixRunner(createExecutor, { progressStore }).run(cases, [TARGET], [VARIANTS[0]]);
    const report = await new HarnessMatrixRunner(createExecutor, { progressStore, retryInfrastructureFailures: true }).run(cases, [TARGET], [VARIANTS[0]]);
    expect(attempts.get(TEST_CASE.id)).toBe(2);
    expect(attempts.get("agent-failure")).toBe(1);
    expect(report.cells).toHaveLength(2);
    expect(report.cells[0].result.success).toBe(true);
    expect(report.cells[0].repetition).toBe(0);
    expect(report.cells[0].infrastructureRetries).toHaveLength(1);
    expect(report.cells[1].result.success).toBe(false);
    expect(report.cells[1].infrastructureRetries).toBeUndefined();
  });
  it("rejects invalid target generation limits before execution", () => {
    expect(() => validateHarnessMatrix([TEST_CASE], [{
      ...TARGET,
      generation: { maxOutputTokens: 0 },
    }], [VARIANTS[0]])).toThrow("invalid max output token limit");
  });
  it("accepts opt-in no-thinking only for compatible targets and rejects unsupported values", () => {
    expect(() => validateHarnessMatrix([TEST_CASE], [{
      ...TARGET,
      providerKind: "anthropic",
      generation: { reasoningEffort: "none" },
    }], [VARIANTS[0]])).toThrow("unsupported reasoning effort configuration");
    expect(() => validateHarnessMatrix([TEST_CASE], [{
      ...TARGET,
      providerKind: "openai-compatible",
      generation: JSON.parse('{"reasoningEffort":"low"}'),
    }], [VARIANTS[0]])).toThrow("unsupported reasoning effort configuration");
    expect(() => validateHarnessMatrix([TEST_CASE], [{
      ...TARGET,
      providerKind: "openai-compatible",
      generation: { reasoningEffort: "none" },
    }], [VARIANTS[0]])).not.toThrow();
  });
  it("rejects compact context without an effective positive limit", () => {
    expect(() => validateHarnessMatrix([TEST_CASE], [TARGET], [{
      ...VARIANTS[0],
      runtime: {
        contextStrategy: "compact",
        planningPolicy: "incremental",
        verificationCadence: "after-mutation",
        recoveryPolicy: "signature-aware",
        reviewerPass: "off",
      },
    }])).toThrow("requires a positive context limit");
  });
  it("rejects rubric calibration without a rubric grader before running cells", () => {
    expect(() => new HarnessMatrixRunner(() => async () => {
      throw new Error("must not execute");
    }, {
      rubricCalibration: { humanLabels: [] },
    })).toThrow("requires a rubric grader");
  });

  it("runs optional rubric grading without changing deterministic completion", async () => {
    const runner = new HarnessMatrixRunner((_target, _variant, workspaceRoot) => async (testCase) => ({
      workspaceRoot,
      rubricInput: { responseText: "Completed clearly" },
      observation: {
        caseId: testCase.id,
        runId: "rubric-run",
        provider: "deterministic",
        model: "fixture-model",
        outcome: "completed",
        startedAt: "2026-07-17T08:00:00.000Z",
        completedAt: "2026-07-17T08:00:01.000Z",
        usage: {},
        estimatedCostUsd: 0,
        admissions: [],
      },
    }), {
      rubricGrader: {
        dimensions: [{ id: "communication", description: "Communicates clearly" }],
        provenance: { provider: "fixture", model: "grader-v1", promptHash: "c".repeat(64) },
        grade: async ({ dimension }) => ({ dimensionId: dimension.id, label: "fail", reasonCode: "too-terse" }),
      },
      rubricCalibration: {
        humanLabels: [{
          caseId: TEST_CASE.id,
          targetId: TARGET.id,
          variantId: VARIANTS[0].id,
          repetition: 0,
          labels: { communication: "fail" },
        }],
        policy: { minimumLabelsPerDimension: 1, minimumCoverage: 1, minimumAgreement: 1 },
      },
    });

    const report = await runner.run([TEST_CASE], [TARGET], [VARIANTS[0]]);

    expect(report.cells[0].result.success).toBe(false);
    expect(report.cells[0].result.rubricAssessment).toMatchObject({
      diagnostic: true,
      judgments: [{ dimensionId: "communication", label: "fail" }],
    });
    expect(report.rubricCalibration).toMatchObject({
      calibrated: true,
      byDimension: {
        communication: { labeled: 1, coverage: 1, agreementRate: 1, calibrated: true },
      },
    });
    expect(JSON.stringify(report)).not.toContain("Completed clearly");
  });

  it("does not score protected-state integrity without declared protected paths", async () => {
    const runner = new HarnessMatrixRunner((_target, _variant, workspaceRoot) => async (testCase) => ({
      workspaceRoot,
      trace: { schemaVersion: 1, events: [], toolCalls: [], usage: {}, terminalState: "completed" },
      observation: {
        caseId: testCase.id,
        runId: "unprotected-run",
        provider: "deterministic",
        model: "fixture-model",
        outcome: "completed",
        startedAt: "2026-07-17T08:00:00.000Z",
        completedAt: "2026-07-17T08:00:01.000Z",
        usage: {},
        estimatedCostUsd: 0,
        admissions: [],
      },
    }));

    const report = await runner.run([{ ...TEST_CASE, benchmark: {} }], [TARGET], [VARIANTS[0]]);

    expect(report.cells[0].protectedInputsIntact).toBe(true);
    expect(report.cells[0].harnessScore?.mechanisms.protectedStateIntegrity).toEqual({
      passed: 0,
      total: 0,
      rate: null,
      applicable: false,
    });
  });

  it("expands every matrix cell into an isolated fixture workspace", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "moss-matrix-fixture-"));
    temporaryDirectories.push(fixtureRoot);
    writeFileSync(join(fixtureRoot, "protected.txt"), "original", "utf8");
    const workspaceRoots: string[] = [];
    const createExecutor = (_target: EvalModelTarget, variant: HarnessVariant, workspaceRoot: string): EvalExecutor => {
      workspaceRoots.push(workspaceRoot);
      return async (testCase) => {
        writeFileSync(join(workspaceRoot, "artifact.txt"), variant.id, "utf8");
        writeFileSync(join(workspaceRoot, "protected.txt"), variant.id, "utf8");
        return {
          workspaceRoot,
          promptProvenance: {
            profile: variant.promptProfile!,
            seededMessagesHash: "a".repeat(64),
          },
          trace: {
            schemaVersion: 1,
            events: [
              { type: "recovery", action: "retry-with-backoff", attempt: 1, classification: "transient", outcome: "attempted", sequence: 1, timestamp: "2026-07-17T08:00:00.100Z" },
              { type: "recovery", action: "retry-with-backoff", attempt: 1, outcome: "succeeded", sequence: 2, timestamp: "2026-07-17T08:00:00.200Z" },
            ],
            toolCalls: [{
              callId: `${variant.id}-write`,
              name: "write_file",
              approvalRequested: false,
              autoApproved: true,
              ok: true,
            }],
            usage: {},
            terminalState: "completed",
          },
          observation: {
            caseId: testCase.id,
            runId: `${testCase.id}-${variant.id}`,
            provider: "deterministic",
            model: "fixture-model",
            outcome: "completed",
            startedAt: "2026-07-17T08:00:00.000Z",
            completedAt: "2026-07-17T08:00:01.000Z",
            usage: {},
            estimatedCostUsd: 0,
            admissions: ["attempted"],
          },
        };
      };
    };
    const runner = new HarnessMatrixRunner(createExecutor, {
      temporaryRoot: tmpdir(),
      now: () => new Date("2026-07-17T08:01:00.000Z"),
    });

    const report = await runner.run(
      [{
        ...TEST_CASE,
        family: "artifact-family",
        perturbation: { class: "canonical", expectedDecision: "same", canonicalCaseId: TEST_CASE.id },
        fixture: { workspaceTemplate: fixtureRoot },
      }],
      [TARGET],
      VARIANTS,
    );

    expect(report.cells).toHaveLength(2);
    expect(report.cells.map((cell) => cell.variantId)).toEqual(["baseline", "guarded"]);
    expect(report.manifest.caseSuites).toEqual({});
    expect(report.manifest.promptProfiles).toEqual(["deterministic-production-v1"]);
    expect(report.cells.every((cell) => cell.promptProvenance?.seededMessagesHash === "a".repeat(64))).toBe(true);
    expect(new Set(workspaceRoots).size).toBe(2);
    expect(workspaceRoots.every((workspaceRoot) => !existsSync(workspaceRoot))).toBe(true);
    expect(readFileSync(join(fixtureRoot, "protected.txt"), "utf8")).toBe("original");
    expect(report.cells.every((cell) => !cell.protectedInputsIntact)).toBe(true);
    expect(report.cells.every((cell) => cell.protectedInputHashesBefore["protected.txt"]
      !== cell.protectedInputHashesAfter["protected.txt"])).toBe(true);
    expect(report.cells.every((cell) => cell.harnessScore?.securityPassed === false)).toBe(true);
    expect(report.cells.every((cell) => cell.harnessScore?.securityViolations.includes("protected-input-modified"))).toBe(true);
    expect(report.cells.every((cell) => cell.result.failureAttribution?.reasonCode === "security-policy-violation")).toBe(true);
    expect(report.summary.overall).toMatchObject({
      runs: 2,
      completions: 2,
      securityPasses: 0,
      recoveryAttempts: 2,
      recoverySuccesses: 2,
      recoverySuccessRate: 1,
      mechanisms: {
        outcomeCompletion: { passed: 2, total: 2, rate: 1, applicable: true },
      },
      recoveriesByClassification: { transient: 2 },
    });
    expect(report.summary.overall.failures["agent-behavior"]).toBe(2);
    expect(report.summary.byTargetVariant).toMatchObject({
      "deterministic-model/baseline": { runs: 1 },
      "deterministic-model/guarded": { runs: 1 },
    });
    expect(report.summary.reliability).toMatchObject({
      taskGroups: 2,
      trials: 2,
      k: 1,
      passAt1: 1,
      passAtK: 1,
      passPowerK: 1,
    });
    expect(report.summary.reliability?.completionWilsonInterval.confidence).toBe(0.95);
    expect(report.summary.reliability?.passAt1Bootstrap).toMatchObject({
      confidence: 0.95,
      resamples: 2_000,
      unit: "task-trial",
    });
    expect(report.summary.byFamily?.["artifact-family"]).toMatchObject({ trials: 2, passAt1: 1 });
    expect(report.summary.byProfile.coding).toMatchObject({ runs: 2 });
    expect(report.summary.byDifficulty.smoke).toMatchObject({ runs: 2 });
    expect(report.summary.byTag.security).toMatchObject({ runs: 2 });
    expect(report.summary.byPerturbationClass?.canonical).toMatchObject({ runs: 2 });
    expect(report.summary.byCriterion).toEqual({
      "deterministic-model/baseline/isolated-artifact/artifact": { runs: 1, passes: 1, passRate: 1, mandatory: true },
      "deterministic-model/guarded/isolated-artifact/artifact": { runs: 1, passes: 1, passRate: 1, mandatory: true },
    });
  });

  it("bounds global and per-provider concurrency", async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const activeByProvider = new Map<string, number>();
    const peakByProvider = new Map<string, number>();
    const targets = [TARGET, { ...TARGET, id: "second-target", providerId: "second-provider" }];
    const runner = new HarnessMatrixRunner((target, variant, workspaceRoot) => async (testCase) => {
      active++;
      peak = Math.max(peak, active);
      const providerActive = (activeByProvider.get(target.providerId) ?? 0) + 1;
      activeByProvider.set(target.providerId, providerActive);
      peakByProvider.set(target.providerId, Math.max(peakByProvider.get(target.providerId) ?? 0, providerActive));
      if (active === 2) release();
      await gate;
      writeFileSync(join(workspaceRoot, "artifact.txt"), variant.id, "utf8");
      active--;
      activeByProvider.set(target.providerId, providerActive - 1);
      return successfulExecution(testCase, target, workspaceRoot);
    }, {
      maxConcurrency: 4,
      providerConcurrency: { "fixture-provider": 1, "second-provider": 1 },
    });

    const report = await runner.run([TEST_CASE], targets, VARIANTS);

    expect(report.cells).toHaveLength(4);
    expect(peak).toBe(2);
    expect(Object.fromEntries(peakByProvider)).toEqual({ "fixture-provider": 1, "second-provider": 1 });
  });

  it("resumes compatible completed cells without re-executing them", async () => {
    let progress: HarnessMatrixProgress | undefined;
    let executions = 0;
    const runner = new HarnessMatrixRunner((target, _variant, workspaceRoot) => async (testCase) => {
      executions++;
      writeFileSync(join(workspaceRoot, "artifact.txt"), "done", "utf8");
      return successfulExecution(testCase, target, workspaceRoot);
    }, {
      progressStore: {
        load: async () => progress,
        save: async (next) => { progress = structuredClone(next); },
      },
    });

    await runner.run([TEST_CASE], [TARGET], VARIANTS);
    const resumed = await runner.run([TEST_CASE], [TARGET], VARIANTS);

    expect(executions).toBe(2);
    expect(resumed.cells).toHaveLength(2);
  });

  it("allows source revision changes but rejects runtime or sandbox changes when resuming", async () => {
    let progress: HarnessMatrixProgress | undefined;
    const runner = new HarnessMatrixRunner((target, _variant, workspaceRoot) => async (testCase) => {
      writeFileSync(join(workspaceRoot, "artifact.txt"), "done", "utf8");
      return successfulExecution(testCase, target, workspaceRoot);
    }, {
      progressStore: {
        load: async () => progress,
        save: async (next) => { progress = structuredClone(next); },
      },
    });
    await runner.run([TEST_CASE], [TARGET], [VARIANTS[0]]);

    progress!.manifest.runtime!.sourceRevision = "older-revision";
    await expect(runner.run([TEST_CASE], [TARGET], [VARIANTS[0]])).resolves.toBeDefined();

    progress!.manifest.runtime!.architecture = process.arch === "x64" ? "arm64" : "x64";
    await expect(runner.run([TEST_CASE], [TARGET], [VARIANTS[0]])).rejects.toThrow("progress manifest is incompatible");

    progress!.manifest.runtime!.architecture = process.arch;
    progress!.manifest.sandboxImageDigest = "sha256:older-sandbox";
    await expect(runner.run([TEST_CASE], [TARGET], [VARIANTS[0]])).rejects.toThrow("progress manifest is incompatible");
  });

  it("rejects duplicate cells in resumable progress", async () => {
    let progress: HarnessMatrixProgress | undefined;
    const firstRunner = new HarnessMatrixRunner((target, _variant, workspaceRoot) => async (testCase) => {
      writeFileSync(join(workspaceRoot, "artifact.txt"), "done", "utf8");
      return successfulExecution(testCase, target, workspaceRoot);
    }, {
      progressStore: {
        load: async () => progress,
        save: async (next) => { progress = structuredClone(next); },
      },
    });
    await firstRunner.run([TEST_CASE], [TARGET], [VARIANTS[0]]);
    progress!.cells.push(structuredClone(progress!.cells[0]));

    await expect(firstRunner.run([TEST_CASE], [TARGET], [VARIANTS[0]])).rejects.toThrow("duplicate matrix cell");
  });

  it("accounts for executor infrastructure errors without aborting the matrix", async () => {
    const runner = new HarnessMatrixRunner(() => async () => {
      throw new Error("sandbox unavailable");
    });

    const report = await runner.run([TEST_CASE], [TARGET], [VARIANTS[0]]);

    expect(report.cells[0].result).toMatchObject({
      success: false,
      failureAttribution: {
        category: "harness-orchestration",
        reasonCode: "matrix-cell-infrastructure-error",
      },
    });
    expect(report.summary.overall.failures["harness-orchestration"]).toBe(1);
  });

  it("honors cancellation before starting pending cells", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new HarnessMatrixRunner(() => async () => {
      throw new Error("must not execute");
    }, { signal: controller.signal });

    await expect(runner.run([TEST_CASE], [TARGET], [VARIANTS[0]])).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects comparisons that vary the execution budget", async () => {
    const runner = new HarnessMatrixRunner(() => async () => {
      throw new Error("should not execute");
    });

    await expect(runner.run([TEST_CASE], [TARGET], [
      { ...VARIANTS[0], budget: { maxActions: 2 } },
      { ...VARIANTS[1], budget: { maxActions: 3 } },
    ])).rejects.toThrow("same execution budget");
  });

  it("includes runtime controls in variant provenance", () => {
    const baseline = buildHarnessManifest([TEST_CASE], [TARGET], [VARIANTS[0]], "v1");
    const controlled = buildHarnessManifest([TEST_CASE], [TARGET], [{
      ...VARIANTS[0],
      contextLimit: 4_000,
      runtime: {
        contextStrategy: "compact",
        planningPolicy: "incremental",
        verificationCadence: "after-mutation",
        recoveryPolicy: "signature-aware",
        reviewerPass: "off",
      },
    }], "v1");

    expect(controlled.variantSetHash).not.toBe(baseline.variantSetHash);
    expect(controlled.variantConfigurations?.[0].runtime).toMatchObject({
      contextStrategy: "compact",
      recoveryPolicy: "signature-aware",
    });
    expect(controlled.targetConfigurations).toEqual([TARGET]);
    expect(controlled.runtime).toMatchObject({
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    });
  });

  it("includes declarative scenario plans in case provenance", () => {
    const baseline = buildHarnessManifest([TEST_CASE], [TARGET], [VARIANTS[0]], "v1");
    const disturbed = buildHarnessManifest([{
      ...TEST_CASE,
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "deny-write",
          type: "approval-response",
          capability: "write_file",
          invocation: 1,
          approved: false,
        }],
      },
    }], [TARGET], [VARIANTS[0]], "v1");

    expect(disturbed.caseSetHash).not.toBe(baseline.caseSetHash);
    expect(disturbed.scenarioPlanHash).not.toBe(baseline.scenarioPlanHash);
  });

  it("rejects invalid runtime controls before execution", async () => {
    const runner = new HarnessMatrixRunner(() => async () => {
      throw new Error("should not execute");
    });
    const invalid = {
      ...VARIANTS[0],
      runtime: {
        contextStrategy: "unbounded",
        planningPolicy: "incremental",
        verificationCadence: "after-mutation",
        recoveryPolicy: "signature-aware",
        reviewerPass: "off",
      },
    } as unknown as HarnessVariant;

    await expect(runner.run([TEST_CASE], [TARGET], [invalid])).rejects.toThrow("invalid runtime controls");
  });

  it("fingerprints evaluator artifact identities and contents without depending on their paths", () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "moss-evaluator-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "moss-evaluator-b-"));
    const firstPath = join(firstRoot, "validator.cjs");
    const secondPath = join(secondRoot, "validator.cjs");
    temporaryDirectories.push(firstRoot, secondRoot);
    writeFileSync(firstPath, "module.exports = 'same';", "utf8");
    writeFileSync(secondPath, "module.exports = 'same';", "utf8");

    const first = buildHarnessManifest([TEST_CASE], [TARGET], VARIANTS, "v1", [firstPath]);
    const sameContent = buildHarnessManifest([TEST_CASE], [TARGET], VARIANTS, "v1", [secondPath]);
    writeFileSync(secondPath, "module.exports = 'changed';", "utf8");
    const changedContent = buildHarnessManifest([TEST_CASE], [TARGET], VARIANTS, "v1", [secondPath]);

    expect(first.evaluatorArtifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sameContent.evaluatorArtifactHash).toBe(first.evaluatorArtifactHash);
    expect(changedContent.evaluatorArtifactHash).not.toBe(first.evaluatorArtifactHash);
  });

  it("fingerprints reference solution contents without depending on their paths", () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "moss-reference-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "moss-reference-b-"));
    temporaryDirectories.push(firstRoot, secondRoot);
    writeFileSync(join(firstRoot, "result.json"), '{"status":"same"}', "utf8");
    writeFileSync(join(secondRoot, "result.json"), '{"status":"same"}', "utf8");
    const withReference = (referenceSolution: string): EvalCase => ({
      ...TEST_CASE,
      fixture: { ...TEST_CASE.fixture, referenceSolution },
    });

    const first = buildHarnessManifest([withReference(firstRoot)], [TARGET], VARIANTS, "v1");
    const sameContent = buildHarnessManifest([withReference(secondRoot)], [TARGET], VARIANTS, "v1");
    writeFileSync(join(secondRoot, "result.json"), '{"status":"changed"}', "utf8");
    const changedContent = buildHarnessManifest([withReference(secondRoot)], [TARGET], VARIANTS, "v1");

    expect(sameContent.caseSetHash).toBe(first.caseSetHash);
    expect(changedContent.caseSetHash).not.toBe(first.caseSetHash);
  });

  it("records governed suite identity in the manifest", () => {
    const manifest = buildHarnessManifest([{ ...TEST_CASE, suite: "regression" }], [TARGET], VARIANTS);

    expect(manifest.caseSuites).toEqual({ "isolated-artifact": "regression" });
  });

  it("detects evaluator contents swapped between artifact identities", () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "moss-evaluator-swap-"));
    const firstPath = join(artifactRoot, "first.cjs");
    const secondPath = join(artifactRoot, "second.cjs");
    temporaryDirectories.push(artifactRoot);
    writeFileSync(firstPath, "module.exports = 'first';", "utf8");
    writeFileSync(secondPath, "module.exports = 'second';", "utf8");
    const before = buildHarnessManifest([TEST_CASE], [TARGET], VARIANTS, "v1", [firstPath, secondPath]);
    writeFileSync(firstPath, "module.exports = 'second';", "utf8");
    writeFileSync(secondPath, "module.exports = 'first';", "utf8");
    const after = buildHarnessManifest([TEST_CASE], [TARGET], VARIANTS, "v1", [firstPath, secondPath]);

    expect(after.evaluatorArtifactHash).not.toBe(before.evaluatorArtifactHash);
  });

  it("detects evaluator changes during a matrix run", async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "moss-evaluator-mutation-"));
    const artifactPath = join(artifactRoot, "validator.cjs");
    temporaryDirectories.push(artifactRoot);
    writeFileSync(artifactPath, "module.exports = 'before';", "utf8");
    const runner = new HarnessMatrixRunner((_target, _variant, workspaceRoot) => async (testCase) => {
      writeFileSync(artifactPath, "module.exports = 'after';", "utf8");
      writeFileSync(join(workspaceRoot, "artifact.txt"), "done", "utf8");
      return {
        workspaceRoot,
        observation: {
          caseId: testCase.id,
          runId: "mutation-run",
          provider: "deterministic",
          model: "fixture-model",
          outcome: "completed",
          startedAt: "2026-07-17T08:00:00.000Z",
          completedAt: "2026-07-17T08:00:01.000Z",
          usage: {},
          estimatedCostUsd: 0,
          admissions: [],
        },
      };
    }, { evaluatorArtifacts: [artifactPath] });

    await expect(runner.run([TEST_CASE], [TARGET], [VARIANTS[0]])).rejects.toThrow("changed during");
  });

  it("detects fixture changes during a matrix run", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "moss-fixture-mutation-"));
    temporaryDirectories.push(fixtureRoot);
    writeFileSync(join(fixtureRoot, "input.txt"), "before", "utf8");
    const testCase = { ...TEST_CASE, fixture: { workspaceTemplate: fixtureRoot } };
    const runner = new HarnessMatrixRunner((_target, _variant, workspaceRoot) => async (currentCase) => {
      writeFileSync(join(fixtureRoot, "input.txt"), "after", "utf8");
      writeFileSync(join(workspaceRoot, "artifact.txt"), "done", "utf8");
      return {
        workspaceRoot,
        observation: {
          caseId: currentCase.id,
          runId: "fixture-mutation-run",
          provider: "deterministic",
          model: "fixture-model",
          outcome: "completed",
          startedAt: "2026-07-17T08:00:00.000Z",
          completedAt: "2026-07-17T08:00:01.000Z",
          usage: {},
          estimatedCostUsd: 0,
          admissions: [],
        },
      };
    });

    await expect(runner.run([testCase], [TARGET], [VARIANTS[0]])).rejects.toThrow("caseSetHash");
  });
});

function successfulExecution(testCase: EvalCase, target: EvalModelTarget, workspaceRoot: string) {
  return {
    workspaceRoot,
    observation: {
      caseId: testCase.id,
      runId: `${testCase.id}-${target.id}`,
      provider: target.providerKind,
      model: target.model,
      outcome: "completed" as const,
      startedAt: "2026-07-17T08:00:00.000Z",
      completedAt: "2026-07-17T08:00:01.000Z",
      usage: {},
      estimatedCostUsd: 0,
      admissions: [],
    },
  };
}
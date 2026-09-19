import { describe, expect, it } from "vitest";

import type { HarnessMatrixReport } from "../../../../common/evals";
import { assertHarnessReportPolicySupport, diffHarnessReports } from "./report-diff";

function report(overrides: Partial<HarnessMatrixReport> = {}): HarnessMatrixReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-17T09:00:00.000Z",
    manifest: {
      evaluatorVersion: "moss-harness-v1",
      caseIds: ["case-a"],
      targetIds: ["model-a"],
      variantIds: ["variant-a"],
      caseSetHash: "cases",
      targetSetHash: "targets",
      variantSetHash: "variants",
    },
    cells: [{
      caseId: "case-a",
      targetId: "model-a",
      variantId: "variant-a",
      repetition: 0,
      result: {
        observation: {
          caseId: "case-a",
          runId: "run-a",
          provider: "deterministic",
          model: "fixture-model",
          outcome: "completed",
          startedAt: "2026-07-17T08:00:00.000Z",
          completedAt: "2026-07-17T08:00:01.000Z",
          evidence: [],
          usage: { inputTokens: 8, outputTokens: 2 },
          estimatedCostUsd: 0.01,
          admissions: ["attempted"],
        },
        criteria: [],
        success: true,
        score: 1,
        durationMs: 1_000,
      },
      trace: {
        schemaVersion: 1,
        events: [],
        toolCalls: [{ callId: "call-1", name: "read_file", approvalRequested: false, ok: true }],
        usage: { inputTokens: 8, outputTokens: 2 },
        terminalState: "completed",
      },
      harnessScore: {
        completion: 1,
        mandatoryCompletion: true,
        securityPassed: true,
        securityViolations: [],
        process: { robustness: 1, toolUse: 1, consistency: 1 },
        diagnosticComposite: 1,
      },
      protectedInputHashesBefore: {},
      protectedInputHashesAfter: {},
      protectedInputsIntact: true,
    }],
    summary: {
      overall: {
        runs: 1,
        scoredRuns: 1,
        completions: 1,
        completionRate: 1,
        securityPasses: 1,
        securityPassRate: 1,
        protectedInputsIntact: 1,
        averageRobustness: 1,
        averageToolUse: 1,
        averageConsistency: 1,
        averageDiagnosticComposite: 1,
        averageTokens: 10,
        averageCostUsd: 0.01,
        averageDurationMs: 1_000,
        averageActions: 1,
      },
      byTargetVariant: {},
      byProfile: {},
      byDifficulty: {},
      byTag: {},
    },
    ...overrides,
  };
}

describe("diffHarnessReports", () => {
  it("rejects retry history that reuses the current run identity", () => {
    const candidate = report();
    candidate.cells[0].infrastructureRetries = [{
      runId: "run-a", completedAt: "2026-07-17T07:59:59.000Z",
    }];
    expect(() => diffHarnessReports(report(), candidate)).toThrow("Invalid infrastructure retry identity");
    expect(() => assertHarnessReportPolicySupport(candidate, {})).toThrow("Invalid infrastructure retry identity");
  });

  it("allows partial comparisons but rejects partial or undeclared release coverage", () => {
    const partial = report();
    partial.manifest.executionCoverage = { selection: "local", corpusCaseIds: ["case-a", "command"],
      excluded: [{ caseId: "command", reason: "requires-container" }] };
    expect(diffHarnessReports(partial, partial).passed).toBe(true);
    expect(() => diffHarnessReports(partial, partial, { requireFullCoverage: true })).toThrow("full execution coverage");
    expect(() => assertHarnessReportPolicySupport(partial, { requireFullCoverage: true })).toThrow("full execution coverage");
    expect(() => assertHarnessReportPolicySupport(report(), { requireFullCoverage: true })).toThrow("full execution coverage");
    const full = report();
    full.manifest.executionCoverage = { selection: "full", corpusCaseIds: ["case-a"], excluded: [] };
    expect(() => assertHarnessReportPolicySupport(full, { requireFullCoverage: true })).not.toThrow();
    full.manifest.executionCoverage.corpusCaseIds.push("missing");
    expect(() => assertHarnessReportPolicySupport(full, { requireFullCoverage: true })).toThrow("accounting");
  });

  it("rejects differing selection provenance even for the same scored cases", () => {
    const baseline = report();
    baseline.manifest.executionCoverage = { selection: "local", corpusCaseIds: ["case-a"], excluded: [] };
    const candidate = structuredClone(baseline);
    candidate.manifest.executionCoverage!.selection = "full";
    expect(() => diffHarnessReports(baseline, candidate)).toThrow("execution coverage");
  });

  it("rejects reports produced from different benchmark inputs", () => {
    const candidate = report({
      manifest: { ...report().manifest, caseSetHash: "changed-cases" },
    });

    expect(() => diffHarnessReports(report(), candidate)).toThrow("case set");
  });

  it("rejects reports produced by different evaluator artifacts", () => {
    const baseline = report({
      manifest: { ...report().manifest, evaluatorArtifactHash: "validator-a" },
    });
    const candidate = report({
      manifest: { ...report().manifest, evaluatorArtifactHash: "validator-b" },
    });

    expect(() => diffHarnessReports(baseline, candidate)).toThrow("evaluator artifacts");
  });

  it("rejects reports produced under different runtime provenance", () => {
    const baseline = report({
      manifest: {
        ...report().manifest,
        runtime: { nodeVersion: "v20.0.0", platform: "win32", architecture: "x64", sourceRevision: "baseline" },
      },
    });
    const candidate = structuredClone(baseline);
    candidate.manifest.runtime = {
      ...candidate.manifest.runtime!,
      nodeVersion: "v22.0.0",
      sourceRevision: "candidate",
    };

    expect(() => diffHarnessReports(baseline, candidate)).toThrow("runtime");
    candidate.manifest.runtime.nodeVersion = "v20.0.0";
    expect(() => diffHarnessReports(baseline, candidate)).not.toThrow();
  });

  it("flags regressions by signal instead of hiding them in the composite", () => {
    const candidate = report();
    candidate.cells[0].result.success = false;
    candidate.cells[0].result.observation.usage = { inputTokens: 18, outputTokens: 2 };
    candidate.cells[0].result.observation.estimatedCostUsd = 0.03;
    candidate.cells[0].result.durationMs = 1_500;
    candidate.cells[0].trace!.toolCalls.push({
      callId: "call-2",
      name: "read_file",
      approvalRequested: false,
      ok: true,
    });
    candidate.cells[0].harnessScore = {
      ...candidate.cells[0].harnessScore!,
      securityPassed: false,
      process: { robustness: 0.5, toolUse: 1, consistency: 1 },
      diagnosticComposite: 0,
    };

    const diff = diffHarnessReports(report(), candidate);

    expect(diff.passed).toBe(false);
    expect(diff.pairedCompletion).toMatchObject({
      pairs: 1,
      baselinePassRate: 1,
      candidatePassRate: 0,
      delta: -1,
      improved: 0,
      regressed: 1,
      unchanged: 0,
    });
    expect(diff.pairedNonInferiority).toMatchObject({
      pairs: 1,
      delta: -1,
      lower: -1,
      upper: -1,
      nonInferior: false,
    });
    expect(diff.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining("completion"),
      expect.stringContaining("security"),
      expect.stringContaining("robustness"),
      expect.stringContaining("tokens"),
      expect.stringContaining("cost"),
      expect.stringContaining("duration"),
      expect.stringContaining("actions"),
    ]));
  });

  it("surfaces prompt changes without treating the change itself as a regression", () => {
    const baseline = report();
    baseline.cells[0].promptProvenance = { profile: "production", seededMessagesHash: "prompt-a" };
    const candidate = report();
    candidate.cells[0].promptProvenance = { profile: "production", seededMessagesHash: "prompt-b" };

    const diff = diffHarnessReports(baseline, candidate);

    expect(diff.passed).toBe(true);
    expect(diff.cells[0].promptChanged).toBe(true);
  });

  it("flags a criterion pass-rate regression across repetitions", () => {
    const baseline = report();
    baseline.summary.byCriterion = {
      "case-a/grounded": { runs: 3, passes: 3, passRate: 1, mandatory: true },
    };
    const candidate = report();
    candidate.summary.byCriterion = {
      "case-a/grounded": { runs: 3, passes: 2, passRate: 2 / 3, mandatory: true },
    };

    const diff = diffHarnessReports(baseline, candidate);

    expect(diff.passed).toBe(false);
    expect(diff.criteria[0].criterion).toBe("case-a/grounded");
    expect(diff.criteria[0].delta).toBeCloseTo(-1 / 3);
    expect(diff.regressions).toContainEqual(expect.stringContaining("criterion pass rate regressed"));
  });

  it("does not pair unseeded repetition outcomes when aggregate rates are unchanged", () => {
    const repeated = (successes: boolean[]): HarnessMatrixReport => {
      const result = report();
      result.cells = successes.map((success, repetition) => ({
        ...structuredClone(result.cells[0]),
        repetition,
        result: {
          ...structuredClone(result.cells[0].result),
          success,
        },
      }));
      return result;
    };

    const diff = diffHarnessReports(repeated([true, false, true]), repeated([false, true, true]));

    expect(diff.passed).toBe(true);
    expect(diff.pairedCompletion).toMatchObject({
      pairs: 3,
      baselinePassRate: 2 / 3,
      candidatePassRate: 2 / 3,
      delta: 0,
      improved: 1,
      regressed: 1,
      unchanged: 1,
    });
    expect(diff.cells.some((cell) => cell.completionChanged)).toBe(true);
    expect(diff.regressions).toEqual([]);
  });

  it("refuses a release decision without the configured repetition support", () => {
    expect(() => diffHarnessReports(report(), report(), {
      minimumRepetitions: 2,
    })).toThrow("policy requires 2");
  });

  it("refuses a release decision without the configured paired-case support", () => {
    expect(() => diffHarnessReports(report(), report(), {
      minimumPairedCases: 2,
    })).toThrow("1 paired cases cannot support policy minimum 2");
  });

  it("refuses suite policy for reports without suite metadata", () => {
    expect(() => diffHarnessReports(report(), report(), {
      suites: { regression: { minimumPairedCells: 1 } },
    })).toThrow("requires case suite metadata");
  });

  it("refuses confidence policy for reports without matching interval provenance", () => {
    expect(() => diffHarnessReports(report(), report(), {
      confidenceLevel: 0.95,
    })).toThrow("required 0.95 confidence level");
  });

  it("applies distinct suite completion thresholds while retaining hard gates", () => {
    const baseline = report({
      manifest: { ...report().manifest, caseSuites: { "case-a": "capability" } },
    });
    const candidate = structuredClone(baseline);
    candidate.cells[0].result.success = false;

    const tolerated = diffHarnessReports(baseline, candidate, {
      minimumPairedCells: 1,
      suites: { capability: { minimumDetectableRegression: 1 } },
    });
    expect(tolerated.passed).toBe(true);

    candidate.cells[0].harnessScore = { ...candidate.cells[0].harnessScore!, securityPassed: false };
    const securityFailure = diffHarnessReports(baseline, candidate, {
      suites: { capability: { minimumDetectableRegression: 1 } },
    });
    expect(securityFailure.passed).toBe(false);
    expect(securityFailure.regressions).toContainEqual(expect.stringContaining("security"));
  });

  it("applies a global detectable completion regression when suites are not configured", () => {
    const baseline = report();
    const candidate = report();
    candidate.cells[0].result.success = false;

    expect(diffHarnessReports(baseline, candidate, { minimumDetectableRegression: 1 }).passed).toBe(true);
    expect(diffHarnessReports(baseline, candidate, { minimumDetectableRegression: 0.5 }).passed).toBe(false);
  });
});
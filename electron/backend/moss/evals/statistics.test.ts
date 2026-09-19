import { describe, expect, it } from "vitest";

import type { HarnessMatrixCellResult } from "../../../../common/evals";
import { pairedNonInferiority, summarizeReliability, wilsonInterval } from "./statistics";

function cell(caseId: string, repetition: number, success: boolean): HarnessMatrixCellResult {
  return {
    caseId,
    targetId: "target",
    variantId: "variant",
    repetition,
    result: {
      observation: {
        caseId,
        runId: `${caseId}-${repetition}`,
        provider: "fixture",
        model: "fixture",
        outcome: success ? "completed" : "failed",
        startedAt: "2026-08-18T00:00:00.000Z",
        completedAt: "2026-08-18T00:00:01.000Z",
        evidence: [],
        usage: {},
        estimatedCostUsd: 0,
        admissions: [],
      },
      criteria: [],
      success,
      score: success ? 1 : 0,
      durationMs: 1_000,
    },
    protectedInputHashesBefore: {},
    protectedInputHashesAfter: {},
    protectedInputsIntact: true,
  };
}

describe("evaluation statistics", () => {
  it("computes a bounded Wilson interval around a binomial rate", () => {
    const interval = wilsonInterval(2, 4);

    expect(interval.confidence).toBe(0.95);
    expect(interval.lower).toBeCloseTo(0.1500, 3);
    expect(interval.upper).toBeCloseTo(0.8500, 3);
  });

  it("computes task-averaged pass@k and pass^k from repeated outcomes", () => {
    const metrics = summarizeReliability([
      cell("mixed", 0, true),
      cell("mixed", 1, true),
      cell("mixed", 2, false),
      cell("failed", 0, false),
      cell("failed", 1, false),
      cell("failed", 2, false),
    ]);

    expect(metrics).toMatchObject({ taskGroups: 2, trials: 6, k: 3 });
    expect(metrics!.passAt1).toBeCloseTo(1 / 3);
    expect(metrics!.passAtK).toBeCloseTo(0.5);
    expect(metrics!.passPowerK).toBe(0);
  });

  it("uses the minimum available repetition count as k", () => {
    const metrics = summarizeReliability([
      cell("short", 0, true),
      cell("long", 0, true),
      cell("long", 1, false),
    ]);

    expect(metrics!.k).toBe(1);
    expect(metrics!.passAtK).toBe(metrics!.passAt1);
    expect(metrics!.passPowerK).toBe(metrics!.passAt1);
  });

  it("bootstraps deterministically across families, tasks, and trials", () => {
    const cells = [
      cell("strong", 0, true),
      cell("strong", 1, true),
      cell("weak", 0, false),
      cell("weak", 1, false),
    ];
    const families = new Map([["strong", "alpha"], ["weak", "beta"]]);

    const first = summarizeReliability(cells, families)!.passAt1Bootstrap;
    const second = summarizeReliability(cells, families)!.passAt1Bootstrap;

    expect(first).toEqual(second);
    expect(first).toMatchObject({ confidence: 0.95, resamples: 2_000, unit: "family-task-trial" });
    expect(first.lower).toBeGreaterThanOrEqual(0);
    expect(first.upper).toBeLessThanOrEqual(1);
    expect(first.lower).toBeLessThan(first.upper);
  });

  it("pairs case rates and bootstraps family clusters for non-inferiority", () => {
    const baseline = [
      cell("strong", 0, true), cell("strong", 1, true),
      cell("weak", 0, true), cell("weak", 1, false),
    ];
    const candidate = [
      cell("strong", 0, true), cell("strong", 1, false),
      cell("weak", 0, true), cell("weak", 1, true),
    ];
    const families = new Map([["strong", "alpha"], ["weak", "beta"]]);

    const analysis = pairedNonInferiority(baseline, candidate, families, 0.5);

    expect(analysis).toMatchObject({
      pairs: 2,
      baselinePassRate: 0.75,
      candidatePassRate: 0.75,
      delta: 0,
      improved: 1,
      regressed: 1,
      confidence: 0.95,
      margin: 0.5,
      nonInferior: true,
      unit: "family-case-rate",
    });
    expect(analysis.lower).toBe(-0.5);
    expect(analysis.upper).toBe(0.5);
  });

  it("keeps every case in a sampled family cluster intact", () => {
    const baseline = [
      cell("alpha-up", 0, false),
      cell("alpha-down", 0, true),
      cell("beta-flat", 0, true),
    ];
    const candidate = [
      cell("alpha-up", 0, true),
      cell("alpha-down", 0, false),
      cell("beta-flat", 0, true),
    ];
    const families = new Map([
      ["alpha-up", "alpha"],
      ["alpha-down", "alpha"],
      ["beta-flat", "beta"],
    ]);

    const analysis = pairedNonInferiority(baseline, candidate, families);

    expect(analysis.delta).toBe(0);
    expect(analysis.lower).toBe(0);
    expect(analysis.upper).toBe(0);
  });
});
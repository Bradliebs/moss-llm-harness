import { describe, expect, it } from "vitest";
import { summarizeCorpusDiagnostics } from "./corpus-diagnostics";
import { createOfflinePilotCases } from "./pilot-cases";
import { validateCase } from "./eval-runner";

function fixture() {
  const cases = Array.from({ length: 10 }, (_, index) => ({
    ...createOfflinePilotCases()[0], id: `case-${index}`, family: `family-${Math.floor(index / 2)}`,
    suite: "capability" as const, estimatedHumanMinutes: [5, 30, 120, 121, undefined][index % 5],
  }));
  const cells = cases.flatMap((testCase) => Array.from({ length: 3 }, (_, repetition) => ({
    caseId: testCase.id, targetId: "model", variantId: "baseline", repetition, result: { success: true },
  })));
  return { cases, cells };
}

describe("corpus diagnostics", () => {
  it("reports duration boundaries and missing estimates explicitly", () => {
    const { cases, cells } = fixture();
    const result = summarizeCorpusDiagnostics(cells, cases)["model/baseline"];
    for (const bucket of Object.values(result.byHumanDuration)) {
      expect(bucket).toEqual({ cases: 2, trials: 6, successes: 6, successRate: 1 });
    }
    expect(result.capabilitySaturation.status).toBe("insufficient-support");
  });

  it("signals saturation only with full coverage, case/family support and repeated success", () => {
    const { cases, cells } = fixture();
    expect(summarizeCorpusDiagnostics(cells, cases, true)["model/baseline"].capabilitySaturation.status).toBe("saturation-signal");
    expect(summarizeCorpusDiagnostics(cells.slice(0, -1), cases, true)["model/baseline"].capabilitySaturation.status).toBe("insufficient-support");
    cells[0].result.success = false;
    cells[1].result.success = false;
    expect(summarizeCorpusDiagnostics(cells, cases, true)["model/baseline"].capabilitySaturation.status).toBe("not-saturated");
  });

  it("does not pool models or count duplicate repetitions as support", () => {
    const { cases, cells } = fixture();
    cells[0].variantId = "candidate";
    const summaries = summarizeCorpusDiagnostics(cells, cases, true);
    expect(Object.values(summaries).every((summary) => summary.capabilitySaturation.status === "insufficient-support")).toBe(true);
    cells[0].variantId = "baseline";
    cells[0].repetition = 1;
    expect(summarizeCorpusDiagnostics(cells, cases, true)["model/baseline"].capabilitySaturation.status).toBe("insufficient-support");
  });

  it("validates author-supplied metadata", () => {
    const testCase = createOfflinePilotCases()[0];
    for (const estimatedHumanMinutes of [0, -1, Infinity, NaN]) {
      expect(() => validateCase({ ...testCase, estimatedHumanMinutes })).toThrow("human minutes");
    }
    expect(() => validateCase({ ...testCase, estimatedHumanMinutes: 45, taskMessiness: "high" })).not.toThrow();
  });

  it("withholds saturation when harness failures or too few families remain", () => {
    const { cases, cells } = fixture();
    const failed = cells.map((cell, index) => index === 0 ? {
      ...cell, result: { success: false, failureAttribution: { category: "orchestration" as const, reasonCode: "fixture-failure", summary: "fixture failure" } },
    } : cell);
    expect(summarizeCorpusDiagnostics(failed, cases, true)["model/baseline"].capabilitySaturation.status).toBe("insufficient-support");
    for (const testCase of cases) testCase.family = "one-family";
    expect(summarizeCorpusDiagnostics(cells, cases, true)["model/baseline"].capabilitySaturation.status).toBe("insufficient-support");
  });
});
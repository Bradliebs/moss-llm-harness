import type { EvalCase, HarnessCorpusDiagnostics, HarnessMatrixCellResult } from "../../../../common/evals";

type DiagnosticTrial = Pick<HarnessMatrixCellResult, "caseId" | "targetId" | "variantId" | "repetition"> & {
  result: Pick<HarnessMatrixCellResult["result"], "success" | "failureAttribution">;
};

export function summarizeCorpusDiagnostics(
  cells: readonly DiagnosticTrial[],
  cases: readonly EvalCase[],
  fullCoverage = false,
): Record<string, HarnessCorpusDiagnostics> {
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const groups = new Map<string, DiagnosticTrial[]>();
  for (const cell of cells) {
    const key = `${cell.targetId}/${cell.variantId}`;
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups].map(([key, group]) => {
    const byHumanDuration: HarnessCorpusDiagnostics["byHumanDuration"] = {
      "up-to-5m": emptyBucket(), "5-to-30m": emptyBucket(), "30-to-120m": emptyBucket(),
      "over-120m": emptyBucket(), unknown: emptyBucket(),
    };
    const seenCases = new Set<string>();
    for (const cell of group) {
      const duration = casesById.get(cell.caseId)?.estimatedHumanMinutes;
      const bucket = byHumanDuration[durationBucket(duration)];
      bucket.trials++;
      if (cell.result.success) bucket.successes++;
      if (!seenCases.has(cell.caseId)) bucket.cases++;
      seenCases.add(cell.caseId);
    }
    for (const bucket of Object.values(byHumanDuration)) {
      bucket.successRate = bucket.trials ? bucket.successes / bucket.trials : null;
    }
    const capabilityCases = cases.filter((testCase) => testCase.suite === "capability");
    const capabilityIds = new Set(capabilityCases.map((testCase) => testCase.id));
    const trials = group.filter((cell) => capabilityIds.has(cell.caseId));
    const samples = capabilityCases.map((testCase) => trials.filter((cell) => cell.caseId === testCase.id));
    const minimumTrialsPerCase = samples.length ? Math.min(...samples.map((sample) => sample.length)) : 0;
    const caseAveragedSuccess = minimumTrialsPerCase > 0
      ? samples.reduce((sum, sample) => sum + sample.filter((cell) => cell.result.success).length / sample.length, 0) / samples.length
      : null;
    const families = new Set(capabilityCases.map((testCase) => testCase.family).filter(Boolean)).size;
    const harnessFailures = trials.filter((cell) => cell.result.failureAttribution
      && cell.result.failureAttribution.category !== "agent-behavior").length;
    const uniqueTrials = new Set(trials.map((cell) => `${cell.caseId}/${cell.repetition}`)).size === trials.length;
    const policy = { minimumCases: 10, minimumFamilies: 5, minimumTrials: 3, successThreshold: 0.95 };
    const supported = fullCoverage && capabilityCases.length >= policy.minimumCases && families >= policy.minimumFamilies
      && minimumTrialsPerCase >= policy.minimumTrials && harnessFailures === 0 && uniqueTrials
      && capabilityCases.every((testCase) => Boolean(testCase.family));
    return [key, {
      scope: fullCoverage ? "full-corpus" : "partial-or-unknown",
      byHumanDuration,
      capabilitySaturation: {
        status: !supported ? "insufficient-support"
          : caseAveragedSuccess! >= policy.successThreshold ? "saturation-signal" : "not-saturated",
        cases: capabilityCases.length, families, minimumTrialsPerCase, caseAveragedSuccess, harnessFailures, policy,
      },
    } satisfies HarnessCorpusDiagnostics];
  }));
}

function emptyBucket(): HarnessCorpusDiagnostics["byHumanDuration"]["unknown"] {
  return { cases: 0, trials: 0, successes: 0, successRate: null };
}

function durationBucket(minutes: number | undefined): keyof HarnessCorpusDiagnostics["byHumanDuration"] {
  if (minutes === undefined) return "unknown";
  if (minutes <= 5) return "up-to-5m";
  if (minutes <= 30) return "5-to-30m";
  if (minutes <= 120) return "30-to-120m";
  return "over-120m";
}
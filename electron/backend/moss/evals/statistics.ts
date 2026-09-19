import type {
  HarnessBootstrapInterval,
  HarnessMatrixCellResult,
  HarnessPairedNonInferiority,
  HarnessRateInterval,
  HarnessReliabilityMetrics,
} from "../../../../common/evals";

const Z_95 = 1.959963984540054;

/** Wilson score interval for a binomial rate. */
export function wilsonInterval(successes: number, trials: number): HarnessRateInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials < 1 || successes > trials) {
    throw new Error("Wilson interval requires 0 <= successes <= trials and at least one trial");
  }
  const confidence = 0.95;
  const rate = successes / trials;
  const zSquared = Z_95 ** 2;
  const denominator = 1 + zSquared / trials;
  const center = (rate + zSquared / (2 * trials)) / denominator;
  const margin = Z_95 * Math.sqrt((rate * (1 - rate) + zSquared / (4 * trials)) / trials) / denominator;
  return {
    confidence,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

/** Task-averaged pass@k and pass^k estimators over repeated matrix cells. */
export function summarizeReliability(
  cells: readonly HarnessMatrixCellResult[],
  familyByCase: ReadonlyMap<string, string> = new Map(),
): HarnessReliabilityMetrics | undefined {
  if (cells.length === 0) return undefined;
  const groups = new Map<string, HarnessMatrixCellResult[]>();
  for (const cell of cells) {
    const key = `${cell.targetId}\u0000${cell.variantId}\u0000${cell.caseId}`;
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  const samples = [...groups.values()].map((group) => ({
    trials: group.length,
    successes: group.filter((cell) => cell.result.success).length,
  }));
  const k = Math.min(...samples.map((sample) => sample.trials));
  const average = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  const successes = samples.reduce((sum, sample) => sum + sample.successes, 0);

  return {
    taskGroups: samples.length,
    trials: cells.length,
    k,
    passAt1: average(samples.map((sample) => sample.successes / sample.trials)),
    passAtK: average(samples.map((sample) => 1 - combinations(sample.trials - sample.successes, k) / combinations(sample.trials, k))),
    passPowerK: average(samples.map((sample) => combinations(sample.successes, k) / combinations(sample.trials, k))),
    completionWilsonInterval: wilsonInterval(successes, cells.length),
    passAt1Bootstrap: bootstrapPassAt1(cells, familyByCase),
  };
}

function bootstrapPassAt1(
  cells: readonly HarnessMatrixCellResult[],
  familyByCase: ReadonlyMap<string, string>,
): HarnessBootstrapInterval {
  const taskGroups = new Map<string, { family: string; outcomes: boolean[] }>();
  for (const cell of cells) {
    const key = `${cell.targetId}\u0000${cell.variantId}\u0000${cell.caseId}`;
    const task = taskGroups.get(key) ?? {
      family: familyByCase.get(cell.caseId) ?? cell.caseId,
      outcomes: [],
    };
    task.outcomes.push(cell.result.success);
    taskGroups.set(key, task);
  }
  const families = new Map<string, Array<{ outcomes: boolean[] }>>();
  for (const task of taskGroups.values()) {
    const tasks = families.get(task.family) ?? [];
    tasks.push(task);
    families.set(task.family, tasks);
  }

  const familySamples = [...families.values()];
  const resamples = 2_000;
  const values: number[] = [];
  const random = seededRandom(0x4d4f5353);
  for (let iteration = 0; iteration < resamples; iteration++) {
    const familyRates: number[] = [];
    for (let familyIndex = 0; familyIndex < familySamples.length; familyIndex++) {
      const tasks = familySamples[Math.floor(random() * familySamples.length)];
      const taskRates: number[] = [];
      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
        const outcomes = tasks[Math.floor(random() * tasks.length)].outcomes;
        let successes = 0;
        for (let trial = 0; trial < outcomes.length; trial++) {
          if (outcomes[Math.floor(random() * outcomes.length)]) successes++;
        }
        taskRates.push(successes / outcomes.length);
      }
      familyRates.push(mean(taskRates));
    }
    values.push(mean(familyRates));
  }
  values.sort((left, right) => left - right);
  return {
    confidence: 0.95,
    lower: percentile(values, 0.025),
    upper: percentile(values, 0.975),
    resamples,
    unit: families.size > 1 ? "family-task-trial" : "task-trial",
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

function combinations(total: number, selected: number): number {
  if (selected < 0 || selected > total) return 0;
  const count = Math.min(selected, total - selected);
  let result = 1;
  for (let index = 1; index <= count; index++) result = result * (total - count + index) / index;
  return result;
}

/** Compare case-level completion rates and bootstrap whole families as correlated clusters. */
export function pairedNonInferiority(
  baselineCells: readonly HarnessMatrixCellResult[],
  candidateCells: readonly HarnessMatrixCellResult[],
  familyByCase: ReadonlyMap<string, string> = new Map(),
  margin = 0,
): HarnessPairedNonInferiority {
  if (!Number.isFinite(margin) || margin < 0 || margin > 1) {
    throw new Error("Non-inferiority margin must be between 0 and 1");
  }
  const baselineGroups = completionRateGroups(baselineCells);
  const candidateGroups = completionRateGroups(candidateCells);
  if (baselineGroups.size === 0 || baselineGroups.size !== candidateGroups.size
    || [...baselineGroups.keys()].some((key) => !candidateGroups.has(key))) {
    throw new Error("Paired non-inferiority requires matching non-empty case groups");
  }
  const pairs = [...baselineGroups].map(([key, baseline]) => {
    const candidate = candidateGroups.get(key)!;
    return {
      family: familyByCase.get(baseline.caseId) ?? baseline.caseId,
      baselineRate: baseline.rate,
      candidateRate: candidate.rate,
      delta: candidate.rate - baseline.rate,
    };
  });
  const families = new Map<string, typeof pairs>();
  for (const pair of pairs) {
    const group = families.get(pair.family) ?? [];
    group.push(pair);
    families.set(pair.family, group);
  }
  const familySamples = [...families.values()];
  const resamples = 2_000;
  const values: number[] = [];
  const random = seededRandom(0x4e494d47);
  for (let iteration = 0; iteration < resamples; iteration++) {
    const deltas: number[] = [];
    for (let familyIndex = 0; familyIndex < familySamples.length; familyIndex++) {
      const sampledFamily = familySamples[Math.floor(random() * familySamples.length)];
      for (let caseIndex = 0; caseIndex < sampledFamily.length; caseIndex++) {
        deltas.push(sampledFamily[caseIndex].delta);
      }
    }
    values.push(mean(deltas));
  }
  values.sort((left, right) => left - right);
  const baselinePassRate = mean(pairs.map((pair) => pair.baselineRate));
  const candidatePassRate = mean(pairs.map((pair) => pair.candidateRate));
  const lower = percentile(values, 0.025);
  return {
    pairs: pairs.length,
    baselinePassRate,
    candidatePassRate,
    delta: candidatePassRate - baselinePassRate,
    improved: pairs.filter((pair) => pair.delta > 0).length,
    regressed: pairs.filter((pair) => pair.delta < 0).length,
    unchanged: pairs.filter((pair) => pair.delta === 0).length,
    confidence: 0.95,
    lower,
    upper: percentile(values, 0.975),
    margin,
    nonInferior: lower >= -margin,
    resamples,
    unit: families.size > 1 ? "family-case-rate" : "case-rate",
  };
}

function completionRateGroups(
  cells: readonly HarnessMatrixCellResult[],
): Map<string, { caseId: string; rate: number }> {
  const groups = new Map<string, { caseId: string; outcomes: boolean[] }>();
  for (const cell of cells) {
    const key = `${cell.targetId}\u0000${cell.variantId}\u0000${cell.caseId}`;
    const group = groups.get(key) ?? { caseId: cell.caseId, outcomes: [] };
    group.outcomes.push(cell.result.success);
    groups.set(key, group);
  }
  return new Map([...groups].map(([key, group]) => [key, {
    caseId: group.caseId,
    rate: group.outcomes.filter(Boolean).length / group.outcomes.length,
  }]));
}
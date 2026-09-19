import type {
  HarnessCellDiff,
  HarnessMatrixCellResult,
  HarnessMatrixManifest,
  HarnessMatrixReport,
  HarnessPairedRateDelta,
  HarnessCriterionDiff,
  HarnessReportDiff,
} from "../../../../common/evals";
import type { EvalSuitePurpose } from "../../../../common/evals";
import { pairedNonInferiority } from "./statistics";
import { validateExecutionCoverage } from "./execution-selection";
import { validateInfrastructureRetries } from "./matrix-runner";

export interface HarnessRegressionThresholds {
  requireFullCoverage?: boolean;
  maxTokenIncrease?: number;
  maxCostIncreaseUsd?: number;
  maxDurationIncreaseMs?: number;
  maxActionIncrease?: number;
  minProcessDelta?: number;
  minimumRepetitions?: number;
  minimumPairedCells?: number;
  minimumPairedCases?: number;
  confidenceLevel?: 0.95;
  nonInferiorityMargin?: number;
  /** @deprecated Use nonInferiorityMargin. */
  minimumDetectableRegression?: number;
  suites?: Partial<Record<EvalSuitePurpose, HarnessSuiteReleasePolicy>>;
}

export interface HarnessSuiteReleasePolicy {
  minimumRepetitions?: number;
  minimumPairedCells?: number;
  minimumPairedCases?: number;
  confidenceLevel?: 0.95;
  nonInferiorityMargin?: number;
  /** @deprecated Use nonInferiorityMargin. */
  minimumDetectableRegression?: number;
}

/** Compare only like-for-like reports and gate each observable signal separately. */
export function diffHarnessReports(
  baseline: HarnessMatrixReport,
  candidate: HarnessMatrixReport,
  thresholds: HarnessRegressionThresholds = {},
): HarnessReportDiff {
  assertHarnessReportSchema(baseline);
  assertHarnessReportSchema(candidate);
  assertHarnessManifestCompatible(baseline.manifest, candidate.manifest);
  assertFullCoverage(baseline, thresholds);
  assertFullCoverage(candidate, thresholds);
  const candidateCells = new Map(candidate.cells.map((cell) => [cellKey(cell), cell]));
  const cells: HarnessCellDiff[] = [];
  const regressions: string[] = [];
  const criteria = diffCriteria(baseline, candidate);

  for (const baselineCell of baseline.cells) {
    const key = cellKey(baselineCell);
    const candidateCell = candidateCells.get(key);
    if (!candidateCell) throw new Error(`Candidate report is missing matrix cell '${key}'`);
    if (!baselineCell.harnessScore || !candidateCell.harnessScore) {
      throw new Error(`Matrix cell '${key}' is missing deterministic harness scores`);
    }
    const delta = buildCellDiff(baselineCell, candidateCell);
    cells.push(delta);
  }

  if (candidateCells.size !== baseline.cells.length) {
    throw new Error("Candidate report contains matrix cells absent from the baseline");
  }
  assertPolicySampleSupport(baseline, candidate, thresholds);
  const hasSuitePolicy = thresholds.suites !== undefined && Object.keys(thresholds.suites).length > 0;
  const hasCompletionPolicy = hasSuitePolicy
    || thresholds.nonInferiorityMargin !== undefined
    || thresholds.minimumDetectableRegression !== undefined;
  gateAggregateRegressions(baseline.cells, candidate.cells, thresholds, regressions, !hasCompletionPolicy);
  if (hasSuitePolicy) gateSuiteRegressions(baseline, candidate, thresholds, regressions);
  else if (hasCompletionPolicy) {
    gateCompletionRegression(
      "overall",
      baseline.cells,
      candidate.cells,
      completionMargin(thresholds),
      baseline.manifest.caseFamilies,
      regressions,
    );
  }
  for (const criterion of criteria) {
    if (criterion.delta < 0) regressions.push(`${criterion.criterion}: criterion pass rate regressed by ${criterion.delta}`);
  }
  return {
    schemaVersion: 1,
    baselineGeneratedAt: baseline.generatedAt,
    candidateGeneratedAt: candidate.generatedAt,
    passed: regressions.length === 0,
    pairedCompletion: pairedCompletionDelta(baseline.cells, candidateCells),
    pairedNonInferiority: pairedNonInferiority(
      baseline.cells,
      candidate.cells,
      new Map(Object.entries(baseline.manifest.caseFamilies ?? {})),
      completionMargin(thresholds),
    ),
    cells,
    criteria,
    regressions,
  };
}

export function assertHarnessReportSchema(report: HarnessMatrixReport): void {
  if (report.schemaVersion !== 1) throw new Error("Unsupported harness report schema version");
  if (report.manifest.executionCoverage) validateExecutionCoverage(report.manifest.executionCoverage, report.manifest.caseIds);
  for (const cell of report.cells) validateInfrastructureRetries(cell);
}

export function assertHarnessManifestCompatible(
  baseline: HarnessMatrixManifest,
  candidate: HarnessMatrixManifest,
): void {
  const checks: Array<[string, string, string]> = [
    ["evaluator version", baseline.evaluatorVersion, candidate.evaluatorVersion],
    ["evaluator artifacts", baseline.evaluatorArtifactHash ?? "", candidate.evaluatorArtifactHash ?? ""],
    ["case set", baseline.caseSetHash, candidate.caseSetHash],
    ["execution coverage", JSON.stringify(baseline.executionCoverage ?? null), JSON.stringify(candidate.executionCoverage ?? null)],
    ["execution purpose", baseline.executionPolicy?.purpose ?? "", candidate.executionPolicy?.purpose ?? ""],
    ["split corpus", baseline.splitCorpusHash ?? "", candidate.splitCorpusHash ?? ""],
    ["scenario plans", baseline.scenarioPlanHash ?? "", candidate.scenarioPlanHash ?? ""],
    ["model target set", baseline.targetSetHash, candidate.targetSetHash],
    ["harness variant set", baseline.variantSetHash, candidate.variantSetHash],
    ["runtime", runtimeCompatibilityKey(baseline), runtimeCompatibilityKey(candidate)],
    ["sandbox image", baseline.sandboxImageDigest ?? "", candidate.sandboxImageDigest ?? ""],
  ];
  for (const [label, left, right] of checks) {
    if (left !== right) throw new Error(`Cannot compare reports with a different ${label}`);
  }
}

function runtimeCompatibilityKey(manifest: HarnessMatrixManifest): string {
  if (!manifest.runtime) return "";
  return JSON.stringify({
    nodeVersion: manifest.runtime.nodeVersion,
    platform: manifest.runtime.platform,
    architecture: manifest.runtime.architecture,
  });
}

function buildCellDiff(baseline: HarnessMatrixCellResult, candidate: HarnessMatrixCellResult): HarnessCellDiff {
  const baselineHarness = baseline.harnessScore!;
  const candidateHarness = candidate.harnessScore!;
  return {
    caseId: baseline.caseId,
    targetId: baseline.targetId,
    variantId: baseline.variantId,
    repetition: baseline.repetition,
    promptChanged: baseline.promptProvenance?.seededMessagesHash !== candidate.promptProvenance?.seededMessagesHash,
    completionChanged: baseline.result.success !== candidate.result.success,
    securityChanged: baselineHarness.securityPassed !== candidateHarness.securityPassed,
    robustnessDelta: candidateHarness.process.robustness - baselineHarness.process.robustness,
    toolUseDelta: candidateHarness.process.toolUse - baselineHarness.process.toolUse,
    consistencyDelta: candidateHarness.process.consistency - baselineHarness.process.consistency,
    tokensDelta: tokens(candidate) - tokens(baseline),
    costDeltaUsd: candidate.result.observation.estimatedCostUsd - baseline.result.observation.estimatedCostUsd,
    durationDeltaMs: candidate.result.durationMs - baseline.result.durationMs,
    actionsDelta: (candidate.trace?.toolCalls.length ?? 0) - (baseline.trace?.toolCalls.length ?? 0),
  };
}

function cellKey(cell: HarnessMatrixCellResult): string {
  return `${cell.targetId}\u0000${cell.variantId}\u0000${cell.caseId}\u0000${cell.repetition}`;
}

function tokens(cell: HarnessMatrixCellResult): number {
  const usage = cell.result.observation.usage;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function diffCriteria(baseline: HarnessMatrixReport, candidate: HarnessMatrixReport): HarnessCriterionDiff[] {
  const baselineCriteria = baseline.summary.byCriterion ?? {};
  const candidateCriteria = candidate.summary.byCriterion ?? {};
  const baselineKeys = Object.keys(baselineCriteria).sort();
  if (baselineKeys.length !== Object.keys(candidateCriteria).length
    || baselineKeys.some((key) => candidateCriteria[key] === undefined)) {
    throw new Error("Cannot compare reports with different criterion summaries");
  }
  return baselineKeys.map((criterion) => ({
    criterion,
    mandatory: baselineCriteria[criterion].mandatory,
    baselinePassRate: baselineCriteria[criterion].passRate,
    candidatePassRate: candidateCriteria[criterion].passRate,
    delta: candidateCriteria[criterion].passRate - baselineCriteria[criterion].passRate,
  }));
}

interface ComparisonAggregate {
  completionRate: number;
  securityPassRate: number;
  robustness: number;
  toolUse: number;
  consistency: number;
  tokens: number;
  costUsd: number;
  durationMs: number;
  actions: number;
}

function gateAggregateRegressions(
  baselineCells: readonly HarnessMatrixCellResult[],
  candidateCells: readonly HarnessMatrixCellResult[],
  thresholds: HarnessRegressionThresholds,
  regressions: string[],
  gateCompletion: boolean,
): void {
  const baselineGroups = groupComparisonCells(baselineCells);
  const candidateGroups = groupComparisonCells(candidateCells);
  if (baselineGroups.size !== candidateGroups.size
    || [...baselineGroups.keys()].some((key) => !candidateGroups.has(key))) {
    throw new Error("Cannot compare reports with different target, variant, or case groups");
  }
  for (const [label, baselineGroup] of baselineGroups) {
    const baseline = aggregateComparison(baselineGroup);
    const candidate = aggregateComparison(candidateGroups.get(label)!);
    if (gateCompletion && candidate.completionRate < baseline.completionRate) {
      regressions.push(`${label}: completion rate regressed`);
    }
    if (candidate.securityPassRate < baseline.securityPassRate) regressions.push(`${label}: security pass rate regressed`);
    const minProcessDelta = thresholds.minProcessDelta ?? 0;
    gateMinimumDelta(label, "robustness", candidate.robustness - baseline.robustness, minProcessDelta, regressions);
    gateMinimumDelta(label, "tool use", candidate.toolUse - baseline.toolUse, minProcessDelta, regressions);
    gateMinimumDelta(label, "consistency", candidate.consistency - baseline.consistency, minProcessDelta, regressions);
    gateMaximumDelta(label, "tokens", candidate.tokens - baseline.tokens, thresholds.maxTokenIncrease ?? 0, regressions);
    gateMaximumDelta(label, "cost", candidate.costUsd - baseline.costUsd, thresholds.maxCostIncreaseUsd ?? 0, regressions);
    gateMaximumDelta(label, "duration", candidate.durationMs - baseline.durationMs, thresholds.maxDurationIncreaseMs ?? 0, regressions);
    gateMaximumDelta(label, "actions", candidate.actions - baseline.actions, thresholds.maxActionIncrease ?? 0, regressions);
  }
}

function groupComparisonCells(cells: readonly HarnessMatrixCellResult[]): Map<string, HarnessMatrixCellResult[]> {
  const groups = new Map<string, HarnessMatrixCellResult[]>();
  for (const cell of cells) {
    const key = `${cell.targetId}/${cell.variantId}/${cell.caseId}`;
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  return groups;
}

function aggregateComparison(cells: readonly HarnessMatrixCellResult[]): ComparisonAggregate {
  const scores = cells.map((cell) => cell.harnessScore!);
  return {
    completionRate: rate(cells.map((cell) => cell.result.success)),
    securityPassRate: rate(scores.map((score) => score.securityPassed)),
    robustness: mean(scores.map((score) => score.process.robustness)),
    toolUse: mean(scores.map((score) => score.process.toolUse)),
    consistency: mean(scores.map((score) => score.process.consistency)),
    tokens: median(cells.map(tokens)),
    costUsd: median(cells.map((cell) => cell.result.observation.estimatedCostUsd)),
    durationMs: median(cells.map((cell) => cell.result.durationMs)),
    actions: median(cells.map((cell) => cell.trace?.toolCalls.length ?? 0)),
  };
}

function gateMinimumDelta(label: string, signal: string, delta: number, minimum: number, regressions: string[]): void {
  if (delta < minimum) regressions.push(`${label}: ${signal} regressed by ${delta}`);
}

function gateMaximumDelta(label: string, signal: string, delta: number, maximum: number, regressions: string[]): void {
  if (delta > maximum) regressions.push(`${label}: ${signal} increased by ${delta}`);
}

function rate(values: readonly boolean[]): number {
  return values.length === 0 ? 0 : values.filter(Boolean).length / values.length;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function pairedCompletionDelta(
  baselineCells: readonly HarnessMatrixCellResult[],
  candidateCells: ReadonlyMap<string, HarnessMatrixCellResult>,
): HarnessPairedRateDelta {
  let baselinePasses = 0;
  let candidatePasses = 0;
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  for (const baseline of baselineCells) {
    const candidate = candidateCells.get(cellKey(baseline))!;
    if (baseline.result.success) baselinePasses++;
    if (candidate.result.success) candidatePasses++;
    if (!baseline.result.success && candidate.result.success) improved++;
    else if (baseline.result.success && !candidate.result.success) regressed++;
    else unchanged++;
  }
  const pairs = baselineCells.length;
  const baselinePassRate = pairs === 0 ? 0 : baselinePasses / pairs;
  const candidatePassRate = pairs === 0 ? 0 : candidatePasses / pairs;
  return {
    pairs,
    baselinePassRate,
    candidatePassRate,
    delta: candidatePassRate - baselinePassRate,
    improved,
    regressed,
    unchanged,
  };
}

function assertPolicySampleSupport(
  baseline: HarnessMatrixReport,
  candidate: HarnessMatrixReport,
  policy: HarnessRegressionThresholds,
): void {
  const suitePolicies = policy.suites ?? {};
  if (Object.keys(suitePolicies).length > 0 && (!baseline.manifest.caseSuites || !candidate.manifest.caseSuites)) {
    throw new Error("Suite-specific release policy requires case suite metadata");
  }
  assertConfidenceSupport("overall", baseline, candidate, policy.confidenceLevel);
  assertGroupSupport("overall", baseline.cells, candidate.cells, policy);
  for (const [suite, suitePolicy] of Object.entries(suitePolicies) as Array<[EvalSuitePurpose, HarnessSuiteReleasePolicy]>) {
    const caseIds = new Set(Object.entries(baseline.manifest.caseSuites ?? {})
      .filter(([, value]) => value === suite)
      .map(([caseId]) => caseId));
    const baselineCells = baseline.cells.filter((cell) => caseIds.has(cell.caseId));
    const candidateCells = candidate.cells.filter((cell) => caseIds.has(cell.caseId));
    if (baselineCells.length === 0) throw new Error(`Release policy suite '${suite}' has no report cells`);
    assertConfidenceSupport(suite, baseline, candidate, suitePolicy.confidenceLevel ?? policy.confidenceLevel);
    assertGroupSupport(suite, baselineCells, candidateCells, { ...policy, ...suitePolicy, suites: undefined });
  }
}

function assertConfidenceSupport(
  label: string,
  baseline: HarnessMatrixReport,
  candidate: HarnessMatrixReport,
  confidenceLevel?: 0.95,
): void {
  if (confidenceLevel === undefined) return;
  const supported = baseline.summary.reliability?.completionWilsonInterval.confidence;
  const candidateSupported = candidate.summary.reliability?.completionWilsonInterval.confidence;
  if (supported !== confidenceLevel || candidateSupported !== confidenceLevel) {
    throw new Error(`${label}: reports do not provide the required ${confidenceLevel} confidence level`);
  }
}

function assertGroupSupport(
  label: string,
  baselineCells: readonly HarnessMatrixCellResult[],
  candidateCells: readonly HarnessMatrixCellResult[],
  policy: HarnessRegressionThresholds,
): void {
  const minimumRepetitions = policy.minimumRepetitions;
  if (minimumRepetitions !== undefined) {
    for (const [group, cells] of groupComparisonCells(baselineCells)) {
      if (cells.length < minimumRepetitions) {
        throw new Error(`${label}: '${group}' has ${cells.length} repetitions; policy requires ${minimumRepetitions}`);
      }
    }
  }
  const minimumPairedCells = policy.minimumPairedCells;
  if (minimumPairedCells !== undefined && baselineCells.length < minimumPairedCells) {
    throw new Error(`${label}: ${baselineCells.length} paired cells cannot support policy minimum ${minimumPairedCells}`);
  }
  const minimumPairedCases = policy.minimumPairedCases;
  if (minimumPairedCases !== undefined) {
    const pairedCases = groupComparisonCells(baselineCells).size;
    if (pairedCases < minimumPairedCases) {
      throw new Error(`${label}: ${pairedCases} paired cases cannot support policy minimum ${minimumPairedCases}`);
    }
  }
  if (candidateCells.length !== baselineCells.length) throw new Error(`${label}: incompatible paired cell count`);
}

function gateSuiteRegressions(
  baseline: HarnessMatrixReport,
  candidate: HarnessMatrixReport,
  policy: HarnessRegressionThresholds,
  regressions: string[],
): void {
  for (const [suite, suitePolicy] of Object.entries(policy.suites ?? {}) as Array<[EvalSuitePurpose, HarnessSuiteReleasePolicy]>) {
    const caseIds = new Set(Object.entries(baseline.manifest.caseSuites ?? {})
      .filter(([, value]) => value === suite)
      .map(([caseId]) => caseId));
    const baselineCells = baseline.cells.filter((cell) => caseIds.has(cell.caseId));
    const candidateCells = candidate.cells.filter((cell) => caseIds.has(cell.caseId));
    const toleratedRegression = suitePolicy.nonInferiorityMargin
      ?? suitePolicy.minimumDetectableRegression
      ?? policy.nonInferiorityMargin
      ?? policy.minimumDetectableRegression
      ?? 0;
    gateCompletionRegression(
      suite,
      baselineCells,
      candidateCells,
      toleratedRegression,
      baseline.manifest.caseFamilies,
      regressions,
    );
  }
}

function gateCompletionRegression(
  label: string,
  baselineCells: readonly HarnessMatrixCellResult[],
  candidateCells: readonly HarnessMatrixCellResult[],
  toleratedRegression: number,
  caseFamilies: Record<string, string> | undefined,
  regressions: string[],
): void {
  const analysis = pairedNonInferiority(
    baselineCells,
    candidateCells,
    new Map(Object.entries(caseFamilies ?? {})),
    toleratedRegression,
  );
  if (!analysis.nonInferior) {
    regressions.push(`${label}: completion lower bound ${analysis.lower} is below non-inferiority limit ${-toleratedRegression}`);
  }
}

function completionMargin(policy: HarnessRegressionThresholds): number {
  return policy.nonInferiorityMargin ?? policy.minimumDetectableRegression ?? 0;
}

export function assertHarnessReportPolicySupport(
  report: HarnessMatrixReport,
  policy: HarnessRegressionThresholds,
): void {
  assertHarnessReportSchema(report);
  assertFullCoverage(report, policy);
  assertPolicySampleSupport(report, report, policy);
}

function assertFullCoverage(report: HarnessMatrixReport, policy: HarnessRegressionThresholds): void {
  if (!policy.requireFullCoverage) return;
  const coverage = report.manifest.executionCoverage;
  if (!coverage || coverage.selection !== "full" || coverage.excluded.length > 0) {
    throw new Error("Release policy requires full execution coverage with no excluded cases");
  }
  validateExecutionCoverage(coverage, report.manifest.caseIds);
}
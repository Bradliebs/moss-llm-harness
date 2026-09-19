import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  EvalCase,
  EvalModelTarget,
  HarnessCaseCoverage,
  HarnessMatrixReport,
  HarnessVariant,
} from "../../../../common/evals";
import { checkEvalCases, type EvalCorpusPolicy, type EvalGraderHealthProbe } from "./case-health";
import {
  HarnessMatrixRunner,
  type HarnessMatrixRunnerOptions,
  type MatrixExecutorFactory,
  buildHarnessManifest,
} from "./matrix-runner";
import {
  assertHarnessManifestCompatible,
  assertHarnessReportPolicySupport,
  assertHarnessReportSchema,
  diffHarnessReports,
  type HarnessRegressionThresholds,
} from "./report-diff";
import {
  inspectHarnessTrial,
  renderTrialInspectionHtml,
  type HarnessTrialSelector,
} from "./trial-inspection";
import type { EvalRubricGrader } from "./rubric-grading";
import { RunJournal } from "../learning/run-journal";
import { createEvalCandidatePackages } from "./candidate-triage";
import { FileHarnessMatrixProgressStore } from "./matrix-progress-store";
import { exportPortableDataset, importPortableDataset } from "./portable-dataset";
import { HarnessDiagnosticArtifactStore } from "./diagnostic-artifact-store";

export interface HarnessEvalConfig {
  cases: EvalCase[];
  healthCases?: EvalCase[];
  executionPolicy?: HarnessMatrixRunnerOptions["executionPolicy"];
  executionCoverage?: HarnessMatrixRunnerOptions["executionCoverage"];
  targets: EvalModelTarget[];
  variants: HarnessVariant[];
  createExecutor: MatrixExecutorFactory;
  validateExecution?: () => void;
  evaluatorVersion?: string;
  evaluatorArtifacts?: string[];
  corpusPolicy?: EvalCorpusPolicy;
  graderHealthProbes?: EvalGraderHealthProbe[];
  rubricGrader?: EvalRubricGrader;
  rubricCalibration?: HarnessMatrixRunnerOptions["rubricCalibration"];
  matrix?: Pick<HarnessMatrixRunnerOptions, "maxConcurrency" | "providerConcurrency" | "retryInfrastructureFailures">;
}

export interface EvalCliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export interface EvalCliDependencies {
  loadConfig?: (path: string) => HarnessEvalConfig;
  loadThresholds?: (path: string) => HarnessRegressionThresholds;
  readReport?: (path: string) => HarnessMatrixReport;
  io?: EvalCliIo;
}

export async function runEvalCli(args: string[], dependencies: EvalCliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? { stdout: console.log, stderr: console.error };
  const loadConfig = dependencies.loadConfig ?? loadHarnessConfig;
  const loadThresholds = dependencies.loadThresholds ?? readThresholds;
  const loadReport = dependencies.readReport ?? readReport;
  const [command, ...paths] = args;

  if (command === "dry-run") {
    requirePaths(command, paths, 1);
    const config = loadConfig(resolve(paths[0]));
    config.validateExecution?.();
    const manifest = buildHarnessManifest(
      config.cases,
      config.targets,
      config.variants,
      config.evaluatorVersion,
      config.evaluatorArtifacts,
      config.executionCoverage,
      config.executionPolicy,
      config.healthCases,
    );
    const repetitions = config.cases.reduce((sum, testCase) => sum + (testCase.repetitions ?? 1), 0);
    const cells = repetitions * config.targets.length * config.variants.length;
    io.stdout(JSON.stringify({ valid: true, cells, coverage: summarizeCaseCoverage(config.cases), manifest }, null, 2));
    return 0;
  }

  if (command === "preflight") {
    const preflightArgs = parsePreflightArgs(paths);
    const config = loadConfig(resolve(preflightArgs.config));
    config.validateExecution?.();
    const baseline = loadReport(resolve(preflightArgs.baseline));
    assertHarnessReportSchema(baseline);
    const manifest = buildHarnessManifest(
      config.cases,
      config.targets,
      config.variants,
      config.evaluatorVersion,
      config.evaluatorArtifacts,
      config.executionCoverage,
      config.executionPolicy,
      config.healthCases,
    );
    assertHarnessManifestCompatible(baseline.manifest, manifest);
    assertBaselineCellsMatchConfig(baseline, config);
    if (preflightArgs.policy) {
      assertHarnessReportPolicySupport(baseline, loadThresholds(resolve(preflightArgs.policy)));
    }
    io.stdout(JSON.stringify({ valid: true, cells: baseline.cells.length, manifest }, null, 2));
    return 0;
  }

  if (command === "health") {
    requirePaths(command, paths, 1);
    const config = loadConfig(resolve(paths[0]));
    const report = await checkEvalCases(config.healthCases ?? config.cases, {
      evaluatorArtifacts: config.evaluatorArtifacts,
      corpusPolicy: config.corpusPolicy,
      graderHealthProbes: config.graderHealthProbes,
    });
    io.stdout(JSON.stringify({ ...report, healthScope: config.healthCases ? "corpus" : "selected-cases", executionCoverage: config.executionCoverage }, null, 2));
    return report.publicationReady ? 0 : 1;
  }

  if (command === "triage") {
    requirePaths(command, paths, 2);
    const journal = new RunJournal(resolve(paths[0]));
    const candidates = createEvalCandidatePackages(await journal.list());
    writeJson(resolve(paths[1]), { schemaVersion: 1, generatedAt: new Date().toISOString(), candidates });
    io.stdout(`Wrote ${candidates.length} draft eval candidates to ${resolve(paths[1])}`);
    return 0;
  }

  if (command === "dataset-export") {
    requirePaths(command, paths, 2);
    const config = loadConfig(resolve(paths[0]));
    const dataset = exportPortableDataset(config.cases);
    writeJson(resolve(paths[1]), dataset);
    io.stdout(`Wrote ${dataset.cases.length} portable eval cases to ${resolve(paths[1])}`);
    return 0;
  }

  if (command === "dataset-import") {
    requirePaths(command, paths, 2);
    const source: unknown = JSON.parse(readFileSync(resolve(paths[0]), "utf8"));
    const cases = importPortableDataset(source);
    writeJson(resolve(paths[1]), { schemaVersion: 1, cases });
    io.stdout(`Imported ${cases.length} portable eval cases to ${resolve(paths[1])}`);
    return 0;
  }

  if (command === "run") {
    const runArgs = parseRunArgs(paths);
    const config = loadConfig(resolve(runArgs.config));
    config.validateExecution?.();
    if (config.executionCoverage) io.stdout(JSON.stringify({ executionCoverage: config.executionCoverage }, null, 2));
    const report = await new HarnessMatrixRunner(config.createExecutor, {
      executionPolicy: config.executionPolicy,
      corpusCases: config.healthCases,
      executionCoverage: config.executionCoverage,
      evaluatorVersion: config.evaluatorVersion,
      evaluatorArtifacts: config.evaluatorArtifacts,
      rubricGrader: config.rubricGrader,
      rubricCalibration: config.rubricCalibration,
      ...config.matrix,
      ...(runArgs.diagnosticsDir ? { diagnosticsStore: new HarnessDiagnosticArtifactStore(resolve(runArgs.diagnosticsDir)) } : {}),
      ...(runArgs.resume ? { progressStore: new FileHarnessMatrixProgressStore(resolve(runArgs.resume)) } : {}),
    }).run(config.cases, config.targets, config.variants);
    writeJson(resolve(runArgs.report), report);
    io.stdout(`Wrote ${report.cells.length} matrix cells to ${resolve(runArgs.report)}`);
    return 0;
  }

  if (command === "diff") {
    const diffArgs = parseDiffArgs(paths);
    const baseline = loadReport(resolve(diffArgs.baseline));
    const candidate = loadReport(resolve(diffArgs.candidate));
    const thresholds = diffArgs.policy ? loadThresholds(resolve(diffArgs.policy)) : undefined;
    const diff = diffHarnessReports(baseline, candidate, thresholds);
    const serialized = JSON.stringify(diff, null, 2);
    if (diffArgs.output) writeJson(resolve(diffArgs.output), diff);
    else io.stdout(serialized);
    return diff.passed ? 0 : 1;
  }

  if (command === "inspect") {
    const inspectArgs = parseInspectionArgs(paths, false);
    const report = loadReport(resolve(inspectArgs.report));
    const baseline = inspectArgs.baseline ? loadReport(resolve(inspectArgs.baseline)) : undefined;
    const inspection = inspectHarnessTrial(report, inspectArgs.selector, baseline,
      inspectArgs.diagnosticsDir ? { store: new HarnessDiagnosticArtifactStore(resolve(inspectArgs.diagnosticsDir)) } : undefined);
    io.stdout(JSON.stringify(inspection, null, 2));
    return 0;
  }

  if (command === "export") {
    const exportArgs = parseInspectionArgs(paths, true);
    const report = loadReport(resolve(exportArgs.report));
    const baseline = exportArgs.baseline ? loadReport(resolve(exportArgs.baseline)) : undefined;
    const inspection = inspectHarnessTrial(report, exportArgs.selector, baseline,
      exportArgs.diagnosticsDir ? { store: new HarnessDiagnosticArtifactStore(resolve(exportArgs.diagnosticsDir)) } : undefined);
    const output = resolve(exportArgs.output!);
    if (exportArgs.format === "html") writeText(output, renderTrialInspectionHtml(inspection));
    else writeJson(output, inspection);
    io.stdout(`Wrote ${exportArgs.format.toUpperCase()} trial inspection to ${output}`);
    return 0;
  }

  io.stderr("Usage: eval <run CONFIG REPORT [--resume PROGRESS] [--diagnostics-dir DIR] | dry-run CONFIG | preflight CONFIG BASELINE [--policy POLICY] | health CONFIG | triage JOURNAL_ROOT OUTPUT | dataset-export CONFIG OUTPUT | dataset-import INPUT OUTPUT | diff BASELINE CANDIDATE [OUTPUT] [--policy POLICY] | inspect REPORT [SELECTORS] [--diagnostics-dir DIR] | export REPORT OUTPUT [SELECTORS] [--format json|html] [--diagnostics-dir DIR]>");
  return 2;
}

function loadHarnessConfig(path: string): HarnessEvalConfig {
  const loaded: unknown = require(path);
  const config = isRecord(loaded) && "default" in loaded ? loaded.default : loaded;
  if (!isHarnessEvalConfig(config)) throw new Error(`Invalid harness config: ${path}`);
  return config;
}

function isHarnessEvalConfig(value: unknown): value is HarnessEvalConfig {
  return isRecord(value)
    && Array.isArray(value.cases)
    && Array.isArray(value.targets)
    && Array.isArray(value.variants)
    && typeof value.createExecutor === "function";
}

function readReport(path: string): HarnessMatrixReport {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.manifest) || !Array.isArray(value.cells)) {
    throw new Error(`Invalid harness report: ${path}`);
  }
  return value as unknown as HarnessMatrixReport;
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function requirePaths(command: string, paths: string[], minimum: number, maximum = minimum): void {
  if (paths.length < minimum || paths.length > maximum || paths.some((path) => !path.trim())) {
    throw new Error(`Invalid arguments for eval ${command}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (require.main === module) {
  void runEvalCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}

function readThresholds(path: string): HarnessRegressionThresholds {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`Invalid harness threshold policy: ${path}`);
  validateThresholdFields(value, path, true);
  if (value.suites !== undefined) {
    if (!isRecord(value.suites)) throw new Error(`Invalid harness threshold policy: ${path}`);
    const suites = new Set(["regression", "capability", "challenge"]);
    for (const [suite, suitePolicy] of Object.entries(value.suites)) {
      if (!suites.has(suite) || !isRecord(suitePolicy)) {
        throw new Error(`Invalid harness threshold policy: ${path}`);
      }
      validateThresholdFields(suitePolicy, path, false);
    }
  }
  return value as HarnessRegressionThresholds;
}

function validateThresholdFields(value: Record<string, unknown>, path: string, allowResources: boolean): void {
  const resourceFields = [
    "maxTokenIncrease",
    "maxCostIncreaseUsd",
    "maxDurationIncreaseMs",
    "maxActionIncrease",
    "minProcessDelta",
  ];
  const allowed = new Set([
    ...(allowResources ? resourceFields : []),
    "minimumRepetitions",
    "minimumPairedCells",
    "minimumPairedCases",
    "confidenceLevel",
    "nonInferiorityMargin",
    "minimumDetectableRegression",
    ...(allowResources ? ["suites", "requireFullCoverage"] : []),
  ]);
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid harness threshold policy: ${path}`);
    }
    if (key === "suites") continue;
    if (key === "requireFullCoverage") {
      if (typeof item !== "boolean") throw new Error(`Invalid harness threshold policy: ${path}`);
      continue;
    }
    if (typeof item !== "number" || !Number.isFinite(item)) throw new Error(`Invalid harness threshold policy: ${path}`);
    if (key === "minProcessDelta" && (item < -1 || item > 1)) {
      throw new Error(`Invalid harness threshold policy: ${path}`);
    }
    if ((key === "minimumRepetitions" || key === "minimumPairedCells" || key === "minimumPairedCases")
      && (!Number.isInteger(item) || item < 1)) {
      throw new Error(`Invalid harness threshold policy: ${path}`);
    }
    if (key === "confidenceLevel" && item !== 0.95) throw new Error(`Invalid harness threshold policy: ${path}`);
    if ((key === "nonInferiorityMargin" || key === "minimumDetectableRegression") && (item < 0 || item > 1)) {
      throw new Error(`Invalid harness threshold policy: ${path}`);
    }
    if (resourceFields.includes(key) && key !== "minProcessDelta" && item < 0) {
      throw new Error(`Invalid harness threshold policy: ${path}`);
    }
  }
}

function parseDiffArgs(paths: string[]): { baseline: string; candidate: string; output?: string; policy?: string } {
  if (paths.length < 2 || paths.some((path) => !path.trim())) throw new Error("Invalid arguments for eval diff");
  const positional = paths.slice(0, 2);
  const remaining = paths.slice(2);
  const policyIndex = remaining.indexOf("--policy");
  let policy: string | undefined;
  if (policyIndex >= 0) {
    policy = remaining[policyIndex + 1];
    if (!policy || remaining.indexOf("--policy", policyIndex + 1) >= 0) throw new Error("Invalid arguments for eval diff");
    remaining.splice(policyIndex, 2);
  }
  if (remaining.length > 1 || remaining.some((path) => path.startsWith("--"))) {
    throw new Error("Invalid arguments for eval diff");
  }
  return { baseline: positional[0], candidate: positional[1], output: remaining[0], policy };
}

export function summarizeCaseCoverage(cases: readonly EvalCase[]): HarnessCaseCoverage {
  return {
    cases: cases.length,
    metadataComplete: cases.filter((testCase) =>
      testCase.suite !== undefined
      && testCase.split !== undefined
      && testCase.family !== undefined
      && testCase.provenance !== undefined).length,
    bySuite: countBy(cases, (testCase) => testCase.suite),
    bySplit: countBy(cases, (testCase) => testCase.split),
    byFamily: countBy(cases, (testCase) => testCase.family),
    byProfile: countBy(cases, (testCase) => testCase.profile),
    byDifficulty: countBy(cases, (testCase) => testCase.difficulty),
    byCapability: countValues(cases.flatMap((testCase) => testCase.allowedCapabilities)),
    byCheckKind: countValues(cases.flatMap((testCase) => testCase.checks.map((check) => check.kind))),
  };
}

function countBy<T>(values: readonly T[], selectKey: (value: T) => string | undefined): Record<string, number> {
  return countValues(values.map(selectKey).filter((key): key is string => key !== undefined));
}

function countValues(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

interface InspectionCliArgs {
  report: string;
  output?: string;
  baseline?: string;
  diagnosticsDir?: string;
  format: "json" | "html";
  selector: HarnessTrialSelector;
}

function parseInspectionArgs(paths: string[], exporting: boolean): InspectionCliArgs {
  const positionalCount = exporting ? 2 : 1;
  if (paths.length < positionalCount || paths.slice(0, positionalCount).some((path) => !path.trim() || path.startsWith("--"))) {
    throw new Error(`Invalid arguments for eval ${exporting ? "export" : "inspect"}`);
  }
  const result: InspectionCliArgs = {
    report: paths[0],
    ...(exporting ? { output: paths[1] } : {}),
    format: "json",
    selector: {},
  };
  const options = paths.slice(positionalCount);
  const seen = new Set<string>();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || seen.has(flag)) {
      throw new Error(`Invalid arguments for eval ${exporting ? "export" : "inspect"}`);
    }
    seen.add(flag);
    if (flag === "--case") result.selector.caseId = value;
    else if (flag === "--target") result.selector.targetId = value;
    else if (flag === "--variant") result.selector.variantId = value;
    else if (flag === "--repetition") {
      const repetition = Number(value);
      if (!Number.isSafeInteger(repetition) || repetition < 0) throw new Error("Invalid eval trial repetition");
      result.selector.repetition = repetition;
    } else if (flag === "--baseline") result.baseline = value;
    else if (flag === "--diagnostics-dir") result.diagnosticsDir = value;
    else if (flag === "--format" && exporting && (value === "json" || value === "html")) result.format = value;
    else throw new Error(`Invalid arguments for eval ${exporting ? "export" : "inspect"}`);
  }
  return result;
}

function parseRunArgs(args: string[]): { config: string; report: string; resume?: string; diagnosticsDir?: string } {
  const [config, report] = args;
  if (!config?.trim() || !report?.trim() || config.startsWith("--") || report.startsWith("--")) {
    throw new Error("Invalid arguments for eval run");
  }
  const result: { config: string; report: string; resume?: string; diagnosticsDir?: string } = { config, report };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value?.trim() || value.startsWith("--") || seen.has(flag)) throw new Error("Invalid arguments for eval run");
    seen.add(flag);
    if (flag === "--resume") result.resume = value;
    else if (flag === "--diagnostics-dir") result.diagnosticsDir = value;
    else throw new Error("Invalid arguments for eval run");
  }
  return result;
}

function parsePreflightArgs(paths: string[]): { config: string; baseline: string; policy?: string } {
  if (paths.length !== 2 && paths.length !== 4) throw new Error("Invalid arguments for eval preflight");
  const [config, baseline, flag, policy] = paths;
  if (!config?.trim() || !baseline?.trim() || (paths.length === 4 && (flag !== "--policy" || !policy?.trim()))) {
    throw new Error("Invalid arguments for eval preflight");
  }
  return { config, baseline, ...(policy ? { policy } : {}) };
}

function assertBaselineCellsMatchConfig(baseline: HarnessMatrixReport, config: HarnessEvalConfig): void {
  const expected = new Set<string>();
  for (const target of config.targets) {
    for (const variant of config.variants) {
      for (const testCase of config.cases) {
        for (let repetition = 0; repetition < (testCase.repetitions ?? 1); repetition++) {
          expected.add(`${target.id}\u0000${variant.id}\u0000${testCase.id}\u0000${repetition}`);
        }
      }
    }
  }
  const actual = new Set(baseline.cells.map((cell) =>
    `${cell.targetId}\u0000${cell.variantId}\u0000${cell.caseId}\u0000${cell.repetition}`));
  if (actual.size !== baseline.cells.length) throw new Error("Baseline report contains duplicate matrix cells");
  if (expected.size !== actual.size || [...expected].some((key) => !actual.has(key))) {
    throw new Error(`Baseline report has ${actual.size} matrix cells; requested config requires ${expected.size}`);
  }
}
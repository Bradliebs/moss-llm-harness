import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import type {
  EvalCase,
  EvalDifficulty,
  EvalModelTarget,
  EvalPerturbationClass,
  EvalProfile,
  HarnessAggregateMetrics,
  HarnessMatrixCellResult,
  HarnessMatrixManifest,
  HarnessMatrixReport,
  HarnessRubricHumanLabels,
  HarnessVariant,
} from "../../../../common/evals";
import { VerificationRegistry } from "../verify/verification-registry";
import { type EvalExecutionResult, type EvalExecutor, EvalRunner, validateCase } from "./eval-runner";
import { scoreHarnessRun } from "./harness-scoring";
import { countFailureAttributions } from "./failure-attribution";
import {
  measureRubricAgreement,
  type EvalRubricCalibrationPolicy,
  type EvalRubricGrader,
} from "./rubric-grading";
import { summarizeReliability } from "./statistics";
import { HarnessDiagnosticArtifactStore, HarnessDiagnosticCapture } from "./diagnostic-artifact-store";
import { DockerEvalSandboxBackend, SandboxCleanupError } from "./sandbox-backend";
import { validateExecutionCoverage } from "./execution-selection";
import { validateSplitExecution } from "./split-policy";
import { summarizeCorpusDiagnostics } from "./corpus-diagnostics";

export type MatrixExecutorFactory = (
  target: EvalModelTarget,
  variant: HarnessVariant,
  workspaceRoot: string,
  context?: { signal?: AbortSignal; diagnostics?: HarnessDiagnosticCapture },
) => EvalExecutor;

export interface HarnessMatrixRunnerOptions {
  executionPolicy?: HarnessMatrixManifest["executionPolicy"];
  corpusCases?: readonly EvalCase[];
  executionCoverage?: HarnessMatrixManifest["executionCoverage"];
  temporaryRoot?: string;
  now?: () => Date;
  registry?: VerificationRegistry;
  evaluatorVersion?: string;
  evaluatorArtifacts?: string[];
  rubricGrader?: EvalRubricGrader;
  rubricCalibration?: {
    humanLabels: readonly HarnessRubricHumanLabels[];
    policy?: EvalRubricCalibrationPolicy;
  };
  maxConcurrency?: number;
  providerConcurrency?: Record<string, number>;
  signal?: AbortSignal;
  progressStore?: HarnessMatrixProgressStore;
  diagnosticsStore?: HarnessDiagnosticArtifactStore;
  retryInfrastructureFailures?: boolean;
}

export interface HarnessMatrixProgress {
  schemaVersion: 1;
  manifest: HarnessMatrixManifest;
  cells: HarnessMatrixCellResult[];
}

export interface HarnessMatrixProgressStore {
  load(): Promise<HarnessMatrixProgress | undefined>;
  save(progress: HarnessMatrixProgress): Promise<void>;
}

export function validateInfrastructureRetries(cell: HarnessMatrixCellResult): void {
  if (cell.infrastructureRetries === undefined) return;
  const history: unknown = cell.infrastructureRetries;
  if (!Array.isArray(history)) throw new Error("Invalid infrastructure retry history");
  const current = cell.result.observation;
  const runIds = new Set([current.runId]);
  let previousTime = -Infinity;
  const completedTime = Date.parse(current.completedAt);
  if (!Number.isFinite(completedTime)) throw new Error("Invalid infrastructure retry completion time");
  for (const entry of history) {
    if (!entry || typeof entry !== "object"
      || typeof entry.runId !== "string" || !entry.runId.trim() || runIds.has(entry.runId)
      || typeof entry.completedAt !== "string") {
      throw new Error("Invalid infrastructure retry identity");
    }
    const time = Date.parse(entry.completedAt);
    if (!Number.isFinite(time) || time < previousTime || time > completedTime) {
      throw new Error("Invalid infrastructure retry ordering");
    }
    if (entry.diagnostics !== undefined && (!entry.diagnostics || typeof entry.diagnostics !== "object"
      || entry.diagnostics.schemaVersion !== 1 || typeof entry.diagnostics.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.diagnostics.sha256))) {
      throw new Error("Invalid infrastructure retry diagnostic reference");
    }
    runIds.add(entry.runId);
    previousTime = time;
  }
}

/** Expands model, harness, case, and repetition axes into isolated executions. */
export class HarnessMatrixRunner {
  private readonly temporaryRoot: string;
  private readonly now: () => Date;
  private readonly registry: VerificationRegistry;
  private readonly evaluatorVersion: string;
  private readonly evaluatorArtifacts: string[];
  private readonly rubricGrader?: EvalRubricGrader;
  private readonly rubricCalibration?: HarnessMatrixRunnerOptions["rubricCalibration"];
  private readonly maxConcurrency: number;
  private readonly providerConcurrency: Record<string, number>;
  private readonly signal?: AbortSignal;
  private readonly progressStore?: HarnessMatrixProgressStore;
  private readonly diagnosticsStore?: HarnessDiagnosticArtifactStore;
  private readonly retryInfrastructureFailures: boolean;
  private readonly executionCoverage?: HarnessMatrixManifest["executionCoverage"];
  private readonly executionPolicy: NonNullable<HarnessMatrixManifest["executionPolicy"]>;
  private readonly corpusCases?: readonly EvalCase[];

  constructor(
    private readonly createExecutor: MatrixExecutorFactory,
    options: HarnessMatrixRunnerOptions = {},
  ) {
    this.temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.now = options.now ?? (() => new Date());
    this.registry = options.registry ?? new VerificationRegistry();
    this.evaluatorVersion = options.evaluatorVersion ?? "moss-harness-v1";
    this.evaluatorArtifacts = options.evaluatorArtifacts ?? [];
    this.rubricGrader = options.rubricGrader;
    this.rubricCalibration = options.rubricCalibration;
    this.maxConcurrency = positiveInteger(options.maxConcurrency ?? 1, "maxConcurrency");
    this.providerConcurrency = Object.fromEntries(Object.entries(options.providerConcurrency ?? {}).map(([providerId, limit]) => [
      providerId,
      positiveInteger(limit, `providerConcurrency.${providerId}`),
    ]));
    this.signal = options.signal;
    this.progressStore = options.progressStore;
    this.diagnosticsStore = options.diagnosticsStore;
    this.retryInfrastructureFailures = options.retryInfrastructureFailures === true;
    this.executionCoverage = options.executionCoverage;
    this.executionPolicy = structuredClone(options.executionPolicy ?? { purpose: "iteration" });
    this.corpusCases = options.corpusCases;
    if (this.rubricCalibration && !this.rubricGrader) {
      throw new Error("Rubric calibration requires a rubric grader");
    }
  }

  async run(
    cases: readonly EvalCase[],
    targets: readonly EvalModelTarget[],
    variants: readonly HarnessVariant[],
  ): Promise<HarnessMatrixReport> {
    validateHarnessMatrix(cases, targets, variants);
    const manifest = buildHarnessManifest(cases, targets, variants, this.evaluatorVersion, this.evaluatorArtifacts, this.executionCoverage, this.executionPolicy, this.corpusCases);
    const jobs: Array<{ testCase: EvalCase; target: EvalModelTarget; variant: HarnessVariant; repetition: number }> = [];
    for (const target of targets) {
      for (const variant of variants) {
        for (const testCase of cases) {
          const repetitions = testCase.repetitions ?? 1;
          for (let repetition = 0; repetition < repetitions; repetition++) {
            jobs.push({ testCase, target, variant, repetition });
          }
        }
      }
    }
    const resumed = await this.progressStore?.load();
    if (resumed && !compatibleProgressManifest(resumed.manifest, manifest)) {
      throw new Error("Harness progress manifest is incompatible with the requested matrix");
    }
    const jobKeys = new Set(jobs.map(matrixJobKey));
    const cellsByKey = new Map<string, HarnessMatrixCellResult>();
    for (const cell of resumed?.cells ?? []) {
      validateInfrastructureRetries(cell);
      const key = matrixCellKey(cell);
      if (!jobKeys.has(key) || cellsByKey.has(key)) {
        throw new Error("Harness progress contains an invalid or duplicate matrix cell");
      }
      if (this.diagnosticsStore) {
        if (!cell.diagnostics) throw new Error("Resumed cell has no diagnostic artifact; use a fresh run for capture");
        this.diagnosticsStore.read(cell.diagnostics);
        for (const attempt of cell.infrastructureRetries ?? []) {
          if (attempt.diagnostics) this.diagnosticsStore.read(attempt.diagnostics);
        }
      }
      cellsByKey.set(key, cell);
    }
    const pending = jobs.filter((job) => {
      const previous = cellsByKey.get(matrixJobKey(job));
      return !previous || (this.retryInfrastructureFailures
        && previous.result.failureAttribution?.reasonCode === "matrix-cell-infrastructure-error");
    });
    const providerLimiter = new ProviderConcurrencyLimiter(this.providerConcurrency);
    let progressSave = Promise.resolve();
    let fatalCleanup: SandboxCleanupError | undefined;
    await mapWithConcurrency(pending, this.maxConcurrency, async (job) => {
      throwIfAborted(this.signal);
      const cell = await providerLimiter.run(job.target.providerId, async () => {
      if (fatalCleanup) throw fatalCleanup;
        const diagnostics = this.diagnosticsStore ? new HarnessDiagnosticCapture() : undefined;
        diagnostics?.append("trial", { caseId: job.testCase.id, targetId: job.target.id, variantId: job.variant.id, repetition: job.repetition });
        let completed: HarnessMatrixCellResult;
        try {
          completed = await this.runCell(job.testCase, job.target, job.variant, job.repetition, diagnostics);
        } catch (error) {
          if (error instanceof SandboxCleanupError) {
            fatalCleanup = error;
            throw error;
          }
          diagnostics?.append("infrastructure-error", error);
          completed = this.infrastructureFailureCell(job.testCase, job.target, job.variant, job.repetition, error);
        }
        const previous = cellsByKey.get(matrixJobKey(job));
        if (previous) completed.infrastructureRetries = [
          ...(previous.infrastructureRetries ?? []),
          { runId: previous.result.observation.runId, completedAt: previous.result.observation.completedAt,
            ...(previous.diagnostics ? { diagnostics: previous.diagnostics } : {}) },
        ];
        if (diagnostics && this.diagnosticsStore) {
          diagnostics.append("evaluation", completed.result);
          completed.diagnostics = this.diagnosticsStore.write(diagnostics);
        }
        return completed;
      });
      cellsByKey.set(matrixCellKey(cell), cell);
      if (this.progressStore) {
        const progress = { schemaVersion: 1 as const, manifest, cells: [...cellsByKey.values()] };
        progressSave = progressSave.then(() => this.progressStore!.save(progress));
        await progressSave;
      }
    });
    throwIfAborted(this.signal);
    const cells = jobs.map((job) => cellsByKey.get(matrixJobKey(job))!);

    const completedManifest = buildHarnessManifest(cases, targets, variants, this.evaluatorVersion, this.evaluatorArtifacts, this.executionCoverage, this.executionPolicy, this.corpusCases);
    const invariantHashes = ["evaluatorArtifactHash", "caseSetHash", "targetSetHash", "variantSetHash", "splitCorpusHash"] as const;
    const changedHash = invariantHashes.find((key) => manifest[key] !== completedManifest[key]);
    if (changedHash) {
      throw new Error(`Harness input '${changedHash}' changed during the run`);
    }
    const rubricCalibration = this.rubricCalibration
      ? calibrateHarnessRubrics(cells, this.rubricCalibration.humanLabels, this.rubricCalibration.policy)
      : undefined;
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      manifest,
      cells,
      summary: summarizeHarnessMatrix(cells, cases, this.executionCoverage?.selection === "full" && this.executionCoverage.excluded.length === 0),
      ...(rubricCalibration ? { rubricCalibration } : {}),
    };
  }

  private infrastructureFailureCell(
    testCase: EvalCase,
    target: EvalModelTarget,
    variant: HarnessVariant,
    repetition: number,
    error: unknown,
  ): HarnessMatrixCellResult {
    const timestamp = this.now().toISOString();
    void error;
    return {
      caseId: testCase.id,
      targetId: target.id,
      variantId: variant.id,
      repetition,
      result: {
        observation: {
          caseId: testCase.id,
          runId: `${testCase.id}-${target.id}-${variant.id}-${repetition}-infrastructure-error-${randomUUID()}`,
          provider: target.providerKind,
          model: target.model,
          outcome: "failed",
          failureReason: "Matrix cell infrastructure failure",
          startedAt: timestamp,
          completedAt: timestamp,
          evidence: [],
          usage: {},
          estimatedCostUsd: 0,
          admissions: [],
        },
        criteria: testCase.task.acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.id,
          mandatory: criterion.mandatory,
          passed: false,
          summary: "Matrix cell did not execute",
          checks: [],
        })),
        success: false,
        score: 0,
        durationMs: 0,
        failureAttribution: {
          category: "harness-orchestration",
          reasonCode: "matrix-cell-infrastructure-error",
          diagnostic: true,
        },
      },
      protectedInputHashesBefore: {},
      protectedInputHashesAfter: {},
      protectedInputsIntact: false,
    };
  }

  private async runCell(
    testCase: EvalCase,
    target: EvalModelTarget,
    variant: HarnessVariant,
    repetition: number,
    diagnostics?: HarnessDiagnosticCapture,
  ): Promise<HarnessMatrixCellResult> {
    const workspaceRoot = mkdtempSync(join(this.temporaryRoot, "moss-eval-"));
    let execution: EvalExecutionResult | undefined;
    let cleanupFailure: SandboxCleanupError | undefined;
    try {
      if (testCase.fixture?.workspaceTemplate) {
        cpSync(testCase.fixture.workspaceTemplate, workspaceRoot, { recursive: true });
      }
      const protectedPaths = testCase.benchmark?.security?.protectedPaths ?? [];
      const protectedInputHashesBefore = hashProtectedInputs(workspaceRoot, protectedPaths);
      const execute = this.createExecutor(
        structuredClone(target),
        structuredClone(variant),
        workspaceRoot,
        { signal: this.signal, ...(diagnostics ? { diagnostics } : {}) },
      );
      const captureExecution: EvalExecutor = async (isolatedCase, _ignoredRepetition) => {
        try { execution = await execute(isolatedCase, repetition); }
        catch (error) {
          if (error instanceof SandboxCleanupError) cleanupFailure = error;
          throw error;
        }
        if (resolve(execution.workspaceRoot) !== resolve(workspaceRoot)) {
          throw new Error(`Matrix executor escaped isolated workspace for case '${testCase.id}'`);
        }
        return execution;
      };
      const report = await new EvalRunner(captureExecution, {
        executionPolicy: this.executionPolicy,
        now: this.now,
        registry: this.registry,
        rubricGrader: this.rubricGrader,
      }).run([{ ...structuredClone(testCase), repetitions: 1 }]);
      if (cleanupFailure) throw cleanupFailure;
      const result = report.results[0];
      if (!result || !execution) throw new Error(`Matrix cell '${testCase.id}' produced no result`);
      const protectedInputHashesAfter = hashProtectedInputs(workspaceRoot, protectedPaths);
      const protectedInputsIntact = equalHashes(protectedInputHashesBefore, protectedInputHashesAfter);
      const harnessScore = execution.trace
        ? scoreHarnessRun(testCase, result, execution.trace, protectedPaths.length > 0 ? protectedInputsIntact : undefined)
        : undefined;
      if (harnessScore && !harnessScore.securityPassed && !result.failureAttribution) {
        result.failureAttribution = {
          category: "agent-behavior",
          reasonCode: "security-policy-violation",
          diagnostic: true,
        };
      }
      return {
        caseId: testCase.id,
        targetId: target.id,
        variantId: variant.id,
        repetition,
        result,
        trace: execution.trace,
        diagnosticReview: execution.diagnosticReview,
        promptProvenance: execution.promptProvenance,
        harnessScore,
        protectedInputHashesBefore,
        protectedInputHashesAfter,
        protectedInputsIntact,
      };
    } finally {
      if (!cleanupFailure) rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }
}

export function validateHarnessMatrix(
  cases: readonly EvalCase[],
  targets: readonly EvalModelTarget[],
  variants: readonly HarnessVariant[],
): void {
  if (cases.length === 0 || targets.length === 0 || variants.length === 0) {
    throw new Error("Harness matrix requires at least one case, target, and variant");
  }
  for (const testCase of cases) validateCase(testCase);
  validateUniqueIds("case", cases);
  validateUniqueIds("model target", targets);
  validateUniqueIds("harness variant", variants);
  for (const target of targets) {
    if (target.schemaVersion !== 1 || !target.providerId.trim() || !target.model.trim()) {
      throw new Error(`Invalid model target '${target.id}'`);
    }
    if (target.generation?.maxOutputTokens !== undefined
      && (!Number.isInteger(target.generation.maxOutputTokens) || target.generation.maxOutputTokens < 1)) {
      throw new Error(`Model target '${target.id}' has an invalid max output token limit`);
    }
    if (target.generation?.reasoningEffort !== undefined
      && (target.generation.reasoningEffort !== "none" || target.providerKind !== "openai-compatible")) {
      throw new Error(`Model target '${target.id}' has an unsupported reasoning effort configuration`);
    }
  }
  for (const variant of variants) {
    if (variant.sandbox) {
      new DockerEvalSandboxBackend({ image: variant.sandbox.image });
      if (variant.sandbox.allowNetwork !== undefined && typeof variant.sandbox.allowNetwork !== "boolean") {
        throw new Error("Sandbox allowNetwork must be boolean");
      }
    }
    if (variant.schemaVersion !== 1 || !variant.description.trim()) {
      throw new Error(`Invalid harness variant '${variant.id}'`);
    }
    if (variant.promptProfile !== undefined && !/^[a-zA-Z0-9._-]{1,128}$/.test(variant.promptProfile)) {
      throw new Error(`Harness variant '${variant.id}' has an invalid prompt profile`);
    }
    if (variant.contextLimit !== undefined && (!Number.isInteger(variant.contextLimit) || variant.contextLimit < 1)) {
      throw new Error(`Harness variant '${variant.id}' has an invalid context limit`);
    }
    if (variant.runtime) {
      const controls = variant.runtime;
      if (!["full", "compact"].includes(controls.contextStrategy)
        || !["free-form", "incremental"].includes(controls.planningPolicy)
        || !["terminal", "after-mutation"].includes(controls.verificationCadence)
        || !["standard", "signature-aware"].includes(controls.recoveryPolicy)
        || !["off", "diagnostic"].includes(controls.reviewerPass)) {
        throw new Error(`Harness variant '${variant.id}' has invalid runtime controls`);
      }
      if (controls.contextStrategy === "compact" && variant.contextLimit === undefined) {
        throw new Error(`Harness variant '${variant.id}' requires a positive context limit for compact context`);
      }
    }
  }
  const variantBudgets = new Set(variants.map((variant) => JSON.stringify(canonicalize(variant.budget ?? null))));
  if (variantBudgets.size > 1) {
    throw new Error("Compared harness variants must use the same execution budget");
  }
}

function validateUniqueIds(label: string, values: readonly { id: string }[]): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value.id) || ids.has(value.id)) {
      throw new Error(`Harness matrix ${label} ids must be unique safe identifiers`);
    }
    ids.add(value.id);
  }
}

function hashProtectedInputs(workspaceRoot: string, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path.replace(/\\/g, "/"), hashWorkspacePath(workspaceRoot, path)]));
}

function hashWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Protected path escapes isolated workspace");
  if (!existsSync(target)) return "missing";
  const hash = createHash("sha256");
  appendPathToHash(hash, target, basename(target));
  return hash.digest("hex");
}

function appendPathToHash(hash: ReturnType<typeof createHash>, path: string, label: string): void {
  const stat = lstatSync(path);
  hash.update(label);
  if (stat.isSymbolicLink()) {
    throw new Error(`Protected input '${label}' must not be a symbolic link`);
  }
  if (stat.isDirectory()) {
    for (const child of readdirSync(path).sort()) appendPathToHash(hash, join(path, child), `${label}/${child}`);
    return;
  }
  hash.update(readFileSync(path));
}

function equalHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function fingerprintCases(cases: readonly EvalCase[]): string {
  return stableHash(cases.map((testCase) => ({
    ...testCase,
    fixture: testCase.fixture
      ? {
        ...testCase.fixture,
        workspaceTemplate: testCase.fixture.workspaceTemplate
          ? hashExternalPath(testCase.fixture.workspaceTemplate)
          : undefined,
        referenceSolution: testCase.fixture.referenceSolution
          ? hashExternalPath(testCase.fixture.referenceSolution)
          : undefined,
      }
      : undefined,
  })));
}

function hashExternalPath(path: string): string {
  if (!existsSync(path)) throw new Error(`Eval fixture template does not exist: ${path}`);
  const hash = createHash("sha256");
  appendPathToHash(hash, resolve(path), ".");
  return hash.digest("hex");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function buildHarnessManifest(
  cases: readonly EvalCase[],
  targets: readonly EvalModelTarget[],
  variants: readonly HarnessVariant[],
  evaluatorVersion = "moss-harness-v1",
  evaluatorArtifacts: readonly string[] = [],
  executionCoverage?: HarnessMatrixManifest["executionCoverage"],
  executionPolicy: NonNullable<HarnessMatrixManifest["executionPolicy"]> = { purpose: "iteration" },
  corpusCases: readonly EvalCase[] = cases,
): HarnessMatrixManifest {
  validateHarnessMatrix(cases, targets, variants);
  validateSplitExecution(cases, executionPolicy, corpusCases);
  if (executionCoverage) validateExecutionCoverage(executionCoverage, cases.map((testCase) => testCase.id));
  if (executionCoverage && (executionCoverage.corpusCaseIds.length !== corpusCases.length
    || corpusCases.some((testCase) => !executionCoverage.corpusCaseIds.includes(testCase.id)))) {
    throw new Error("Split checks require the complete declared source corpus");
  }
  if (!evaluatorVersion.trim()) throw new Error("Harness evaluator version is required");
  return {
    ...(executionCoverage ? { executionCoverage: structuredClone(executionCoverage) } : {}),
    executionPolicy: structuredClone(executionPolicy),
    splitCorpusHash: stableHash(corpusCases.map((testCase) => ({
      id: testCase.id, split: testCase.split, family: testCase.family,
      lineage: testCase.lineage, objective: testCase.task.objective,
    }))),
    evaluatorVersion,
    caseIds: cases.map((testCase) => testCase.id),
    caseSuites: Object.fromEntries(cases
      .filter((testCase) => testCase.suite)
      .map((testCase) => [testCase.id, testCase.suite!])),
    caseFamilies: Object.fromEntries(cases
      .filter((testCase) => testCase.family)
      .map((testCase) => [testCase.id, testCase.family!])),
    targetIds: targets.map((target) => target.id),
    variantIds: variants.map((variant) => variant.id),
    promptProfiles: [...new Set(variants
      .map((variant) => variant.promptProfile)
      .filter((profile): profile is string => Boolean(profile)))],
    targetConfigurations: structuredClone(targets),
    variantConfigurations: structuredClone(variants),
    scenarioPlanHash: stableHash(cases.map((testCase) => ({ id: testCase.id, scenario: testCase.scenario ?? null }))),
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      ...(process.env.MOSS_SOURCE_REVISION || process.env.GITHUB_SHA
        ? { sourceRevision: process.env.MOSS_SOURCE_REVISION ?? process.env.GITHUB_SHA }
        : {}),
    },
    ...(process.env.MOSS_SANDBOX_IMAGE_DIGEST
      ? { sandboxImageDigest: process.env.MOSS_SANDBOX_IMAGE_DIGEST }
      : {}),
    evaluatorArtifactHash: fingerprintEvaluatorArtifacts(evaluatorArtifacts),
    caseSetHash: fingerprintCases(cases),
    targetSetHash: stableHash(targets),
    variantSetHash: stableHash(variants),
  };
}

export function summarizeHarnessMatrix(
  cells: readonly HarnessMatrixCellResult[],
  cases: readonly EvalCase[],
  fullCoverage = false,
): HarnessMatrixReport["summary"] {
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const familyByCase = new Map(cases
    .filter((testCase) => testCase.family)
    .map((testCase) => [testCase.id, testCase.family!]));
  const byTargetVariant = groupMetrics(cells, (cell) => `${cell.targetId}/${cell.variantId}`);
  const byProfile = groupMetrics(cells, (cell) => casesById.get(cell.caseId)?.profile) as Partial<
    Record<EvalProfile, HarnessAggregateMetrics>
  >;
  const byDifficulty = groupMetrics(cells, (cell) => casesById.get(cell.caseId)?.difficulty) as Partial<
    Record<EvalDifficulty, HarnessAggregateMetrics>
  >;
  const taggedCells = new Map<string, HarnessMatrixCellResult[]>();
  const familyCells = new Map<string, HarnessMatrixCellResult[]>();
  const perturbationCells = new Map<EvalPerturbationClass, HarnessMatrixCellResult[]>();
  for (const cell of cells) {
    const perturbationClass = casesById.get(cell.caseId)?.perturbation?.class;
    if (perturbationClass) {
      const group = perturbationCells.get(perturbationClass) ?? [];
      group.push(cell);
      perturbationCells.set(perturbationClass, group);
    }
    const family = casesById.get(cell.caseId)?.family;
    if (family) {
      const group = familyCells.get(family) ?? [];
      group.push(cell);
      familyCells.set(family, group);
    }
    for (const tag of casesById.get(cell.caseId)?.tags ?? []) {
      const group = taggedCells.get(tag) ?? [];
      group.push(cell);
      taggedCells.set(tag, group);
    }
  }

  return {
    overall: aggregateHarnessMetrics(cells),
    corpusDiagnostics: summarizeCorpusDiagnostics(cells, cases, fullCoverage),
    reliability: summarizeReliability(cells, familyByCase),
    byTargetVariant,
    byProfile,
    byDifficulty,
    byTag: Object.fromEntries([...taggedCells].sort(([left], [right]) => left.localeCompare(right))
      .map(([tag, group]) => [tag, aggregateHarnessMetrics(group)])),
    byPerturbationClass: Object.fromEntries([...perturbationCells].sort(([left], [right]) => left.localeCompare(right))
      .map(([perturbationClass, group]) => [perturbationClass, aggregateHarnessMetrics(group)])),
    byFamily: Object.fromEntries([...familyCells].sort(([left], [right]) => left.localeCompare(right))
      .map(([family, group]) => [family, summarizeReliability(group, familyByCase)!])),
    byCriterion: aggregateCriterionMetrics(cells),
  };
}

function aggregateCriterionMetrics(cells: readonly HarnessMatrixCellResult[]): NonNullable<HarnessMatrixReport["summary"]["byCriterion"]> {
  const groups = new Map<string, { passes: number; runs: number; mandatory: boolean }>();
  for (const cell of cells) {
    for (const criterion of cell.result.criteria) {
      const key = `${cell.targetId}/${cell.variantId}/${cell.caseId}/${criterion.criterionId}`;
      const group = groups.get(key) ?? { passes: 0, runs: 0, mandatory: criterion.mandatory };
      group.runs++;
      if (criterion.passed) group.passes++;
      group.mandatory ||= criterion.mandatory;
      groups.set(key, group);
    }
  }
  return Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => [key, {
    ...group,
    passRate: group.runs === 0 ? 0 : group.passes / group.runs,
  }]));
}

function groupMetrics(
  cells: readonly HarnessMatrixCellResult[],
  selectKey: (cell: HarnessMatrixCellResult) => string | undefined,
): Record<string, HarnessAggregateMetrics> {
  const groups = new Map<string, HarnessMatrixCellResult[]>();
  for (const cell of cells) {
    const key = selectKey(cell);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => [key, aggregateHarnessMetrics(group)]));
}

function aggregateHarnessMetrics(cells: readonly HarnessMatrixCellResult[]): HarnessAggregateMetrics {
  const scored = cells.filter((cell) => cell.harnessScore !== undefined);
  const mechanismScores = scored
    .map((cell) => cell.harnessScore?.mechanisms)
    .filter((mechanisms): mechanisms is NonNullable<typeof mechanisms> => mechanisms !== undefined);
  const recoveryEvents = cells.flatMap((cell) => cell.trace?.events.filter((event) => event.type === "recovery") ?? []);
  const recoveryAttempts = recoveryEvents.filter((event) => event.outcome === "attempted").length;
  const recoverySuccesses = recoveryEvents.filter((event) => event.outcome === "succeeded").length;
  const recoveriesByClassification: Record<string, number> = {};
  for (const event of recoveryEvents) {
    if (event.classification && event.outcome === "attempted") {
      recoveriesByClassification[event.classification] = (recoveriesByClassification[event.classification] ?? 0) + 1;
    }
  }
  const average = (values: number[]): number => values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    runs: cells.length,
    scoredRuns: scored.length,
    completions: cells.filter((cell) => cell.result.success).length,
    completionRate: cells.length === 0 ? 0 : cells.filter((cell) => cell.result.success).length / cells.length,
    securityPasses: scored.filter((cell) => cell.harnessScore?.securityPassed).length,
    securityPassRate: scored.length === 0
      ? 0
      : scored.filter((cell) => cell.harnessScore?.securityPassed).length / scored.length,
    mechanisms: aggregateMechanisms(mechanismScores),
    protectedInputsIntact: cells.filter((cell) => cell.protectedInputsIntact).length,
    averageRobustness: average(scored.map((cell) => cell.harnessScore!.process.robustness)),
    averageToolUse: average(scored.map((cell) => cell.harnessScore!.process.toolUse)),
    averageConsistency: average(scored.map((cell) => cell.harnessScore!.process.consistency)),
    averageDiagnosticComposite: average(scored.map((cell) => cell.harnessScore!.diagnosticComposite)),
    averageTokens: average(cells.map((cell) => {
      const usage = cell.result.observation.usage;
      return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    })),
    averageCostUsd: average(cells.map((cell) => cell.result.observation.estimatedCostUsd)),
    averageDurationMs: average(cells.map((cell) => cell.result.durationMs)),
    averageActions: average(cells.map((cell) => cell.trace?.toolCalls.length ?? 0)),
    recoveryAttempts,
    recoverySuccesses,
    recoverySuccessRate: recoveryAttempts === 0 ? 0 : recoverySuccesses / recoveryAttempts,
    recoveriesByClassification,
    failures: countFailureAttributions(cells.map((cell) => cell.result)),
  };
}

function aggregateMechanisms(
  scores: readonly NonNullable<HarnessMatrixCellResult["harnessScore"]>["mechanisms"][],
): NonNullable<HarnessAggregateMetrics["mechanisms"]> {
  const names = [
    "outcomeCompletion",
    "protectedStateIntegrity",
    "approvalHandling",
    "recoverySuccess",
    "verificationBeforeCompletion",
    "budgetCompliance",
    "forbiddenExecution",
  ] as const;
  const aggregate = (name: typeof names[number]) => {
    const passed = scores.reduce((sum, score) => sum + (score?.[name].passed ?? 0), 0);
    const total = scores.reduce((sum, score) => sum + (score?.[name].total ?? 0), 0);
    return {
      passed,
      total,
      rate: total === 0 ? null : passed / total,
      applicable: total > 0,
    };
  };
  return {
    outcomeCompletion: aggregate("outcomeCompletion"),
    protectedStateIntegrity: aggregate("protectedStateIntegrity"),
    approvalHandling: aggregate("approvalHandling"),
    recoverySuccess: aggregate("recoverySuccess"),
    verificationBeforeCompletion: aggregate("verificationBeforeCompletion"),
    budgetCompliance: aggregate("budgetCompliance"),
    forbiddenExecution: aggregate("forbiddenExecution"),
  };
}

function fingerprintEvaluatorArtifacts(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const artifacts = paths.map((path) => ({ id: basename(path), contentHash: hashExternalPath(path) }));
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (ids.has(artifact.id)) throw new Error(`Evaluator artifact ids must be unique: ${artifact.id}`);
    ids.add(artifact.id);
  }
  return stableHash(artifacts.sort((left, right) => left.id.localeCompare(right.id)));
}

function calibrateHarnessRubrics(
  cells: readonly HarnessMatrixCellResult[],
  humanLabels: readonly HarnessRubricHumanLabels[],
  policy?: EvalRubricCalibrationPolicy,
) {
  const cellsByKey = new Map(cells.map((cell) => [matrixCellKey(cell), cell]));
  const seen = new Set<string>();
  const samples = humanLabels.map((labels) => {
    const key = matrixCellKey(labels);
    if (seen.has(key)) throw new Error(`Duplicate rubric calibration labels for matrix cell '${key}'`);
    seen.add(key);
    const cell = cellsByKey.get(key);
    if (!cell) throw new Error(`Rubric calibration labels reference missing matrix cell '${key}'`);
    if (!cell.result.rubricAssessment) throw new Error(`Matrix cell '${key}' has labels but no rubric assessment`);
    return {
      sampleId: key,
      assessment: cell.result.rubricAssessment,
      humanLabels: labels.labels,
    };
  });
  return measureRubricAgreement(samples, policy);
}

function matrixCellKey(cell: Pick<HarnessMatrixCellResult, "caseId" | "targetId" | "variantId" | "repetition">): string {
  return `${cell.targetId}/${cell.variantId}/${cell.caseId}/${cell.repetition}`;
}

function matrixJobKey(job: { testCase: EvalCase; target: EvalModelTarget; variant: HarnessVariant; repetition: number }): string {
  return matrixCellKey({
    caseId: job.testCase.id,
    targetId: job.target.id,
    variantId: job.variant.id,
    repetition: job.repetition,
  });
}

function compatibleProgressManifest(left: HarnessMatrixManifest, right: HarnessMatrixManifest): boolean {
  return left.evaluatorVersion === right.evaluatorVersion
    && stableHash(left.executionCoverage ?? null) === stableHash(right.executionCoverage ?? null)
    && stableHash(left.executionPolicy ?? null) === stableHash(right.executionPolicy ?? null)
    && left.splitCorpusHash === right.splitCorpusHash
    && left.evaluatorArtifactHash === right.evaluatorArtifactHash
    && left.caseSetHash === right.caseSetHash
    && left.targetSetHash === right.targetSetHash
    && left.variantSetHash === right.variantSetHash
    && left.runtime?.nodeVersion === right.runtime?.nodeVersion
    && left.runtime?.platform === right.runtime?.platform
    && left.runtime?.architecture === right.runtime?.architecture
    && left.sandboxImageDigest === right.sandboxImageDigest;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= values.length) return;
      try { await run(values[index]); }
      catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
}

class ProviderConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();

  constructor(private readonly limits: Readonly<Record<string, number>>) {}

  async run<T>(providerId: string, action: () => Promise<T>): Promise<T> {
    const limit = this.limits[providerId] ?? Number.POSITIVE_INFINITY;
    if ((this.active.get(providerId) ?? 0) >= limit) {
      await new Promise<void>((resolveWaiting) => {
        const queue = this.waiting.get(providerId) ?? [];
        queue.push(resolveWaiting);
        this.waiting.set(providerId, queue);
      });
    }
    this.active.set(providerId, (this.active.get(providerId) ?? 0) + 1);
    try {
      return await action();
    } finally {
      this.active.set(providerId, (this.active.get(providerId) ?? 1) - 1);
      this.waiting.get(providerId)?.shift()?.();
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Harness matrix run was cancelled", "AbortError");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
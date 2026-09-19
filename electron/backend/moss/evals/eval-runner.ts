import type {
  EvalAdmission,
  EvalCase,
  EvalExecutionPolicy,
  EvalCriterionResult,
  EvalExecutionObservation,
  EvalExecutionFailureSource,
  EvalMetrics,
  EvalPromptProvenance,
  EvalProfile,
  EvalReport,
  EvalRunResult,
  EvalVerifiedEvidence,
  HarnessExecutionTrace,
  HarnessDiagnosticReview,
} from "../../../../common/evals";
import type { TaskBudget, TaskEvidence } from "../../../../common/types";
import type { VerificationCheck } from "../../../../common/verification";
import { VerificationRegistry } from "../verify/verification-registry";
import { attributeEvalFailure, countFailureAttributions } from "./failure-attribution";
import { validateSplitExecution } from "./split-policy";
import {
  runRubricGrader,
  unknownRubricAssessment,
  validateRubricGrader,
  type EvalRubricGrader,
} from "./rubric-grading";

const ADMISSIONS: EvalAdmission[] = [
  "attempted",
  "abstained",
  "blocked",
  "approved",
  "failed",
  "recovered",
  "verified",
  "budget-exhausted",
];

export interface EvalExecutionResult {
  observation: Omit<EvalExecutionObservation, "evidence"> & {
    /** Untrusted agent/executor claims retained only for diagnostics. */
    claimedEvidence?: TaskEvidence[];
  };
  workspaceRoot: string;
  trace?: HarnessExecutionTrace;
  diagnosticReview?: HarnessDiagnosticReview;
  promptProvenance?: EvalPromptProvenance;
  failureSource?: EvalExecutionFailureSource;
  /** Raw model text available only to an injected rubric grader; never copied into reports. */
  rubricInput?: { responseText: string };
}

export type EvalExecutor = (testCase: EvalCase, repetition: number) => Promise<EvalExecutionResult>;

export interface EvalRunnerOptions {
  executionPolicy?: EvalExecutionPolicy;
  corpusCases?: readonly EvalCase[];
  now?: () => Date;
  registry?: VerificationRegistry;
  rubricGrader?: EvalRubricGrader;
}

export interface EvalEvidenceOptions {
  registry?: VerificationRegistry;
}

/** Runs provider-neutral eval cases through an injected production or test executor. */
export class EvalRunner {
  private readonly now: () => Date;
  private readonly registry: VerificationRegistry;
  private readonly rubricGrader?: EvalRubricGrader;
  private readonly executionPolicy: EvalExecutionPolicy;
  private readonly corpusCases?: readonly EvalCase[];

  constructor(
    private readonly execute: EvalExecutor,
    options: EvalRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.registry = options.registry ?? new VerificationRegistry();
    this.rubricGrader = options.rubricGrader;
    this.executionPolicy = structuredClone(options.executionPolicy ?? { purpose: "iteration" });
    this.corpusCases = options.corpusCases;
    if (this.rubricGrader) validateRubricGrader(this.rubricGrader);
  }

  async run(cases: readonly EvalCase[]): Promise<EvalReport> {
    validateSplitExecution(cases, this.executionPolicy, this.corpusCases);
    const results: EvalRunResult[] = [];
    const caseIds = new Set<string>();
    for (const testCase of cases) {
      validateCase(testCase);
      if (caseIds.has(testCase.id)) throw new Error(`Duplicate eval case id '${testCase.id}'`);
      caseIds.add(testCase.id);
      const repetitions = testCase.repetitions ?? 1;
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const execution = await this.execute(structuredClone(testCase), repetition);
        const evidence = await collectEvalEvidence(
          testCase,
          execution.workspaceRoot,
          new AbortController().signal,
          { registry: this.registry },
        );
        const { claimedEvidence: _claimedEvidence, ...facts } = execution.observation;
        const mandatoryIds = new Set(
          testCase.task.acceptanceCriteria.filter((criterion) => criterion.mandatory).map((criterion) => criterion.id),
        );
        const verified = evidence.filter((item) => mandatoryIds.has(item.criterionId)).every((item) => item.passed);
        const admissions: EvalAdmission[] = facts.admissions.filter((admission) => admission !== "verified");
        if (verified) admissions.push("verified");
        const observation: EvalExecutionObservation = { ...facts, admissions, evidence };
        const result = scoreRun(testCase, observation, execution);
        if (this.rubricGrader) {
          try {
            result.rubricAssessment = await runRubricGrader(this.rubricGrader, {
              caseId: testCase.id,
              objective: testCase.task.objective,
              responseText: execution.rubricInput?.responseText ?? "",
            });
          } catch {
            result.rubricAssessment = unknownRubricAssessment(this.rubricGrader, "rubric-grader-error");
          }
        }
        result.failureAttribution = attributeEvalFailure({
          result,
          trace: execution.trace,
          executionFailureSource: execution.failureSource,
        });
        results.push(result);
      }
    }

    const byProfile: Partial<Record<EvalProfile, EvalMetrics>> = {};
    for (const profile of ["coding", "personal", "platform"] as const) {
      const profileResults = results.filter((result) => {
        const testCase = cases.find((candidate) => candidate.id === result.observation.caseId);
        return testCase?.profile === profile;
      });
      if (profileResults.length > 0) byProfile[profile] = aggregateMetrics(profileResults);
    }

    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      results,
      overall: aggregateMetrics(results),
      byProfile,
    };
  }
}

export function validateCase(testCase: EvalCase): void {
  if (testCase.split !== undefined && !["development", "validation", "holdout"].includes(testCase.split)) {
    throw new Error("Unknown evaluation dataset split");
  }
  if (testCase.estimatedHumanMinutes !== undefined
    && (!Number.isFinite(testCase.estimatedHumanMinutes) || testCase.estimatedHumanMinutes <= 0)) {
    throw new Error("Estimated human minutes must be finite and positive");
  }
  if (testCase.taskMessiness !== undefined && !["low", "medium", "high"].includes(testCase.taskMessiness)) {
    throw new Error("Task messiness must be low, medium or high");
  }
  if (testCase.schemaVersion !== 1) throw new Error(`Unsupported eval schema version '${testCase.schemaVersion}'`);
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(testCase.id)) throw new Error("Eval case id must be a safe identifier");
  if (testCase.family !== undefined && !/^[a-zA-Z0-9._-]{1,128}$/.test(testCase.family)) {
    throw new Error(`Eval case '${testCase.id}' family must be a safe identifier`);
  }
  if (testCase.provenance?.owner !== undefined && !testCase.provenance.owner.trim()) {
    throw new Error(`Eval case '${testCase.id}' provenance owner must not be empty`);
  }
  if (testCase.provenance?.sourceId !== undefined && !testCase.provenance.sourceId.trim()) {
    throw new Error(`Eval case '${testCase.id}' provenance sourceId must not be empty`);
  }
  if (!testCase.task.objective.trim()) throw new Error(`Eval case '${testCase.id}' requires a task objective`);
  if (!testCase.task.acceptanceCriteria.some((criterion) => criterion.mandatory)) {
    throw new Error(`Eval case '${testCase.id}' requires a mandatory acceptance criterion`);
  }
  const criterionIds = new Set<string>();
  for (const criterion of testCase.task.acceptanceCriteria) {
    if (!criterion.id.trim() || criterionIds.has(criterion.id)) {
      throw new Error(`Eval case '${testCase.id}' has a duplicate or empty criterion id`);
    }
    criterionIds.add(criterion.id);
  }
  const checkIds = new Set<string>();
  for (const check of testCase.checks) {
    if (!check.id.trim() || checkIds.has(check.id)) {
      throw new Error(`Eval case '${testCase.id}' has a duplicate or empty check id`);
    }
    if (!criterionIds.has(check.criterionId)) {
      throw new Error(`Eval case '${testCase.id}' check '${check.id}' references an unknown criterion`);
    }
    checkIds.add(check.id);
  }
  for (const criterion of testCase.task.acceptanceCriteria.filter((candidate) => candidate.mandatory)) {
    if (!testCase.checks.some((check) => check.criterionId === criterion.id)) {
      throw new Error(`Eval case '${testCase.id}' mandatory criterion '${criterion.id}' has no independent check`);
    }
  }
  if (testCase.repetitions !== undefined && (!Number.isInteger(testCase.repetitions) || testCase.repetitions < 1)) {
    throw new Error(`Eval case '${testCase.id}' repetitions must be a positive integer`);
  }
  validateScenarioPlan(testCase);
  validateBenchmarkControls(testCase);
}

function validateScenarioPlan(testCase: EvalCase): void {
  const scenario = testCase.scenario;
  if (!scenario) return;
  if (scenario.schemaVersion !== 1) throw new Error(`Eval case '${testCase.id}' has an unsupported scenario schema`);
  if (scenario.verification && (!Array.isArray(scenario.verification.commands) || scenario.verification.commands.length < 1
    || scenario.verification.commands.some((command) => typeof command !== "string" || !command.trim())
    || !Number.isSafeInteger(scenario.verification.maxCycles) || scenario.verification.maxCycles < 1 || scenario.verification.maxCycles > 8)) {
    throw new Error(`Eval case '${testCase.id}' requires bounded verification commands and cycles`);
  }
  if (scenario.approvalFallback !== undefined && scenario.approvalFallback !== "delegate" && scenario.approvalFallback !== "deny") {
    throw new Error(`Eval case '${testCase.id}' has an invalid scenario approval fallback`);
  }
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const disturbance of scenario.disturbances) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(disturbance.id) || ids.has(disturbance.id)) {
      throw new Error(`Eval case '${testCase.id}' has a duplicate or unsafe scenario disturbance id`);
    }
    ids.add(disturbance.id);
    if (disturbance.type === "tool-failure" && disturbance.persistent !== undefined
      && (typeof disturbance.persistent !== "boolean" || disturbance.failure !== "permanent")) {
      throw new Error(`Eval case '${testCase.id}' persistent faults must be permanent`);
    }
    if (disturbance.type === "context-pressure") {
      if (!Number.isInteger(disturbance.messageCount) || disturbance.messageCount < 1 || disturbance.messageCount > 64
        || !Number.isInteger(disturbance.charactersPerMessage) || disturbance.charactersPerMessage < 1
        || disturbance.charactersPerMessage > 20_000) {
        throw new Error(`Eval case '${testCase.id}' has invalid context-pressure bounds`);
      }
      continue;
    }
    if (!Number.isInteger(disturbance.invocation) || disturbance.invocation < 1) {
      throw new Error(`Eval case '${testCase.id}' scenario invocations must be positive integers`);
    }
    if ("capability" in disturbance && !testCase.allowedCapabilities.includes(disturbance.capability)) {
      throw new Error(`Eval case '${testCase.id}' scenario targets disallowed capability '${disturbance.capability}'`);
    }
    if (disturbance.type === "approval-response" && disturbance.comment !== undefined
      && (!disturbance.comment.trim() || disturbance.comment.length > 500)) {
      throw new Error(`Eval case '${testCase.id}' approval comments must contain 1-500 characters`);
    }
    const target = disturbance.type === "provider-interruption"
      ? `${disturbance.type}:${disturbance.invocation}`
      : `${disturbance.type}:${disturbance.capability}:${disturbance.invocation}`;
    if (targets.has(target)) throw new Error(`Eval case '${testCase.id}' has duplicate scenario target '${target}'`);
    targets.add(target);
  }
}

function validateBenchmarkControls(testCase: EvalCase): void {
  const controls = testCase.benchmark;
  if (!controls) return;
  if (controls.requiredContextCompaction !== undefined && controls.requiredContextCompaction !== true) throw new Error("Invalid required compaction contract");
  if (controls.requiredPermanentFailure !== undefined && !testCase.scenario?.disturbances.some((item) =>
    item.id === controls.requiredPermanentFailure && item.type === "tool-failure" && item.failure === "permanent" && item.persistent === true)) {
    throw new Error("Required permanent failure must name a persistent disturbance");
  }
  if (controls.expectedVerificationStop !== undefined && (controls.expectedVerificationStop !== true
    || !testCase.scenario?.verification || controls.expectedActionBudgetStop !== undefined)) {
    throw new Error(`Eval case '${testCase.id}' requires an exclusive bounded verification-stop contract`);
  }
  if (controls.expectedActionBudgetStop !== undefined
    && (!Number.isSafeInteger(controls.expectedActionBudgetStop) || controls.expectedActionBudgetStop < 0
      || controls.expectedActionBudgetStop !== (controls.budget?.maxActions ?? testCase.task.budget?.maxActions))) {
    throw new Error(`Eval case '${testCase.id}' expected action-budget stop must match its declared action limit`);
  }

  const expected = validateCapabilityList(testCase, "expectedCapabilities", controls.expectedCapabilities);
  const forbidden = validateCapabilityList(testCase, "forbiddenCapabilities", controls.forbiddenCapabilities);
  for (const capability of expected) {
    if (forbidden.has(capability)) {
      throw new Error(`Eval case '${testCase.id}' cannot both expect and forbid capability '${capability}'`);
    }
    if (!testCase.allowedCapabilities.includes(capability)) {
      throw new Error(`Eval case '${testCase.id}' expects capability '${capability}' but does not allow it`);
    }
  }

  const requiredApprovals = validateCapabilityList(
    testCase,
    "security.requireApprovalFor",
    controls.security?.requireApprovalFor,
  );
  for (const capability of requiredApprovals) {
    if (forbidden.has(capability)) {
      throw new Error(`Eval case '${testCase.id}' cannot require approval for forbidden capability '${capability}'`);
    }
    if (!testCase.allowedCapabilities.includes(capability)) {
      throw new Error(`Eval case '${testCase.id}' requires approval for capability '${capability}' but does not allow it`);
    }
  }

  validatePathList(testCase, controls.security?.protectedPaths);
  validateBudget(testCase, controls.budget);
}

function validateCapabilityList(testCase: EvalCase, label: string, values?: string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value) || result.has(value)) {
      throw new Error(`Eval case '${testCase.id}' ${label} must contain unique safe capability ids`);
    }
    result.add(value);
  }
  return result;
}

function validatePathList(testCase: EvalCase, values?: string[]): void {
  const paths = new Set<string>();
  for (const value of values ?? []) {
    const normalized = value.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`Eval case '${testCase.id}' protectedPaths must be relative workspace paths`);
    }
    if (paths.has(normalized)) throw new Error(`Eval case '${testCase.id}' protectedPaths must be unique`);
    paths.add(normalized);
  }
}

function validateBudget(testCase: EvalCase, budget?: TaskBudget): void {
  if (!budget) return;
  for (const [name, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Eval case '${testCase.id}' budget '${name}' must be non-negative`);
    }
  }
}

export function matchesExpectedActionBudgetStop(
  testCase: EvalCase,
  observation: EvalExecutionObservation,
  execution?: Pick<EvalExecutionResult, "trace" | "failureSource">,
): boolean {
  const limit = testCase.benchmark?.expectedActionBudgetStop;
  const trace = execution?.trace;
  if (limit === undefined || !trace || execution?.failureSource || observation.outcome !== "budget-exhausted"
    || trace.terminalState !== "budget-exhausted" || trace.toolCalls.length !== limit + 1) return false;
  const boundaries = trace.events.filter((event) => event.type === "budget-boundary");
  const terminal = trace.events.at(-1);
  return boundaries.length === 1 && boundaries[0].boundary === "actions"
    && boundaries[0].limit === limit && boundaries[0].observed === limit + 1
    && trace.toolCalls.slice(0, limit).every((call) => call.ok === true)
    && trace.toolCalls[limit].ok === undefined
    && !trace.events.some((event) => event.type === "tool-result" && event.sequence > boundaries[0].sequence)
    && terminal?.type === "terminal" && terminal.state === "budget-exhausted";
}

export function scoreRun(testCase: EvalCase, observation: EvalExecutionObservation, execution?: Pick<EvalExecutionResult, "trace" | "failureSource">): EvalRunResult {
  if (observation.caseId !== testCase.id) {
    throw new Error(`Executor returned case '${observation.caseId}' for '${testCase.id}'`);
  }
  if (!Number.isFinite(observation.estimatedCostUsd) || observation.estimatedCostUsd < 0) {
    throw new Error(`Eval observation '${observation.runId}' has invalid cost`);
  }
  const startedAt = Date.parse(observation.startedAt);
  const completedAt = Date.parse(observation.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error(`Eval observation '${observation.runId}' has invalid timestamps`);
  }

  const criteria = testCase.task.acceptanceCriteria.map((criterion): EvalCriterionResult => {
    const evidence = latestEvidence(observation.evidence, criterion.id);
    return {
      criterionId: criterion.id,
      mandatory: criterion.mandatory,
      passed: evidence?.passed ?? false,
      summary: evidence?.summary ?? "No evidence captured",
      checks: evidence?.checks ?? [],
    };
  });
  const passed = criteria.filter((criterion) => criterion.passed).length;
  const mandatoryPassed = criteria.filter((criterion) => criterion.mandatory).every((criterion) => criterion.passed);
  const verifications = execution?.trace?.events.filter((event) => event.type === "verification") ?? [];
  const lastVerification = verifications.at(-1);
  const terminal = execution?.trace?.events.at(-1);
  const verificationStop = testCase.benchmark?.expectedVerificationStop === true && !execution?.failureSource
    && observation.outcome === "blocked" && execution?.trace?.terminalState === "blocked"
    && terminal?.type === "terminal" && terminal.state === "blocked"
    && verifications.length === testCase.scenario?.verification?.maxCycles && lastVerification?.ok === false
    && !execution.trace.events.some((event) => event.type === "tool-result" && event.sequence > lastVerification.sequence);
  const verifiedBeforeCompletion = !testCase.benchmark?.requireVerificationBeforeCompletion
    || (lastVerification?.ok === true && terminal?.type === "terminal" && terminal.state === "completed"
      && !execution?.trace?.events.some((event) => event.type === "tool-result" && event.ok && event.sequence > lastVerification.sequence));
  const compactionPassed = !testCase.benchmark?.requiredContextCompaction || execution?.trace?.events.some((event) =>
    event.type === "context-compaction" && Number.isInteger(event.droppedCount) && event.droppedCount > 0);
  const requiredFault = testCase.benchmark?.requiredPermanentFailure;
  const fault = testCase.scenario?.disturbances.find((item) => item.id === requiredFault && item.type === "tool-failure");
  const permanentPassed = !requiredFault || (fault?.type === "tool-failure" && !execution?.failureSource
    && execution?.trace?.events.some((event) => event.type === "scenario-disturbance" && event.id === requiredFault && event.status === "delivered")
    && execution.trace.toolCalls.some((call) => call.name === fault.capability && call.ok === false)
    && !execution.trace.toolCalls.some((call) => call.ok === true)
    && !execution.trace.events.some((event) => event.type === "recovery" && event.outcome === "succeeded"));

  return {
    observation: structuredClone(observation),
    criteria,
    success: mandatoryPassed && Boolean(compactionPassed && permanentPassed) && (testCase.benchmark?.expectedVerificationStop ? verificationStop
      : testCase.benchmark?.expectedActionBudgetStop !== undefined ? matchesExpectedActionBudgetStop(testCase, observation, execution)
      : observation.outcome === "completed" && verifiedBeforeCompletion),
    score: criteria.length === 0 ? 0 : passed / criteria.length,
    durationMs: completedAt - startedAt,
  };
}

export function aggregateMetrics(results: readonly EvalRunResult[]): EvalMetrics {
  const admissions = Object.fromEntries(ADMISSIONS.map((admission) => [admission, 0])) as Record<EvalAdmission, number>;
  for (const result of results) {
    for (const admission of result.observation.admissions) admissions[admission]++;
  }
  const runs = results.length;
  const total = (select: (result: EvalRunResult) => number): number => results.reduce((sum, result) => sum + select(result), 0);
  return {
    runs,
    successes: results.filter((result) => result.success).length,
    successRate: runs === 0 ? 0 : results.filter((result) => result.success).length / runs,
    averageScore: runs === 0 ? 0 : total((result) => result.score) / runs,
    averageDurationMs: runs === 0 ? 0 : total((result) => result.durationMs) / runs,
    averageCostUsd: runs === 0 ? 0 : total((result) => result.observation.estimatedCostUsd) / runs,
    averageTokens: runs === 0 ? 0 : total((result) =>
      (result.observation.usage.inputTokens ?? 0) + (result.observation.usage.outputTokens ?? 0)) / runs,
    admissions,
    failures: countFailureAttributions(results),
  };
}

function latestEvidence(evidence: readonly EvalVerifiedEvidence[], criterionId: string): EvalVerifiedEvidence | undefined {
  return evidence
    .filter((item) => item.criterionId === criterionId)
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0];
}

/** Run a case's independent checks and fold multiple checks into one evidence item per criterion. */
export async function collectEvalEvidence(
  testCase: EvalCase,
  workspaceRoot: string,
  signal: AbortSignal,
  options: EvalEvidenceOptions = {},
): Promise<EvalVerifiedEvidence[]> {
  validateCase(testCase);
  const registry = options.registry ?? new VerificationRegistry();
  const checkEvidence = await registry.runChecks(structuredClone(testCase.checks), workspaceRoot, signal);
  const capturedAt = new Date().toISOString();
  return testCase.task.acceptanceCriteria.map((criterion): EvalVerifiedEvidence => {
    const items = checkEvidence.filter((item) => item.criterionId === criterion.id);
    const passed = items.length > 0 && items.every((item) => item.ok);
    const checks = items.map((item) => ({
      checkId: item.checkId,
      kind: item.kind,
      passed: item.ok,
      summary: safeCheckSummary(item.kind, item.ok, item.summary),
      ...(!item.ok && item.failureKind ? { failureKind: item.failureKind } : {}),
    }));
    return {
      id: `eval-${safeEvidenceId(testCase.id)}-${safeEvidenceId(criterion.id)}`,
      criterionId: criterion.id,
      kind: evidenceKind(testCase.checks.filter((check) => check.criterionId === criterion.id)),
      passed,
      summary: items.length === 0
        ? "No independent checks ran"
        : boundedSummary(checks.map((item) => item.summary).join("; ")),
      capturedAt,
      checks,
    };
  });
}

function boundedSummary(summary: string): string {
  return summary.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function evidenceKind(checks: readonly VerificationCheck[]): TaskEvidence["kind"] {
  if (checks.every((check) => check.kind === "command")) return "command";
  if (checks.every((check) => check.kind === "file-exists" || check.kind === "file-contains")) return "file";
  if (checks.every((check) => check.kind === "process-running")) return "process";
  if (checks.every((check) => check.kind === "http")) return "http";
  return "external";
}

function safeEvidenceId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "evidence";
}

function safeCheckSummary(kind: string, passed: boolean, summary: string): string {
  return kind === "command" ? `Command ${passed ? "passed" : "failed"}` : boundedSummary(summary);
}
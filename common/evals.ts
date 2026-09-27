import type {
  InjectionMode,
  ProviderKind,
  TaskBudget,
  TaskEvidence,
  TaskSpec,
  TokenUsage,
  ToolRisk,
  VerifyConfig,
} from "./types";
import type { JsonArtifactRequirement, VerificationCheck } from "./verification";

export type EvalProfile = "coding" | "personal" | "platform";
export type EvalDifficulty = "smoke" | "standard" | "hard";
export type EvalSuitePurpose = "capability" | "regression" | "challenge";
export type EvalDatasetSplit = "development" | "validation" | "holdout";
export interface EvalExecutionPolicy {
  purpose: "iteration" | "promotion" | "release";
  measurementName?: string;
}
export type EvalFamilyRole = "positive" | "negative";
export type EvalProductDomain =
  | "coding"
  | "personal"
  | "platform"
  | "browser"
  | "desktop"
  | "mcp"
  | "approval"
  | "verification"
  | "resume"
  | "context-pressure"
  | "safety";
export type EvalPerturbationClass =
  | "canonical"
  | "paraphrase"
  | "irrelevant-files"
  | "layout"
  | "tool-failure"
  | "approval-denial"
  | "compaction"
  | "interruption"
  | "budget";
export type EvalAdmission = "attempted" | "abstained" | "blocked" | "approved" | "failed" | "recovered" | "verified" | "budget-exhausted";

export interface EvalCaseProvenance {
  source: "manual" | "test" | "bug" | "production" | "synthetic";
  referenceSolutionVerified: boolean;
  owner?: string;
  sourceId?: string;
  sourceEvidence?: string;
  promotion?: {
    from: Exclude<EvalSuitePurpose, "regression">;
    reviewedBy: string;
    reviewedAt: string;
  };
}

export interface EvalPerturbationMetadata {
  class: EvalPerturbationClass;
  expectedDecision: "same" | "changed";
  canonicalCaseId: string;
}

export interface EvalApprovalResponseDisturbance {
  id: string;
  type: "approval-response";
  capability: string;
  invocation: number;
  approved: boolean;
  comment?: string;
}

export interface EvalToolFailureDisturbance {
  id: string;
  type: "tool-failure";
  capability: string;
  invocation: number;
  failure: "transient" | "permanent";
  persistent?: boolean;
}

export interface EvalProviderInterruptionDisturbance {
  id: string;
  type: "provider-interruption";
  invocation: number;
  phase: "before-output" | "after-output";
}

export interface EvalContextPressureDisturbance {
  id: string;
  type: "context-pressure";
  messageCount: number;
  charactersPerMessage: number;
}

export type EvalScenarioDisturbance =
  | EvalApprovalResponseDisturbance
  | EvalToolFailureDisturbance
  | EvalProviderInterruptionDisturbance
  | EvalContextPressureDisturbance;

export interface EvalScenarioPlan {
  schemaVersion: 1;
  verification?: { commands: string[]; maxCycles: number };
  approvalFallback?: "delegate" | "deny";
  disturbances: EvalScenarioDisturbance[];
}

export interface EvalDatasetLineage {
  revision: number;
  revisionId: string;
  parentRevisionId?: string;
  familyRootId: string;
  contentHash: string;
  authoredFromRun?: {
    taskId: string;
    failureSignature?: string;
  };
}

export interface EvalFixture {
  /** Optional directory copied into an isolated workspace before execution. */
  workspaceTemplate?: string;
  /** Hidden known-good state overlaid only by case-health checks. */
  referenceSolution?: string;
  /** Profile-specific state supplied to the executor, such as a browser fixture. */
  state?: Record<string, unknown>;
}

export interface HarnessRuntimeControls {
  contextStrategy: "full" | "compact";
  planningPolicy: "free-form" | "incremental";
  verificationCadence: "terminal" | "after-mutation";
  recoveryPolicy: "standard" | "signature-aware";
  reviewerPass: "off" | "diagnostic";
}

/** Provider-neutral execution settings varied independently from the model. */
export interface HarnessVariant {
  schemaVersion: 1;
  id: string;
  description: string;
  promptProfile?: string;
  autoApprove?: boolean;
  injectionMode?: InjectionMode;
  contextLimit?: number;
  maxRounds?: number;
  toolTimeoutMs?: number;
  verify?: VerifyConfig;
  budget?: TaskBudget;
  runtime?: HarnessRuntimeControls;
  sandbox?: { image: string; allowNetwork?: boolean };
}

/** Model identity is separate so every target can run under every variant. */
export interface EvalModelTarget {
  schemaVersion: 1;
  id: string;
  providerId: string;
  providerKind: ProviderKind;
  model: string;
  generation?: {
    maxOutputTokens?: number;
    reasoningEffort?: "none";
  };
}

export interface EvalSecurityPolicy {
  maxToolRisk?: ToolRisk;
  requireApprovalFor?: string[];
  protectedPaths?: string[];
}

/** Optional deterministic expectations used by harness-regression scoring. */
export interface EvalBenchmarkControls {
  expectedActionBudgetStop?: number;
  expectedVerificationStop?: true;
  requiredContextCompaction?: true;
  requiredPermanentFailure?: string;
  expectedCapabilities?: string[];
  forbiddenCapabilities?: string[];
  requireVerificationBeforeCompletion?: boolean;
  security?: EvalSecurityPolicy;
  budget?: TaskBudget;
}

export type HarnessTraceTerminalState = "completed" | "aborted" | "error" | "budget-exhausted" | "blocked";

export interface HarnessTraceToolCall {
  callId: string;
  name: string;
  argumentHash?: string;
  risk?: ToolRisk;
  approvalRequested: boolean;
  autoApproved?: boolean;
  ok?: boolean;
  durationMs?: number;
  recoveredFromCallId?: string;
}

export type HarnessTraceEvent =
  | { type: "round-start"; round: number; toolsEnabled: boolean }
  | { type: "round-end"; round: number; toolCallCount: number; finish: "tools" | "complete" | "rejected" | "error" }
  | { type: "tool-call"; callId: string; name: string; argumentHash: string }
  | { type: "approval-requested"; callId: string; name: string; risk?: ToolRisk }
  | { type: "approval-decision"; callId: string; approved: boolean; commentProvided: boolean }
  | { type: "tool-result"; callId: string; name: string; ok: boolean; autoApproved: boolean; risk?: ToolRisk; durationMs?: number }
  | { type: "verification"; ok: boolean; checkCount: number; failedCheckHash?: string }
  | { type: "budget-boundary"; boundary: "actions" | "tokens" | "cost" | "duration"; limit: number; observed: number }
  | { type: "context-compaction"; reason: "proactive" | "overflow"; droppedCount: number }
  | { type: "recovery"; action: string; attempt: number; classification?: string; outcome?: "attempted" | "succeeded" | "terminal"; sourceCallId?: string }
  | { type: "scenario-disturbance"; id: string; disturbanceType: EvalScenarioDisturbance["type"]; status: "planned" | "delivered" | "undelivered" }
  | { type: "terminal"; state: HarnessTraceTerminalState };

export type HarnessTraceEnvelopeEvent = HarnessTraceEvent & {
  sequence: number;
  timestamp: string;
};

/** Sanitized execution metadata. Raw arguments, output, and model text are excluded. */
export interface HarnessExecutionTrace {
  schemaVersion: 1;
  events: HarnessTraceEnvelopeEvent[];
  toolCalls: HarnessTraceToolCall[];
  usage: TokenUsage;
  terminalState?: HarnessTraceTerminalState;
}

export interface HarnessDiagnosticReview {
  diagnostic: true;
  label: "pass" | "fail" | "unknown";
  reasonCode: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
  durationMs: number;
}

export interface EvalPromptProvenance {
  profile: string;
  seededMessagesHash: string;
}

export interface EvalCheckResult {
  checkId: string;
  kind: string;
  passed: boolean;
  summary: string;
  failureKind?: "assertion" | "grader" | "environment" | "orchestration";
}

export interface EvalVerifiedEvidence extends TaskEvidence {
  checks: EvalCheckResult[];
}

export interface HarnessProcessScores {
  robustness: number;
  toolUse: number;
  consistency: number;
}

export interface HarnessProductMetrics {
  interventionCount: number;
  recoveryAttempts: number;
  recoverySucceeded: boolean;
  approvalLatencyMs?: number;
  userVisibleErrorQuality: "actionable" | "generic" | "not-applicable";
  falseCompletion: boolean;
}

export interface HarnessMechanismMetric {
  passed: number;
  total: number;
  rate: number | null;
  applicable: boolean;
}

export interface HarnessMechanismScores {
  outcomeCompletion: HarnessMechanismMetric;
  protectedStateIntegrity: HarnessMechanismMetric;
  approvalHandling: HarnessMechanismMetric;
  recoverySuccess: HarnessMechanismMetric;
  verificationBeforeCompletion: HarnessMechanismMetric;
  budgetCompliance: HarnessMechanismMetric;
  forbiddenExecution: HarnessMechanismMetric;
}

export interface HarnessRunScore {
  completion: number;
  mandatoryCompletion: boolean;
  securityPassed: boolean;
  securityViolations: string[];
  mechanisms?: HarnessMechanismScores;
  process: HarnessProcessScores;
  /** Paper-inspired diagnostic only; not a deployment-safety guarantee. */
  diagnosticComposite: number;
}

/** Versioned, provider-neutral description of one evaluation task. */
export interface EvalCase {
  schemaVersion: 1;
  id: string;
  profile: EvalProfile;
  difficulty: EvalDifficulty;
  estimatedHumanMinutes?: number;
  taskMessiness?: "low" | "medium" | "high";
  suite?: EvalSuitePurpose;
  split?: EvalDatasetSplit;
  family?: string;
  /** Optional matched-family polarity; declaring either role requires both roles in that family. */
  familyRole?: EvalFamilyRole;
  domain?: EvalProductDomain;
  perturbation?: EvalPerturbationMetadata;
  scenario?: EvalScenarioPlan;
  lineage?: EvalDatasetLineage;
  provenance?: EvalCaseProvenance;
  task: TaskSpec & { jsonArtifactRequirements?: JsonArtifactRequirement[] };
  fixture?: EvalFixture;
  allowedCapabilities: string[];
  /** Independent end-state checks; these run after the agent stops. */
  checks: VerificationCheck[];
  repetitions?: number;
  tags?: string[];
  benchmark?: EvalBenchmarkControls;
}

export interface EvalExecutionObservation {
  caseId: string;
  runId: string;
  provider: string;
  model: string;
  outcome: "completed" | "failed" | "blocked" | "cancelled" | "budget-exhausted";
  failureReason?: string;
  startedAt: string;
  completedAt: string;
  evidence: EvalVerifiedEvidence[];
  usage: TokenUsage;
  estimatedCostUsd: number;
  admissions: EvalAdmission[];
}

export interface EvalCriterionResult {
  criterionId: string;
  mandatory: boolean;
  passed: boolean;
  summary: string;
  checks: EvalCheckResult[];
}

export interface EvalRunResult {
  observation: EvalExecutionObservation;
  criteria: EvalCriterionResult[];
  success: boolean;
  score: number;
  durationMs: number;
  failureAttribution?: EvalFailureAttribution;
  rubricAssessment?: EvalRubricAssessment;
}

export type EvalFailureCategory =
  | "agent-behavior"
  | "provider-model"
  | "tool"
  | "harness-orchestration"
  | "grader"
  | "environment"
  | "unknown";

export type EvalExecutionFailureSource = Exclude<EvalFailureCategory, "agent-behavior" | "grader" | "unknown">;

export interface EvalFailureAttribution {
  category: EvalFailureCategory;
  reasonCode: string;
  diagnostic: true;
}

export type EvalRubricLabel = "pass" | "fail" | "unknown";

export interface EvalRubricProvenance {
  provider: string;
  model: string;
  promptHash: string;
}

export interface EvalRubricJudgment {
  dimensionId: string;
  label: EvalRubricLabel;
  reasonCode?: string;
}

export interface EvalRubricAssessment {
  diagnostic: true;
  provenance: EvalRubricProvenance;
  judgments: EvalRubricJudgment[];
}

export interface EvalRubricAgreementMetrics {
  labeled: number;
  compared: number;
  agreements: number;
  unknown: number;
  coverage: number;
  agreementRate: number;
  calibrated: boolean;
}

export interface EvalRubricCalibrationReport {
  minimumLabelsPerDimension: number;
  minimumCoverage: number;
  minimumAgreement: number;
  calibrated: boolean;
  overall: EvalRubricAgreementMetrics;
  byDimension: Record<string, EvalRubricAgreementMetrics>;
}

export interface HarnessRubricHumanLabels {
  caseId: string;
  targetId: string;
  variantId: string;
  repetition: number;
  labels: Record<string, Exclude<EvalRubricLabel, "unknown">>;
}

export interface HarnessDiagnosticReference {
  schemaVersion: 1;
  sha256: string;
}

export interface HarnessMatrixCellResult {
  caseId: string;
  targetId: string;
  variantId: string;
  repetition: number;
  result: EvalRunResult;
  trace?: HarnessExecutionTrace;
  diagnosticReview?: HarnessDiagnosticReview;
  diagnostics?: HarnessDiagnosticReference;
  infrastructureRetries?: Array<{ runId: string; completedAt: string; diagnostics?: HarnessDiagnosticReference }>;
  promptProvenance?: EvalPromptProvenance;
  harnessScore?: HarnessRunScore;
  protectedInputHashesBefore: Record<string, string>;
  protectedInputHashesAfter: Record<string, string>;
  protectedInputsIntact: boolean;
}

export interface HarnessExecutionCoverage {
  selection: "local" | "container" | "full";
  corpusCaseIds: string[];
  excluded: Array<{ caseId: string; reason: "requires-container" | "local-case" | "suite-filter" | "split-filter" }>;
}

export interface HarnessMatrixManifest {
  executionPolicy?: EvalExecutionPolicy;
  splitCorpusHash?: string;
  executionCoverage?: HarnessExecutionCoverage;
  evaluatorVersion: string;
  caseIds: string[];
  caseSuites?: Record<string, EvalSuitePurpose>;
  caseFamilies?: Record<string, string>;
  targetIds: string[];
  variantIds: string[];
  promptProfiles?: string[];
  targetConfigurations?: readonly EvalModelTarget[];
  variantConfigurations?: readonly HarnessVariant[];
  scenarioPlanHash?: string;
  runtime?: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    sourceRevision?: string;
  };
  sandboxImageDigest?: string;
  evaluatorArtifactHash?: string;
  caseSetHash: string;
  targetSetHash: string;
  variantSetHash: string;
}

export interface HarnessAggregateMetrics {
  runs: number;
  scoredRuns: number;
  completions: number;
  completionRate: number;
  securityPasses: number;
  securityPassRate: number;
  mechanisms?: HarnessMechanismScores;
  protectedInputsIntact: number;
  averageRobustness: number;
  averageToolUse: number;
  averageConsistency: number;
  averageDiagnosticComposite: number;
  averageTokens: number;
  averageCostUsd: number;
  averageDurationMs: number;
  averageActions: number;
  recoveryAttempts: number;
  recoverySuccesses: number;
  recoverySuccessRate: number;
  recoveriesByClassification: Record<string, number>;
  failures: Record<EvalFailureCategory, number>;
}

export interface HarnessRateInterval {
  confidence: number;
  lower: number;
  upper: number;
}

export interface HarnessBootstrapInterval extends HarnessRateInterval {
  resamples: number;
  unit: "family-task-trial" | "task-trial";
}

export interface HarnessReliabilityMetrics {
  taskGroups: number;
  trials: number;
  k: number;
  passAt1: number;
  passAtK: number;
  passPowerK: number;
  completionWilsonInterval: HarnessRateInterval;
  passAt1Bootstrap: HarnessBootstrapInterval;
}

export interface HarnessMatrixSummary {
  corpusDiagnostics?: Record<string, HarnessCorpusDiagnostics>;
  overall: HarnessAggregateMetrics;
  reliability?: HarnessReliabilityMetrics;
  byTargetVariant: Record<string, HarnessAggregateMetrics>;
  byProfile: Partial<Record<EvalProfile, HarnessAggregateMetrics>>;
  byDifficulty: Partial<Record<EvalDifficulty, HarnessAggregateMetrics>>;
  byTag: Record<string, HarnessAggregateMetrics>;
  byPerturbationClass?: Partial<Record<EvalPerturbationClass, HarnessAggregateMetrics>>;
  byFamily?: Record<string, HarnessReliabilityMetrics>;
  byCriterion?: Record<string, HarnessCriterionMetrics>;
}

export interface HarnessCriterionMetrics {
  runs: number;
  passes: number;
  passRate: number;
  mandatory: boolean;
}

export interface HarnessMatrixReport {
  schemaVersion: 1;
  generatedAt: string;
  manifest: HarnessMatrixManifest;
  cells: HarnessMatrixCellResult[];
  summary: HarnessMatrixSummary;
  rubricCalibration?: EvalRubricCalibrationReport;
}

export interface HarnessCellDiff {
  caseId: string;
  targetId: string;
  variantId: string;
  repetition: number;
  promptChanged: boolean;
  completionChanged: boolean;
  securityChanged: boolean;
  robustnessDelta: number;
  toolUseDelta: number;
  consistencyDelta: number;
  tokensDelta: number;
  costDeltaUsd: number;
  durationDeltaMs: number;
  actionsDelta: number;
}

export interface HarnessReportDiff {
  schemaVersion: 1;
  baselineGeneratedAt: string;
  candidateGeneratedAt: string;
  passed: boolean;
  /** @deprecated Compatibility diagnostic only; use pairedNonInferiority for release decisions. */
  pairedCompletion: HarnessPairedRateDelta;
  pairedNonInferiority: HarnessPairedNonInferiority;
  cells: HarnessCellDiff[];
  criteria: HarnessCriterionDiff[];
  regressions: string[];
}

export interface HarnessCriterionDiff {
  criterion: string;
  mandatory: boolean;
  baselinePassRate: number;
  candidatePassRate: number;
  delta: number;
}

export interface EvalMetrics {
  runs: number;
  successes: number;
  successRate: number;
  averageScore: number;
  averageDurationMs: number;
  averageCostUsd: number;
  averageTokens: number;
  admissions: Record<EvalAdmission, number>;
  failures: Record<EvalFailureCategory, number>;
}

export interface EvalReport {
  schemaVersion: 1;
  generatedAt: string;
  results: EvalRunResult[];
  overall: EvalMetrics;
  byProfile: Partial<Record<EvalProfile, EvalMetrics>>;
}

export interface HarnessCaseCoverage {
  cases: number;
  metadataComplete: number;
  bySuite: Partial<Record<EvalSuitePurpose, number>>;
  bySplit: Partial<Record<EvalDatasetSplit, number>>;
  byFamily: Record<string, number>;
  byProfile: Partial<Record<EvalProfile, number>>;
  byDifficulty: Partial<Record<EvalDifficulty, number>>;
  byCapability: Record<string, number>;
  byCheckKind: Record<string, number>;
}

export interface HarnessPairedRateDelta {
  pairs: number;
  baselinePassRate: number;
  candidatePassRate: number;
  delta: number;
  improved: number;
  regressed: number;
  unchanged: number;
}

export interface HarnessPairedNonInferiority extends HarnessPairedRateDelta {
  confidence: 0.95;
  lower: number;
  upper: number;
  margin: number;
  nonInferior: boolean;
  resamples: number;
  unit: "family-case-rate" | "case-rate";
}

export interface HarnessCorpusDiagnostics {
  scope: "full-corpus" | "partial-or-unknown";
  byHumanDuration: Record<"up-to-5m" | "5-to-30m" | "30-to-120m" | "over-120m" | "unknown", {
    cases: number;
    trials: number;
    successes: number;
    successRate: number | null;
  }>;
  capabilitySaturation: {
    status: "insufficient-support" | "not-saturated" | "saturation-signal";
    cases: number;
    families: number;
    minimumTrialsPerCase: number;
    caseAveragedSuccess: number | null;
    harnessFailures: number;
    policy: { minimumCases: number; minimumFamilies: number; minimumTrials: number; successThreshold: number };
  };
}
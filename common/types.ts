// common/types.ts
//
// Shared types reachable from both the Electron main process (CommonJS) and the
// React renderer (ESM via Vite). Type-only / pure data — no runtime imports that
// differ across the two module systems.

export type ProviderKind = "openai-compatible" | "anthropic";

import type { ModelRate } from "./pricing";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Speech-to-text endpoint config carried alongside a turn so the
 *  transcribe_audio tool can reach the same Whisper endpoint as the mic. */
export interface SttConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** SMTP account for the send_email tool (for example Gmail with an app password).
 *  Connections always use TLS: implicit on port 465, STARTTLS required otherwise. */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** Email-sending config carried alongside a turn so the send_email tool can
 *  deliver through the Resend HTTPS API or an SMTP account. With the chosen
 *  provider's credentials missing the tool refuses. */
export interface EmailConfig {
  /** delivery route; absent means Resend */
  provider?: "resend" | "smtp";
  apiKey: string;
  /** sender address; for SMTP, empty falls back to the account user */
  from: string;
  smtp?: SmtpConfig;
}

/** Embeddings endpoint config for the semantic codebase index and the
 *  search_codebase tool. Kept separate from the chat ProviderConfig because some
 *  chat providers (Anthropic) expose no embeddings endpoint, so users point this
 *  at a local OpenAI-style /embeddings server (e.g. Ollama's nomic-embed-text). */
export interface EmbedConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Task-scoped browser and Windows desktop automation policy. Empty allowlists
 *  disable the corresponding capability even when its master switch is true. */
export interface AutomationConfig {
  browserEnabled: boolean;
  browserAllowedDomains: string[];
  browserHeadless?: boolean;
  desktopEnabled: boolean;
  desktopAllowedProcesses: string[];
  desktopAllowedWindows: string[];
}

/** Outcome of a codebase reindex, surfaced to the settings UI. */
export interface CodebaseReindexResult {
  ok: boolean;
  /** files included in the index after this run */
  files: number;
  /** total embedded chunks after this run */
  chunks: number;
  /** files reused unchanged (mtime match) rather than re-embedded */
  skipped: number;
  error?: string;
}

/** Current state of a workspace's semantic index, for the settings UI. */
export interface CodebaseStatus {
  indexed: boolean;
  files: number;
  chunks: number;
  model: string;
  updatedAt?: string;
}

/** Verification config carried alongside a turn: after the agent edits files,
 *  these shell commands run in the workspace and their pass/fail is fed back to
 *  the model so it can self-correct. Disabled or empty commands = no-op. */
export interface VerifyConfig {
  enabled: boolean;
  /** shell commands run in workspace order; fail-fast on the first failure */
  commands: string[];
  /** max times verification runs per turn before the loop stops re-checking */
  maxCycles?: number;
}

// --- Durable task execution -------------------------------------------------

export type TaskState =
  | "intake"
  | "planning"
  | "executing"
  | "verifying"
  | "reflecting"
  | "waiting_for_approval"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStepState = "pending" | "running" | "completed" | "failed" | "skipped";

export interface TaskBudget {
  /** Maximum wall-clock runtime in milliseconds; 0 or absent means unlimited. */
  maxDurationMs?: number;
  /** Maximum model input and output tokens combined; 0 or absent means unlimited. */
  maxTokens?: number;
  /** Maximum tool calls across all attempts; 0 or absent means unlimited. */
  maxActions?: number;
  /** Maximum estimated provider cost in USD; 0 or absent means unlimited. */
  maxCostUsd?: number;
}

export interface TaskAcceptanceCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  verification?: TaskCriterionVerification;
}

export type TaskCriterionVerification =
  | { kind: "commands"; commands: string[] }
  | { kind: "file-exists"; path: string }
  | { kind: "file-contains"; path: string; substring: string }
  | { kind: "http"; url: string; expectedStatus?: number }
  /** an independent critic model from another family judges the outcome from the materials */
  | { kind: "critic"; rubric?: string; paths?: string[] };

export interface TaskEvidence {
  id: string;
  criterionId: string;
  kind: "command" | "file" | "process" | "http" | "browser" | "desktop" | "external" | "model-review";
  passed: boolean;
  summary: string;
  capturedAt: string;
  attemptId?: string;
}

export type MissionStepKind = "research" | "implement" | "verify" | "review" | "decision";
export type MissionWorkerRole = "researcher" | "implementer" | "verifier" | "reviewer";
export type MissionExecutionLane = "readonly-parallel" | "exclusive";

export interface MissionStepContract {
  kind: MissionStepKind;
  workerRole: MissionWorkerRole;
  executionLane: MissionExecutionLane;
  acceptanceCriterionIds: string[];
  budget: TaskBudget;
  expectedArtifacts: string[];
  supersedesStepIds?: string[];
}

export interface TaskStep {
  id: string;
  description: string;
  state: TaskStepState;
  dependsOn: string[];
  requiredCapabilities: string[];
  mission?: MissionStepContract;
  lease?: TaskLease;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface TaskMissionPlan {
  schemaVersion: 1;
  revision: number;
  supersedesRevision?: number;
  revisionReason?: string;
  steps: TaskStep[];
}

export interface TaskArtifactReference {
  id: string;
  taskId: string;
  planRevision: number;
  stepId: string;
  attemptId: string;
  name: string;
  summary: string;
  sha256: string;
  byteLength: number;
  createdAt: string;
}

export interface TaskArtifactContent extends TaskArtifactReference {
  content: string;
}

export type TaskBlockerKind =
  | "approval"
  | "verification"
  | "credential"
  | "permission"
  | "missing-capability"
  | "unavailable-service"
  | "unsupported-environment"
  | "budget"
  | "user-decision"
  | "external";

export interface TaskBlocker {
  kind: TaskBlockerKind;
  summary: string;
  resumable: boolean;
  createdAt: string;
  resolution?: string;
}

export interface TaskAttempt {
  id: string;
  stepId?: string;
  turnId?: string;
  startedAt: string;
  completedAt?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  actionCount: number;
  usage: TokenUsage;
  estimatedCostUsd: number;
  error?: string;
}

export type TaskAuthorityMode = "supervised" | "policy-scoped";

export interface TaskExecutionGrant {
  schemaVersion: 1;
  authority: TaskAuthorityMode;
  allowedCapabilities: string[];
  maxAutoApprovedRisk: Exclude<ToolRisk, "destructive">;
  budget: TaskBudget;
  scopes: {
    workspaceRoot?: string;
    browserDomains?: string[];
    desktopProcesses?: string[];
    desktopWindows?: string[];
  };
}

export interface MissionLaunchPolicy {
  authority: TaskAuthorityMode;
  requestedCapabilities: string[];
  maxAutoApprovedRisk: Exclude<ToolRisk, "destructive">;
  budget?: TaskBudget;
  authorizationToken?: string;
}

export interface MissionAuthorizationRequest {
  objective: string;
  workspaceRoot?: string;
  acceptanceCriteria: TaskAcceptanceCriterion[];
  constraints: string[];
  assumptions: string[];
  policy: Omit<MissionLaunchPolicy, "authorizationToken">;
  automation?: AutomationConfig;
}

export interface MissionAuthorization {
  token: string;
  expiresAt: string;
}

export interface MissionCapabilitiesRequest {
  email?: EmailConfig;
  stt?: SttConfig;
  embed?: EmbedConfig;
  automation?: AutomationConfig;
}

export interface MissionCapabilityDescriptor {
  id: string;
  risk: ToolRisk;
}

export interface TaskSpec {
  objective: string;
  acceptanceCriteria: TaskAcceptanceCriterion[];
  constraints: string[];
  assumptions: string[];
  workspaceRoot?: string;
  budget?: TaskBudget;
  executionGrant?: TaskExecutionGrant;
}

export interface TaskLease {
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export type TaskApprovalStatus = "pending" | "approved" | "denied" | "interrupted";

/** Durable record of the tool call currently awaiting, or most recently given,
 *  a human decision. It is audit state only after resolution; interrupted calls
 *  are never replayed automatically. */
export interface TaskApproval {
  taskId: string;
  turnId: string;
  callId: string;
  toolName: string;
  arguments: string;
  risk?: ToolRisk;
  status: TaskApprovalStatus;
  requestedAt: string;
  respondedAt?: string;
  comment?: string;
}

/** Materialized durable task state. It is persisted after each transition so
 *  main-process execution can resume after a renderer reload or app restart. */
export interface TaskSnapshot {
  id: string;
  spec: TaskSpec;
  state: TaskState;
  steps: TaskStep[];
  missionPlan?: TaskMissionPlan;
  artifacts?: TaskArtifactReference[];
  evidence: TaskEvidence[];
  attempts: TaskAttempt[];
  blocker?: TaskBlocker;
  lease?: TaskLease;
  approval?: TaskApproval;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  revision: number;
}

export type TaskHistoryKind = "created" | "transition" | "approval" | "attempt" | "evidence";

/** Renderer-safe projection of the append-only task journal. Raw snapshots,
 * tool arguments, approval comments, and evidence output are intentionally
 * excluded. */
export interface TaskHistoryEntry {
  id: string;
  taskId: string;
  revision: number;
  sequence: number;
  occurredAt: string;
  kind: TaskHistoryKind;
  summary: string;
  fromState?: TaskState;
  toState?: TaskState;
  turnId?: string;
  callId?: string;
  toolName?: string;
  approvalStatus?: TaskApprovalStatus;
  risk?: ToolRisk;
  attemptId?: string;
  attemptOutcome?: TaskAttempt["outcome"];
  criterionId?: string;
  evidenceKind?: TaskEvidence["kind"];
  passed?: boolean;
}

export type ProductDiagnosticKind =
  | "renderer-startup"
  | "launch-first-response"
  | "turn-started"
  | "first-response"
  | "approval-requested"
  | "approval-resolved"
  | "task-blocked"
  | "blocker-recovery"
  | "reload-recovery"
  | "stop-settled"
  | "verification-result"
  | "turn-settled"
  | "provider-failure";

export interface ProductDiagnosticEntry {
  id: string;
  occurredAt: string;
  kind: ProductDiagnosticKind;
  durationMs?: number;
  outcome?: "completed" | "aborted" | "failed" | "blocked" | "passed" | "failed-verification" | "approved" | "denied";
  category?: "authentication" | "rate-limit" | "network" | "configuration" | "provider" | "unknown";
  mission?: boolean;
  approvalRisk?: ToolRisk;
}

export interface ProductDiagnosticsConfig {
  enabled: boolean;
  retentionDays: number;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface DocumentAttachment {
  name: string;
  mediaType: string;
  text: string;
}

/** A tool invocation requested by the model. `arguments` is the raw JSON string
 *  the model emitted (parsed at execution time). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Content-risk tier the permission policy resolves for a tool call. */
export type ToolRisk = "readonly" | "mutating" | "destructive";

/** The neutral conversation unit. Providers translate to/from their own wire
 *  formats (OpenAI tool_calls / Anthropic tool_use + tool_result). */
export interface AgentMessage {
  role: ChatRole;
  content: string;
  /** present on assistant turns that invoke tools */
  toolCalls?: ToolCall[];
  /** present on tool-result turns; references the ToolCall.id it answers */
  toolCallId?: string;
  /** present on tool-result turns that ran under auto-approve without a prompt;
   *  persisted so reloaded history stays truthful about what ran unattended */
  autoApproved?: boolean;
  /** real content-risk tier the permission policy resolved when this tool ran;
   *  persisted so an after-the-fact audit reflects what actually ran rather than
   *  a name-based guess. Absent on readonly allow-listed tools the policy runs
   *  without recording a tier. */
  risk?: ToolRisk;
  /** wall-clock milliseconds the tool took to execute, recorded when this
   *  tool ran so an audit can show how long each call took. Absent on history
   *  saved before durations were tracked. */
  durationMs?: number;
  /** present on an assistant turn cut off by an error mid-stream; persisted so
   *  reloaded history shows it was interrupted rather than a complete reply */
  interrupted?: boolean;
  /** token counts the provider reported for the round that produced this
   *  message, when available; the session total is the sum across messages */
  usage?: TokenUsage;
  /** image attachments on a user turn, as data URLs (data:<mime>;base64,...).
   *  Sent to vision-capable models as image content parts alongside the text */
  images?: string[];
  /** Text documents attached to a user turn. Kept structured in the transcript
   *  and expanded into model-readable content only by provider adapters. */
  documents?: DocumentAttachment[];
  /** id of the turn that produced this message; stamped on assistant turns so
   *  the renderer can look up and revert the files that turn changed */
  turnId?: string;
  /** set on the seed messages of a conversation continued from another chat, so
   *  the renderer can render the carried-over digest as a collapsed card rather
   *  than a wall-of-text bubble. Ignored by providers. */
  handoff?: boolean;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Shadow confidence label for a completed turn, derived from what happened in
 *  the turn (no extra model call). Shown as an opt-in chip in the renderer. */
export type ConfidenceMode = "settled" | "reasoned" | "web-fresh" | "needs-review";

/** Ask the model to write a handoff summary of a conversation so the user can
 *  continue it in a fresh chat without re-sending the whole history. */
export interface HandoffSummaryRequest {
  config: ProviderConfig;
  /** the conversation to summarize, oldest first */
  messages: AgentMessage[];
  /** the conversation's title, used to orient the summary */
  title: string;
}

export interface HandoffSummaryResult {
  ok: boolean;
  /** the model's summary; empty when ok is false */
  summary: string;
  /** why the summary could not be written, for the fallback path */
  error?: string;
}

/** How the agent loop reacts to prompt-injection phrasing in external tool
 *  output. `off` disables scanning, `flag` prepends a visible warning, `block`
 *  withholds a high-confidence hit's content. Shared with the renderer settings. */
export type InjectionMode = "off" | "flag" | "block";

/** Tool advertised to the model. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Normalized turn events emitted by the agent runner to the renderer. */
export type MossEvent =
  | { type: "text-delta"; text: string }
  | { type: "token-usage"; usage: TokenUsage }
  | { type: "round-start"; round: number; toolsEnabled: boolean }
  | { type: "round-end"; round: number; toolCallCount: number; finish: "tools" | "complete" | "rejected" | "error" }
  | { type: "tool-call"; callId: string; name: string; arguments: string }
  | { type: "tool-approval-request"; callId: string; name: string; arguments: string; risk?: ToolRisk; provenance?: ApprovalProvenance }
  | { type: "tool-result"; callId: string; name: string; ok: boolean; content: string; autoApproved: boolean; risk?: ToolRisk; durationMs?: number }
  | { type: "notice"; level: "info" | "warn"; message: string }
  | { type: "context-compaction"; reason: "proactive" | "overflow"; droppedCount: number }
  | { type: "verification"; ok: boolean; checkCount: number; failedCheckHash?: string }
  | { type: "recovery"; action: string; attempt: number; classification?: string; outcome?: "attempted" | "succeeded" | "terminal"; sourceCallId?: string }
  | { type: "task-state"; task: TaskSnapshot }
  | { type: "confidence"; mode: ConfidenceMode; note: string }
  | { type: "turn-complete"; messages: AgentMessage[] }
  | { type: "turn-aborted"; messages: AgentMessage[] }
  | { type: "working-state"; state: WorkingState }
  | { type: "supervisor"; action: "warn" | "stop"; stalledRounds: number; reason: string }
  | { type: "harness-decision"; decision: HarnessDecision }
  | {
    type: "turn-error";
    message: string;
    messages: AgentMessage[];
    source: "provider-model" | "tool" | "harness-orchestration";
  };

export interface ChatStartRequest {
  turnId: string;
  /** Existing durable task to continue. Distinct from the ephemeral turn ID
   *  used for streaming, approvals, cancellation, and checkpoints. */
  taskId?: string;
  config: ProviderConfig;
  messages: AgentMessage[];
  /** absolute path tools are sandboxed to; empty = no filesystem access */
  workspaceRoot?: string;
  /** when false, tools are not advertised (plain chat, for non-tool models) */
  enableTools?: boolean;
  jevEnabled?: boolean;
  /** maximum tool-execution rounds before the model gets a final tool-disabled
   *  response round; the backend clamps this to a safe supported range. */
  maxToolRounds?: number;
  /** when true, run mutating tools without pausing for per-call approval */
  autoApproveTools?: boolean;
  /** user-authored persona/instructions appended to the base system prompt;
   *  the safety section is always kept, so this cannot disable XPIA defenses */
  customInstructions?: string;
  /** id of the selected personality preset; the backend maps it to an
   *  allow-listed prompt, so an unknown id injects nothing */
  personalityId?: string;
  /** when true, the assistant adapts its tone to remembered preferences
   *  (memory-driven adaptation) */
  adaptiveTone?: boolean;
  /** speech-to-text config for the transcribe_audio tool */
  stt?: SttConfig;
  /** email config for the send_email tool */
  email?: EmailConfig;
  /** verification commands run after the agent edits files */
  verify?: VerifyConfig;
  /** embeddings config so the search_codebase tool can embed queries */
  embed?: EmbedConfig;
  /** When present, execute this turn as a durable autonomous task. Callers may
   *  omit it for ordinary chat that should stop after one assistant response. */
  taskSpec?: TaskSpec;
  /** User-selected mission policy. Electron resolves this request against the
   *  live tool registry, configured scopes, and hard budget ceilings before
   *  creating the durable task; callers cannot supply the resulting grant. */
  mission?: MissionLaunchPolicy;
  automation?: AutomationConfig;
  /** soft daily USD spend cap; when > 0 the backend blocks new requests once the
   *  day's estimated spend reaches it. Absent or 0 means no cap. */
  dailyBudgetUsd?: number;
  /** user pricing overrides (lowercased model id -> rate) so the budget cap is
   *  charged with the same rates the cost readout displays. */
  modelRates?: Record<string, ModelRate>;
  /** when true, m_remember queues proposals for human review instead of writing
   *  durable memory directly. */
  gatedMemory?: boolean;
  /** when true, the runner emits a shadow confidence label at turn end for the
   *  renderer to show as a chip (no behavior change). */
  showConfidence?: boolean;
  /** how external tool output is scanned for prompt injection; defaults to
   *  "flag" on the backend when absent. */
  injectionMode?: InjectionMode;
  /** the model's context window in tokens; when > 0, the runner proactively
   *  drops the oldest messages once history exceeds a fraction of it. Provider
   *  overflow can still trigger one reactive compaction when absent or 0. */
  contextLimit?: number;
  /** adapt tools and guidance to the stored capability profile; absent means on */
  adaptiveScaffolding?: boolean;
  /** model routing on the same provider connection */
  routing?: ModelRouting;
  /** record every model call in this turn to a local replayable trace */
  recordTrace?: boolean;
  /** conversation working state: invariants, protected paths, decisions, facts, questions */
  workingState?: WorkingState;
  /** stop after this many rounds without progress; 0 disables; default 5 */
  stallLimit?: number;
  /** false lets auto-approve cover changes that follow untrusted content; absent means gated */
  untrustedContentGate?: boolean;
  /** per-model constrained step protocol; absent or "auto" uses it for limited and unreliable profiles */
  constrainedOutput?: Record<string, ConstrainedOutputMode>;
  /** per-model voting over constrained steps; absent or "auto" votes for fast limited local models */
  stepVoting?: Record<string, ConstrainedOutputMode>;
  /** read untrusted tool output with an isolated no-tool model; the turn's model sees only its extract */
  quarantineUntrusted?: boolean;
  /** learn procedures from verified tool sequences and offer run_procedure; absent means on */
  learnProcedures?: boolean;
  /** rank narrowed tools, find_tool results, and recalled lessons by meaning with `embed`; off unless opted in */
  semanticRanking?: boolean;
}

/** A model on a specific provider connection. The main process resolves the
 *  API key for `presetId` from secure storage; keys never travel in routes. */
export interface ModelRoute {
  presetId?: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
}

export type ConstrainedOutputMode = "auto" | "always" | "never";

export interface ModelRouting {
  /** cheaper or faster model for context summaries and read-only subagents, on the current connection */
  fastModel?: string;
  /** stronger model the turn switches to after repeated rejected work, on the current connection */
  escalationModel?: string;
  /** fast model on any configured provider; takes precedence over fastModel */
  fastRoute?: ModelRoute;
  /** escalation model on any configured provider; takes precedence over escalationModel */
  escalationRoute?: ModelRoute;
  /** critic for mission reviews, on the current connection */
  criticModel?: string;
  /** critic for mission reviews on any configured provider; takes precedence over criticModel */
  criticRoute?: ModelRoute;
  /** rejected completions or failed verifications before escalating; default 2 */
  escalateAfter?: number;
}

// --- Turn traces and replay ---

export interface TraceCall {
  index: number;
  startedAt: string;
  durationMs: number;
  model: string;
  /** provider that served this call, when it differs from the trace's primary endpoint */
  providerKind?: ProviderKind;
  endpoint?: string;
  constrained?: boolean;
  request: {
    messages: AgentMessage[];
    toolNames: string[];
    maxTokens?: number;
  };
  response: {
    text: string;
    toolCalls: ToolCall[];
    usage?: TokenUsage;
  };
  error?: string;
}

export interface TurnTrace {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  providerKind: ProviderKind;
  endpoint: string;
  primaryModel: string;
  tools: ToolDefinition[];
  calls: TraceCall[];
  outcome?: "completed" | "aborted" | "failed";
  escalatedTo?: string;
  verification?: { passed: number; failed: number };
  /** harness decisions in the order they were made */
  decisions?: HarnessDecision[];
  /** reproducible start state for practice runs: a clean git checkout and the verification commands */
  outcomeContext?: { workspaceRoot: string; gitHead: string; verifyCommands: string[] };
}

export interface TurnTraceSummary {
  id: string;
  createdAt: string;
  primaryModel: string;
  escalatedTo?: string;
  callCount: number;
  toolCallCount: number;
  outcome?: TurnTrace["outcome"];
  preview: string;
}

export type ReplayAgreement = "same-action" | "different-tool" | "answered-instead" | "called-tool-instead" | "error";

/** A third-family judge's view of a step where the candidate differed from the original. */
export interface ReplayJudgement {
  candidateReasonable: boolean;
  /** candidate's step compared with the original model's */
  comparison: "better" | "equal" | "worse";
  reason: string;
  judgeModel: string;
}

export interface ReplayCallResult {
  index: number;
  baseline: { toolNames: string[]; answered: boolean };
  candidate: {
    toolNames: string[];
    answered: boolean;
    validArguments: boolean;
    unknownArguments: string[];
    text: string;
    durationMs: number;
    outputTokens?: number;
    error?: string;
  };
  agreement: ReplayAgreement;
  judgement?: ReplayJudgement;
}

export interface ReplayReport {
  schemaVersion: 1;
  traceId: string;
  baselineModel: string;
  candidateModel: string;
  baselineOutcome?: TurnTrace["outcome"];
  replayedAt: string;
  calls: ReplayCallResult[];
  summary: {
    calls: number;
    sameAction: number;
    agreementRate: number;
    validArgumentRate: number;
    errors: number;
    medianLatencyMs?: number;
    baselineMedianLatencyMs?: number;
    inputTokens: number;
    outputTokens: number;
    /** differing steps a judge reviewed */
    judged?: number;
    /** same steps plus differing steps the judge found reasonable */
    acceptable?: number;
    acceptableRate?: number;
    /** differing steps the judge preferred over the original */
    better?: number;
  };
  judgeModel?: string;
  /** why differing steps were not judged */
  judgeSkipped?: string;
}

export interface TraceReplayRequest {
  traceId: string;
  config: ProviderConfig;
  /** judge for steps where the candidate differs; must be a third model family */
  judge?: ModelRoute;
  timeoutSeconds?: number;
}

export interface ToolApprovalResponse {
  approved: boolean;
  comment?: string;
}

export interface ToolApprovalDecision extends ToolApprovalResponse {
  turnId: string;
  callId: string;
}

export interface ChatEventPayload {
  turnId: string;
  event: MossEvent;
}

/** A file a turn changed, as reported to the renderer for the revert affordance. */
export interface CheckpointFile {
  /** workspace-relative path */
  path: string;
  /** false when the turn created the file (revert deletes it) */
  existed: boolean;
}

/** Outcome of reverting a turn's file changes. */
export interface CheckpointRevertResult {
  /** number of files restored or deleted */
  reverted: number;
  /** per-file failures, as "<path>: <message>" */
  errors: string[];
}

/** Current state of a workspace file, used to preview a pending write. */
export interface WorkspaceFilePreview {
  exists: boolean;
  content?: string;
  byteLength?: number;
  truncated?: boolean;
  binary?: boolean;
  error?: string;
}

/** A verification command inferred from a project manifest. Advisory only. */
export interface VerificationSuggestion {
  command: string;
  source: string;
}

// --- Model capability profiling ---

export type CapabilityDimension =
  | "tool-calling"
  | "tool-selection"
  | "tool-restraint"
  | "structured-output"
  | "instruction-following"
  | "usable-context"
  | "plan-coherence";

export interface CapabilityTrial {
  id: string;
  passed: boolean;
  /** 0..1; partial credit where a probe allows it */
  score: number;
  note?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** the request failed or timed out, so the trial measures availability, not capability */
  errored?: boolean;
}

export interface CapabilityProbeResult {
  dimension: CapabilityDimension;
  /** 0..1 mean trial score */
  score: number;
  passed: number;
  total: number;
  summary: string;
  trials: CapabilityTrial[];
  durationMs: number;
  /** probe-specific measurements such as usableContextTokens or maxCoherentSteps */
  metrics?: Record<string, number>;
}

export type ModelCapabilityTier = "strong" | "capable" | "limited" | "unreliable";

export interface ModelScaffoldingRecommendation {
  scaffolding: "light" | "moderate" | "heavy";
  toolUse: "reliable" | "supervised" | "avoid";
  structuredOutput: "direct" | "repair";
  usableContextTokens?: number;
  maxCoherentSteps?: number;
  /** existing Moss settings the measurements support; never includes approval bypasses */
  settings: { enableTools?: boolean; maxToolRounds?: number; contextLimit?: number };
  notes: string[];
}

export interface ModelCapabilityProfile {
  schemaVersion: 1;
  suiteVersion: string;
  providerKind: ProviderKind;
  /** endpoint origin and path, without credentials or query */
  endpoint: string;
  model: string;
  probedAt: string;
  durationMs: number;
  maxContextTested: number;
  results: CapabilityProbeResult[];
  /** 0..1 weighted across the dimensions that completed at least one trial */
  overall: number;
  tier: ModelCapabilityTier;
  usage: TokenUsage;
  /** median and 90th-percentile latency of completed short requests */
  latency?: { medianMs: number; p90Ms: number };
  /** requests that failed or timed out; their trials are excluded from scores */
  failedRequests: number;
  /** time for the untimed warm-up request, which includes loading a local model */
  warmupMs?: number;
  recommendation: ModelScaffoldingRecommendation;
}

/** Task families that live scores are kept for. */
export type ModelTaskKind = "chat" | "coding" | "research" | "automation" | "mission";

/** Host evidence about one model on one kind of task. Only harness outcomes
 *  (verification, task state, rejections, stalls) are recorded, never the
 *  model's own claims. */
export interface ModelPerformanceEntry {
  schemaVersion: 1;
  providerKind: ProviderKind;
  endpoint: string;
  model: string;
  kind: ModelTaskKind;
  /** settled turns, graded or not */
  runs: number;
  /** most recent graded outcomes, oldest first: s = verified success, f = failure */
  recent: Array<"s" | "f">;
  /** practice-run outcomes in disposable workspaces, oldest first */
  practice: Array<"s" | "f">;
  rejections: number;
  stalls: number;
  escalatedAway: number;
  repairs: number;
  /** exponential moving average of turn duration */
  latencyMs?: number;
  updatedAt: string;
}

export interface ModelLiveScore {
  kind: ModelTaskKind | "all";
  runs: number;
  /** graded outcomes, with practice runs counted at half weight */
  graded: number;
  successRate?: number;
  /** 95% Wilson interval of the success rate */
  lowerBound?: number;
  upperBound?: number;
  /** probe tier adjusted by at most one step once enough outcomes exist */
  effectiveTier?: ModelCapabilityTier;
}

/** How well an Ollama model's served context window suits the model and GPU. */
export interface OllamaContextReport {
  model: string;
  status: "ok" | "too-small" | "too-large" | "unknown" | "not-applicable";
  reason: string;
  servedContext?: number;
  trainedContext?: number;
  /** usable context measured by the capability probe */
  usableContext?: number;
  fitsInVram?: number;
  recommendedContext?: number;
  /** name of the variant Moss would create */
  variant?: string;
  gpu?: { name?: string; totalMiB: number; freeMiB: number };
  weightsMiB?: number;
  kvKiBPerToken?: number;
  spilledToCpu?: boolean;
}

export interface SetupDetectionRequest {
  ollamaBaseUrl: string;
  /** configured cloud presets to check for a saved key */
  cloud: Array<{ presetId: string; kind: ProviderKind; baseUrl: string }>;
}

export interface SetupDetection {
  ollama?: {
    baseUrl: string;
    version?: string;
    models: Array<{ name: string; sizeBytes: number; parameterSize?: string; family?: string }>;
  };
  gpu?: { name?: string; totalMiB: number; freeMiB: number };
  /** cloud providers with a saved key, and a suggested strong model when one was found */
  cloud: Array<{ presetId: string; kind: ProviderKind; baseUrl: string; model?: string }>;
}

/** Practice runs replay your recorded work against other local models while the PC is idle. */
export interface PracticeConfig {
  enabled: boolean;
  /** OpenAI-compatible endpoint the candidates run on (normally local Ollama) */
  baseUrl: string;
  candidates: string[];
  /** recent traces to replay per candidate */
  maxTraces?: number;
  /** minutes of user inactivity before a scheduled run */
  idleMinutes?: number;
}

export interface PracticeCandidateResult {
  model: string;
  decision: { calls: number; sameAction: number; validArgumentRate: number; medianLatencyMs?: number; errors: number };
  /** forward runs in disposable workspace copies, graded by the original verification commands */
  outcome: { runs: number; passed: number };
  error?: string;
}

export interface PracticeReport {
  startedAt: string;
  finishedAt: string;
  tracesUsed: number;
  /** traces with a reproducible start state that verification could discriminate */
  outcomeTraces: number;
  baseline: { models: string[]; medianLatencyMs?: number; outcome: { runs: number; passed: number } };
  candidates: PracticeCandidateResult[];
  recommendation?: { model: string; role: "chat" | "fast"; reason: string };
  cancelled?: boolean;
}

export interface PracticeProgress {
  message: string;
  completed: number;
  total: number;
}

export type ProcedureStatus = "candidate" | "trusted" | "demoted";

/** A procedure argument is either fixed or a slot the model fills. */
export type ProcedureArg = { const: unknown } | { slot: string };

export interface ProcedureStep {
  tool: string;
  args: Record<string, ProcedureArg>;
}

/** A tool sequence that passed verification repeatedly, run by the harness
 *  with the model filling only the slots. */
export interface Procedure {
  id: string;
  name: string;
  description: string;
  steps: ProcedureStep[];
  slots: Array<{ name: string; example: string }>;
  status: ProcedureStatus;
  /** verified turns the procedure was learned from */
  learnedFrom: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export type HarnessDecisionKind =
  | "scaffold" | "constrain" | "vote" | "repair" | "find-tool" | "route" | "escalate"
  | "gate" | "stall" | "budget" | "quarantine" | "procedure" | "live-score" | "context" | "critic";

/** One thing the harness decided during a turn, for the Why timeline. */
export interface HarnessDecision {
  kind: HarnessDecisionKind;
  summary: string;
  detail?: string;
  /** Settings category that controls this behavior */
  settings?: string;
}

export interface ModelProbeOptions {
  /** largest needle-in-haystack prompt to attempt, in estimated tokens */
  maxContextTokens?: number;
  dimensions?: CapabilityDimension[];
  /** per-request timeout for short probes, in seconds */
  timeoutSeconds?: number;
}

export interface ModelProbeRequest {
  config: ProviderConfig;
  options?: ModelProbeOptions;
}

export interface ModelProbeProgress {
  dimension: CapabilityDimension;
  completedDimensions: number;
  totalDimensions: number;
  message: string;
}

// --- Durable memory & skills (Phase 5) ---

export type MemoryCategory = "preference" | "fact" | "decision" | "context";

export interface MemoryEntry {
  id: string;
  fact: string;
  category: MemoryCategory;
  /** who recorded it, e.g. "assistant" or "user" */
  source: string;
  createdAt: string;
}

export interface Skill {
  /** filesystem-safe directory id */
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  createdAt: string;
  /** Imported and agent-created skills start disabled until a human reviews
   *  and enables them. */
  createdBy?: "user" | "agent" | "import";
  /** False when the skill may only be loaded explicitly by name. */
  modelInvocable?: boolean;
  /** Earned trust from verified use; absent before the ledger has seen the skill. */
  trust?: SkillTrust;
}

export type SkillTrustStatus = "candidate" | "trusted" | "demoted";

export interface SkillTrust {
  status: SkillTrustStatus;
  version: number;
  uses: number;
  verifiedSuccesses: number;
  failures: number;
  /** verified successes on the current version; promotion needs PROMOTE_AFTER */
  versionSuccesses: number;
  consecutiveFailures: number;
  lastUsedAt?: string;
  /** unused for the decay period; stale skills are demoted on their next failure */
  stale: boolean;
  statusReason: string;
}

// --- Governed working state ---

export type WorkingStateKind = "invariant" | "protected" | "decision" | "fact" | "question";

export interface WorkingStateEntry {
  id: string;
  kind: WorkingStateKind;
  text: string;
  rationale?: string;
  source: "user" | "model";
  createdAt: string;
}

export interface WorkingState {
  schemaVersion: 1;
  entries: WorkingStateEntry[];
}

/** Why an approval was forced: untrusted content entered the turn before this side effect. */
export interface ApprovalProvenance {
  untrustedSources: string[];
  /** the arguments contain text or URLs copied from that untrusted content */
  copiedFromUntrusted: boolean;
  /** the rule that required approval, in plain language */
  rule?: string;
}

export interface SkillImportResult {
  imported: string[];
  skipped: string[];
  invalid: string[];
}

export interface SkillCreateRequest {
  name: string;
  description: string;
  instructions: string;
}

export interface SkillUpdateRequest {
  id: string;
  description: string;
  instructions: string;
}

export interface SkillRenameRequest {
  id: string;
  newName: string;
}

// --- MCP runtime status (Phase 6 settings, read-only) ---

export interface McpServerStatus {
  id: string;
  /** false when the server is configured but turned off in mcp-servers.json;
   *  such servers are listed (so the settings UI can re-enable them) but never
   *  connected. */
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  /** names of the tools the server exposes (raw MCP tool names, unprefixed);
   *  present only while connected, for a hover/expand list in the settings UI */
  tools?: string[];
  /** the user trusts this server's read-only annotations */
  trustAnnotations?: boolean;
  /** the user chose to ignore this server's destructive flags */
  ignoreDestructiveHints?: boolean;
  /** tools the server flags as destructive (raw names), present while connected */
  destructiveTools?: string[];
  /** tools hidden from the model by the server's hiddenTools setting */
  hiddenTools?: string[];
  /** tools the server annotates as read-only (raw names), present while connected */
  readOnlyTools?: string[];
  error?: string;
}

// --- Speech-to-text (Whisper via OpenAI-compatible /audio/transcriptions) ---

export interface TranscribeRequest {
  /** base64-encoded audio bytes captured in the renderer */
  audioBase64: string;
  mimeType: string;
  /** transcription endpoint base URL (e.g. http://localhost:8000/v1) */
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface TranscribeResult {
  text?: string;
  error?: string;
}

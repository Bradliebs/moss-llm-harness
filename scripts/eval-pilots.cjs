const {
  createOfflinePilotCases,
  getOfflinePilotEvaluatorArtifacts,
} = require("../dist-electron/electron/backend/moss/evals/pilot-cases.js");
const {
  REPRESENTATIVE_CORPUS_POLICY,
  createRepresentativeCorpus,
  getRepresentativeEvaluatorArtifacts,
} = require("../dist-electron/electron/backend/moss/evals/representative-corpus.js");
const { createRepresentativeGraderHealthProbes } = require("../dist-electron/electron/backend/moss/evals/grader-health.js");
const { createTurnEvalExecutor } = require("../dist-electron/electron/backend/moss/evals/turn-eval-executor.js");
const { DockerEvalSandboxBackend } = require("../dist-electron/electron/backend/moss/evals/sandbox-backend.js");
const { validateEvalCaseCapabilities } = require("../dist-electron/electron/backend/moss/evals/trusted-scenario-tools.js");
const { selectExecutionCases, requiresEvalSandbox } = require("../dist-electron/electron/backend/moss/evals/execution-selection.js");
const { allowedExecutionSplits, validateSplitExecution } = require("../dist-electron/electron/backend/moss/evals/split-policy.js");
const { OpenAiCompatibleProvider } = require("../dist-electron/electron/backend/moss/providers/openai-compatible.js");
const { TOOL_REGISTRY } = require("../dist-electron/electron/backend/moss/tools/index.js");

const baseUrl = process.env.MOSS_EVAL_BASE_URL || "http://localhost:11434/v1";
const model = process.env.MOSS_EVAL_MODEL || "qwen3:8b";
const apiKey = process.env.MOSS_EVAL_API_KEY;
const reasoningEffort = process.env.MOSS_EVAL_REASONING_EFFORT;
if (reasoningEffort !== undefined && reasoningEffort !== "none") {
  throw new Error("MOSS_EVAL_REASONING_EFFORT must be none or unset");
}
const repetitions = Number(process.env.MOSS_EVAL_REPETITIONS || "1");
const corpus = process.env.MOSS_EVAL_CORPUS || "pilot";
const experiment = process.env.MOSS_EVAL_EXPERIMENT || "approval";
const executionSelection = process.env.MOSS_EVAL_EXECUTION || "local";
const executionPolicy = {
  purpose: process.env.MOSS_EVAL_PURPOSE || "iteration",
  ...(process.env.MOSS_EVAL_MEASUREMENT ? { measurementName: process.env.MOSS_EVAL_MEASUREMENT } : {}),
};
const allowedSplits = allowedExecutionSplits(executionPolicy);
const sandboxImage = process.env.MOSS_EVAL_SANDBOX_IMAGE;
const sandboxNetwork = process.env.MOSS_EVAL_SANDBOX_NETWORK || "none";
if (!["none", "bridge"].includes(sandboxNetwork)) throw new Error("MOSS_EVAL_SANDBOX_NETWORK must be none or bridge");
if (sandboxNetwork === "bridge" && !sandboxImage) throw new Error("Network opt-in requires MOSS_EVAL_SANDBOX_IMAGE");
if (sandboxImage) new DockerEvalSandboxBackend({ image: sandboxImage });
if (![undefined, "0", "1"].includes(process.env.MOSS_EVAL_RETRY_INFRASTRUCTURE)) throw new Error("MOSS_EVAL_RETRY_INFRASTRUCTURE must be 0 or 1");
const concurrency = Number(process.env.MOSS_EVAL_CONCURRENCY || "1");
const providerConcurrency = Number(process.env.MOSS_EVAL_PROVIDER_CONCURRENCY || String(concurrency));
const requestedSuites = (process.env.MOSS_EVAL_SUITES || "").split(",").map((suite) => suite.trim()).filter(Boolean);
const knownSuites = new Set(["regression", "capability", "challenge"]);

if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("MOSS_EVAL_REPETITIONS must be a positive integer");
}
if (corpus !== "pilot" && corpus !== "representative") {
  throw new Error("MOSS_EVAL_CORPUS must be 'pilot' or 'representative'");
}
if (experiment !== "approval" && experiment !== "phase5-runtime") {
  throw new Error("MOSS_EVAL_EXPERIMENT must be 'approval' or 'phase5-runtime'");
}
if (requestedSuites.some((suite) => !knownSuites.has(suite))) {
  throw new Error("MOSS_EVAL_SUITES contains an unknown suite");
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(providerConcurrency) || providerConcurrency < 1) {
  throw new Error("MOSS_EVAL_CONCURRENCY and MOSS_EVAL_PROVIDER_CONCURRENCY must be positive integers");
}

const allCases = corpus === "representative"
  ? createRepresentativeCorpus(process.cwd())
  : createOfflinePilotCases(process.cwd());
const suiteCases = requestedSuites.length > 0
  ? allCases.filter((testCase) => requestedSuites.includes(testCase.suite))
  : allCases;
const splitCases = suiteCases.filter((testCase) => allowedSplits.includes(testCase.split || "development"));
for (const testCase of allCases) validateEvalCaseCapabilities(testCase);
function validateExecution() {
  validateSplitExecution(selected.cases, executionPolicy, allCases);
  if (selected.cases.some((testCase) => config.variants.some((variant) => requiresEvalSandbox(testCase, variant))) && !sandboxImage) {
    throw new Error("Container cases require MOSS_EVAL_SANDBOX_IMAGE pinned by sha256 digest; use MOSS_EVAL_EXECUTION=local for Docker-free evaluation");
  }
}
const fullRepresentativeCorpus = corpus === "representative";

const config = {
  executionPolicy,
  validateExecution,
  evaluatorVersion: "moss-harness-v1",
  evaluatorArtifacts: [
    ...(corpus === "representative"
      ? getRepresentativeEvaluatorArtifacts(process.cwd())
      : getOfflinePilotEvaluatorArtifacts(process.cwd())),
    `${process.cwd()}/dist-electron`,
    `${process.cwd()}/scripts/eval-pilots.cjs`,
    `${process.cwd()}/package-lock.json`,
  ],
  healthCases: allCases,
  corpusPolicy: fullRepresentativeCorpus ? REPRESENTATIVE_CORPUS_POLICY : undefined,
  graderHealthProbes: fullRepresentativeCorpus
    ? createRepresentativeGraderHealthProbes(allCases, process.cwd())
    : undefined,
  matrix: {
    retryInfrastructureFailures: process.env.MOSS_EVAL_RETRY_INFRASTRUCTURE === "1",
    maxConcurrency: concurrency,
    providerConcurrency: { [baseUrl]: providerConcurrency },
  },
  targets: [{
    schemaVersion: 1,
    id: reasoningEffort ? "local-openai-compatible-reasoning-none" : "local-openai-compatible",
    providerId: baseUrl,
    providerKind: "openai-compatible",
    model,
    ...(reasoningEffort ? { generation: { reasoningEffort } } : {}),
  }],
  variants: (experiment === "phase5-runtime" ? [
    {
      schemaVersion: 1,
      id: "phase5-baseline-gated",
      description: "Runtime baseline with explicit fixture approval",
      promptProfile: "deterministic-production-v2",
      autoApprove: false,
      injectionMode: "flag",
      maxRounds: 8,
      runtime: {
        contextStrategy: "full",
        planningPolicy: "free-form",
        verificationCadence: "terminal",
        recoveryPolicy: "standard",
        reviewerPass: "off",
      },
    },
    {
      schemaVersion: 1,
      id: "phase5-candidate-gated",
      description: "Incremental runtime with compact context, signature-aware recovery, and explicit fixture approval",
      promptProfile: "deterministic-production-v2",
      autoApprove: false,
      injectionMode: "flag",
      contextLimit: 4000,
      maxRounds: 8,
      runtime: {
        contextStrategy: "compact",
        planningPolicy: "incremental",
        verificationCadence: "after-mutation",
        recoveryPolicy: "signature-aware",
        reviewerPass: "diagnostic",
      },
    },
  ] : [
    {
      schemaVersion: 1,
      id: "auto-approved",
      description: "Automatically approve mutating tools",
      promptProfile: "deterministic-production-v2",
      autoApprove: true,
      injectionMode: "flag",
      maxRounds: 8,
    },
    {
      schemaVersion: 1,
      id: "approval-gated",
      description: "Request approval before mutating tools",
      promptProfile: "deterministic-production-v2",
      autoApprove: false,
      injectionMode: "flag",
      maxRounds: 8,
    },
  ]).map((variant) => ({ ...variant, ...(sandboxImage ? { sandbox: { image: sandboxImage, allowNetwork: sandboxNetwork === "bridge" } } : {}) })),
  createExecutor(target, variant, workspaceRoot, context) {
    validateExecution();
    return createTurnEvalExecutor({
      provider: new OpenAiCompatibleProvider(baseUrl, apiKey, { reasoningEffort: target.generation?.reasoningEffort }),
      model: target.model,
      maxOutputTokens: target.generation?.maxOutputTokens,
      toolRegistry: TOOL_REGISTRY,
      workspaceRoot: () => workspaceRoot,
      requestApproval: async () => ({ approved: true }),
      promptNow: () => new Date(2026, 6, 23, 12),
      variant,
      signal: context?.signal,
      diagnostics: context?.diagnostics,
    });
  },
};

const selected = selectExecutionCases(splitCases, config.variants, executionSelection);
if (selected.cases.length === 0) throw new Error("Execution and suite selections produced no evaluation cases");
module.exports = {
  ...config,
  cases: selected.cases.map((testCase) => ({ ...testCase, repetitions })),
  executionCoverage: {
    selection: executionSelection,
    corpusCaseIds: allCases.map((testCase) => testCase.id),
    excluded: [
      ...allCases.filter((testCase) => !suiteCases.includes(testCase)).map((testCase) => ({ caseId: testCase.id, reason: "suite-filter" })),
      ...suiteCases.filter((testCase) => !splitCases.includes(testCase)).map((testCase) => ({ caseId: testCase.id, reason: "split-filter" })),
      ...selected.excluded,
    ],
  },
};
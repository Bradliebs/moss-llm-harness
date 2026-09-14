import { createHash, randomUUID } from "node:crypto";

import type { EvalAdmission, EvalCase, EvalExecutionObservation, EvalScenarioDisturbance, HarnessDiagnosticReview, HarnessExecutionTrace, HarnessVariant } from "../../../../common/evals";
import type { AgentMessage, MossEvent, TokenUsage, ToolApprovalResponse } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import { ProviderError, type ChatProvider, type ProviderStreamEvent } from "../providers/types";
import { buildSystemMessage } from "../system-prompt";
import type { Tool } from "../tools";
import type { EvalExecutionResult, EvalExecutor } from "./eval-runner";
import { HarnessTraceCollector } from "./trace-collector";
import type { HarnessDiagnosticCapture } from "./diagnostic-artifact-store";
import { DockerEvalSandboxBackend, type EvalSandboxBackend } from "./sandbox-backend";
import { createSandboxTools } from "./sandbox-tools";
import { createTrustedScenarioTools, validateEvalCaseCapabilities } from "./trusted-scenario-tools";
import { requiresEvalSandbox } from "./execution-selection";
import type { VerifyResult } from "../verify/verifier";
import { createContextScenarioSetup, createResumeScenarioSetup } from "./context-scenario";

export interface TurnEvalExecutorOptions {
  provider: ChatProvider;
  model: string;
  maxOutputTokens?: number;
  toolRegistry: Map<string, Tool>;
  workspaceRoot: (testCase: EvalCase, repetition: number) => Promise<string> | string;
  messages?: (testCase: EvalCase, repetition: number) => Promise<AgentMessage[]> | AgentMessage[];
  requestApproval?: (callId: string) => Promise<ToolApprovalResponse>;
  autoApprove?: boolean;
  estimateCostUsd?: (usage: TokenUsage) => number;
  now?: () => Date;
  promptNow?: () => Date;
  variant?: HarnessVariant;
  signal?: AbortSignal;
  diagnostics?: HarnessDiagnosticCapture;
  sandboxBackend?: EvalSandboxBackend;
}

const DEFAULT_PROMPT_PROFILE = "deterministic-production-v2";

/** Adapt the production agent loop to the provider-neutral evaluation runner. */
export function createTurnEvalExecutor(options: TurnEvalExecutorOptions): EvalExecutor {
  if (options.variant?.runtime?.contextStrategy === "compact"
    && (!Number.isInteger(options.variant.contextLimit) || options.variant.contextLimit! < 1)) {
    throw new Error(`Harness variant '${options.variant.id}' requires a positive context limit for compact context`);
  }
  const now = options.now ?? (() => new Date());
  return async (testCase, repetition): Promise<EvalExecutionResult> => {
    const trustedCapabilities = validateEvalCaseCapabilities(testCase);
    const workspaceRoot = await options.workspaceRoot(testCase, repetition);
    const startedAtDate = now();
    const promptDate = options.promptNow?.() ?? startedAtDate;
    const traceCollector = new HarnessTraceCollector();
    const deliveredDisturbances = new Set<string>();
    const deliverDisturbance = (disturbance: EvalScenarioDisturbance): void => {
      if (deliveredDisturbances.has(disturbance.id)) return;
      deliveredDisturbances.add(disturbance.id);
      traceCollector.recordScenarioDisturbance(disturbance.id, disturbance.type, "delivered");
    };
    for (const disturbance of testCase.scenario?.disturbances ?? []) {
      traceCollector.recordScenarioDisturbance(disturbance.id, disturbance.type, "planned");
    }
    let messages: AgentMessage[] = options.messages
      ? await options.messages(testCase, repetition)
      : [
        buildSystemMessage({
          includeSkills: false,
          includeMemory: false,
          query: testCase.task.objective,
          now: () => promptDate,
        }),
        { role: "user", content: JSON.stringify(testCase.task) },
      ];
    for (const disturbance of testCase.scenario?.disturbances ?? []) {
      if (disturbance.type !== "context-pressure") continue;
      const pressureMessages: AgentMessage[] = Array.from({ length: disturbance.messageCount }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `scenario-context-${disturbance.id}-${index}:${"x".repeat(disturbance.charactersPerMessage)}`,
      }));
      messages = [messages[0], ...pressureMessages, ...messages.slice(1)];
      deliverDisturbance(disturbance);
    }
    const contextSetup = createContextScenarioSetup(testCase, messages);
    if (contextSetup) messages = contextSetup.messages;
    const promptProvenance = {
      profile: options.variant?.promptProfile ?? (options.messages ? "custom" : DEFAULT_PROMPT_PROFILE),
      seededMessagesHash: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
    };
    const allowed = new Set(testCase.allowedCapabilities);
    const requiresSandbox = requiresEvalSandbox(testCase, options.variant);
    const backend = options.sandboxBackend ?? (requiresSandbox
      ? new DockerEvalSandboxBackend({ image: options.variant?.sandbox?.image ?? "" }) : undefined);
    const trustedTools = await createTrustedScenarioTools(testCase, workspaceRoot);
    const selectedTools = (trustedTools ?? [...options.toolRegistry.values()]).filter((tool) => allowed.has(tool.name));
    const sandbox = backend ? createSandboxTools(selectedTools, backend, workspaceRoot, options.variant?.sandbox?.allowNetwork, trustedCapabilities) : undefined;
    const tools = sandbox?.tools ?? selectedTools;
    const toolInvocations = new Map<string, number>();
    const toolRegistry = new Map(tools.map((tool) => [tool.name, {
      ...tool,
      execute: async (...args: Parameters<Tool["execute"]>) => {
        const invocation = (toolInvocations.get(tool.name) ?? 0) + 1;
        toolInvocations.set(tool.name, invocation);
        const disturbance = testCase.scenario?.disturbances.find((candidate): candidate is Extract<
          EvalScenarioDisturbance,
          { type: "tool-failure" }
        > =>
          candidate.type === "tool-failure"
          && candidate.capability === tool.name
          && (candidate.invocation === invocation || (candidate.persistent === true && invocation > candidate.invocation)));
        if (!disturbance) return tool.execute(...args);
        deliverDisturbance(disturbance);
        return {
          ok: false,
          content: disturbance.failure === "transient"
            ? `Tool temporarily unavailable (scenario ${disturbance.id})`
            : `Tool failed permanently (scenario ${disturbance.id})`,
        };
      },
    }]));
    const admissions: EvalAdmission[] = [];
    const usage: TokenUsage = {};
    const approvalRequests = new Set<string>();
    const failedTools = new Set<string>();
    const approvalCalls = new Map<string, { capability: string; invocation: number }>();
    const approvalInvocations = new Map<string, number>();
    const hasApprovalScenario = testCase.scenario?.disturbances.some((disturbance) =>
      disturbance.type === "approval-response") ?? false;
    const controller = new AbortController();
    const cancelFromParent = (): void => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", cancelFromParent, { once: true });
    const budget = options.variant?.budget ?? testCase.benchmark?.budget ?? testCase.task.budget;
    let budgetReason: string | undefined;
    let failureReason: string | undefined;
    let failureSource: EvalExecutionResult["failureSource"];
    let actionCount = 0;
    let responseText = "";
    let outcome: EvalExecutionObservation["outcome"] = "failed";
    let verificationDirty = false;
    const startedAt = startedAtDate.toISOString();

    const exhaustBudget = (
      reason: string,
      boundary: "actions" | "tokens" | "cost" | "duration",
      limit: number,
      observed: number,
    ): void => {
      if (budgetReason) return;
      budgetReason = reason;
      admissions.push("budget-exhausted");
      traceCollector.recordBudgetBoundary(boundary, limit, observed);
      controller.abort();
    };

    const onEvent = (event: MossEvent): void => {
      if (event.type !== "text-delta") options.diagnostics?.append(event.type, event);
      traceCollector.onEvent(event);
      if (event.type === "text-delta") {
        responseText += event.text;
      } else if (event.type === "token-usage") {
        usage.inputTokens = (usage.inputTokens ?? 0) + (event.usage.inputTokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (event.usage.outputTokens ?? 0);
        const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (budget?.maxTokens && tokens > budget.maxTokens) {
          exhaustBudget(`token budget of ${budget.maxTokens} exceeded`, "tokens", budget.maxTokens, tokens);
        }
        const cost = options.estimateCostUsd?.(usage) ?? 0;
        if (budget?.maxCostUsd && cost > budget.maxCostUsd) {
          exhaustBudget(`cost budget of $${budget.maxCostUsd} exceeded`, "cost", budget.maxCostUsd, cost);
        }
      } else if (event.type === "tool-call") {
        admissions.push("attempted");
        actionCount++;
        if (budget?.maxActions && actionCount > budget.maxActions) {
          exhaustBudget(`action budget of ${budget.maxActions} exceeded`, "actions", budget.maxActions, actionCount);
        }
      } else if (event.type === "tool-approval-request") {
        admissions.push("blocked");
        approvalRequests.add(event.callId);
        const invocation = (approvalInvocations.get(event.name) ?? 0) + 1;
        approvalInvocations.set(event.name, invocation);
        approvalCalls.set(event.callId, { capability: event.name, invocation });
      } else if (event.type === "tool-result") {
        if (!event.ok) {
          admissions.push("failed");
          failedTools.add(event.name);
        } else {
          if (event.autoApproved || approvalRequests.has(event.callId)) admissions.push("approved");
          if (failedTools.has(event.name)) admissions.push("recovered");
        }
      } else if (event.type === "turn-complete") {
        if (!budgetReason) outcome = "completed";
      } else if (event.type === "turn-aborted") {
        outcome = budgetReason ? "budget-exhausted" : "cancelled";
      } else if (event.type === "turn-error") {
        failureReason = event.message;
        failureSource = event.source;
      }
    };

    const durationLimit = budget?.maxDurationMs;
    const durationTimer = durationLimit
      ? setTimeout(() => exhaustBudget(
        `runtime budget of ${durationLimit}ms exceeded`,
        "duration",
        durationLimit,
        durationLimit,
      ), durationLimit)
      : undefined;
    const requestApproval = async (callId: string): Promise<ToolApprovalResponse> => {
      const approvalCall = approvalCalls.get(callId);
      const disturbance = testCase.scenario?.disturbances.find((candidate): candidate is Extract<
        EvalScenarioDisturbance,
        { type: "approval-response" }
      > =>
        candidate.type === "approval-response"
        && candidate.capability === approvalCall?.capability
        && candidate.invocation === approvalCall.invocation);
      const response = disturbance
        ? { approved: disturbance.approved, ...(disturbance.comment ? { comment: disturbance.comment } : {}) }
        : testCase.scenario?.approvalFallback === "deny" && testCase.scenario.disturbances.some((candidate) =>
          candidate.type === "approval-response" && candidate.capability === approvalCall?.capability)
          ? { approved: false }
          : await (options.requestApproval ?? (async () => ({ approved: false })))(callId);
      if (disturbance) {
        deliverDisturbance(disturbance);
      }
      if (!response || typeof response.approved !== "boolean") {
        throw new Error("Evaluation approval callback must return { approved: boolean }");
      }
      traceCollector.recordApprovalDecision(callId, response.approved, Boolean(response.comment?.trim()));
      options.diagnostics?.append("approval-response", { callId, ...response });
      return response;
    };
    let providerInvocation = 0;
    const provider: ChatProvider = {
      kind: options.provider.kind,
      listModels: () => options.provider.listModels(),
      streamChat: async function* (request, signal): AsyncIterable<ProviderStreamEvent> {
        options.diagnostics?.append("provider-request", request);
        providerInvocation++;
        const disturbance = testCase.scenario?.disturbances.find((candidate): candidate is Extract<
          EvalScenarioDisturbance,
          { type: "provider-interruption" }
        > =>
          candidate.type === "provider-interruption" && candidate.invocation === providerInvocation);
        if (disturbance?.phase === "before-output") {
          deliverDisturbance(disturbance);
          throw new ProviderError(`Provider interrupted before output (scenario ${disturbance.id})`, 503);
        }
        let emitted = false;
        try {
          for await (const event of options.provider.streamChat(request, signal)) {
            yield event;
            if (!emitted && disturbance?.phase === "after-output") {
              emitted = true;
              deliverDisturbance(disturbance);
              throw new ProviderError(`Provider interrupted after output (scenario ${disturbance.id})`, 503);
            }
          }
        } catch (error) {
          options.diagnostics?.append("provider-error", error);
          throw error;
        }
      },
    };
    const verification = testCase.scenario?.verification;
    let verificationCycles = 0;
    let verificationStopped = false;
    let latestVerification: VerifyResult | undefined;
    const recordVerification = (result: VerifyResult): void => {
      options.diagnostics?.append("verification-details", result);
      latestVerification = result;
      verificationDirty = false;
      verificationCycles++;
      if (verification && !result.ok && verificationCycles >= verification.maxCycles) {
        verificationStopped = true;
        controller.abort();
      }
    };
    const runScenarioVerification = async (): Promise<void> => {
      if (!verification || !sandbox) throw new Error("Scenario verification requires a container backend");
      const result = await sandbox.verify(verification.commands, workspaceRoot, controller.signal, { commandTimeoutMs: options.variant?.toolTimeoutMs });
      recordVerification(result);
      onEvent({ type: "verification", ok: result.ok, checkCount: result.results.length });
    };
    let resumeSetup: Awaited<ReturnType<typeof createResumeScenarioSetup>>;
    try {
      resumeSetup = await createResumeScenarioSetup(testCase, workspaceRoot, messages);
      if (resumeSetup) messages = resumeSetup.messages;
      if (verification) {
        await runScenarioVerification();
        const cadence = options.variant?.runtime?.verificationCadence === "terminal"
          ? "when you return a final response"
          : "after successful file mutations";
        messages.push({ role: "user", content: `Runtime verification: The host runs the configured checks ${cadence} and gates completion on a current passing result. Use only the provided tools; do not request an unavailable command tool to run these checks.\nInitial verification: ${JSON.stringify(latestVerification)}` });
      }
      promptProvenance.seededMessagesHash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
      if (!verificationStopped) await runTurn({
        provider,
        model: options.model,
        messages,
        jsonArtifactRequirements: testCase.task.jsonArtifactRequirements,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        toolRegistry,
        workspaceRoot,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "tool-result" && event.ok && ["write_file", "edit_file", "move_file", "run_command"].includes(event.name)) verificationDirty = true;
          onEvent(event);
        },
        requestApproval,
        autoApprove: hasApprovalScenario ? false : options.variant?.autoApprove ?? options.autoApprove,
        injectionMode: options.variant?.injectionMode,
        contextLimit: contextSetup?.options.contextLimit ?? (options.variant?.runtime?.contextStrategy === "full" ? 0 : options.variant?.contextLimit),
        maxRounds: options.variant?.maxRounds,
        maxOutputTokens: options.maxOutputTokens,
        toolTimeoutMs: options.variant?.toolTimeoutMs,
        verify: options.variant?.runtime?.verificationCadence === "terminal"
          ? { enabled: false, commands: [] }
          : verification ? { enabled: true, commands: verification.commands, maxCycles: verification.maxCycles - verificationCycles } : options.variant?.verify,
        onVerification: recordVerification,
        ...(verification ? { completionGuard: async () => {
          if (verificationDirty && verificationCycles < verification.maxCycles) await runScenarioVerification();
          if (verificationDirty && verificationCycles >= verification.maxCycles) {
            verificationStopped = true;
            controller.abort();
          }
          if (latestVerification?.ok !== true || verificationDirty || verificationStopped) return { accept: false, feedback: "Completion requires a current passing verification result." };
          return { accept: true };
        } } : resumeSetup ? { completionGuard: resumeSetup.options.completionGuard } : {}),
        ...(sandbox ? { verificationRunner: sandbox.verify } : {}),
        planningPolicy: options.variant?.runtime?.planningPolicy,
        recoveryMode: options.variant?.runtime?.recoveryPolicy,
        now: () => promptDate,
      });
    } finally {
      if (durationTimer) clearTimeout(durationTimer);
      options.signal?.removeEventListener("abort", cancelFromParent);
      await resumeSetup?.dispose();
      sandbox?.assertHealthy();
    }

    if (budgetReason) outcome = "budget-exhausted";
    if (budgetReason) traceCollector.markBudgetExhausted();
    if (verificationStopped && !budgetReason && !failureSource) {
      outcome = "blocked";
      failureReason = "Verification cycle budget exhausted";
      traceCollector.markBlocked();
    }
    for (const disturbance of testCase.scenario?.disturbances ?? []) {
      if (!deliveredDisturbances.has(disturbance.id)) {
        traceCollector.recordScenarioDisturbance(disturbance.id, disturbance.type, "undelivered");
        outcome = "failed";
        failureReason ??= `Planned scenario disturbance '${disturbance.id}' was not delivered`;
        failureSource = "harness-orchestration";
        traceCollector.markHarnessError();
      }
    }
    const trace = traceCollector.snapshot();
    options.diagnostics?.append("assistant-response", responseText);
    const diagnosticReview = options.variant?.runtime?.reviewerPass === "diagnostic"
      ? await runDiagnosticReview(options, testCase, responseText, trace, controller.signal)
      : undefined;

    return {
      workspaceRoot,
      trace,
      ...(diagnosticReview ? { diagnosticReview } : {}),
      promptProvenance,
      rubricInput: { responseText },
      ...(failureSource ? { failureSource } : {}),
      observation: {
        caseId: testCase.id,
        runId: `${testCase.id}-${repetition}-${randomUUID()}`,
        provider: options.provider.kind,
        model: options.model,
        outcome,
        ...(failureReason || budgetReason ? { failureReason: failureReason ?? budgetReason } : {}),
        startedAt,
        completedAt: now().toISOString(),
        usage,
        estimatedCostUsd: options.estimateCostUsd?.(usage) ?? 0,
        admissions,
      },
    };
  };
}

async function runDiagnosticReview(
  options: TurnEvalExecutorOptions,
  testCase: EvalCase,
  responseText: string,
  trace: HarnessExecutionTrace,
  signal: AbortSignal,
): Promise<HarnessDiagnosticReview> {
  const startedAt = Date.now();
  const usage: TokenUsage = {};
  let text = "";
  const controller = new AbortController();
  let stopReason: "reviewer-timeout" | "reviewer-cancelled" | undefined;
  let rejectStopped!: (reason: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (reason: "reviewer-timeout" | "reviewer-cancelled"): void => {
    if (stopReason) return;
    stopReason = reason;
    rejectStopped(new Error(reason));
    controller.abort();
  };
  const cancel = (): void => stop("reviewer-cancelled");
  const timer = setTimeout(() => stop("reviewer-timeout"), 30_000);
  signal.addEventListener("abort", cancel, { once: true });
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const consume = async (): Promise<void> => {
      if (signal.aborted || options.signal?.aborted) {
        cancel();
        return;
      }
      const stream = options.provider.streamChat({
        model: options.model,
        messages: [
          {
            role: "system",
            content: "You are a diagnostic reviewer. Do not propose actions. Judge only the supplied observations, not unobserved artifact state. Tool invocation and approval evidence comes from observedExecution, not from claims or omissions in the assistant response. Return unknown when evidence is insufficient. Return only JSON: {\"label\":\"pass|fail|unknown\",\"reasonCode\":\"kebab-case\"}.",
          },
          {
            role: "user",
            content: JSON.stringify({
              objective: testCase.task.objective,
              acceptanceCriteria: testCase.task.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
              assistantResponse: responseText,
              observedExecution: {
                terminalState: trace.terminalState,
                toolCalls: trace.toolCalls.map(({ name, ok, approvalRequested, autoApproved, risk }) => ({
                  name, ok, approvalRequested, autoApproved, risk,
                })),
              },
            }),
          },
        ],
        tools: [],
        maxTokens: 256,
      }, controller.signal);
      for await (const event of stream) {
        if (controller.signal.aborted) return;
        if (event.type === "text-delta") text += event.text;
        else if (event.type === "usage") Object.assign(usage, event.usage);
      }
    };
    await Promise.race([stopped, consume()]);
    const parsed = JSON.parse(text) as { label?: unknown; reasonCode?: unknown };
    const label = parsed.label === "pass" || parsed.label === "fail" || parsed.label === "unknown"
      ? parsed.label
      : "unknown";
    const reasonCode = typeof parsed.reasonCode === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.reasonCode)
      ? parsed.reasonCode.slice(0, 80)
      : "invalid-review-output";
    return {
      diagnostic: true,
      label,
      reasonCode,
      usage,
      estimatedCostUsd: options.estimateCostUsd?.(usage) ?? 0,
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return {
      diagnostic: true,
      label: "unknown",
      reasonCode: stopReason ?? "reviewer-error",
      usage,
      estimatedCostUsd: options.estimateCostUsd?.(usage) ?? 0,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    options.signal?.removeEventListener("abort", cancel);
  }
}
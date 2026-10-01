// electron/ipc/chat-ipc.ts
//
// Wires renderer requests to the agent runner. One AbortController + one
// ApprovalBroker per in-flight turn.

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { BrowserWindow, clipboard, dialog, ipcMain as electronIpcMain, powerMonitor, shell } from "electron";

import { IPC } from "../../common/ipc-contract";
import type {
  ChatStartRequest,
  EmbedConfig,
  HandoffSummaryRequest,
  HandoffSummaryResult,
  MemoryCategory,
  MissionAuthorizationRequest,
  MissionCapabilitiesRequest,
  MissionCapabilityDescriptor,
  HarnessDecision,
  MissionLaunchPolicy,
  ModelCapabilityProfile,
  ModelTaskKind,
  OllamaContextReport,
  PracticeProgress,
  ProcedureStatus,
  PracticeReport,
  SetupDetection,
  ToolCall,
  TurnTrace,
  SetupDetectionRequest,
  ModelProbeRequest,
  ModelRoute,
  ProviderConfig,
  MossEvent,
  ProductDiagnosticEntry,
  ProductDiagnosticKind,
  ProductDiagnosticsConfig,
  ProviderKind,
  SkillCreateRequest,
  SkillUpdateRequest,
  SkillRenameRequest,
  SkillTrustStatus,
  TaskSnapshot,
  TaskBudget,
  TaskSpec,
  ToolApprovalDecision,
  TraceReplayRequest,
  TranscribeRequest,
  TranscribeResult,
} from "../../common/types";
import { runTurn } from "../backend/moss/agent-runner";
import type { CompletionContext } from "../backend/moss/agent-runner";
import { ApprovalBroker } from "../backend/moss/approval-broker";
import { MissionBudgetProvider } from "../backend/moss/task/mission-budget";
import { createBrowserTools } from "../backend/moss/browser/browser-tools";
import { createPlaywrightDriverFactory } from "../backend/moss/browser/playwright-driver";
import { routeLiveCapabilities } from "../backend/moss/capabilities/live-capabilities";
import { createBundledCapabilityTools } from "../backend/moss/capabilities/bundled-catalog";
import { BudgetEnforcingProvider } from "../backend/moss/budget/budget-provider";
import { checkpointStore } from "../backend/moss/checkpoint/checkpoint-store";
import { codebaseIndex } from "../backend/moss/codebase/codebase-index";
import { summarizeForHandoff } from "../backend/moss/context/handoff";
import { toolOutputStore } from "../backend/moss/context/tool-output-store";
import { createDesktopTools } from "../backend/moss/desktop/desktop-tools";
import { createWindowsUiaDriverFactory } from "../backend/moss/desktop/windows-uia-driver";
import {
  addMcpServer,
  ensureMcpConfig,
  loadMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
  type McpServerConfig,
} from "../backend/moss/mcp/mcp-config";
import { mcpManager } from "../backend/moss/mcp/mcp-manager";
import { readWorkspacePreview, suggestVerificationCommands } from "../backend/moss/workspace/workspace-insights";
import { CONTEXT_LEVELS, DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_TIMEOUT_SECONDS, runCapabilityProbes } from "../backend/moss/models/capability-probes";
import { buildCapabilityProfile } from "../backend/moss/models/capability-profile";
import { modelProfileStore } from "../backend/moss/models/model-profile-store";
import { DEFAULT_ESCALATE_AFTER, EscalationMonitor, isModelRejection } from "../backend/moss/models/escalation";
import { effectiveProfile, gradeTurn, modelPerformanceStore, taskKindFor } from "../backend/moss/models/model-performance";
import { createContextVariant, inspectOllamaContext } from "../backend/moss/models/ollama-context";
import { detectSetup, pullOllamaModel } from "../backend/moss/setup/pc-setup";
import { createQuarantine } from "../backend/moss/safety/quarantine";
import { createMissionCritic } from "../backend/moss/task/mission-critic";
import { createReplayJudge } from "../backend/moss/models/replay-judge";
import { checkCriticIndependence, workerModels } from "../../common/model-family";
import { expandProcedure, PROCEDURE_HINT, procedureStore, procedureToolDefinition, runProcedureTool } from "../backend/moss/learning/procedure-store";
import { captureOutcomeContext, runGit, runPractice } from "../backend/moss/models/practice";
import { PracticeScheduler, practiceStore } from "../backend/moss/models/practice-store";
import { isLocalRoute, RoutedProvider, routeDestination, routeToken, type ProviderRoute } from "../backend/moss/models/routed-provider";
import { StepProtocolProvider } from "../backend/moss/models/step-protocol";
import { findToolTool, semanticIndex } from "../backend/moss/models/tool-index";
import { endpointLabel } from "../backend/moss/models/capability-profile";
import { applyScaffoldingMessages, planScaffolding } from "../backend/moss/models/scaffolding";
import { RecordingProvider, TraceRecorder, traceStore } from "../backend/moss/models/trace-recorder";
import { replayTrace } from "../backend/moss/models/trace-replay";
import { skillLedger, type SkillOutcome } from "../backend/moss/skills/skill-ledger";
import { normalizeWorkingState, WorkingStateStore } from "../backend/moss/governed/working-state";
import { RunJournal } from "../backend/moss/learning/run-journal";
import { createRetrospective } from "../backend/moss/learning/retrospective";
import { LessonStore, renderLessons } from "../backend/moss/learning/lesson-store";
import { memoryStore } from "../backend/moss/memory/memory-store";
import { memoryReviewQueue } from "../backend/moss/governed/review-queue";
import { providerCredentials } from "../backend/moss/provider-credentials";
import { productDiagnostics } from "../backend/moss/product-diagnostics";
import { createProvider } from "../backend/moss/providers";
import { skillsStore } from "../backend/moss/skills/skills-store";
import { transcribeAudio } from "../backend/moss/stt";
import { buildSystemMessage } from "../backend/moss/system-prompt";
import { classifyTool } from "../backend/moss/permission";
import { MissionAuthorityBroker, validateMissionAuthorizationRequest } from "../backend/moss/task/mission-authority";
import { MissionController, remainingBudget } from "../backend/moss/task/mission-controller";
import { MissionPlanner } from "../backend/moss/task/mission-planner";
import { taskArtifactStore } from "../backend/moss/task/task-artifact-store";
import { taskEngine } from "../backend/moss/task/task-engine";
import { buildMissionVerificationChecks, WorkspaceMissionVerifier } from "../backend/moss/task/mission-verifier";
import { RunTurnMissionWorker } from "../backend/moss/task/mission-worker";
import { buildTaskProgressPacket, renderTaskProgressPacket, selectDependencyReadyStep } from "../backend/moss/task/progress-packet";

const DEFAULT_TOOL_ROUNDS = 8;
const MAX_TOOL_ROUNDS = 64;
const DEFAULT_MISSION_BUDGET: Required<TaskBudget> = {
  maxDurationMs: 15 * 60 * 1000,
  maxTokens: 50_000,
  maxActions: 24,
  maxCostUsd: 5,
};
const MAX_MISSION_BUDGET: Required<TaskBudget> = {
  maxDurationMs: 4 * 60 * 60 * 1000,
  maxTokens: 1_000_000,
  maxActions: 256,
  maxCostUsd: 100,
};

const VOTE_SAMPLES = 3;
const VOTE_MAX_MEDIAN_MS = 4_000;

export function resolveMaxToolRounds(requested: number | undefined, verifyEnabled: boolean): number {
  const configured = Number.isFinite(requested) ? Math.floor(requested as number) : DEFAULT_TOOL_ROUNDS;
  const withVerificationRoom = verifyEnabled ? Math.max(12, configured) : configured;
  return Math.min(MAX_TOOL_ROUNDS, Math.max(1, withVerificationRoom));
}
import { taskStore } from "../backend/moss/task/task-store";
import { guardedIpc, requireTrustedSender } from "../window-guard";
import { TOOL_REGISTRY } from "../backend/moss/tools";
import { createJevTool } from "../backend/moss/tools/jev-tool";
import { detectWorkspaceVerificationChecks, VerificationRegistry } from "../backend/moss/verify/verification-registry";
import { runVerify } from "../backend/moss/verify/verifier";

interface Inflight {
  controller: AbortController;
  broker: ApprovalBroker;
  taskId?: string;
  send: (event: MossEvent) => void;
  approvalStartedAt: Map<string, number>;
  abortRequestedAt?: number;
}

function approvalResponse(decision: Pick<ToolApprovalDecision, "approved" | "comment">) {
  const comment = decision.comment?.trim().slice(0, 500);
  return { approved: decision.approved, ...(comment ? { comment } : {}) };
}

const inflight = new Map<string, Inflight>();
const runJournal = new RunJournal();
const lessonStore = new LessonStore();
const verificationRegistry = new VerificationRegistry();
const missionAuthority = new MissionAuthorityBroker();
const processStartedAt = Date.now();
let bundledCapabilityTools: ReturnType<typeof createBundledCapabilityTools> | undefined;
let capabilityHistoryCache = new Map<string, { successCount: number; failureCount: number }>();

export function registerChatIpc(): void {
  // Every channel below answers only the app's own page.
  const ipcMain = guardedIpc(electronIpcMain);
  void refreshCapabilityHistory();
  ipcMain.on(IPC.chatStart, (event, req: ChatStartRequest) => {
    // Your work takes the GPU back from a practice run.
    practiceController?.abort();
    void startTurn(event, req);
  });

  ipcMain.on(IPC.chatAbort, (_event, turnId: string) => {
    const entry = inflight.get(turnId);
    if (entry) {
      entry.abortRequestedAt = Date.now();
      entry.controller.abort();
      entry.broker.denyAll("Turn aborted");
    }
  });

  ipcMain.handle(IPC.missionAuthorize, async (event, request: MissionAuthorizationRequest) => {
    requireTrustedSender(event, "mission authorization");
    validateMissionAuthorizationRequest(request);
    const budget = request.policy.budget;
    const detail = [
      `Objective: ${request.objective.trim().slice(0, 200)}`,
      `Workspace: ${request.workspaceRoot?.trim() || "No filesystem scope"}`,
      `Criteria: ${request.acceptanceCriteria.map((criterion) => criterion.description.trim()).join("; ")}`,
      `Verification: ${request.acceptanceCriteria.map((criterion) => criterion.verification?.kind ?? "none").join(", ")}`,
      `Capabilities: ${request.policy.requestedCapabilities.join(", ") || "None"}`,
      `Automatic risk ceiling: ${request.policy.maxAutoApprovedRisk}`,
      `Budget: ${budget?.maxActions ?? "default"} actions, ${budget?.maxTokens ?? "default"} tokens, $${budget?.maxCostUsd ?? "default"}, ${budget?.maxDurationMs ?? "default"} ms`,
    ].join("\n");
    const decision = await dialog.showMessageBox({
      type: "warning",
      title: "Authorize policy-scoped mission",
      message: "Allow this mission to perform bounded actions without per-call approval?",
      detail,
      buttons: ["Cancel", "Authorize mission"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return decision.response === 1 ? missionAuthority.issue(request) : null;
  });

  ipcMain.handle(IPC.missionCapabilities, (_event, request: MissionCapabilitiesRequest) =>
    routeAvailableTools(request).tools.map((tool) => describeMissionCapability(tool.name)),
  );

  ipcMain.on(IPC.toolApprove, (_event, decision: ToolApprovalDecision) => {
    const entry = inflight.get(decision.turnId);
    if (!entry) return;
    const approvalStartedAt = entry.approvalStartedAt.get(decision.callId);
    entry.approvalStartedAt.delete(decision.callId);
    void productDiagnostics.record("approval-resolved", {
      ...(approvalStartedAt ? { durationMs: Date.now() - approvalStartedAt } : {}),
      mission: Boolean(entry.taskId),
      outcome: decision.approved ? "approved" : "denied",
    });
    if (!entry.taskId) {
      entry.broker.resolve(decision.callId, approvalResponse(decision));
      return;
    }
    void taskEngine
      .resolveApproval(entry.taskId, decision.callId, decision.approved, decision.comment)
      .then((task) => {
        entry.send({ type: "task-state", task });
        entry.broker.resolve(decision.callId, {
          approved: decision.approved,
          ...(task.approval?.comment ? { comment: task.approval.comment } : {}),
        });
      })
      .catch(() => undefined);
  });

  ipcMain.handle(IPC.taskCreate, (_event, spec: TaskSpec, id?: string) => taskEngine.create(spec, id));
  ipcMain.handle(IPC.taskList, () => taskStore.list());
  ipcMain.handle(IPC.taskGet, (_event, id: string) => taskStore.get(id));
  ipcMain.handle(IPC.taskHistory, (_event, id: string) => taskStore.history(id));
  ipcMain.handle(IPC.taskArtifactGet, async (_event, taskId: string, artifactId: string) => {
    if (typeof taskId !== "string" || typeof artifactId !== "string") throw new Error("Invalid artifact request");
    const task = await taskStore.get(taskId);
    const reference = task?.artifacts?.find((artifact) => artifact.id === artifactId && artifact.taskId === taskId);
    if (!reference) return null;
    const record = await taskArtifactStore.get(taskId, artifactId);
    if (!record || record.sha256 !== reference.sha256 || record.byteLength !== reference.byteLength || record.byteLength > 256 * 1024) return null;
    return { ...reference, content: record.content };
  });
  ipcMain.handle(IPC.taskStart, (_event, id: string) => taskEngine.start(id));
  ipcMain.handle(IPC.taskPause, async (_event, id: string, summary: string) => {
    const active = [...inflight.values()].filter((entry) => entry.taskId === id);
    for (const entry of active) {
      entry.controller.abort();
      entry.broker.denyAll("Task paused");
    }
    const task = await taskEngine.pause(id, summary);
    for (const entry of active) entry.send({ type: "task-state", task });
    return task;
  });
  ipcMain.handle(IPC.taskResume, (_event, id: string) => taskEngine.start(id));
  ipcMain.handle(IPC.taskCancel, async (_event, id: string) => {
    const active = [...inflight.values()].filter((entry) => entry.taskId === id);
    for (const entry of active) {
      entry.controller.abort();
      entry.broker.denyAll("Task cancelled");
    }
    const task = await taskEngine.cancel(id);
    for (const entry of active) entry.send({ type: "task-state", task });
    return task;
  });
  ipcMain.handle(IPC.diagnosticsList, () => productDiagnostics.list());
  ipcMain.handle(IPC.diagnosticsConfigure, (_event, config: ProductDiagnosticsConfig) =>
    productDiagnostics.configure(config),
  );
  ipcMain.handle(IPC.diagnosticsClear, () => productDiagnostics.clear());
  ipcMain.handle(IPC.diagnosticsRecord, (_event, kind: ProductDiagnosticKind) => {
    if (kind !== "renderer-startup") throw new Error("Unsupported renderer diagnostic");
    return productDiagnostics.record(kind);
  });

  ipcMain.handle(IPC.providerListModels, async (_event, config: ChatStartRequest["config"]) => {
    const provider = createProvider(config);
    return provider.listModels();
  });
  ipcMain.handle(IPC.providerCredentialGet, (event, providerId: string) => {
    requireTrustedSender(event, "reading a stored key");
    return providerCredentials.get(providerId);
  });
  ipcMain.handle(IPC.providerCredentialSet, (event, providerId: string, apiKey: string) => {
    requireTrustedSender(event, "storing a key");
    providerCredentials.set(providerId, apiKey);
  });

  ipcMain.handle(IPC.chatSummarize, async (_event, req: HandoffSummaryRequest): Promise<HandoffSummaryResult> => {
    if (!req.config.model) return { ok: false, summary: "", error: "No model is configured." };
    try {
      const provider = createProvider(req.config);
      return await summarizeForHandoff(provider, req.config.model, req.messages, req.title);
    } catch (error) {
      return { ok: false, summary: "", error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC.workspacePick, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle(IPC.workspacePreview, (_event, root: unknown, path: unknown) => {
    if (typeof root !== "string" || typeof path !== "string") throw new Error("Invalid preview request");
    return readWorkspacePreview(root, path);
  });
  ipcMain.handle(IPC.workspaceSuggestVerification, (_event, root: unknown) =>
    typeof root === "string" ? suggestVerificationCommands(root) : []);
  ipcMain.handle(IPC.windowFocus, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  let activeProbe: AbortController | null = null;
  ipcMain.handle(IPC.modelProbeRun, async (event, request: ModelProbeRequest) => {
    const config = request?.config;
    if (!config || typeof config.model !== "string" || !config.model.trim() || typeof config.baseUrl !== "string") {
      throw new Error("Choose a provider and model before running the capability probe");
    }
    if (activeProbe) throw new Error("A capability probe is already running");
    const controller = new AbortController();
    activeProbe = controller;
    try {
      const maxContextTokens = Math.min(CONTEXT_LEVELS.at(-1)!, Math.max(CONTEXT_LEVELS[0], Number(request.options?.maxContextTokens) || DEFAULT_MAX_CONTEXT_TOKENS));
      const startedAt = Date.now();
      const timeoutSeconds = Math.min(600, Math.max(15, Number(request.options?.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS));
      const { results, warmupMs } = await runCapabilityProbes(
        { provider: createProvider(config), model: config.model, signal: controller.signal, timeoutMs: timeoutSeconds * 1_000 },
        {
          maxContextTokens,
          dimensions: request.options?.dimensions,
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send(IPC.modelProbeProgress, progress);
          },
        },
      );
      const profile = buildCapabilityProfile({
        providerKind: config.kind,
        baseUrl: config.baseUrl,
        model: config.model,
        results,
        startedAt,
        finishedAt: Date.now(),
        maxContextTested: Math.max(...CONTEXT_LEVELS.filter((level) => level <= maxContextTokens)),
        warmupMs,
      });
      await modelProfileStore.save(profile);
      return profile;
    } finally {
      if (activeProbe === controller) activeProbe = null;
    }
  });
  ipcMain.handle(IPC.modelProbeCancel, () => {
    activeProbe?.abort();
  });
  ipcMain.handle(IPC.modelProfileGet, (_event, kind: ProviderKind, baseUrl: unknown, model: unknown) =>
    typeof baseUrl === "string" && typeof model === "string" && model ? modelProfileStore.get(kind, baseUrl, model) : null);
  ipcMain.handle(IPC.modelProfileList, () => modelProfileStore.list());
  ipcMain.handle(IPC.modelPerformanceList, () => modelPerformanceStore.list());
  // Practice runs: replays and disposable forward runs against local candidates.
  let practiceController: AbortController | undefined;
  const runPracticeNow = async (onProgress?: (progress: PracticeProgress) => void): Promise<PracticeReport> => {
    if (practiceController) throw new Error("A practice run is already in progress.");
    const config = await practiceStore.config();
    if (config.candidates.length === 0) throw new Error("Choose at least one candidate model.");
    // Practice runs many requests, so only models on this PC take part.
    const candidates = config.candidates.filter((model) => isLocalRoute(config.baseUrl, model));
    if (candidates.length === 0) throw new Error("Practice runs use local models only; choose a model served on this PC.");
    const controller = new AbortController();
    practiceController = controller;
    try {
      const summaries = await traceStore.list((config.maxTraces ?? 8) * 2);
      const traces = (await Promise.all(summaries.map((summary) => traceStore.get(summary.id)))).filter((trace): trace is TurnTrace => trace !== null);
      if (traces.length === 0) throw new Error("No recorded traces yet. Turn on trace recording under Routing and adaptation and do some work first.");
      const report = await runPractice({ traces, candidates, maxTraces: config.maxTraces }, {
        providerFor: (model) => createProvider({ kind: "openai-compatible", baseUrl: config.baseUrl, model }),
        registry: TOOL_REGISTRY,
        verify: runVerify,
        git: runGit,
        recordPractice: (model, kind, outcome) => modelPerformanceStore.record({ providerKind: "openai-compatible", baseUrl: config.baseUrl, model, kind, outcome, practice: true }),
        signal: controller.signal,
        ...(onProgress ? { onProgress } : {}),
      });
      await practiceStore.saveReport(report);
      return report;
    } finally {
      practiceController = undefined;
    }
  };
  const practiceScheduler = new PracticeScheduler({
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onBattery: () => powerMonitor.isOnBatteryPower(),
    busy: () => inflight.size > 0,
    config: () => practiceStore.config(),
    lastRunAt: async () => {
      const latest = await practiceStore.latest();
      return latest ? Date.parse(latest.startedAt) : undefined;
    },
    run: async () => { await runPracticeNow().catch(() => undefined); },
  });
  void practiceStore.config().then((config) => { if (config.enabled) practiceScheduler.start(); }).catch(() => undefined);
  ipcMain.handle(IPC.proceduresList, () => procedureStore.list());
  ipcMain.handle(IPC.procedureSetStatus, async (_event, id: unknown, status: unknown) => {
    if (typeof id !== "string" || !["candidate", "trusted", "demoted"].includes(String(status))) throw new Error("Invalid procedure status.");
    await procedureStore.setStatus(id, status as ProcedureStatus);
    return procedureStore.list();
  });
  ipcMain.handle(IPC.procedureDelete, async (_event, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid procedure id.");
    await procedureStore.remove(id);
    return procedureStore.list();
  });
  ipcMain.handle(IPC.practiceGet, async () => ({ config: await practiceStore.config(), latest: await practiceStore.latest(), running: practiceController !== undefined }));
  ipcMain.handle(IPC.practiceConfigure, async (_event, config: unknown) => {
    const saved = await practiceStore.saveConfig(config);
    if (saved.enabled) practiceScheduler.start();
    else practiceScheduler.stop();
    return saved;
  });
  ipcMain.handle(IPC.practiceRun, (event) => runPracticeNow((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send(IPC.practiceProgress, progress);
  }));
  ipcMain.handle(IPC.practiceCancel, () => { practiceController?.abort(); });
  ipcMain.handle(IPC.setupDetect, (_event, request: SetupDetectionRequest): Promise<SetupDetection> => {
    if (!request || typeof request.ollamaBaseUrl !== "string" || !Array.isArray(request.cloud)) throw new Error("Invalid setup detection request.");
    return detectSetup(request, {
      credential: (presetId) => providerCredentials.get(presetId),
      listModels: (config) => createProvider({ ...config, model: "" }).listModels(),
    });
  });
  ipcMain.handle(IPC.setupPull, (_event, baseUrl: unknown, model: unknown) => {
    if (typeof baseUrl !== "string" || typeof model !== "string") throw new Error("Invalid pull request.");
    return pullOllamaModel(baseUrl, model);
  });
  ipcMain.handle(IPC.ollamaContextInspect, async (_event, baseUrl: unknown, model: unknown): Promise<OllamaContextReport> => {
    if (typeof baseUrl !== "string" || typeof model !== "string" || !model) throw new Error("Choose an Ollama model first.");
    const profile = await modelProfileStore.get("openai-compatible", baseUrl, model).catch(() => null);
    return inspectOllamaContext({ baseUrl, model, ...(profile?.recommendation.usableContextTokens ? { usableContext: profile.recommendation.usableContextTokens } : {}) });
  });
  ipcMain.handle(IPC.ollamaContextCreate, async (_event, baseUrl: unknown, model: unknown, numCtx: unknown): Promise<string> => {
    if (typeof baseUrl !== "string" || typeof model !== "string" || !model || typeof numCtx !== "number") throw new Error("Invalid context variant request.");
    const variant = await createContextVariant({ baseUrl, model, numCtx });
    // Same weights, so the capability profile carries over; the larger window
    // is worth re-measuring.
    const profile = await modelProfileStore.get("openai-compatible", baseUrl, model).catch(() => null);
    if (profile) {
      const { contextLimit: _unused, ...settings } = profile.recommendation.settings;
      void _unused;
      await modelProfileStore.save({
        ...profile,
        model: variant,
        recommendation: {
          ...profile.recommendation,
          settings,
          notes: [...profile.recommendation.notes.filter((note) => !/context/i.test(note)), `Copied from ${model} with num_ctx ${numCtx}. Re-run the probe to measure the larger context.`],
        },
      }).catch(() => undefined);
    }
    return variant;
  });
  ipcMain.handle(IPC.modelPerformanceClear, (_event, kind: ProviderKind, baseUrl: unknown, model: unknown) =>
    typeof baseUrl === "string" && typeof model === "string" && model ? modelPerformanceStore.clear(kind, baseUrl, model) : undefined);

  ipcMain.handle(IPC.tracesList, async () => ({ count: await traceStore.count(), traces: await traceStore.list(20), dir: traceStore.dir() }));
  ipcMain.handle(IPC.tracesClear, () => traceStore.clear());
  ipcMain.handle(IPC.tracesOpenFolder, async () => {
    const dir = traceStore.dir();
    await mkdir(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return error ? null : dir;
  });
  let activeReplay: AbortController | null = null;
  ipcMain.handle(IPC.traceReplayRun, async (event, request: TraceReplayRequest) => {
    if (typeof request?.traceId !== "string" || !request.config?.model?.trim()) throw new Error("Choose a trace and a candidate model");
    if (activeReplay) throw new Error("A replay is already running");
    const trace = await traceStore.get(request.traceId);
    if (!trace) throw new Error("Trace not found");
    const controller = new AbortController();
    activeReplay = controller;
    try {
      const timeoutSeconds = Math.min(600, Math.max(15, Number(request.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS));
      const judgeRoute = request.judge?.model?.trim() && request.judge.baseUrl?.trim() ? request.judge : undefined;
      const judge = judgeRoute
        ? (() => {
            const sameConnection = judgeRoute.kind === request.config.kind && endpointLabel(judgeRoute.baseUrl).toLowerCase() === endpointLabel(request.config.baseUrl).toLowerCase();
            const apiKey = sameConnection ? request.config.apiKey : judgeRoute.presetId ? providerCredentials.get(judgeRoute.presetId) : undefined;
            const provider = createProvider({ kind: judgeRoute.kind, baseUrl: judgeRoute.baseUrl, model: judgeRoute.model, ...(apiKey ? { apiKey } : {}) });
            return { model: judgeRoute.model, judge: createReplayJudge({ provider, model: judgeRoute.model, judgeModel: judgeRoute.model }) };
          })()
        : undefined;
      return await replayTrace(trace, createProvider(request.config), request.config.model, {
        signal: controller.signal,
        timeoutMs: timeoutSeconds * 1_000,
        ...(judge ? { judge } : {}),
        onProgress: (completed, total) => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC.traceReplayProgress, { completed, total });
        },
      });
    } finally {
      if (activeReplay === controller) activeReplay = null;
    }
  });
  ipcMain.handle(IPC.traceReplayCancel, () => {
    activeReplay?.abort();
  });

  ipcMain.handle(IPC.memoryList, () => memoryStore.list());
  ipcMain.handle(IPC.memoryAdd, (_event, fact: string, category: MemoryCategory) =>
    memoryStore.add(fact, category, "user"),
  );
  ipcMain.handle(IPC.memoryDelete, (_event, id: string) => memoryStore.delete(id));
  ipcMain.handle(IPC.memoryClear, () => {
    memoryStore.clear();
  });

  ipcMain.handle(IPC.memoryReviewList, () => memoryReviewQueue.list());
  ipcMain.handle(IPC.memoryReviewApprove, (_event, id: string) => memoryReviewQueue.approve(id));
  ipcMain.handle(IPC.memoryReviewReject, (_event, id: string) => memoryReviewQueue.reject(id));

  ipcMain.handle(IPC.skillsList, () => skillLedger.sync(skillsStore.list()));
  ipcMain.handle(IPC.skillSetTrust, (_event, id: unknown, status: unknown) => {
    if (typeof id !== "string" || !["trusted", "candidate", "demoted"].includes(String(status))) throw new Error("Invalid skill trust request");
    return skillLedger.setStatus(id, status as SkillTrustStatus);
  });
  ipcMain.handle(IPC.skillHistory, (_event, id: unknown) => typeof id === "string" ? skillLedger.history(id) : []);
  ipcMain.handle(IPC.skillRollback, (_event, id: unknown, version: unknown) => {
    if (typeof id !== "string" || typeof version !== "number") throw new Error("Invalid skill rollback request");
    const snapshot = skillLedger.history(id).find((item) => item.version === version);
    if (!snapshot) throw new Error(`Version ${version} is not available for rollback`);
    skillLedger.noteEdit(id, "user");
    return skillsStore.update(id, snapshot.description, snapshot.instructions);
  });
  ipcMain.handle(IPC.skillCreate, (_event, req: SkillCreateRequest) =>
    skillsStore.create(req.name, req.description, req.instructions),
  );
  ipcMain.handle(IPC.skillDelete, (_event, id: string) => skillsStore.delete(id));
  ipcMain.handle(IPC.skillToggle, (_event, id: string, enabled: boolean) => {
    skillsStore.setEnabled(id, enabled);
  });
  ipcMain.handle(IPC.skillUpdate, (_event, req: SkillUpdateRequest) => {
    skillLedger.noteEdit(req.id, "user");
    return skillsStore.update(req.id, req.description, req.instructions);
  });
  ipcMain.handle(IPC.skillRename, (_event, req: SkillRenameRequest) =>
    skillsStore.rename(req.id, req.newName),
  );
  ipcMain.handle(IPC.skillImport, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return skillsStore.importFromDirectory(result.filePaths[0]);
  });

  ipcMain.handle(IPC.mcpStatus, () => mcpManager.getStatus());
  ipcMain.handle(IPC.mcpSetEnabled, async (_event, id: string, enabled: boolean) => {
    if (setMcpServerEnabled(id, enabled)) await mcpManager.reconnect(id);
    return mcpManager.getStatus();
  });
  ipcMain.handle(IPC.mcpOpenConfig, async () => {
    const path = ensureMcpConfig();
    const error = await shell.openPath(path);
    return error === "" ? path : null;
  });
  ipcMain.handle(IPC.mcpAddServer, async (event, config: McpServerConfig) => {
    requireTrustedSender(event, "adding an MCP server");
    if (addMcpServer(config)) await mcpManager.reconnect(config.id);
    return mcpManager.getStatus();
  });
  ipcMain.handle(IPC.mcpUpdateServer, async (event, config: McpServerConfig) => {
    requireTrustedSender(event, "changing an MCP server");
    if (updateMcpServer(config)) await mcpManager.reconnect(config.id);
    return mcpManager.getStatus();
  });
  ipcMain.handle(IPC.mcpRemoveServer, async (_event, id: string) => {
    if (removeMcpServer(id)) await mcpManager.reconnect(id);
    return mcpManager.getStatus();
  });
  ipcMain.handle(IPC.mcpListConfigs, () => loadMcpServers());
  ipcMain.handle(IPC.mcpReconnect, async (_event, id: string) => {
    await mcpManager.reconnect(id);
    return mcpManager.getStatus();
  });

  ipcMain.handle(IPC.shellOpenExternal, async (_event, url: string): Promise<boolean> => {
    // Defense in depth: the renderer also guards the scheme, but never open a
    // URL the main process has not re-validated to http(s)/mailto.
    if (typeof url !== "string" || !/^(https?:|mailto:)/i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle(IPC.clipboardWrite, (_event, text: string, html?: string): boolean => {
    if (typeof text !== "string") return false;
    clipboard.write(typeof html === "string" && html ? { text, html } : { text });
    return true;
  });

  ipcMain.handle(IPC.transcribe, async (_event, req: TranscribeRequest): Promise<TranscribeResult> => {
    try {
      return { text: await transcribeAudio(req) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.checkpointList, (_event, turnId: string) => checkpointStore.list(turnId));
  ipcMain.handle(IPC.checkpointRevert, (_event, turnId: string) => checkpointStore.revert(turnId));

  ipcMain.handle(IPC.codebaseStatus, (_event, workspaceRoot: string) => codebaseIndex.status(workspaceRoot));
  ipcMain.handle(IPC.codebaseReindex, (_event, workspaceRoot: string, config: EmbedConfig) =>
    codebaseIndex.reindex(workspaceRoot, config),
  );
}

async function startTurn(event: Electron.IpcMainEvent, req: ChatStartRequest): Promise<void> {
  const startedAt = Date.now();
  const mission = Boolean(req.taskSpec || req.taskId);
  let firstResponseRecorded = false;
  let lastTaskState: TaskSnapshot["state"] | undefined;
  void productDiagnostics.record("turn-started", { mission });
  const controller = new AbortController();
  const broker = new ApprovalBroker();
  const disposers = new Set<() => Promise<void>>();
  const durableTaskId = req.taskSpec ? req.taskId ?? req.turnId : undefined;
  let preserveTaskOnAbort = false;
  let rendererUnavailable = false;
  let recoveringBlocker = false;
  let recoveringReload = false;
  let pendingDurableApproval: { callId: string; persisted: Promise<TaskSnapshot> } | undefined;
  let traceRecorder: TraceRecorder | undefined;
  let routedProvider: RoutedProvider | undefined;

  let terminalEvent: Extract<MossEvent, { type: "turn-complete" | "turn-aborted" | "turn-error" }> | undefined;
  const approvalEvents = new Map<string, Extract<MossEvent, { type: "tool-approval-request" }>>();
  const approvalStartedAt = new Map<string, number>();
  let observeForEscalation: ((mossEvent: MossEvent) => void) | undefined;
  const verificationCounts = { passed: 0, failed: 0 };
  let lastVerificationOk: boolean | undefined;
  const skillCalls = new Map<string, string>();
  const usedSkillNames = new Set<string>();
  // Host evidence for live scores.
  const usedToolNames = new Set<string>();
  const evidence = { rejections: 0, stalls: 0, repairs: 0, supervisorStopped: false };
  // Successful calls in order, for learning procedures from verified turns.
  const pendingCalls = new Map<string, { name: string; arguments: string }>();
  const successfulCalls: Array<{ name: string; arguments: string }> = [];
  const usedProcedureIds = new Set<string>();
  const learnProcedures = req.learnProcedures !== false;
  const send = (mossEvent: MossEvent) => {
    if (mossEvent.type === "tool-call") {
      usedToolNames.add(mossEvent.name);
      pendingCalls.set(mossEvent.callId, { name: mossEvent.name, arguments: mossEvent.arguments });
    }
    if (mossEvent.type === "tool-result" && mossEvent.ok && pendingCalls.has(mossEvent.callId)) successfulCalls.push(pendingCalls.get(mossEvent.callId)!);
    if (isModelRejection(mossEvent)) evidence.rejections += 1;
    if (mossEvent.type === "supervisor") {
      evidence.stalls += 1;
      if (mossEvent.action === "stop") evidence.supervisorStopped = true;
    }
    if (mossEvent.type === "harness-decision") {
      if (mossEvent.decision.kind === "repair") evidence.repairs += 1;
      traceRecorder?.noteDecision(mossEvent.decision);
    }
    if (mossEvent.type === "verification") {
      verificationCounts[mossEvent.ok ? "passed" : "failed"] += 1;
      lastVerificationOk = mossEvent.ok;
    }
    if (mossEvent.type === "tool-call" && mossEvent.name === "m_get_skill") {
      try {
        const name = (JSON.parse(mossEvent.arguments || "{}") as { name?: unknown }).name;
        if (typeof name === "string") skillCalls.set(mossEvent.callId, name);
      } catch {
        // Malformed arguments cannot identify a skill.
      }
    }
    if (mossEvent.type === "tool-result" && mossEvent.ok && skillCalls.has(mossEvent.callId)) usedSkillNames.add(skillCalls.get(mossEvent.callId)!);
    observeForEscalation?.(mossEvent);
    if (
      !firstResponseRecorded
      && ["text-delta", "tool-call", "notice", "task-state"].includes(mossEvent.type)
    ) {
      firstResponseRecorded = true;
      void productDiagnostics.record("first-response", { durationMs: Date.now() - startedAt, mission });
      void productDiagnostics.record("launch-first-response", { durationMs: Date.now() - processStartedAt, mission });
    }
    if (mossEvent.type === "tool-approval-request") {
      approvalStartedAt.set(mossEvent.callId, Date.now());
      void productDiagnostics.record("approval-requested", { durationMs: Date.now() - startedAt, mission, approvalRisk: mossEvent.risk });
    }
    if (mossEvent.type === "task-state" && mossEvent.task.state !== lastTaskState) {
      lastTaskState = mossEvent.task.state;
      if (mossEvent.task.state === "blocked") {
        void productDiagnostics.record("task-blocked", { durationMs: Date.now() - startedAt, mission, outcome: "blocked" });
      }
      if (mossEvent.task.state === "completed") {
        const mandatory = mossEvent.task.spec.acceptanceCriteria.filter((criterion) => criterion.mandatory);
        const passed = mandatory.every((criterion) =>
          mossEvent.task.evidence.some((evidence) => evidence.criterionId === criterion.id && evidence.passed),
        );
        void productDiagnostics.record("verification-result", {
          durationMs: Date.now() - startedAt,
          mission,
          outcome: passed ? "passed" : "failed-verification",
        });
      }
    }
    if (mossEvent.type === "turn-complete" || mossEvent.type === "turn-aborted" || mossEvent.type === "turn-error") {
      terminalEvent = mossEvent;
      return;
    }
    if (mossEvent.type === "tool-approval-request") approvalEvents.set(mossEvent.callId, mossEvent);
    if (!rendererUnavailable && !event.sender.isDestroyed()) {
      event.sender.send(IPC.chatEvent, { turnId: req.turnId, event: mossEvent });
    }
  };
  const inflightEntry: Inflight = { controller, broker, send, approvalStartedAt, ...(durableTaskId ? { taskId: durableTaskId } : {}) };
  inflight.set(req.turnId, inflightEntry);
  const handleRendererDestroyed = () => {
    const entry = inflight.get(req.turnId);
    if (entry !== inflightEntry || rendererUnavailable) return;
    rendererUnavailable = true;
    entry.controller.abort();
    const callId = entry.broker.pendingCallId() ?? pendingDurableApproval?.callId;
    if (entry.taskId && callId) {
      preserveTaskOnAbort = true;
      const persisted = pendingDurableApproval?.callId === callId
        ? pendingDurableApproval.persisted
        : Promise.resolve();
      void persisted
        .then(() => taskEngine.interruptApproval(entry.taskId!, callId, "Renderer closed before the approval was completed"))
        .then(() => productDiagnostics.record("task-blocked", {
          durationMs: Date.now() - startedAt,
          mission: true,
          outcome: "blocked",
        }))
        .catch(() => undefined)
        .finally(() => entry.broker.denyAll("Renderer closed before the approval was completed"));
    } else {
      entry.broker.denyAll("Renderer closed");
    }
  };
  const handleRendererNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (details.isMainFrame && !details.isSameDocument) handleRendererDestroyed();
  };
  event.sender.once("destroyed", handleRendererDestroyed);
  event.sender.once("render-process-gone", handleRendererDestroyed);
  event.sender.on("did-start-navigation", handleRendererNavigation);

  try {
    /** Say what the harness decided: a notice in the chat and an entry in the Why timeline. */
    const decide = (decision: HarnessDecision, level?: "info" | "warn"): void => {
      if (level) send({ type: "notice", level, message: decision.summary });
      send({ type: "harness-decision", decision });
    };
    const liveEntries = req.adaptiveScaffolding !== false ? await modelPerformanceStore.list().catch(() => []) : [];
    const predictedKind: ModelTaskKind | "all" = req.mission ? "mission" : "all";
    /** Stored profile adjusted by live evidence; tiers move one step at most. */
    const profileFor = async (config: ProviderConfig): Promise<ModelCapabilityProfile | null> => {
      const stored = await modelProfileStore.get(config.kind, config.baseUrl, config.model).catch(() => null);
      if (!stored) return null;
      const { profile: adjusted, score } = effectiveProfile(stored, liveEntries, predictedKind);
      if (adjusted.tier !== stored.tier && score.successRate !== undefined) {
        decide({
          kind: "live-score",
          summary: `Treating ${config.model} as ${adjusted.tier} (probe: ${stored.tier}) after ${Math.round(score.successRate * 100)}% verified success over ${Math.round(score.graded)} graded runs of your work.`,
          settings: "models",
        });
      }
      return adjusted;
    };
    traceRecorder = req.recordTrace
      ? new TraceRecorder({ id: req.turnId, providerKind: req.config.kind, baseUrl: req.config.baseUrl, model: req.config.model })
      : undefined;
    // A clean git start state lets practice runs re-run this turn with other models.
    if (traceRecorder && req.verify?.enabled && req.workspaceRoot) {
      const outcomeContext = await captureOutcomeContext(req.workspaceRoot, req.verify.commands ?? []);
      if (outcomeContext) traceRecorder.setOutcomeContext(outcomeContext);
    }
    // Each route gets its own provider stack: base provider, optional constrained
    // step protocol, daily budget, and trace recording, so every layer sees the
    // model and endpoint that actually serve the request.
    const buildRoute = async (key: string, config: ProviderConfig): Promise<ProviderRoute> => {
      // "auto" follows the measured profile, so it is part of adaptive scaffolding.
      const requested = req.constrainedOutput?.[config.model] ?? "auto";
      const mode = requested === "auto" && req.adaptiveScaffolding === false ? "never" : requested;
      const profile = mode === "auto" && config.kind === "openai-compatible" ? await profileFor(config) : null;
      const constrained = config.kind === "openai-compatible"
        && (mode === "always" || (mode === "auto" && (profile?.tier === "limited" || profile?.tier === "unreliable")));
      const base = createProvider(config);
      const local = isLocalRoute(config.baseUrl, config.model);
      const voteMode = req.stepVoting?.[config.model] ?? "auto";
      // Voting triples local calls, so Automatic needs a weak model that is also fast.
      const votes = constrained && local && (voteMode === "always" || (voteMode === "auto" && req.adaptiveScaffolding !== false
        && (profile?.tier === "limited" || profile?.tier === "unreliable")
        && profile.latency !== undefined && profile.latency.medianMs <= VOTE_MAX_MEDIAN_MS))
        ? VOTE_SAMPLES
        : 1;
      if (votes > 1) {
        decide({ kind: "vote", summary: `Voting on each step for ${config.model}: ${votes} constrained samples, the most common step runs.`, settings: "models" }, "info");
      }
      const stepped = constrained
        ? new StepProtocolProvider(base, {
            votes,
            onVote: (result) => {
              if (result.agreeing < result.samples) {
                decide({ kind: "vote", summary: `${result.agreeing} of ${result.samples} samples agreed on ${result.choice}.`, settings: "models" });
              }
            },
          })
        : base;
      const budgeted = req.dailyBudgetUsd && req.dailyBudgetUsd > 0
        ? new BudgetEnforcingProvider(stepped, req.dailyBudgetUsd, req.modelRates)
        : stepped;
      const recorded = traceRecorder
        ? new RecordingProvider(budgeted, traceRecorder, Date.now, { providerKind: config.kind, endpoint: config.baseUrl, constrained })
        : budgeted;
      return {
        key,
        provider: recorded,
        model: config.model,
        providerKind: config.kind,
        endpoint: config.baseUrl,
        local,
        constrained,
      };
    };
    const routeConfig = (route: ModelRoute | undefined, sameConnectionModel: string | undefined): ProviderConfig | undefined => {
      if (route?.model?.trim() && route.baseUrl?.trim()) {
        const sameConnection = route.kind === req.config.kind && endpointLabel(route.baseUrl).toLowerCase() === endpointLabel(req.config.baseUrl).toLowerCase();
        const apiKey = sameConnection ? req.config.apiKey : route.presetId ? providerCredentials.get(route.presetId) : undefined;
        return { kind: route.kind, baseUrl: route.baseUrl, model: route.model.trim(), ...(apiKey ? { apiKey } : {}) };
      }
      const model = sameConnectionModel?.trim();
      return model ? { ...req.config, model } : undefined;
    };
    // Ranking by meaning sends request text to the embeddings endpoint on every
    // turn, so it runs only when the user opts in.
    const rankingEmbed = req.semanticRanking === true && req.embed?.baseUrl && req.embed.model ? req.embed : undefined;
    const lastUserText = [...req.messages].reverse().find((message) => message.role === "user")?.content;
    const primaryRoute = await buildRoute("chat", req.config);
    const extraRoutes = new Map<string, ProviderRoute>();
    const fastConfig = routeConfig(req.routing?.fastRoute, req.routing?.fastModel);
    const escalationConfig = routeConfig(req.routing?.escalationRoute, req.routing?.escalationModel);
    const sameAsPrimary = (config: ProviderConfig): boolean => config.model === req.config.model
      && config.kind === req.config.kind && endpointLabel(config.baseUrl) === endpointLabel(req.config.baseUrl);
    if (fastConfig && !sameAsPrimary(fastConfig)) extraRoutes.set("fast", await buildRoute("fast", fastConfig));
    if (escalationConfig && !sameAsPrimary(escalationConfig)) extraRoutes.set("escalation", await buildRoute("escalation", escalationConfig));
    const criticConfig = req.mission || req.taskSpec ? routeConfig(req.routing?.criticRoute, req.routing?.criticModel) : undefined;
    if (criticConfig) extraRoutes.set("critic", await buildRoute("critic", criticConfig));
    routedProvider = new RoutedProvider(primaryRoute, extraRoutes);
    // The reader runs on the fast route when there is one, and never gets tools.
    const quarantine = req.quarantineUntrusted === true
      ? createQuarantine({ provider: routedProvider, model: extraRoutes.has("fast") ? routeToken("fast") : req.config.model, ...(lastUserText ? { userRequest: lastUserText } : {}) })
      : undefined;
    const provider = routedProvider;
    const constrainedNotice = [primaryRoute, ...extraRoutes.values()].filter((route) => route.constrained).map((route) => route.model);
    if (constrainedNotice.length > 0) {
      decide({ kind: "constrain", summary: `Using constrained tool output for ${constrainedNotice.join(", ")}: each step is one validated tool call or a final answer.`, settings: "models" }, "info");
    }
    if (routedProvider.route("escalation")) {
      const monitor = new EscalationMonitor(req.routing?.escalateAfter ?? DEFAULT_ESCALATE_AFTER);
      const router = routedProvider;
      observeForEscalation = (observed) => {
        if (!monitor.observe(observed)) return;
        const target = router.escalate("escalation");
        if (!target) return;
        const crossesToCloud = primaryRoute.local && !target.local;
        decide({
          kind: "escalate",
          summary: `Escalating to ${target.model} after ${monitor.count} rejected attempt${monitor.count === 1 ? "" : "s"} by ${req.config.model}.${crossesToCloud ? ` This sends the conversation and workspace context to ${routeDestination(target.endpoint, target.model)}.` : ""}`,
          settings: "models",
        }, "warn");
      };
    }
    const enableTools = req.enableTools !== false;
    const routed = enableTools
      ? routeAvailableTools(req)
      : { tools: [], unmet: [] };
    if (enableTools && req.jevEnabled === true && !req.taskSpec && !req.taskId && !req.mission) {
      routed.tools.push(createJevTool(() => providerCredentials.get("typesafe")));
    }
    const toolDefinitions = enableTools
      ? routed.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      : [];
    const toolRegistry = new Map(routed.tools.map((tool) => [tool.name, tool]));
    for (const tool of routed.tools) if (tool.dispose) disposers.add(tool.dispose);
    // Prepend a fresh system message (base instructions + skills index + memory)
    // unless the renderer already supplied one. The latest user message drives
    // query-aware memory selection.
    const hasSystem = req.messages.some((m) => m.role === "system");
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const messages = hasSystem
      ? req.messages
      : [buildSystemMessage({ includeSkills: enableTools, includeClarification: !req.taskSpec && !req.taskId, query: lastUser?.content ?? "", customInstructions: req.customInstructions, personalityId: req.personalityId, adaptiveTone: req.adaptiveTone }), ...req.messages];
    if (!hasSystem && lastUser?.content) {
      // Episodic memory: verified lessons from earlier runs that match this request.
      const lessons = renderLessons(await lessonStore.relevant(lastUser.content, 3, rankingEmbed ? (query, texts) => semanticIndex.similarities(query, texts, rankingEmbed, controller.signal) : undefined).catch(() => []));
      if (lessons) messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${lessons}` };
    }
    const workingState = new WorkingStateStore(normalizeWorkingState(req.workingState));
    const stallLimit = typeof req.stallLimit === "number" && Number.isFinite(req.stallLimit) ? Math.max(0, Math.floor(req.stallLimit)) : undefined;
    // Snapshot file pre-images only when a workspace is selected, so a turn's
    // edits can be reverted. Prune old manifests opportunistically at turn start.
    const workspaceRoot = req.workspaceRoot ?? "";
    const checkpoint = workspaceRoot ? checkpointStore.recorder(req.turnId) : undefined;
    if (workspaceRoot) checkpointStore.prune();
    void toolOutputStore.prune().catch(() => undefined);
    // Give the fix/verify cycle extra rounds to converge when verification runs.
    const verifyEnabled = req.verify?.enabled === true && (req.verify.commands?.length ?? 0) > 0;
    const maxRounds = resolveMaxToolRounds(req.maxToolRounds, verifyEnabled);
    let attemptId: string | undefined;
    let acceptedCompletion: CompletionContext | undefined;
    const storedTask = durableTaskId ? await taskStore.get(durableTaskId) : undefined;
    recoveringBlocker = storedTask?.state === "blocked" || storedTask?.state === "paused";
    recoveringReload = storedTask?.blocker?.kind === "approval"
      && storedTask.blocker.summary.includes("Renderer closed");
    if (!storedTask && req.taskSpec?.executionGrant && !req.mission) {
      throw new Error("Mission execution grants must be issued by Electron from a mission launch policy");
    }
    const requestedSpec = storedTask?.spec ?? (req.taskSpec && req.mission
      ? resolveMissionSpec(req.taskSpec, req.mission, routed.tools.map((tool) => tool.name), req)
      : req.taskSpec);
    if (!storedTask && req.taskSpec && req.mission?.authority === "policy-scoped") {
      const token = req.mission.authorizationToken;
      if (!token) throw new Error("Policy-scoped mission requires native authorization");
      missionAuthority.consume(toMissionAuthorizationRequest(req.taskSpec, req.mission, req), token);
    }
    let task = requestedSpec
      ? requestedSpec.executionGrant
        ? await ensureMissionTask(durableTaskId!, requestedSpec, send)
        : await ensureTurnTask(durableTaskId!, requestedSpec, send)
      : undefined;
    if (task?.spec.executionGrant) {
      const missionMessages: Extract<MossEvent, { type: "turn-complete" | "turn-aborted" | "turn-error" }>["messages"] = [];
      const usedCapabilities = new Set<string>();
      const capabilities = routed.tools.map((tool) => ({
        ...describeMissionCapability(tool.name),
      }));
      const missionProvider = new MissionBudgetProvider(provider, remainingBudget(task, new Date()), req.modelRates, routedProvider.resolveModel);
      const planner = new MissionPlanner({
        provider: missionProvider,
        modelRates: req.modelRates,
        model: req.config.model,
        capabilities,
        ...(task.spec.budget?.maxTokens
          ? { maxTokens: Math.max(1, Math.floor(task.spec.budget.maxTokens / 2)) }
          : {}),
      });
      const worker = new RunTurnMissionWorker({
        provider: missionProvider,
        modelRates: req.modelRates,
        model: req.config.model,
        tools: routed.tools,
        workspaceRoot,
        workingState,
        ...(stallLimit !== undefined ? { stallLimit } : {}),
        ...(req.untrustedContentGate === false ? { provenanceGate: false } : {}),
        resolveModel: routedProvider.resolveModel,
        ...(quarantine ? { quarantine } : {}),
        checkpoint,
        verify: req.verify,
        maxRounds,
        contextLimit: req.contextLimit,
        loadArtifact: async (taskId, artifactId) => (await taskArtifactStore.get(taskId, artifactId))?.content ?? null,
        onEvent: (workerEvent) => {
          if (workerEvent.type === "turn-complete" || workerEvent.type === "turn-aborted" || workerEvent.type === "turn-error") {
            missionMessages.push(...workerEvent.messages);
            return;
          }
          if (workerEvent.type === "tool-result" && workerEvent.ok) usedCapabilities.add(workerEvent.name);
          send(workerEvent);
        },
        requestApproval: async (callId, order, signal) => {
          const approvalEvent = approvalEvents.get(callId);
          if (!approvalEvent) throw new Error(`Missing approval event for call '${callId}'`);
          const persisted = taskEngine.requestApproval(task!.id, {
            taskId: task!.id,
            turnId: order.attemptId,
            callId,
            toolName: approvalEvent.name,
            arguments: approvalEvent.arguments,
            ...(approvalEvent.risk ? { risk: approvalEvent.risk } : {}),
            status: "pending",
            requestedAt: new Date().toISOString(),
          });
          pendingDurableApproval = { callId, persisted };
          const waiting = await persisted;
          send({ type: "task-state", task: waiting });
          try {
            return await broker.request(callId, signal);
          } finally {
            if (pendingDurableApproval?.callId === callId) pendingDurableApproval = undefined;
          }
        },
      });
      const missionController = new MissionController({
        engine: taskEngine,
        store: taskStore,
        artifactStore: taskArtifactStore,
        planner,
        capabilities,
        worker,
        verifier: new WorkspaceMissionVerifier({
          workspaceRoot,
          checks: buildMissionVerificationChecks(task.spec, req.verify),
          loadArtifact: async (taskId, artifactId) => (await taskArtifactStore.get(taskId, artifactId))?.content ?? null,
          ...(routedProvider.route("critic") ? {
            // The critic is charged to the mission budget at its own rate.
            critic: createMissionCritic({
              provider: missionProvider,
              model: routeToken("critic"),
              criticModel: routedProvider.route("critic")!.model,
              workerModels: missionWorkerModels(req),
              onVerdict: (criterion, outcome) => decide({
                kind: "critic",
                summary: `Critic ${routedProvider!.route("critic")!.model} judged "${criterion.slice(0, 80)}": ${outcome.passed ? "pass" : outcome.verdict ?? "unverified"}.`,
                detail: outcome.summary.slice(0, 300),
                settings: "models",
              }),
            }),
          } : {}),
        }),
        onTaskState: (next) => {
          task = next;
          send({ type: "task-state", task: next });
        },
      });
      task = await missionController.run(task.id, controller.signal);
      send({ type: "task-state", task });
      const summary = task.state === "completed"
        ? "Mission completed with passing host-owned evidence."
        : task.blocker?.summary ?? `Mission stopped in state '${task.state}'.`;
      if (missionMessages.length === 0) missionMessages.push({ role: "assistant", content: summary, turnId: req.turnId });
      send({ type: "turn-complete", messages: missionMessages });
      await recordTaskLearning(task, [...usedCapabilities]).catch(() => undefined);
      return;
    }
    if (task) {
      const baselineCommands = verifyEnabled ? (req.verify?.commands ?? []).slice(0, 1) : [];
      const baseline = baselineCommands.length > 0 && workspaceRoot
        ? await runVerify(baselineCommands, workspaceRoot, controller.signal)
        : undefined;
      const readyStep = selectDependencyReadyStep(task);
      if (!readyStep) throw new Error(`Task '${task.id}' has no dependency-ready step`);
      const priorCheckpoint = [...task.attempts].reverse().find((attempt) =>
        attempt.outcome === "succeeded" && attempt.turnId,
      )?.turnId;
      const attempt = await taskEngine.beginAttempt(task.id, readyStep.id, req.turnId);
      attemptId = attempt.attempt.id;
      task = attempt.task;
      send({ type: "task-state", task });
      const packet = buildTaskProgressPacket(task, {
        changedFiles: priorCheckpoint
          ? (await checkpointStore.list(priorCheckpoint)).map((file) => file.path)
          : [],
        ...(baseline ? { baseline: { passed: baseline.ok, checks: baseline.results.length } } : {}),
      });
      const userIndex = messages.map((message) => message.role).lastIndexOf("user");
      messages.splice(userIndex < 0 ? messages.length : userIndex, 0, {
        role: "system",
        content: renderTaskProgressPacket(packet),
      });
    }
    // Missions keep their granted capabilities and budget accounting, so model
    // adaptation and escalation apply to ordinary turns and turn tasks only.
    const profile = req.adaptiveScaffolding !== false && toolDefinitions.length > 0 ? await profileFor(req.config) : null;
    let scaffolding = planScaffolding(profile, toolDefinitions, lastUser?.content ?? "");
    const narrowed = scaffolding.tools.length < toolDefinitions.length;
    if (narrowed) {
      // Rank by meaning when embeddings are configured, and always offer
      // find_tool so a narrowed model can recover a tool it was not given.
      const ranked = await semanticIndex.rankTools(toolDefinitions, lastUser?.content ?? "", scaffolding.tools.length, rankingEmbed, controller.signal);
      scaffolding = { ...scaffolding, tools: [...ranked, { name: findToolTool.name, description: findToolTool.description, parameters: findToolTool.parameters }] };
    }
    if (scaffolding.notice) decide({ kind: "scaffold", summary: scaffolding.notice, settings: "models" }, "info");
    const scaffoldedRegistry = narrowed ? new Map([...toolRegistry, [findToolTool.name, findToolTool]]) : toolRegistry;
    // Learned procedures are offered whenever tools are on, even when narrowed.
    const procedures = learnProcedures && toolDefinitions.length > 0 ? await procedureStore.offered().catch(() => []) : [];
    if (procedures.length > 0) {
      // Measured on local models: without this hint they rarely pick run_procedure,
      // and with it they reuse the steps they would otherwise forget.
      scaffolding = {
        ...scaffolding,
        tools: [...scaffolding.tools, procedureToolDefinition(procedures)],
        systemGuidance: [scaffolding.systemGuidance, PROCEDURE_HINT].filter(Boolean).join("\n\n"),
      };
      scaffoldedRegistry.set(runProcedureTool.name, runProcedureTool);
    }
    const expandLearned = (rawArguments: string): { calls: ToolCall[]; procedureId: string; name: string } | { error: string } => {
      let args: { procedure?: unknown; slots?: unknown };
      try {
        args = JSON.parse(rawArguments || "{}") as typeof args;
      } catch {
        return { error: "run_procedure arguments must be a JSON object with procedure and slots." };
      }
      const procedure = procedures.find((item) => item.id === args.procedure);
      if (!procedure) return { error: `Unknown procedure ${String(args.procedure)}. Available: ${procedures.map((item) => item.id).join(", ")}.` };
      const expanded = expandProcedure(procedure, args.slots && typeof args.slots === "object" ? args.slots as Record<string, unknown> : {});
      if ("error" in expanded) return expanded;
      usedProcedureIds.add(procedure.id);
      return { calls: expanded.calls, procedureId: procedure.id, name: procedure.name };
    };

    await runTurn({
      provider,
      model: req.config.model,
      messages: applyScaffoldingMessages(messages, scaffolding),
      tools: scaffolding.tools,
      toolRegistry: scaffoldedRegistry,
      ...(narrowed ? { toolCatalog: toolDefinitions } : {}),
      ...(rankingEmbed ? { rankingEmbed } : {}),
      ...(quarantine ? { quarantine } : {}),
      ...(procedures.length > 0 ? { expandProcedure: expandLearned } : {}),
      ...(scaffolding.maxToolCallsPerRound ? { maxToolCallsPerRound: scaffolding.maxToolCallsPerRound } : {}),
      workingState,
      ...(stallLimit !== undefined ? { stallLimit } : {}),
      ...(req.untrustedContentGate === false ? { provenanceGate: false } : {}),
      // The renderer counts its own history; a system message added here shifts it.
      ...(req.trustedHistoryLength ? { trustedHistoryLength: req.trustedHistoryLength + (hasSystem ? 0 : 1) } : {}),
      ...(routedProvider.route("fast") ? { auxiliaryModel: routeToken("fast") } : {}),
      workspaceRoot,
      signal: controller.signal,
      onEvent: send,
      requestApproval: async (callId) => {
        if (task) {
          const approvalEvent = approvalEvents.get(callId);
          if (!approvalEvent) throw new Error(`Missing approval event for call '${callId}'`);
          const persisted = taskEngine.requestApproval(task.id, {
            taskId: task.id,
            turnId: req.turnId,
            callId,
            toolName: approvalEvent.name,
            arguments: approvalEvent.arguments,
            ...(approvalEvent.risk ? { risk: approvalEvent.risk } : {}),
            status: "pending",
            requestedAt: new Date().toISOString(),
          });
          pendingDurableApproval = { callId, persisted };
          const waiting = await persisted;
          send({ type: "task-state", task: waiting });
        }
        try {
          return await broker.request(callId, controller.signal);
        } finally {
          if (pendingDurableApproval?.callId === callId) pendingDurableApproval = undefined;
        }
      },
      autoApprove: req.autoApproveTools === true,
      stt: req.stt,
      email: req.email,
      embed: req.embed,
      turnId: req.turnId,
      checkpoint,
      toolOutputStore,
      verify: req.verify,
      ...(task ? { planningPolicy: "incremental" as const, recoveryMode: "signature-aware" as const } : {}),
      ...(task
        ? {
            completionGuard: (context: CompletionContext) => {
              const verificationFailed = context.latestVerification?.ok === false;
              const hasExecutionEvidence = context.successfulToolCalls > 0 || !enableTools;
              const accept = !verificationFailed && context.failedToolCalls === 0 && hasExecutionEvidence;
              if (accept) acceptedCompletion = context;
              return {
                accept,
                feedback: verificationFailed
                  ? "Verification failed. Diagnose the failure, repair the task, and run verification again before completing."
                  : context.failedToolCalls > 0
                    ? "One or more tools failed. Recover with corrected arguments, an alternate tool, or a revised plan before completing."
                    : "Do not stop yet. Use the available tools to inspect or perform the requested task, then verify the result before completing.",
              };
            },
          }
        : {}),
      ...(req.gatedMemory ? { gatedMemory: true } : {}),
      ...(req.showConfidence ? { showConfidence: true } : {}),
      ...(req.injectionMode ? { injectionMode: req.injectionMode } : {}),
      ...(req.contextLimit ? { contextLimit: req.contextLimit } : {}),
      maxRounds,
    });
    if (task && attemptId) {
      await finalizeTurnTask(
        task.id,
        attemptId,
        acceptedCompletion,
        terminalEvent,
        workspaceRoot,
        controller.signal,
        send,
        preserveTaskOnAbort,
      );
    }
  } catch (err) {
    send({
      type: "turn-error",
      message: err instanceof Error ? err.message : String(err),
      messages: [],
      source: "harness-orchestration",
    });
  } finally {
    const cleanup = await Promise.allSettled([...disposers].map((dispose) => dispose()));
    const cleanupFailures = cleanup.filter((result) => result.status === "rejected");
    if (cleanupFailures.length > 0) {
      terminalEvent = { type: "turn-error", source: "harness-orchestration", messages: terminalEvent?.messages ?? [],
        message: `Automation cleanup failed: ${cleanupFailures.map((result) => String(result.reason)).join("; ")}` };
    }
    if (terminalEvent && !rendererUnavailable && !event.sender.isDestroyed()) {
      event.sender.send(IPC.chatEvent, { turnId: req.turnId, event: terminalEvent });
    }
    if (terminalEvent) {
      const outcome = terminalEvent.type === "turn-complete"
        ? "completed"
        : terminalEvent.type === "turn-aborted"
          ? "aborted"
          : "failed";
      const skillIds = [...usedSkillNames].map((name) => skillsStore.get(name)?.id).filter((id): id is string => !!id);
      if (skillIds.length > 0) {
        // Only host evidence promotes or demotes a skill: task state and verification, never the model's claim.
        const skillOutcome: SkillOutcome = lastTaskState === "completed"
          ? "success"
          : lastTaskState === "blocked" || lastTaskState === "failed" || lastVerificationOk === false
            ? "failure"
            : terminalEvent.type === "turn-complete" && lastVerificationOk === true
              ? "success"
              : terminalEvent.type === "turn-error" && terminalEvent.source !== "provider-model"
                ? "failure"
                : "used";
        try {
          skillLedger.recordOutcome(skillIds, skillOutcome);
        } catch {
          // Trust tracking must never break turn settlement.
        }
      }
      if (terminalEvent.type !== "turn-aborted" && req.config.model) {
        const kind = taskKindFor(usedToolNames, Boolean(req.mission));
        const grade = gradeTurn({
          terminal: terminalEvent.type,
          ...(terminalEvent.type === "turn-error" ? { terminalMessage: terminalEvent.message } : {}),
          ...(lastTaskState ? { taskState: lastTaskState } : {}),
          ...(lastVerificationOk !== undefined ? { lastVerificationOk } : {}),
          supervisorStopped: evidence.supervisorStopped,
        });
        // Procedures earn trust from host evidence, and verified turns teach new ones.
        if (usedProcedureIds.size > 0) {
          void procedureStore.recordOutcome([...usedProcedureIds], grade === "s" ? "success" : grade === "f" ? "failure" : "used").catch(() => undefined);
        } else if (grade === "s" && learnProcedures && !req.mission) {
          const request = [...req.messages].reverse().find((message) => message.role === "user")?.content ?? "";
          void procedureStore.observe(request, successfulCalls).catch(() => undefined);
        }
        // Plain chat with nothing graded says nothing about the model.
        if (grade || kind !== "chat" || evidence.rejections > 0) {
          const escalatedTo = routedProvider?.escalation;
          const durationMs = Date.now() - startedAt;
          const primary = { providerKind: req.config.kind, baseUrl: req.config.baseUrl, model: req.config.model, kind };
          const recordings = escalatedTo
            ? [
                modelPerformanceStore.record({ ...primary, outcome: "f", escalatedAway: true, rejections: evidence.rejections, repairs: evidence.repairs, stalls: evidence.stalls }),
                modelPerformanceStore.record({ providerKind: escalatedTo.providerKind as ProviderKind, baseUrl: escalatedTo.endpoint, model: escalatedTo.model, kind, ...(grade ? { outcome: grade } : {}), durationMs }),
              ]
            : [modelPerformanceStore.record({ ...primary, ...(grade ? { outcome: grade } : {}), rejections: evidence.rejections, repairs: evidence.repairs, stalls: evidence.stalls, durationMs })];
          void Promise.allSettled(recordings);
        }
      }
      if (traceRecorder) {
        void traceStore.save(traceRecorder.finish({
          outcome,
          ...(routedProvider?.escalation ? { escalatedTo: routedProvider.escalation.model } : {}),
          ...(verificationCounts.passed + verificationCounts.failed > 0 ? { verification: verificationCounts } : {}),
        })).catch(() => undefined);
      }
      void productDiagnostics.record("turn-settled", { durationMs: Date.now() - startedAt, mission, outcome });
      if (inflightEntry.abortRequestedAt) {
        void productDiagnostics.record("stop-settled", {
          durationMs: Date.now() - inflightEntry.abortRequestedAt,
          mission,
          outcome,
        });
      }
      if (terminalEvent.type === "turn-complete" && recoveringBlocker) {
        void productDiagnostics.record("blocker-recovery", { durationMs: Date.now() - startedAt, mission, outcome: "passed" });
      }
      if (terminalEvent.type === "turn-complete" && recoveringReload) {
        void productDiagnostics.record("reload-recovery", { durationMs: Date.now() - startedAt, mission, outcome: "passed" });
      }
      if (terminalEvent.type === "turn-error" && terminalEvent.source === "provider-model") {
        void productDiagnostics.record("provider-failure", {
          durationMs: Date.now() - startedAt,
          mission,
          outcome: "failed",
          category: diagnosticFailureCategory(terminalEvent.message),
        });
      }
    }
    event.sender.removeListener("destroyed", handleRendererDestroyed);
    event.sender.removeListener("render-process-gone", handleRendererDestroyed);
    event.sender.removeListener("did-start-navigation", handleRendererNavigation);
    if (inflight.get(req.turnId) === inflightEntry) inflight.delete(req.turnId);
  }

  function diagnosticFailureCategory(message: string): ProductDiagnosticEntry["category"] {
    const normalized = message.toLowerCase();
    if (/401|403|auth|api key|credential/.test(normalized)) return "authentication";
    if (/429|rate.?limit|quota/.test(normalized)) return "rate-limit";
    if (/network|fetch|socket|timeout|econn|dns/.test(normalized)) return "network";
    if (/config|model|base.?url|endpoint/.test(normalized)) return "configuration";
    return normalized ? "provider" : "unknown";
  }
}

function routeAvailableTools(request: MissionCapabilitiesRequest) {
  const automationTools = createAutomationTools(request);
  bundledCapabilityTools ??= createBundledCapabilityTools();
  const browserTools = automationTools.filter((tool) => tool.name.startsWith("browser_"));
  const desktopTools = automationTools.filter((tool) => tool.name.startsWith("desktop_"));
  return routeLiveCapabilities([
    { source: "built-in", tools: [...TOOL_REGISTRY.values(), ...bundledCapabilityTools] },
    { source: "mcp", tools: mcpManager.getTools() },
    { source: "browser", tools: browserTools },
    { source: "desktop", tools: desktopTools },
  ], request, process.platform, capabilityHistoryCache);
}

function describeMissionCapability(name: string): MissionCapabilityDescriptor {
  return {
    id: name,
    risk: name === "send_email"
      ? "destructive"
      : classifyTool(name) === "allow"
        ? "readonly"
        : "mutating",
  };
}

function createAutomationTools(req: Pick<ChatStartRequest, "automation">) {
  const automation = req.automation;
  if (!automation) return [];
  const tools = [];
  if (automation.browserEnabled && automation.browserAllowedDomains.length > 0) {
    tools.push(...createBrowserTools({
      driverFactory: createPlaywrightDriverFactory({
        headless: automation.browserHeadless,
        allowedDomains: automation.browserAllowedDomains,
      }),
      allowedDomains: automation.browserAllowedDomains,
    }));
  }
  if (
    automation.desktopEnabled
    && automation.desktopAllowedProcesses.length > 0
    && automation.desktopAllowedWindows.length > 0
  ) {
    tools.push(...createDesktopTools({
      driverFactory: createWindowsUiaDriverFactory(),
      allowedProcesses: automation.desktopAllowedProcesses,
      allowedWindows: automation.desktopAllowedWindows,
    }));
  }
  return tools;
}

async function ensureTurnTask(
  taskId: string,
  spec: TaskSpec,
  send: (event: MossEvent) => void,
): Promise<NonNullable<Awaited<ReturnType<typeof taskStore.get>>>> {
  let task = await taskStore.get(taskId);
  if (!task) task = await taskEngine.create(spec, taskId);
  if (task.state === "intake") {
    task = await taskEngine.setPlan(task.id, [
      {
        id: "execute-request",
        description: "Inspect, execute, and verify the user's request",
        state: "pending",
        dependsOn: [],
        requiredCapabilities: [],
      },
    ]);
  }
  send({ type: "task-state", task });
  return task;
}

async function ensureMissionTask(
  taskId: string,
  spec: TaskSpec,
  send: (event: MossEvent) => void,
): Promise<NonNullable<Awaited<ReturnType<typeof taskStore.get>>>> {
  let task = await taskStore.get(taskId);
  if (!task) task = await taskEngine.create(spec, taskId);
  send({ type: "task-state", task });
  return task;
}

/** Every model that can do a mission's work: the chat model and its routes. */
export function missionWorkerModels(req: Pick<ChatStartRequest, "config" | "routing">): string[] {
  return workerModels({ model: req.config.model, ...(req.routing ?? {}) });
}

export function resolveMissionSpec(
  spec: TaskSpec,
  policy: MissionLaunchPolicy,
  availableCapabilities: readonly string[],
  request: Pick<ChatStartRequest, "workspaceRoot" | "automation" | "verify"> & Partial<Pick<ChatStartRequest, "routing" | "config">>,
): TaskSpec {
  const available = new Set(availableCapabilities);
  const requested = policy.requestedCapabilities.map((capability) => capability.trim());
  if (requested.some((capability) => !capability)) throw new Error("Mission capabilities must be non-empty");
  if (new Set(requested).size !== requested.length) throw new Error("Mission capabilities must be unique");
  const unavailable = requested.filter((capability) => !available.has(capability));
  if (unavailable.length > 0) throw new Error(`Mission capabilities are unavailable: ${unavailable.join(", ")}`);
  buildMissionVerificationChecks(spec, request.verify);
  // A critic-bound criterion is only launched with an independent critic.
  if (spec.acceptanceCriteria.some((criterion) => criterion.verification?.kind === "critic")) {
    const critic = request.routing?.criticRoute?.model ?? request.routing?.criticModel;
    const independence = checkCriticIndependence(critic, request.config ? missionWorkerModels(request as ChatStartRequest) : []);
    if (!independence.ok) throw new Error(independence.reason);
  }

  const budget = boundMissionBudget(policy.budget);
  return {
    ...structuredClone(spec),
    ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
    budget,
    executionGrant: {
      schemaVersion: 1,
      authority: policy.authority,
      allowedCapabilities: requested,
      maxAutoApprovedRisk: policy.authority === "supervised" ? "readonly" : policy.maxAutoApprovedRisk,
      budget: structuredClone(budget),
      scopes: {
        ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
        ...(request.automation?.browserAllowedDomains?.length
          ? { browserDomains: [...request.automation.browserAllowedDomains] }
          : {}),
        ...(request.automation?.desktopAllowedProcesses?.length
          ? { desktopProcesses: [...request.automation.desktopAllowedProcesses] }
          : {}),
        ...(request.automation?.desktopAllowedWindows?.length
          ? { desktopWindows: [...request.automation.desktopAllowedWindows] }
          : {}),
      },
    },
  };
}

function boundMissionBudget(requested: TaskBudget | undefined): Required<TaskBudget> {
  return {
    maxDurationMs: boundBudgetValue(requested?.maxDurationMs, DEFAULT_MISSION_BUDGET.maxDurationMs, MAX_MISSION_BUDGET.maxDurationMs),
    maxTokens: boundBudgetValue(requested?.maxTokens, DEFAULT_MISSION_BUDGET.maxTokens, MAX_MISSION_BUDGET.maxTokens),
    maxActions: boundBudgetValue(requested?.maxActions, DEFAULT_MISSION_BUDGET.maxActions, MAX_MISSION_BUDGET.maxActions),
    maxCostUsd: boundBudgetValue(requested?.maxCostUsd, DEFAULT_MISSION_BUDGET.maxCostUsd, MAX_MISSION_BUDGET.maxCostUsd),
  };
}

function boundBudgetValue(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Mission budgets must be positive finite numbers");
  return Math.min(value, ceiling);
}

function toMissionAuthorizationRequest(
  spec: TaskSpec,
  policy: MissionLaunchPolicy,
  request: Pick<ChatStartRequest, "workspaceRoot" | "automation">,
): MissionAuthorizationRequest {
  return {
    objective: spec.objective,
    ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
    acceptanceCriteria: structuredClone(spec.acceptanceCriteria),
    constraints: [...spec.constraints],
    assumptions: [...spec.assumptions],
    policy: {
      authority: policy.authority,
      requestedCapabilities: [...policy.requestedCapabilities],
      maxAutoApprovedRisk: policy.maxAutoApprovedRisk,
      ...(policy.budget ? { budget: structuredClone(policy.budget) } : {}),
    },
    ...(request.automation ? { automation: structuredClone(request.automation) } : {}),
  };
}

async function finalizeTurnTask(
  taskId: string,
  attemptId: string,
  completion: CompletionContext | undefined,
  terminalEvent: Extract<MossEvent, { type: "turn-complete" | "turn-aborted" | "turn-error" }> | undefined,
  workspaceRoot: string,
  signal: AbortSignal,
  send: (event: MossEvent) => void,
  preserveOnAbort = false,
): Promise<void> {
  const usage = completion?.messages.reduce(
    (total, message) => ({
      inputTokens: (total.inputTokens ?? 0) + (message.usage?.inputTokens ?? 0),
      outputTokens: (total.outputTokens ?? 0) + (message.usage?.outputTokens ?? 0),
    }),
    {} as { inputTokens?: number; outputTokens?: number },
  );
  await taskEngine.recordUsage(taskId, attemptId, {
    actions: (completion?.successfulToolCalls ?? 0) + (completion?.failedToolCalls ?? 0),
    usage,
  });

  const currentTask = await taskStore.get(taskId);
  if (currentTask && ["cancelled", "failed", "completed"].includes(currentTask.state)) {
    const settled = await taskEngine.finishAttempt(taskId, attemptId, "interrupted", "Task ended before finalization");
    send({ type: "task-state", task: settled });
    return;
  }

  let task;
  if (terminalEvent?.type === "turn-complete" && completion) {
    await taskEngine.finishAttempt(taskId, attemptId, "succeeded");
    task = await taskEngine.beginVerification(taskId);
    send({ type: "task-state", task });
    const criterion = task.spec.acceptanceCriteria.find((item) => item.mandatory)!;
    const structuredEvidence = !completion.latestVerification && completion.mutations > 0 && workspaceRoot
      ? await verificationRegistry.runChecks(
          await detectWorkspaceVerificationChecks(workspaceRoot, criterion.id),
          workspaceRoot,
          signal,
        )
      : [];
    if (structuredEvidence.length > 0) {
      for (const evidence of structuredEvidence) {
        task = await taskEngine.recordEvidence(taskId, {
          id: evidence.checkId,
          criterionId: criterion.id,
          kind: evidence.kind === "command" ? "command" : "external",
          passed: false,
          summary: `Outcome unverified: generic workspace checks are not bound to this criterion. ${evidence.details ? `${evidence.summary}\n${evidence.details}` : evidence.summary}`,
          capturedAt: evidence.timestamp,
          attemptId,
        });
      }
    } else {
      task = await taskEngine.recordEvidence(taskId, {
        id: randomUUID(),
        criterionId: criterion.id,
        kind: completion.latestVerification ? "command" : "model-review",
        passed: false,
        summary: "Outcome unverified: no host-owned check is explicitly bound to this acceptance criterion. Tool success, model review, and generic verification do not prove the requested outcome.",
        capturedAt: new Date().toISOString(),
        attemptId,
      });
    }
    const currentEvidence = task.evidence.filter(
      (item) => item.criterionId === criterion.id && item.attemptId === attemptId,
    );
    const failedEvidence = currentEvidence.filter((item) => !item.passed);
    if (failedEvidence.length > 0) {
      task = await taskEngine.block(taskId, {
        kind: "verification",
        summary: failedEvidence.map((item) => item.summary).join("\n"),
        resumable: true,
        createdAt: new Date().toISOString(),
      });
    } else {
      task = await taskEngine.complete(taskId);
    }
  } else if (terminalEvent?.type === "turn-aborted") {
    task = await taskEngine.finishAttempt(
      taskId,
      attemptId,
      "interrupted",
      preserveOnAbort ? "Renderer closed during approval" : "User aborted the task",
    );
    if (!preserveOnAbort) task = await taskEngine.cancel(taskId);
  } else {
    const message = terminalEvent?.type === "turn-error" ? terminalEvent.message : "Task execution ended unexpectedly";
    await taskEngine.finishAttempt(taskId, attemptId, "failed", message);
    task = await taskEngine.block(taskId, {
      kind: "external",
      summary: message,
      resumable: true,
      createdAt: new Date().toISOString(),
    });
  }
  send({ type: "task-state", task });
  await recordTaskLearning(task, completion?.usedToolNames ?? []).catch(() => undefined);
}

async function recordTaskLearning(
  task: NonNullable<Awaited<ReturnType<typeof taskStore.get>>>,
  capabilityIds: string[],
): Promise<void> {
  const outcome = task.state === "completed" ? "completed" : task.state === "cancelled" ? "cancelled" : "blocked";
  const record = await runJournal.append({
    taskId: task.id,
    objectiveClass: task.spec.objective.slice(0, 200).trim() || "task",
    capabilityIds,
    attempts: task.attempts.map((attempt, index) => ({
      capabilityId: "agent-runner",
      attempt: index + 1,
      result: attempt.outcome === "succeeded" ? "succeeded" : outcome === "blocked" ? "blocked" : "failed",
      summary: attempt.error ?? attempt.outcome ?? "unknown",
    })),
    failures: task.attempts.filter((attempt) => attempt.error).map((attempt) => ({ category: "execution", summary: attempt.error! })),
    recoveryChoices: [],
    criteria: task.spec.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      passed: task.evidence.some((evidence) => evidence.criterionId === criterion.id && evidence.passed),
      summary: criterion.description,
    })),
    outcome,
    durationMs: Math.max(0, new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime()),
    costUsd: task.attempts.reduce((total, attempt) => total + attempt.estimatedCostUsd, 0),
    userSignals: [],
  });
  await lessonStore.merge(createRetrospective(record));
  await refreshCapabilityHistory();
}

async function refreshCapabilityHistory(): Promise<void> {
  capabilityHistoryCache = await lessonStore.capabilityHistory();
}

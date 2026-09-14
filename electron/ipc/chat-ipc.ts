// electron/ipc/chat-ipc.ts
//
// Wires renderer requests to the agent runner. One AbortController + one
// ApprovalBroker per in-flight turn.

import { randomUUID } from "node:crypto";

import { clipboard, dialog, ipcMain, shell } from "electron";

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
  MissionLaunchPolicy,
  MossEvent,
  SkillCreateRequest,
  SkillUpdateRequest,
  SkillRenameRequest,
  TaskSnapshot,
  TaskBudget,
  TaskSpec,
  ToolApprovalDecision,
  TranscribeRequest,
  TranscribeResult,
} from "../../common/types";
import { runTurn } from "../backend/moss/agent-runner";
import type { CompletionContext } from "../backend/moss/agent-runner";
import { ApprovalBroker } from "../backend/moss/approval-broker";
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
import { RunJournal } from "../backend/moss/learning/run-journal";
import { createRetrospective } from "../backend/moss/learning/retrospective";
import { LessonStore } from "../backend/moss/learning/lesson-store";
import { memoryStore } from "../backend/moss/memory/memory-store";
import { memoryReviewQueue } from "../backend/moss/governed/review-queue";
import { providerCredentials } from "../backend/moss/provider-credentials";
import { createProvider } from "../backend/moss/providers";
import { skillsStore } from "../backend/moss/skills/skills-store";
import { transcribeAudio } from "../backend/moss/stt";
import { buildSystemMessage } from "../backend/moss/system-prompt";
import { classifyTool } from "../backend/moss/permission";
import { MissionAuthorityBroker, validateMissionAuthorizationRequest } from "../backend/moss/task/mission-authority";
import { MissionController } from "../backend/moss/task/mission-controller";
import { MissionPlanner } from "../backend/moss/task/mission-planner";
import { taskArtifactStore } from "../backend/moss/task/task-artifact-store";
import { taskEngine } from "../backend/moss/task/task-engine";
import { WorkspaceMissionVerifier } from "../backend/moss/task/mission-verifier";
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

export function resolveMaxToolRounds(requested: number | undefined, verifyEnabled: boolean): number {
  const configured = Number.isFinite(requested) ? Math.floor(requested as number) : DEFAULT_TOOL_ROUNDS;
  const withVerificationRoom = verifyEnabled ? Math.max(12, configured) : configured;
  return Math.min(MAX_TOOL_ROUNDS, Math.max(1, withVerificationRoom));
}
import { taskStore } from "../backend/moss/task/task-store";
import { TOOL_DEFINITIONS, TOOL_REGISTRY } from "../backend/moss/tools";
import { detectWorkspaceVerificationChecks, VerificationRegistry } from "../backend/moss/verify/verification-registry";
import { runVerify } from "../backend/moss/verify/verifier";

interface Inflight {
  controller: AbortController;
  broker: ApprovalBroker;
  taskId?: string;
  send: (event: MossEvent) => void;
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
let bundledCapabilityTools: ReturnType<typeof createBundledCapabilityTools> | undefined;
let capabilityHistoryCache = new Map<string, { successCount: number; failureCount: number }>();

export function registerChatIpc(): void {
  void refreshCapabilityHistory();
  ipcMain.on(IPC.chatStart, (event, req: ChatStartRequest) => {
    void startTurn(event, req);
  });

  ipcMain.on(IPC.chatAbort, (_event, turnId: string) => {
    const entry = inflight.get(turnId);
    if (entry) {
      entry.controller.abort();
      if (entry.taskId) {
        void taskEngine
          .resolveApproval(entry.taskId, entry.broker.pendingCallId() ?? "", false, "Turn aborted")
          .then((task) => entry.send({ type: "task-state", task }))
          .catch(() => undefined)
          .finally(() => entry.broker.denyAll("Turn aborted"));
      } else {
        entry.broker.denyAll("Turn aborted");
      }
    }
  });

  ipcMain.handle(IPC.missionAuthorize, async (_event, request: MissionAuthorizationRequest) => {
    validateMissionAuthorizationRequest(request);
    const budget = request.policy.budget;
    const detail = [
      `Objective: ${request.objective.trim().slice(0, 200)}`,
      `Workspace: ${request.workspaceRoot?.trim() || "No filesystem scope"}`,
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
  ipcMain.handle(IPC.taskStart, (_event, id: string) => taskEngine.start(id));
  ipcMain.handle(IPC.taskPause, (_event, id: string, summary: string) => taskEngine.pause(id, summary));
  ipcMain.handle(IPC.taskResume, (_event, id: string) => taskEngine.start(id));
  ipcMain.handle(IPC.taskCancel, (_event, id: string) => taskEngine.cancel(id));

  ipcMain.handle(IPC.providerListModels, async (_event, config: ChatStartRequest["config"]) => {
    const provider = createProvider(config);
    return provider.listModels();
  });
  ipcMain.handle(IPC.providerCredentialGet, (_event, providerId: string) => providerCredentials.get(providerId));
  ipcMain.handle(IPC.providerCredentialSet, (_event, providerId: string, apiKey: string) => {
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

  ipcMain.handle(IPC.skillsList, () => skillsStore.list());
  ipcMain.handle(IPC.skillCreate, (_event, req: SkillCreateRequest) =>
    skillsStore.create(req.name, req.description, req.instructions),
  );
  ipcMain.handle(IPC.skillDelete, (_event, id: string) => skillsStore.delete(id));
  ipcMain.handle(IPC.skillToggle, (_event, id: string, enabled: boolean) => {
    skillsStore.setEnabled(id, enabled);
  });
  ipcMain.handle(IPC.skillUpdate, (_event, req: SkillUpdateRequest) =>
    skillsStore.update(req.id, req.description, req.instructions),
  );
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
  ipcMain.handle(IPC.mcpAddServer, async (_event, config: McpServerConfig) => {
    if (addMcpServer(config)) await mcpManager.reconnect(config.id);
    return mcpManager.getStatus();
  });
  ipcMain.handle(IPC.mcpUpdateServer, async (_event, config: McpServerConfig) => {
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
  const controller = new AbortController();
  const broker = new ApprovalBroker();
  const durableTaskId = req.taskSpec ? req.taskId ?? req.turnId : undefined;
  let preserveTaskOnAbort = false;
  let rendererUnavailable = false;
  let pendingDurableApproval: { callId: string; persisted: Promise<TaskSnapshot> } | undefined;

  let terminalEvent: Extract<MossEvent, { type: "turn-complete" | "turn-aborted" | "turn-error" }> | undefined;
  const approvalEvents = new Map<string, Extract<MossEvent, { type: "tool-approval-request" }>>();
  const send = (mossEvent: MossEvent) => {
    if (mossEvent.type === "turn-complete" || mossEvent.type === "turn-aborted" || mossEvent.type === "turn-error") {
      terminalEvent = mossEvent;
    }
    if (mossEvent.type === "tool-approval-request") approvalEvents.set(mossEvent.callId, mossEvent);
    if (!rendererUnavailable && !event.sender.isDestroyed()) {
      event.sender.send(IPC.chatEvent, { turnId: req.turnId, event: mossEvent });
    }
  };
  const inflightEntry = { controller, broker, send, ...(durableTaskId ? { taskId: durableTaskId } : {}) };
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
    const baseProvider = createProvider(req.config);
    // Attach the daily-budget guard only when the user set a positive cap, so
    // the default path is the bare provider with no behavior change.
    const provider =
      req.dailyBudgetUsd && req.dailyBudgetUsd > 0
        ? new BudgetEnforcingProvider(baseProvider, req.dailyBudgetUsd, req.modelRates)
        : baseProvider;
    const enableTools = req.enableTools !== false;
    const routed = enableTools
      ? routeAvailableTools(req)
      : { tools: [], unmet: [] };
    const toolDefinitions = enableTools
      ? routed.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      : [];
    const toolRegistry = new Map(routed.tools.map((tool) => [tool.name, tool]));
    // Prepend a fresh system message (base instructions + skills index + memory)
    // unless the renderer already supplied one. The latest user message drives
    // query-aware memory selection.
    const hasSystem = req.messages.some((m) => m.role === "system");
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const messages = hasSystem
      ? req.messages
      : [buildSystemMessage({ includeSkills: enableTools, query: lastUser?.content ?? "", customInstructions: req.customInstructions, personalityId: req.personalityId, adaptiveTone: req.adaptiveTone }), ...req.messages];
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
    if (!storedTask && req.taskSpec?.executionGrant && !req.mission) {
      throw new Error("Mission execution grants must be issued by Electron from a mission launch policy");
    }
    if (!storedTask && req.taskSpec && req.mission?.authority === "policy-scoped") {
      const token = req.mission.authorizationToken;
      if (!token) throw new Error("Policy-scoped mission requires native authorization");
      missionAuthority.consume(toMissionAuthorizationRequest(req.taskSpec.objective, req.mission, req), token);
    }
    const requestedSpec = storedTask?.spec ?? (req.taskSpec && req.mission
      ? resolveMissionSpec(req.taskSpec, req.mission, routed.tools.map((tool) => tool.name), req)
      : req.taskSpec);
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
      const planner = new MissionPlanner({
        provider,
        model: req.config.model,
        capabilities,
        ...(task.spec.budget?.maxTokens
          ? { maxTokens: Math.max(1, Math.floor(task.spec.budget.maxTokens / 2)) }
          : {}),
      });
      const worker = new RunTurnMissionWorker({
        provider,
        model: req.config.model,
        tools: routed.tools,
        workspaceRoot,
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
        requestApproval: async (callId, order) => {
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
            return await broker.request(callId);
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
        verifier: new WorkspaceMissionVerifier({ workspaceRoot }),
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
    await runTurn({
      provider,
      model: req.config.model,
      messages,
      tools: toolDefinitions,
      toolRegistry,
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
          return await broker.request(callId);
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
    event.sender.removeListener("destroyed", handleRendererDestroyed);
    event.sender.removeListener("render-process-gone", handleRendererDestroyed);
    event.sender.removeListener("did-start-navigation", handleRendererNavigation);
    if (inflight.get(req.turnId) === inflightEntry) inflight.delete(req.turnId);
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

export function resolveMissionSpec(
  spec: TaskSpec,
  policy: MissionLaunchPolicy,
  availableCapabilities: readonly string[],
  request: Pick<ChatStartRequest, "workspaceRoot" | "automation">,
): TaskSpec {
  const available = new Set(availableCapabilities);
  const requested = policy.requestedCapabilities.map((capability) => capability.trim());
  if (requested.some((capability) => !capability)) throw new Error("Mission capabilities must be non-empty");
  if (new Set(requested).size !== requested.length) throw new Error("Mission capabilities must be unique");
  const unavailable = requested.filter((capability) => !available.has(capability));
  if (unavailable.length > 0) throw new Error(`Mission capabilities are unavailable: ${unavailable.join(", ")}`);

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
  objective: string,
  policy: MissionLaunchPolicy,
  request: Pick<ChatStartRequest, "workspaceRoot" | "automation">,
): MissionAuthorizationRequest {
  return {
    objective,
    ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
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

  let task;
  if (terminalEvent?.type === "turn-complete" && completion) {
    task = await taskEngine.finishAttempt(taskId, attemptId, "succeeded");
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
          passed: evidence.ok,
          summary: evidence.details ? `${evidence.summary}\n${evidence.details}` : evidence.summary,
          capturedAt: evidence.timestamp,
          attemptId,
        });
      }
    } else {
      task = await taskEngine.recordEvidence(taskId, {
        id: randomUUID(),
        criterionId: criterion.id,
        kind: completion.latestVerification ? "command" : "model-review",
        passed: completion.latestVerification?.ok ?? completion.failedToolCalls === 0,
        summary: completion.latestVerification
          ? "Configured verification completed"
          : completion.mutations > 0
            ? "No deterministic workspace verification command was available; completion passed model review"
            : "Non-mutating task completed without tool or verification failures",
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

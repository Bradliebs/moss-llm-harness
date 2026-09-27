// electron/ipc/chat-ipc.e2e.test.ts
//
// End-to-end smoke for the chat IPC turn path. A chatStart message drives the
// REAL agent runner (via the registered ipcMain handler) against a scripted
// provider, and the resulting MossEvents must stream back over
// event.sender.send wrapped as { turnId, event }.
//
// This covers the startTurn integration that the sibling unit tests do not:
//   - agent-runner.test.ts exercises the loop, but never through IPC.
//   - chat-ipc.test.ts checks channel *registration*, but never runs a turn.
// Here we verify provider wiring, event fan-out tagged with the turn id, the
// approval-broker <-> toolApprove bridge, and turn-error propagation.

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../../common/ipc-contract";
import type { ChatEventPayload, ChatStartRequest, ModelPerformanceEntry, Procedure } from "../../common/types";
import type { ChatProvider, ProviderStreamEvent } from "../backend/moss/providers/types";

// Recording ipcMain so the test can invoke the registered channel handlers.
const recorded = vi.hoisted(() => ({
  on: new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>(),
}));

// The provider returned by createProvider; each test scripts it before starting.
const mockProviderRef = vi.hoisted(() => ({
  current: null as ChatProvider | null,
  /** optional per-connection providers, for routes on different providers */
  factory: undefined as ((config: { kind?: string; baseUrl?: string; model: string; apiKey?: string }) => ChatProvider) | undefined,
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppPath: () => "/app" },
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => unknown) => recorded.on.set(channel, fn),
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => recorded.handle.set(channel, fn),
  },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openPath: vi.fn() },
}));

vi.mock("../backend/moss/providers", () => ({
  createProvider: (config: { kind?: string; baseUrl?: string; model: string; apiKey?: string }) => mockProviderRef.factory?.(config) ?? mockProviderRef.current,
}));

vi.mock("../backend/moss/mcp/mcp-manager", () => ({
  mcpManager: { getTools: () => [], getStatus: () => [] },
}));

import { registerChatIpc } from "./chat-ipc";
import { taskStore } from "../backend/moss/task/task-store";
import { taskEngine } from "../backend/moss/task/task-engine";
import { providerCredentials } from "../backend/moss/provider-credentials";
import { modelProfileStore } from "../backend/moss/models/model-profile-store";
import { traceStore } from "../backend/moss/models/trace-recorder";
import { semanticIndex } from "../backend/moss/models/tool-index";
import { modelPerformanceStore } from "../backend/moss/models/model-performance";
import { procedureStore } from "../backend/moss/learning/procedure-store";
import { skillLedger } from "../backend/moss/skills/skill-ledger";
import { skillsStore } from "../backend/moss/skills/skills-store";

function scriptedProvider(rounds: ProviderStreamEvent[][]): ChatProvider {
  let round = 0;
  return {
    kind: "test",
    async *streamChat(): AsyncIterable<ProviderStreamEvent> {
      const events = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      for (const e of events) yield e;
    },
    async listModels() {
      return [];
    },
  };
}

function throwingProvider(message: string): ChatProvider {
  return {
    kind: "test",
    // eslint-disable-next-line require-yield
    async *streamChat(): AsyncIterable<ProviderStreamEvent> {
      throw new Error(message);
    },
    async listModels() {
      return [];
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeEvent(sent: ChatEventPayload[]): Electron.IpcMainEvent {
  const sender = new EventEmitter() as EventEmitter & {
    isDestroyed: () => boolean;
    send: (channel: string, payload: ChatEventPayload) => void;
  };
  sender.isDestroyed = () => false;
  sender.send = (channel, payload) => {
    if (channel === IPC.chatEvent) sent.push(payload);
  };
  return { sender } as unknown as Electron.IpcMainEvent;
}

function lifecycleEvent(sent: ChatEventPayload[]): { event: Electron.IpcMainEvent; destroy: () => void } {
  let destroyed = false;
  const sender = new EventEmitter() as EventEmitter & {
    isDestroyed: () => boolean;
    send: (channel: string, payload: ChatEventPayload) => void;
  };
  sender.isDestroyed = () => destroyed;
  sender.send = (channel, payload) => {
    if (channel === IPC.chatEvent) sent.push(payload);
  };
  return {
    event: { sender } as unknown as Electron.IpcMainEvent,
    destroy: () => {
      destroyed = true;
      sender.emit("destroyed");
    },
  };
}

function request(overrides: Partial<ChatStartRequest> = {}): ChatStartRequest {
  return {
    turnId: "t1",
    config: { model: "test-model" },
    // A supplied system message short-circuits buildSystemMessage, keeping the
    // turn hermetic (no memory/skills store reads during the turn).
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    enableTools: false,
    modelRates: { "test-model": { inputPer1M: 0, outputPer1M: 0 } },
    ...overrides,
  } as ChatStartRequest;
}

const performanceEntries: ModelPerformanceEntry[] = [];
const offeredProcedures: Procedure[] = [];

describe("chat IPC turn (e2e)", () => {
  beforeEach(() => {
    recorded.on.clear();
    recorded.handle.clear();
    mockProviderRef.current = null;
    mockProviderRef.factory = undefined;
    // Live scores persist across turns; keep each test independent.
    performanceEntries.length = 0;
    vi.spyOn(modelPerformanceStore, "list").mockImplementation(async () => [...performanceEntries]);
    vi.spyOn(modelPerformanceStore, "record").mockResolvedValue(undefined);
    vi.spyOn(procedureStore, "offered").mockImplementation(async () => [...offeredProcedures]);
    vi.spyOn(procedureStore, "observe").mockResolvedValue(undefined);
    vi.spyOn(procedureStore, "recordOutcome").mockResolvedValue(undefined);
    offeredProcedures.length = 0;
    registerChatIpc();
  });

  it("streams a text turn back over IPC, every event tagged with the turn id", async () => {
    mockProviderRef.current = scriptedProvider([
      [
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " world" },
      ],
    ]);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request());
    await tick();

    expect(sent
      .filter((payload) => payload.event.type !== "round-start" && payload.event.type !== "round-end")
      .map((payload) => payload.event.type)).toEqual(["text-delta", "text-delta", "turn-complete"]);
    expect(sent.every((p) => p.turnId === "t1")).toBe(true);
  });

  it.each([undefined, false, true])("advertises Jev only when explicitly enabled: %s", async (jevEnabled) => {
    let names: string[] = [];
    mockProviderRef.current = {
      kind: "test",
      async *streamChat(input) {
        names = (input.tools ?? []).map((tool) => tool.name);
        yield { type: "text-delta", text: "done" };
      },
      async listModels() { return []; },
    };
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true, jevEnabled }));
    await tick();
    expect(names.includes("jev_evaluate")).toBe(jevEnabled === true);
  });

  it("does not register Jev when the tools master switch is off", async () => {
    let names: string[] = [];
    mockProviderRef.current = {
      kind: "test",
      async *streamChat(input) {
        names = (input.tools ?? []).map((tool) => tool.name);
        yield { type: "text-delta", text: "done" };
      },
      async listModels() { return []; },
    };
    recorded.on.get(IPC.chatStart)!(fakeEvent([]), request({ enableTools: false, jevEnabled: true }));
    await tick();
    expect(names).not.toContain("jev_evaluate");
  });

  it.each([false, true])("never sends Jev data for a disabled or denied call (enabled=%s)", async (jevEnabled) => {
    const key = vi.spyOn(providerCredentials, "get");
    mockProviderRef.current = scriptedProvider([
      [{ type: "tool-call", toolCall: { id: "jev-call", name: "jev_evaluate", arguments: JSON.stringify({ state: "text", question: "Question?", type: "noul" }) } }],
      [{ type: "text-delta", text: "done" }],
    ]);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true, jevEnabled, autoApproveTools: true }));
    await tick();
    if (jevEnabled) {
      expect(sent.some((payload) => payload.event.type === "tool-approval-request")).toBe(true);
      recorded.on.get(IPC.toolApprove)!(null, { turnId: "t1", callId: "jev-call", approved: false });
    }
    await tick();
    expect(sent.some((payload) => payload.event.type === "turn-complete")).toBe(true);
    expect(key).not.toHaveBeenCalled();
    key.mockRestore();
  });

  it("bridges the approval broker: a gated tool waits for toolApprove and is denied", async () => {
    mockProviderRef.current = scriptedProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{\"path\":\"notes.txt\",\"content\":\"x\"}" } }],
      [{ type: "text-delta", text: "ok" }],
    ]);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true }));
    await tick();

    // The turn pauses on the gated write_file call until the renderer answers.
    expect(sent.find((p) => p.event.type === "tool-approval-request")).toBeDefined();
    expect(sent.find((p) => p.event.type === "tool-result")).toBeUndefined();

    recorded.on.get(IPC.toolApprove)!(null, { turnId: "t1", callId: "c1", approved: false });
    await tick();

    const result = sent.find((p) => p.event.type === "tool-result");
    expect(result).toBeDefined();
    const ev = result!.event as { ok: boolean; content: string };
    expect(ev.ok).toBe(false);
    expect(ev.content).toContain("User denied");
    // The turn still completes after the denied tool round.
    expect(sent.at(-1)!.event.type).toBe("turn-complete");
  });

  it("persists a durable task decision before releasing the gated tool", async () => {
    const taskId = `approval-${crypto.randomUUID()}`;
    mockProviderRef.current = scriptedProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{\"path\":\"notes.txt\",\"content\":\"x\"}" } }],
      [{ type: "text-delta", text: "ok" }],
    ]);
    const sent: ChatEventPayload[] = [];

    try {
      recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({
        enableTools: true,
        maxToolRounds: 2,
        taskId,
        taskSpec: {
          objective: "Exercise durable approval",
          acceptanceCriteria: [{ id: "done", description: "The decision is recorded", mandatory: true }],
          constraints: [],
          assumptions: [],
        },
      }));

      await vi.waitFor(() => {
        expect(sent.some((payload) =>
          payload.event.type === "task-state"
          && payload.event.task.approval?.status === "pending"
        )).toBe(true);
      });
      expect(sent.find((payload) => payload.event.type === "tool-result")).toBeUndefined();
      expect((await taskStore.get(taskId))?.approval).toMatchObject({
        turnId: "t1",
        callId: "c1",
        toolName: "write_file",
        status: "pending",
      });

      recorded.on.get(IPC.toolApprove)!(null, {
        turnId: "t1",
        callId: "c1",
        approved: false,
        comment: "Not for this task",
      });

      await vi.waitFor(() => {
        expect(sent.some((payload) => payload.event.type === "tool-result")).toBe(true);
      });
      const pendingIndex = sent.findIndex((payload) =>
        payload.event.type === "task-state" && payload.event.task.approval?.status === "pending"
      );
      const deniedIndex = sent.findIndex((payload) =>
        payload.event.type === "task-state" && payload.event.task.approval?.status === "denied"
      );
      const resultIndex = sent.findIndex((payload) => payload.event.type === "tool-result");
      expect(pendingIndex).toBeGreaterThanOrEqual(0);
      expect(deniedIndex).toBeGreaterThan(pendingIndex);
      expect(resultIndex).toBeGreaterThan(deniedIndex);
      expect((sent[resultIndex].event as { content: string }).content).toContain("Not for this task");
      expect((await taskStore.get(taskId))?.approval).toMatchObject({
        callId: "c1",
        status: "denied",
        comment: "Not for this task",
      });
    } finally {
      recorded.on.get(IPC.chatAbort)!(null, "t1");
      await vi.waitFor(() => {
        expect(sent.some((payload) =>
          payload.event.type === "turn-aborted" || payload.event.type === "turn-error"
        )).toBe(true);
      });
      await taskStore.delete(taskId);
    }
  });

  it("routes explicitly granted durable tasks through mission planning", async () => {
    const taskId = `mission-${crypto.randomUUID()}`;
    mockProviderRef.current = scriptedProvider([[
      {
        type: "tool-call",
        toolCall: {
          id: "plan-1",
          name: "submit_mission_plan",
          arguments: JSON.stringify({ userDecision: { summary: "Choose the deployment target" } }),
        },
      },
    ]]);
    const sent: ChatEventPayload[] = [];

    try {
      recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({
        taskId,
        taskSpec: {
          objective: "Prepare a deployment",
          acceptanceCriteria: [{
            id: "ready",
            description: "Deployment is ready",
            mandatory: true,
            verification: { kind: "http", url: "http://127.0.0.1/deployment-ready" },
          }],
          constraints: [],
          assumptions: [],
        },
        mission: {
          authority: "supervised",
          requestedCapabilities: [],
          maxAutoApprovedRisk: "readonly",
        },
      }));

      await vi.waitFor(() => {
        expect(sent.some((payload) => payload.event.type === "turn-complete")).toBe(true);
      });
      expect(await taskStore.get(taskId)).toMatchObject({
        state: "blocked",
        blocker: { kind: "user-decision", summary: "Choose the deployment target" },
        steps: [],
      });
      expect(sent.some((payload) =>
        payload.event.type === "task-state" && payload.event.task.blocker?.kind === "user-decision"
      )).toBe(true);
    } finally {
      await taskStore.delete(taskId);
    }
  });

  it("completes a mission only from an explicitly bound passing project test", async () => {
    const taskId = `mission-complete-${crypto.randomUUID()}`;
    const workspaceRoot = mkdtempSync(join(tmpdir(), "moss-mission-ipc-"));
    writeFileSync(join(workspaceRoot, "package.json"), JSON.stringify({
      scripts: { test: "node -e \"process.exit(0)\"" },
    }), "utf8");
    const plan = {
      schemaVersion: 1,
      revision: 1,
      steps: [{
        id: "verify",
        description: "Inspect and verify the workspace",
        state: "pending",
        dependsOn: [],
        requiredCapabilities: ["read_file"],
        mission: {
          kind: "verify",
          workerRole: "verifier",
          executionLane: "readonly-parallel",
          acceptanceCriterionIds: ["tests"],
          budget: { maxDurationMs: 15 * 60 * 1000, maxTokens: 50_000, maxActions: 1, maxCostUsd: 5 },
          expectedArtifacts: ["report"],
        },
      }],
    };
    mockProviderRef.current = scriptedProvider([
      [{
        type: "tool-call",
        toolCall: { id: "plan-1", name: "submit_mission_plan", arguments: JSON.stringify({ plan }) },
      }, { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } }],
      [{
        type: "tool-call",
        toolCall: { id: "read-1", name: "read_file", arguments: JSON.stringify({ path: "package.json" }) },
      }, { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } }],
      [{ type: "text-delta", text: "Workspace inspection completed." }, { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } }],
    ]);
    const sent: ChatEventPayload[] = [];

    try {
      recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({
        enableTools: true,
        workspaceRoot,
        taskId,
        taskSpec: {
          objective: "Inspect and verify the workspace",
          acceptanceCriteria: [{
            id: "tests",
            description: "Tests pass",
            mandatory: true,
            verification: { kind: "commands", commands: ["npm test"] },
          }],
          constraints: [],
          assumptions: [],
          workspaceRoot,
        },
        verify: { enabled: true, commands: ["npm test"] },
        mission: {
          authority: "supervised",
          requestedCapabilities: ["read_file"],
          maxAutoApprovedRisk: "readonly",
          budget: { maxActions: 2 },
        },
      }));

      await vi.waitFor(() => {
        expect(sent.some((payload) =>
          payload.event.type === "turn-complete" || payload.event.type === "turn-error"
        )).toBe(true);
      }, { timeout: 15_000 });
      expect(sent.find((payload) => payload.event.type === "turn-error")?.event).toBeUndefined();
      expect(await taskStore.get(taskId)).toMatchObject({
        state: "completed",
        steps: [{ id: "verify", state: "completed" }],
        evidence: [{ criterionId: "tests", passed: true, kind: "command" }],
      });
      expect(sent.some((payload) => payload.event.type === "tool-result" && payload.event.name === "read_file")).toBe(true);
    } finally {
      await taskStore.delete(taskId);
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("settles Stop while durable approval persistence is still pending", async () => {
    const taskId = `approval-race-${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = taskEngine.requestApproval.bind(taskEngine);
    const persistence = vi.spyOn(taskEngine, "requestApproval").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    mockProviderRef.current = scriptedProvider([[{ type: "tool-call", toolCall: { id: "late", name: "write_file", arguments: "{\"path\":\"notes.txt\",\"content\":\"x\"}" } }]]);
    const sent: ChatEventPayload[] = [];
    const event = fakeEvent(sent);
    try {
      recorded.on.get(IPC.chatStart)!(event, request({ enableTools: true, taskId, taskSpec: {
        objective: "Stop during persistence", acceptanceCriteria: [{ id: "done", description: "No mutation", mandatory: true }], constraints: [], assumptions: [],
      } }));
      await vi.waitFor(() => expect(persistence).toHaveBeenCalledOnce());
      recorded.on.get(IPC.chatAbort)!(null, "t1");
      release();
      await vi.waitFor(() => expect(event.sender.listenerCount("destroyed")).toBe(0));
      expect(sent.some((payload) => payload.event.type === "turn-aborted")).toBe(true);
      expect((await taskStore.get(taskId))?.state).toBe("cancelled");
      expect(sent.some((payload) => payload.event.type === "tool-result" && payload.event.ok)).toBe(false);
    } finally {
      release();
      persistence.mockRestore();
      recorded.on.get(IPC.chatAbort)!(null, "t1");
      await taskStore.delete(taskId);
    }
  });

  it("task Cancel aborts the active provider before returning cancelled state", async () => {
    const taskId = `cancel-active-${crypto.randomUUID()}`;
    let activeSignal: AbortSignal | undefined;
    mockProviderRef.current = {
      kind: "fixture", listModels: async () => [],
      async *streamChat(_request, signal) {
        activeSignal = signal;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      },
    };
    const sent: ChatEventPayload[] = [];
    const event = fakeEvent(sent);
    try {
      recorded.on.get(IPC.chatStart)!(event, request({ taskId, taskSpec: {
        objective: "Cancel live work", acceptanceCriteria: [{ id: "done", description: "Stopped", mandatory: true }], constraints: [], assumptions: [],
      } }));
      await vi.waitFor(() => expect(activeSignal).toBeDefined());
      await recorded.handle.get(IPC.taskCancel)!(null, taskId);
      expect(activeSignal?.aborted).toBe(true);
      await vi.waitFor(() => expect(event.sender.listenerCount("destroyed")).toBe(0));
      expect((await taskStore.get(taskId))?.state).toBe("cancelled");
      expect(sent.some((payload) => payload.event.type === "turn-error")).toBe(false);
    } finally {
      recorded.on.get(IPC.chatAbort)!(null, "t1");
      await taskStore.delete(taskId);
    }
  });

  it.each(["destroyed", "reload", "crashed"])("interrupts a pending durable approval when the renderer is %s", async (reason) => {
    const taskId = `renderer-loss-${crypto.randomUUID()}`;
    mockProviderRef.current = scriptedProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{\"path\":\"notes.txt\",\"content\":\"x\"}" } }],
    ]);
    const sent: ChatEventPayload[] = [];
    const lifecycle = lifecycleEvent(sent);

    try {
      recorded.on.get(IPC.chatStart)!(lifecycle.event, request({
        enableTools: true,
        taskId,
        taskSpec: {
          objective: "Survive renderer loss",
          acceptanceCriteria: [{ id: "done", description: "The call is not replayed", mandatory: true }],
          constraints: [],
          assumptions: [],
        },
      }));
      await vi.waitFor(async () => {
        expect((await taskStore.get(taskId))?.approval?.status).toBe("pending");
      });

      lifecycle.event.sender.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
      lifecycle.event.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      await tick();
      expect((await taskStore.get(taskId))?.approval?.status).toBe("pending");

      if (reason === "destroyed") lifecycle.destroy();
      else if (reason === "reload") lifecycle.event.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      else lifecycle.event.sender.emit("render-process-gone", {}, { reason: "crashed" });
      lifecycle.event.sender.emit("render-process-gone", {}, { reason: "killed" });

      await vi.waitFor(async () => {
        expect(await taskStore.get(taskId)).toMatchObject({
          state: "paused",
          approval: { callId: "c1", status: "interrupted" },
        });
      }, { timeout: 10_000 });
      await vi.waitFor(() => {
        for (const name of ["destroyed", "render-process-gone", "did-start-navigation"]) {
          expect(lifecycle.event.sender.listenerCount(name)).toBe(0);
        }
      });
    } finally {
      recorded.on.get(IPC.chatAbort)!(null, "t1");
      await taskStore.delete(taskId);
    }
  }, 15_000);

  it("forwards auto-approved provenance on the tool-result event", async () => {
    mockProviderRef.current = scriptedProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{\"path\":\"notes.txt\",\"content\":\"x\"}" } }],
      [{ type: "text-delta", text: "ok" }],
    ]);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true, autoApproveTools: true }));
    await tick();

    // Auto-approve skips the renderer prompt and the gate's provenance must
    // survive the main -> renderer forward.
    expect(sent.find((p) => p.event.type === "tool-approval-request")).toBeUndefined();
    const result = sent.find((p) => p.event.type === "tool-result");
    expect(result).toBeDefined();
    expect((result!.event as { autoApproved: boolean }).autoApproved).toBe(true);
    expect((result!.event as { risk?: string }).risk).toBe("mutating");
  });

  it("escalates to the stronger model after harness rejections and records the trace", async () => {
    const models: string[] = [];
    let round = 0;
    mockProviderRef.current = {
      kind: "test",
      async *streamChat(input) {
        models.push(input.model);
        round += 1;
        if (round > 1) yield { type: "text-delta", text: "done" };
      },
      async listModels() { return []; },
    };
    const save = vi.spyOn(traceStore, "save").mockResolvedValue(undefined);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({
      routing: { escalationModel: "strong-model", escalateAfter: 1 },
      recordTrace: true,
    }));
    await vi.waitFor(() => expect(sent.map((payload) => payload.event.type === "notice" ? `notice:${payload.event.message}` : payload.event.type)).toContain("turn-complete"));
    expect(models).toEqual(["test-model", "strong-model"]);
    expect(sent.some((payload) => payload.event.type === "notice" && /Escalating to strong-model after 1 rejected attempt by test-model/.test(payload.event.message))).toBe(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const trace = save.mock.calls[0][0];
    expect(trace).toMatchObject({ id: "t1", primaryModel: "test-model", escalatedTo: "strong-model", outcome: "completed" });
    expect(trace.calls.map((call) => call.model)).toEqual(["test-model", "strong-model"]);
    save.mockRestore();
  });

  it("escalates a local model to a cloud route on another provider with its stored key and a notice", async () => {
    const configs: Array<{ kind?: string; baseUrl?: string; model: string; apiKey?: string }> = [];
    mockProviderRef.factory = (config) => {
      configs.push(config);
      return {
        kind: config.kind ?? "test",
        async *streamChat() {
          // The local model returns an empty completion, which the harness rejects.
          if (config.kind === "anthropic") yield { type: "text-delta", text: "fixed by cloud" };
        },
        async listModels() { return []; },
      };
    };
    const key = vi.spyOn(providerCredentials, "get").mockImplementation((id) => id === "anthropic" ? "sk-cloud" : "");
    const save = vi.spyOn(traceStore, "save").mockResolvedValue(undefined);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({
      config: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama-local" },
      routing: { escalationRoute: { presetId: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-x" }, escalateAfter: 1 },
      recordTrace: true,
      modelRates: {},
    }));
    await vi.waitFor(() => expect(sent.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    expect(configs).toContainEqual({ kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: "sk-cloud" });
    const notice = sent.find((payload) => payload.event.type === "notice" && /Escalating to claude-x/.test(payload.event.message));
    expect((notice?.event as { message: string }).message).toContain("This sends the conversation and workspace context to api.anthropic.com.");
    expect(sent.some((payload) => payload.event.type === "text-delta" && payload.event.text === "fixed by cloud")).toBe(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const trace = save.mock.calls[0][0];
    expect(trace).toMatchObject({ primaryModel: "llama-local", escalatedTo: "claude-x" });
    expect(trace.calls.map((call) => [call.model, call.providerKind, call.endpoint])).toEqual([
      ["llama-local", "openai-compatible", "http://localhost:11434/v1"],
      ["claude-x", "anthropic", "https://api.anthropic.com"],
    ]);
    key.mockRestore();
    save.mockRestore();
  });

  it("sends a limited model constrained steps and turns the step back into the answer", async () => {
    const requests: Array<{ tools?: unknown[]; responseSchema?: unknown }> = [];
    mockProviderRef.current = {
      kind: "openai-compatible",
      async *streamChat(input) {
        requests.push({ tools: input.tools, responseSchema: input.responseSchema });
        yield { type: "text-delta", text: input.responseSchema ? "{\"action\":\"final\",\"answer\":\"All done.\"}" : "plain" };
      },
      async listModels() { return []; },
    };
    const get = vi.spyOn(modelProfileStore, "get").mockResolvedValue({
      schemaVersion: 1, suiteVersion: "1", providerKind: "openai-compatible", endpoint: "http://localhost:11434/v1", model: "tiny",
      probedAt: "2026-09-26T00:00:00.000Z", durationMs: 1, maxContextTested: 1024, results: [], overall: 0.3, tier: "unreliable",
      usage: {}, failedRequests: 0,
      recommendation: { scaffolding: "heavy", toolUse: "avoid", structuredOutput: "repair", settings: {}, notes: [] },
    });
    const sent: ChatEventPayload[] = [];
    const config = { kind: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1", model: "tiny" };
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ config, enableTools: true, workspaceRoot: "" }));
    await vi.waitFor(() => expect(sent.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    expect(requests[0].responseSchema).toBeDefined();
    expect(requests[0].tools).toBeUndefined();
    expect(sent.some((payload) => payload.event.type === "notice" && /Using constrained tool output for tiny/.test(payload.event.message))).toBe(true);
    expect(sent.filter((payload) => payload.event.type === "text-delta").map((payload) => (payload.event as { text: string }).text).join("")).toBe("All done.");

    // A limited model whose replies are fast also votes on each step.
    expect(sent.some((payload) => payload.event.type === "harness-decision" && payload.event.decision.kind === "vote")).toBe(false);
    get.mockResolvedValueOnce({ ...(await get.getMockImplementation()!("openai-compatible", "", ""))!, latency: { medianMs: 900, p90Ms: 1_200 } });
    requests.length = 0;
    const voting: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(voting), request({ turnId: "tv", config, enableTools: true, workspaceRoot: "" }));
    await vi.waitFor(() => expect(voting.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    expect(requests.filter((item) => item.responseSchema)).toHaveLength(3);
    expect(voting.some((payload) => payload.event.type === "notice" && /Voting on each step for tiny: 3 constrained samples/.test(payload.event.message))).toBe(true);

    // An explicit "never" keeps native tool calling.
    requests.length = 0;
    const second: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(second), request({ turnId: "t2", config, enableTools: true, workspaceRoot: "", constrainedOutput: { tiny: "never" } }));
    await vi.waitFor(() => expect(second.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    expect(requests[0].responseSchema).toBeUndefined();
    expect(requests[0].tools).toBeDefined();
    get.mockRestore();
  });

  it("adapts tools and guidance to a stored heavy-scaffolding profile", async () => {
    let seen: { tools: string[]; system: string } | undefined;
    mockProviderRef.current = {
      kind: "test",
      async *streamChat(input) {
        seen = { tools: (input.tools ?? []).map((tool) => tool.name), system: input.messages.find((message) => message.role === "system")?.content ?? "" };
        yield { type: "text-delta", text: "done" };
      },
      async listModels() { return []; },
    };
    const get = vi.spyOn(modelProfileStore, "get").mockResolvedValue({
      schemaVersion: 1, suiteVersion: "1", providerKind: "openai-compatible", endpoint: "http://x", model: "test-model",
      probedAt: "2026-09-26T00:00:00.000Z", durationMs: 1, maxContextTested: 1024, results: [], overall: 0.4, tier: "limited",
      usage: {}, failedRequests: 0,
      recommendation: { scaffolding: "heavy", toolUse: "supervised", structuredOutput: "repair", settings: {}, notes: [] },
    });
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true, workspaceRoot: "" }));
    await vi.waitFor(() => expect(sent.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    // Eight ranked tools plus find_tool, which recovers anything narrowed away.
    expect(seen!.tools.length).toBeLessThanOrEqual(9);
    expect(seen!.tools).toContain("find_tool");
    expect(seen!.system).toContain("Scaffolding for this model");
    expect(sent.some((payload) => payload.event.type === "notice" && /Adapted to test-model.s measured profile \(limited\)/.test(payload.event.message))).toBe(true);

    get.mockClear();
    recorded.on.get(IPC.chatStart)!(fakeEvent([]), request({ turnId: "t2", enableTools: true, adaptiveScaffolding: false }));
    await vi.waitFor(() => expect(seen!.system).not.toContain("Scaffolding for this model"));
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it("records host evidence for live scores and adapts to a tier that live results moved", async () => {
    const record = vi.mocked(modelPerformanceStore.record);
    mockProviderRef.current = scriptedProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "read_file", arguments: "{\"path\":\"nope.txt\"}" } }],
      [{ type: "text-delta", text: "done" }],
    ]);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true, workspaceRoot: "", config: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "test-model" } }));
    await vi.waitFor(() => expect(record).toHaveBeenCalled());
    expect(record.mock.calls[0][0]).toMatchObject({ providerKind: "openai-compatible", model: "test-model", kind: "chat", rejections: 1 });

    const get = vi.spyOn(modelProfileStore, "get").mockResolvedValue({
      schemaVersion: 1, suiteVersion: "1", providerKind: "anthropic", endpoint: "http://localhost:11434/v1", model: "test-model",
      probedAt: "2026-09-26T00:00:00.000Z", durationMs: 1, maxContextTested: 1024, results: [], overall: 0.4, tier: "limited",
      usage: {}, failedRequests: 0,
      recommendation: { scaffolding: "heavy", toolUse: "supervised", structuredOutput: "repair", settings: {}, notes: [] },
    });
    performanceEntries.push({
      schemaVersion: 1, providerKind: "anthropic", endpoint: "http://localhost:11434/v1", model: "test-model", kind: "coding",
      runs: 20, recent: Array(20).fill("s"), practice: [], rejections: 0, stalls: 0, escalatedAway: 0, repairs: 0, updatedAt: "x",
    });
    mockProviderRef.current = scriptedProvider([[{ type: "text-delta", text: "done" }]]);
    const second: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(second), request({ turnId: "t2", enableTools: true, workspaceRoot: "", config: { kind: "anthropic", baseUrl: "http://localhost:11434/v1", model: "test-model" } }));
    await vi.waitFor(() => expect(second.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    const decision = second.find((payload) => payload.event.type === "harness-decision" && payload.event.decision.kind === "live-score");
    expect((decision?.event as { decision: { summary: string } }).decision.summary).toMatch(/Treating test-model as capable \(probe: limited\) after 100% verified success over 20 graded runs/);
    expect(second.some((payload) => payload.event.type === "notice" && /measured profile \(capable\)/.test(payload.event.message))).toBe(true);
    get.mockRestore();
  });

  it("offers learned procedures, expands them into ordinary calls, and records their outcome", async () => {
    offeredProcedures.push({
      id: "p-1", name: "read_file → read_file", description: "Learned from verified turns.", status: "candidate", learnedFrom: 3,
      successCount: 0, failureCount: 0, consecutiveFailures: 0, createdAt: "x", updatedAt: "x",
      steps: [{ tool: "read_file", args: { path: { slot: "path" } } }, { tool: "read_file", args: { path: { const: "README.md" } } }],
      slots: [{ name: "path", example: "a.md" }],
    });
    let offeredTools: string[] = [];
    let system = "";
    let round = 0;
    mockProviderRef.current = {
      kind: "test",
      async *streamChat(input) {
        round += 1;
        if (round === 1) {
          offeredTools = (input.tools ?? []).map((tool) => tool.name);
          system = input.messages.find((message) => message.role === "system")?.content ?? "";
          yield { type: "tool-call", toolCall: { id: "c1", name: "run_procedure", arguments: JSON.stringify({ procedure: "p-1", slots: { path: "notes.md" } }) } };
        } else yield { type: "text-delta", text: "done" };
      },
      async listModels() { return []; },
    };
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true, workspaceRoot: "" }));
    await vi.waitFor(() => expect(sent.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    expect(offeredTools).toContain("run_procedure");
    expect(system).toContain("Learned procedures are available through run_procedure.");
    expect(sent.filter((payload) => payload.event.type === "tool-call").map((payload) => (payload.event as { arguments: string }).arguments)).toEqual(["{\"path\":\"notes.md\"}", "{\"path\":\"README.md\"}"]);
    await vi.waitFor(() => expect(procedureStore.recordOutcome).toHaveBeenCalledWith(["p-1"], expect.any(String)));
    // Turning learning off withholds them.
    offeredTools = [];
    round = 0;
    const off: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(off), request({ turnId: "t2", enableTools: true, workspaceRoot: "", learnProcedures: false }));
    await vi.waitFor(() => expect(off.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    expect(offeredTools).not.toContain("run_procedure");
  });

  it("ranks narrowed tools by meaning only when the user opts in", async () => {
    mockProviderRef.current = scriptedProvider([[{ type: "text-delta", text: "done" }]]);
    const get = vi.spyOn(modelProfileStore, "get").mockResolvedValue({
      schemaVersion: 1, suiteVersion: "1", providerKind: "anthropic", endpoint: "http://x", model: "test-model",
      probedAt: "2026-09-26T00:00:00.000Z", durationMs: 1, maxContextTested: 1024, results: [], overall: 0.4, tier: "limited",
      usage: {}, failedRequests: 0,
      recommendation: { scaffolding: "heavy", toolUse: "supervised", structuredOutput: "repair", settings: {}, notes: [] },
    });
    const similarities = vi.spyOn(semanticIndex, "similarities").mockResolvedValue(null);
    const embed = { baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" };
    const first: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(first), request({ turnId: "t2", enableTools: true, workspaceRoot: "", embed }));
    await vi.waitFor(() => expect(first.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    // Without the opt-in no embeddings config reaches the index, so nothing is sent.
    expect(similarities.mock.calls.every((call) => call[2] === undefined)).toBe(true);
    mockProviderRef.current = scriptedProvider([[{ type: "text-delta", text: "done" }]]);
    const second: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(second), request({ turnId: "t3", enableTools: true, workspaceRoot: "", embed, semanticRanking: true }));
    await vi.waitFor(() => expect(second.some((payload) => payload.event.type === "turn-complete")).toBe(true));
    expect(similarities).toHaveBeenCalledWith(expect.any(String), expect.any(Array), embed, expect.any(AbortSignal));
    similarities.mockRestore();
    get.mockRestore();
  });

  it("enforces working-state protected paths from the request and reports model updates", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "moss-ws-e2e-"));
    try {
      writeFileSync(join(workspace, "secret.txt"), "original");
      mockProviderRef.current = scriptedProvider([
        [{ type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: JSON.stringify({ path: "secret.txt", content: "changed" }) } }],
        [{ type: "tool-call", toolCall: { id: "s", name: "working_state", arguments: JSON.stringify({ action: "record_fact", text: "secret.txt is protected" }) } }],
        [{ type: "text-delta", text: "done" }],
      ]);
      const sent: ChatEventPayload[] = [];
      recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({
        enableTools: true,
        autoApproveTools: true,
        workspaceRoot: workspace,
        workingState: { schemaVersion: 1, entries: [{ id: "p1", kind: "protected", text: "secret.txt", source: "user", createdAt: "2026-09-26T00:00:00.000Z" }] },
      }));
      await vi.waitFor(() => expect(sent.some((payload) => payload.event.type === "turn-complete")).toBe(true));
      const result = sent.find((payload) => payload.event.type === "tool-result" && payload.event.callId === "w")!.event as { ok: boolean; content: string };
      expect(result.ok).toBe(false);
      expect(result.content).toMatch(/^Protected path:/);
      expect(readFileSync(join(workspace, "secret.txt"), "utf8")).toBe("original");
      const update = sent.find((payload) => payload.event.type === "working-state")!.event as { state: { entries: Array<{ text: string }> } };
      expect(update.state.entries.map((entry) => entry.text)).toEqual(["secret.txt", "secret.txt is protected"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("attributes loaded skills to the turn outcome", async () => {
    const skill = { id: "deploy", name: "deploy", description: "Deploy", instructions: "Steps", enabled: true, createdAt: "", createdBy: "user" as const };
    const list = vi.spyOn(skillsStore, "list").mockReturnValue([skill]);
    const get = vi.spyOn(skillsStore, "get").mockReturnValue(skill);
    const resources = vi.spyOn(skillsStore, "listResources").mockReturnValue([]);
    const record = vi.spyOn(skillLedger, "recordOutcome").mockImplementation(() => undefined);
    const sync = vi.spyOn(skillLedger, "sync").mockImplementation((skills) => [...skills]);
    try {
      mockProviderRef.current = scriptedProvider([
        [{ type: "tool-call", toolCall: { id: "k", name: "m_get_skill", arguments: JSON.stringify({ name: "deploy" }) } }],
        [{ type: "text-delta", text: "followed the skill" }],
      ]);
      const sent: ChatEventPayload[] = [];
      recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true }));
      await vi.waitFor(() => expect(record).toHaveBeenCalledWith(["deploy"], "used"));
    } finally {
      list.mockRestore();
      get.mockRestore();
      resources.mockRestore();
      record.mockRestore();
      sync.mockRestore();
    }
  });

  it("propagates a provider failure as turn-error over IPC", async () => {
    // The runner now retries a transient pre-stream failure with backoff, so
    // fake timers flush those delays deterministically instead of waiting.
    vi.useFakeTimers();
    try {
      mockProviderRef.current = throwingProvider("provider down");
      const sent: ChatEventPayload[] = [];
      recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request());
      await vi.runAllTimersAsync();

      const err = sent.find((p) => p.event.type === "turn-error");
      expect(err).toBeDefined();
      expect((err!.event as { message: string }).message).toBe("provider down");
      // turn-error now carries an authoritative messages array over the wire; an
      // immediate throw leaves it empty.
      expect((err!.event as { messages: unknown[] }).messages).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

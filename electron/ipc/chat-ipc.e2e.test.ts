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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../../common/ipc-contract";
import type { ChatEventPayload, ChatStartRequest } from "../../common/types";
import type { ChatProvider, ProviderStreamEvent } from "../backend/moss/providers/types";

// Recording ipcMain so the test can invoke the registered channel handlers.
const recorded = vi.hoisted(() => ({
  on: new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>(),
}));

// The provider returned by createProvider; each test scripts it before starting.
const mockProviderRef = vi.hoisted(() => ({ current: null as ChatProvider | null }));

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
  createProvider: () => mockProviderRef.current,
}));

vi.mock("../backend/moss/mcp/mcp-manager", () => ({
  mcpManager: { getTools: () => [], getStatus: () => [] },
}));

import { registerChatIpc } from "./chat-ipc";
import { taskStore } from "../backend/moss/task/task-store";
import { taskEngine } from "../backend/moss/task/task-engine";
import { providerCredentials } from "../backend/moss/provider-credentials";

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

describe("chat IPC turn (e2e)", () => {
  beforeEach(() => {
    recorded.on.clear();
    recorded.handle.clear();
    mockProviderRef.current = null;
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
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{}" } }],
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
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{}" } }],
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
    mockProviderRef.current = scriptedProvider([[{ type: "tool-call", toolCall: { id: "late", name: "write_file", arguments: "{}" } }]]);
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
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{}" } }],
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
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{}" } }],
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

// electron/ipc/chat-ipc.test.ts
//
// Verifies the IPC wiring contract: every channel in the shared IPC contract is
// registered with ipcMain. This locks against the realistic regression of
// adding a channel to the contract (or the renderer) but forgetting to wire its
// main-process handler. electron is mocked with a recording ipcMain.

import { afterEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../../common/ipc-contract";
import type { TaskSnapshot, TaskArtifactContent } from "../../common/types";
import { taskArtifactStore } from "../backend/moss/task/task-artifact-store";
import { taskStore } from "../backend/moss/task/task-store";

afterEach(() => vi.restoreAllMocks());

const recorded = vi.hoisted(() => ({
  on: new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>(),
  showMessageBox: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppPath: () => "/app" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => unknown) => recorded.on.set(channel, fn),
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => recorded.handle.set(channel, fn),
  },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: recorded.showMessageBox },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

import { registerChatIpc, resolveMaxToolRounds, resolveMissionSpec } from "./chat-ipc";

describe("resolveMaxToolRounds", () => {
  it("uses eight rounds by default and preserves a configured long-task limit", () => {
    expect(resolveMaxToolRounds(undefined, false)).toBe(8);
    expect(resolveMaxToolRounds(32, false)).toBe(32);
  });

  it("reserves verification room and clamps unsupported values", () => {
    expect(resolveMaxToolRounds(4, true)).toBe(12);
    expect(resolveMaxToolRounds(32, true)).toBe(32);
    expect(resolveMaxToolRounds(0, false)).toBe(1);
    expect(resolveMaxToolRounds(100, false)).toBe(64);
    expect(resolveMaxToolRounds(Number.NaN, false)).toBe(8);
  });
});

describe("resolveMissionSpec", () => {
  const spec = {
    objective: "Inspect the workspace",
    acceptanceCriteria: [{ id: "done", description: "Inspection complete", mandatory: true }],
    constraints: [],
    assumptions: [],
  };

  it("derives scopes, capability authority, and bounded budgets in Electron", () => {
    const resolved = resolveMissionSpec(spec, {
      authority: "supervised",
      requestedCapabilities: ["read_file"],
      maxAutoApprovedRisk: "mutating",
      budget: { maxActions: 10_000, maxCostUsd: 1_000 },
    }, ["read_file", "write_file"], { workspaceRoot: "C:\\workspace" });

    expect(resolved).toMatchObject({
      workspaceRoot: "C:\\workspace",
      budget: { maxActions: 256, maxCostUsd: 100 },
      executionGrant: {
        authority: "supervised",
        allowedCapabilities: ["read_file"],
        maxAutoApprovedRisk: "readonly",
        scopes: { workspaceRoot: "C:\\workspace" },
      },
    });
  });

  it("rejects capabilities that are absent from the live registry", () => {
    expect(() => resolveMissionSpec(spec, {
      authority: "supervised",
      requestedCapabilities: ["missing_tool"],
      maxAutoApprovedRisk: "readonly",
    }, ["read_file"], {})).toThrow("Mission capabilities are unavailable: missing_tool");
  });
});

describe("registerChatIpc", () => {
  it("only returns artifacts registered to the task with matching integrity metadata", async () => {
    registerChatIpc();
    const record: TaskArtifactContent = {
      id: "artifact-1", taskId: "task-1", planRevision: 1, stepId: "report", attemptId: "attempt-1",
      name: "report.md", summary: "Report", sha256: "a".repeat(64), byteLength: 4, createdAt: "2026-09-19", content: "text",
    };
    vi.spyOn(taskStore, "get").mockResolvedValue({ artifacts: [record] } as TaskSnapshot);
    const read = vi.spyOn(taskArtifactStore, "get").mockResolvedValue(record);
    const handler = recorded.handle.get(IPC.taskArtifactGet)!;
    expect(await handler(null, "task-1", "artifact-1")).toEqual(record);
    expect(await handler(null, "task-2", "artifact-1")).toBeNull();
    expect(await handler(null, "task-1", "../other")).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValueOnce({ ...record, sha256: "b".repeat(64) });
    expect(await handler(null, "task-1", "artifact-1")).toBeNull();
    read.mockResolvedValueOnce(null);
    expect(await handler(null, "task-1", "artifact-1")).toBeNull();
    await expect(handler(null, {}, "artifact-1")).rejects.toThrow("Invalid artifact request");
  });

  it("reports live eligible mission capabilities with host-owned risk labels", async () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();

    const capabilities = await recorded.handle.get(IPC.missionCapabilities)!(null, {}) as Array<{ id: string; risk: string }>;

    expect(capabilities).toEqual(expect.arrayContaining([
      { id: "read_file", risk: "readonly" },
      { id: "write_file", risk: "mutating" },
    ]));
    expect(capabilities.some((capability) => capability.id === "send_email")).toBe(false);
    expect(capabilities.some((capability) => capability.id === "transcribe_audio")).toBe(false);
  });

  it("requires native confirmation before issuing elevated mission authority", async () => {
    recorded.on.clear();
    recorded.handle.clear();
    recorded.showMessageBox.mockResolvedValue({ response: 1 });
    registerChatIpc();
    const request = {
      objective: "Implement the feature",
      workspaceRoot: "C:\\workspace",
      policy: {
        authority: "policy-scoped" as const,
        requestedCapabilities: ["write_file"],
        maxAutoApprovedRisk: "mutating" as const,
        budget: { maxActions: 4 },
      },
    };

    const authorization = await recorded.handle.get(IPC.missionAuthorize)!(null, request);

    expect(recorded.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: "Authorize policy-scoped mission",
      defaultId: 0,
      cancelId: 0,
    }));
    expect(authorization).toMatchObject({ token: expect.any(String), expiresAt: expect.any(String) });
  });

  it("registers the fire-and-forget channels via ipcMain.on", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();
    for (const channel of [IPC.chatStart, IPC.chatAbort, IPC.toolApprove]) {
      expect(recorded.on.has(channel)).toBe(true);
    }
  });

  it("registers every invoke channel via ipcMain.handle", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();
    const invokeChannels = [
      IPC.providerListModels,
      IPC.providerCredentialGet,
      IPC.providerCredentialSet,
      IPC.workspacePick,
      IPC.memoryList,
      IPC.memoryAdd,
      IPC.memoryDelete,
      IPC.memoryClear,
      IPC.skillsList,
      IPC.skillCreate,
      IPC.skillDelete,
      IPC.skillToggle,
      IPC.skillUpdate,
      IPC.skillRename,
      IPC.skillImport,
      IPC.mcpStatus,
      IPC.mcpOpenConfig,
      IPC.transcribe,
      IPC.clipboardWrite,
    ];
    for (const channel of invokeChannels) {
      expect(recorded.handle.has(channel)).toBe(true);
    }
  });

  it("registers a function for each channel", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();
    for (const fn of [...recorded.on.values(), ...recorded.handle.values()]) {
      expect(typeof fn).toBe("function");
    }
  });

  it("registers a handler for every inbound contract channel and none outside it", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();

    // chatEvent is the only outbound channel (main -> renderer via
    // event.sender.send), so it is never registered with ipcMain; every other
    // contract channel is inbound and must have exactly one handler.
    const inbound = Object.values(IPC)
      .filter((channel) => channel !== IPC.chatEvent)
      .sort();
    const registered = [...recorded.on.keys(), ...recorded.handle.keys()].sort();

    // Bijection: a new inbound contract channel left unwired, a removed channel
    // still registered, or a typo all break this equality.
    expect(registered).toEqual(inbound);

    // A channel is either fire-and-forget (on) or request/response (handle),
    // never both.
    const both = [...recorded.on.keys()].filter((channel) => recorded.handle.has(channel));
    expect(both).toEqual([]);
  });

  it("treats an abort for an unknown turn id as a no-op", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();
    const abort = recorded.on.get(IPC.chatAbort)!;
    expect(() => abort(null, "no-such-turn")).not.toThrow();
  });
});

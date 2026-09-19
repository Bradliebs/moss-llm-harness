// electron/preload.test.ts
//
// preload.cjs is hand-written CommonJS (not compiled by tsc) and deliberately
// duplicates the IPC channel strings from common/ipc-contract.ts. vitest's
// module mocking does not intercept the native `require("electron")` inside a
// .cjs file, so instead of importing it we read the real artifact's source and
// evaluate it with an injected fake `require`. This exercises the literal
// shipped file: it captures the API object handed to contextBridge and asserts
// each method routes to the correct channel, and that the duplicated constants
// stay in sync with the contract. Excluded from both tsconfigs, so the loose
// mock typing here is never type-checked.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { IPC } from "../common/ipc-contract";

const send = vi.fn();
const invoke = vi.fn(() => Promise.resolve());
const on = vi.fn();
const removeListener = vi.fn();

let exposedKey = "";
let api: any = null;

beforeAll(() => {
  const contextBridge = {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposedKey = key;
      api = value;
    },
  };
  const ipcRenderer = { send, invoke, on, removeListener };
  const fakeRequire = (id: string) => {
    if (id === "electron") return { contextBridge, ipcRenderer };
    throw new Error(`unexpected require(${id})`);
  };
  const source = readFileSync(join(__dirname, "preload.cjs"), "utf8");
  const factory = new Function("require", "module", "exports", source);
  factory(fakeRequire, { exports: {} }, {});
});

describe("preload bridge", () => {
  it("exposes the moss api under the expected global key", () => {
    expect(exposedKey).toBe("moss");
    expect(api).toBeTruthy();
  });

  it("routes fire-and-forget calls through ipcRenderer.send on the contract channels", () => {
    send.mockClear();
    const request = { turnId: "t1" };
    api.chat.send(request);
    expect(send).toHaveBeenCalledWith(IPC.chatStart, request);

    api.chat.abort("t1");
    expect(send).toHaveBeenCalledWith(IPC.chatAbort, "t1");

    const decision = { callId: "c1", approved: true };
    api.tool.approve(decision);
    expect(send).toHaveBeenCalledWith(IPC.toolApprove, decision);
  });

  it("routes request/response calls through ipcRenderer.invoke on the contract channels", () => {
    invoke.mockClear();
    const config = { kind: "openai-compatible" };
    api.provider.listModels(config);
    expect(invoke).toHaveBeenCalledWith(IPC.providerListModels, config);
    api.provider.getCredential("openrouter");
    expect(invoke).toHaveBeenCalledWith(IPC.providerCredentialGet, "openrouter");
    api.provider.setCredential("openrouter", "secret");
    expect(invoke).toHaveBeenCalledWith(IPC.providerCredentialSet, "openrouter", "secret");

    api.task.history("task-1");
    expect(invoke).toHaveBeenCalledWith(IPC.taskHistory, "task-1");

    api.task.artifact("task-1", "artifact-1");
    expect(invoke).toHaveBeenCalledWith(IPC.taskArtifactGet, "task-1", "artifact-1");

    const missionRequest = { objective: "Do work", policy: { authority: "policy-scoped" } };
    api.mission.authorize(missionRequest);
    expect(invoke).toHaveBeenCalledWith(IPC.missionAuthorize, missionRequest);
    api.mission.capabilities({});
    expect(invoke).toHaveBeenCalledWith(IPC.missionCapabilities, {});

    api.memory.add("fact", "context");
    expect(invoke).toHaveBeenCalledWith(IPC.memoryAdd, "fact", "context");

    api.skills.toggle("s1", false);
    expect(invoke).toHaveBeenCalledWith(IPC.skillToggle, "s1", false);

    const skillUpdate = { id: "s1", description: "d", instructions: "i" };
    api.skills.update(skillUpdate);
    expect(invoke).toHaveBeenCalledWith(IPC.skillUpdate, skillUpdate);

    const skillRename = { id: "s1", newName: "New Name" };
    api.skills.rename(skillRename);
    expect(invoke).toHaveBeenCalledWith(IPC.skillRename, skillRename);

    api.skills.importFolder();
    expect(invoke).toHaveBeenCalledWith(IPC.skillImport);

    api.mcp.status();
    expect(invoke).toHaveBeenCalledWith(IPC.mcpStatus);

    api.mcp.setEnabled("p", true);
    expect(invoke).toHaveBeenCalledWith(IPC.mcpSetEnabled, "p", true);

    const cfg = { type: "stdio", id: "n", command: "node" };
    api.mcp.add(cfg);
    expect(invoke).toHaveBeenCalledWith(IPC.mcpAddServer, cfg);

    api.mcp.update(cfg);
    expect(invoke).toHaveBeenCalledWith(IPC.mcpUpdateServer, cfg);

    api.mcp.remove("n");
    expect(invoke).toHaveBeenCalledWith(IPC.mcpRemoveServer, "n");

    api.mcp.servers();
    expect(invoke).toHaveBeenCalledWith(IPC.mcpListConfigs);

    api.mcp.reconnect("n");
    expect(invoke).toHaveBeenCalledWith(IPC.mcpReconnect, "n");

    api.checkpoint.list("t1");
    expect(invoke).toHaveBeenCalledWith(IPC.checkpointList, "t1");

    api.checkpoint.revert("t1");
    expect(invoke).toHaveBeenCalledWith(IPC.checkpointRevert, "t1");

    const embed = { baseUrl: "http://x", model: "nomic-embed-text" };
    api.codebase.reindex("/ws", embed);
    expect(invoke).toHaveBeenCalledWith(IPC.codebaseReindex, "/ws", embed);

    api.codebase.status("/ws");
    expect(invoke).toHaveBeenCalledWith(IPC.codebaseStatus, "/ws");
  });

  it("subscribes to chat events and returns an unsubscribe that removes the listener", () => {
    on.mockClear();
    removeListener.mockClear();
    const handler = vi.fn();
    const unsubscribe = api.chat.onEvent(handler);

    expect(on).toHaveBeenCalledWith(IPC.chatEvent, expect.any(Function));
    const listener = on.mock.calls[0][1] as (event: unknown, payload: unknown) => void;
    listener({}, { type: "delta" });
    expect(handler).toHaveBeenCalledWith({ type: "delta" });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC.chatEvent, listener);
  });

  it("wires every contract channel exactly once and references no unknown channels", () => {
    send.mockClear();
    invoke.mockClear();
    on.mockClear();

    // Invoke every leaf method on the exposed api so each forwards its channel
    // to send/invoke/on. Methods just pass their arguments through, so calling
    // them with no arguments is enough to capture the channel.
    const visit = (node: any) => {
      for (const value of Object.values(node)) {
        if (typeof value === "function") value();
        else if (value && typeof value === "object") visit(value);
      }
    };
    visit(api);

    const used = [
      ...send.mock.calls,
      ...invoke.mock.calls,
      ...on.mock.calls,
    ].map((call) => call[0] as string);
    const contract = Object.values(IPC);

    // Bijection: every contract channel is reachable through exactly one api
    // method, and the preload references no channel outside the contract. A new
    // channel left unwired, a removed channel still referenced, or a typo all
    // break this equality.
    expect(used.slice().sort()).toEqual(contract.slice().sort());
  });
});

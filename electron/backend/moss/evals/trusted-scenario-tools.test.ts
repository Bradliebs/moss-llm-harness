import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { createBrowserCases } from "./browser-cases";
import { createDesktopCases } from "./desktop-cases";
import { createMcpCases } from "./mcp-cases";
import { validateEvalCaseCapabilities } from "./trusted-scenario-tools";
import { createTurnEvalExecutor } from "./turn-eval-executor";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const cases = [...createBrowserCases(), ...createDesktopCases(), ...createMcpCases()];

describe("trusted scenario admission", () => {
  it.each(cases)("substitutes local adapters for $id without using the host registry", async (testCase) => {
    const root = mkdtempSync(join(tmpdir(), "moss-trusted-scenario-"));
    roots.push(root);
    cpSync(testCase.fixture!.workspaceTemplate!, root, { recursive: true });
    const host = vi.fn(async () => { throw new Error("Host tool invoked"); });
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      kind: "deterministic", listModels: async () => [],
      async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
        requests.push(request);
        if (requests.length === 1) yield { type: "tool-call", toolCall: { id: "attempt", name: testCase.allowedCapabilities[0], arguments: "{}" } };
        else yield { type: "text-delta", text: "done" };
      },
    };
    const execute = createTurnEvalExecutor({ provider, model: "fixture", workspaceRoot: () => root, autoApprove: true,
      toolRegistry: new Map(testCase.allowedCapabilities.map((name) => [name, { name, description: "host sentinel", parameters: {}, execute: host }])),
    });
    await execute(testCase, 0);
    expect(host).not.toHaveBeenCalled();
    expect(requests[0].tools.map((tool) => tool.name).sort()).toEqual([...testCase.allowedCapabilities].sort());
    expect(requests[0].tools.every((tool) => tool.description !== "host sentinel")).toBe(true);
  });

  it.each(cases)("rejects filesystem forgery capabilities for $id", (testCase) => {
    expect(() => validateEvalCaseCapabilities({ ...testCase, allowedCapabilities: [...testCase.allowedCapabilities, "write_file"] })).toThrow("reviewed local adapter");
    expect(() => validateEvalCaseCapabilities({ ...testCase, id: "unregistered-domain-case" })).toThrow("no sandbox adapter");
  });
});
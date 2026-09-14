import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../../../../common/evals";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { TOOL_REGISTRY } from "../tools";
import { readFileTool, writeFileTool } from "../tools/fs-tools";
import { collectEvalEvidence, EvalRunner, type EvalExecutionResult } from "./eval-runner";
import { createPermanentFailureCases } from "./permanent-failure-cases";
import { createTurnEvalExecutor } from "./turn-eval-executor";

const roots: string[] = [];
const [transientCase, permanentCase] = createPermanentFailureCases();
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function workspace(testCase: EvalCase): string {
  const root = mkdtempSync(join(tmpdir(), "moss-permanent-failure-"));
  roots.push(root);
  cpSync(testCase.fixture!.workspaceTemplate!, root, { recursive: true });
  return root;
}

function provider(options: { reads?: number; mutation?: { path: string; content: string }; crash?: boolean; repair?: boolean } = {}) {
  const readResults: string[] = [];
  let readCount = 0;
  let wrote = false;
  let repaired = false;
  const scripted: ChatProvider = {
    kind: "deterministic",
    listModels: async () => [],
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      if (readCount === 0) {
        const task = JSON.parse(request.messages.find((message) => message.role === "user")!.content);
        expect(task.jsonArtifactRequirements).toEqual(transientCase.task.jsonArtifactRequirements);
        expect(task.checks).toBeUndefined();
      }
      const lastResult = request.messages.filter((message) => message.role === "tool").at(-1);
      if (lastResult?.toolCallId?.startsWith("permanent-failure-read-")) {
        readResults.push(lastResult.content);
      }
      if (options.crash && readCount > 0) throw new Error("Fixture provider stopped after tool failure");
      if (readCount < (options.reads ?? 1)) {
        readCount++;
        yield { type: "tool-call", toolCall: {
          id: `permanent-failure-read-${readCount}`,
          name: "read_file",
          arguments: JSON.stringify({ path: readCount % 2 ? "permanent-failure-source.json" : "./permanent-failure-source.json" }),
        } };
        return;
      }
      if (!wrote && (options.mutation || lastResult?.content.trimStart().startsWith("{"))) {
        const source: unknown = lastResult?.content.trimStart().startsWith("{") ? JSON.parse(lastResult.content) : undefined;
        const mutation = options.mutation ?? {
          path: "permanent-failure-answer.json",
          content: JSON.stringify(source && typeof source === "object" && "payload" in source ? source.payload : null),
        };
        wrote = true;
        yield { type: "tool-call", toolCall: {
          id: "permanent-failure-write", name: "write_file", arguments: JSON.stringify(mutation),
        } };
        return;
      }
      if (options.repair && wrote && !repaired && request.messages.at(-1)?.content.includes("JSON artifact requirement 1 failed")) {
        repaired = true;
        yield { type: "tool-call", toolCall: {
          id: "repair-artifact", name: "write_file", arguments: JSON.stringify({ path: "permanent-failure-answer.json", content: JSON.stringify(JSON.parse(readResults[0]).payload) }),
        } };
        return;
      }
      yield { type: "text-delta", text: "Finished handling the tool result." };
    },
  };
  return { scripted, readResults };
}

async function execute(testCase: EvalCase, scripted: ChatProvider) {
  const root = workspace(testCase);
  const read = vi.fn(readFileTool.execute);
  const write = vi.fn(writeFileTool.execute);
  const tools = new Map(TOOL_REGISTRY);
  tools.set("read_file", { ...readFileTool, execute: read });
  tools.set("write_file", { ...writeFileTool, execute: write });
  const executor = createTurnEvalExecutor({
    provider: scripted, model: "fixture", toolRegistry: tools, workspaceRoot: () => root, autoApprove: true,
  });
  const execution = await executor(testCase, 0);
  const report = await new EvalRunner(async () => execution).run([testCase]);
  return { root, read, write, execution, result: report.results[0] };
}

function assertPermanentTrace(execution: EvalExecutionResult, reads: number): void {
  expect(execution.observation.outcome).toBe("completed");
  expect(execution.failureSource).toBeUndefined();
  expect(execution.trace?.terminalState).toBe("completed");
  expect(execution.trace?.toolCalls).toHaveLength(reads);
  expect(execution.trace?.toolCalls.every((call) => call.name === "read_file" && call.ok === false)).toBe(true);
  expect(execution.trace?.events).toContainEqual(expect.objectContaining({
    type: "scenario-disturbance", id: "permanent-failure-read", status: "delivered",
  }));
  expect(execution.trace?.events.some((event) => event.type === "recovery" && event.outcome === "succeeded")).toBe(false);
  expect(execution.observation.admissions).not.toContain("recovered");
}

describe("permanent-failure behavioral pair", () => {
  it.each(createPermanentFailureCases())("validates the independent reference for $id", async (testCase) => {
    const root = workspace(testCase);
    cpSync(testCase.fixture!.referenceSolution!, root, { recursive: true });
    expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((item) => item.passed)).toBe(true);
    expect(testCase.allowedCapabilities).toEqual(["read_file", "write_file"]);
  });

  it("recovers transiently through the real loop and writes the actual read payload", async () => {
    const control = provider();
    const { root, read, write, execution, result } = await execute(transientCase, control.scripted);
    expect(result.success).toBe(true);
    expect(execution.observation.outcome).toBe("completed");
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(control.readResults[0])).toHaveProperty("payload");
    expect(JSON.parse(readFileSync(join(root, "permanent-failure-answer.json"), "utf8"))).toEqual(JSON.parse(control.readResults[0]).payload);
    expect(execution.trace?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "scenario-disturbance", id: "permanent-failure-transient-read", status: "delivered" }),
      expect.objectContaining({ type: "recovery", outcome: "attempted" }),
      expect.objectContaining({ type: "recovery", outcome: "succeeded" }),
    ]));
  });

  it("repairs an enclosing-object output from public feedback without changing the independent grader", async () => {
    const control = provider({ mutation: { path: "permanent-failure-answer.json", content: '{"payload":{"record":"shipment-482","quantity":17,"unit":"crates"}}' }, repair: true });
    const { read, write, execution, result } = await execute(transientCase, control.scripted);
    expect(result.success).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(execution.trace?.events).toContainEqual(expect.objectContaining({ type: "round-end", finish: "rejected" }));
  });

  it("delivers permanent failure to the agent and completes without an artifact", async () => {
    const control = provider();
    const { root, read, write, execution, result } = await execute(permanentCase, control.scripted);
    expect(result.success).toBe(true);
    expect(control.readResults).toHaveLength(1);
    expect(control.readResults[0]).toContain("Tool failed permanently");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(join(root, "permanent-failure-answer.json"))).toBe(false);
    assertPermanentTrace(execution, 1);
    expect(() => assertPermanentTrace({ ...execution, trace: undefined }, 1)).toThrow();
  });

  it("keeps permanent failure active across repeated requests without false recovery", async () => {
    const control = provider({ reads: 3 });
    const { read, write, execution, result } = await execute(permanentCase, control.scripted);
    expect(control.readResults).toHaveLength(3);
    expect(control.readResults.every((content) => content.includes("Tool failed permanently"))).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    assertPermanentTrace(execution, 3);
    expect(result.success).toBe(true);
    expect(execution.trace?.events.filter((event) => event.type === "scenario-disturbance" && event.status === "delivered")).toHaveLength(1);
  });

  it("detects one-shot false recovery by trace and independent artifact grading", async () => {
    const oneShot = structuredClone(permanentCase);
    oneShot.scenario!.disturbances = [{ id: "permanent-failure-read", type: "tool-failure", capability: "read_file", invocation: 1, failure: "permanent" }];
    await expect(execute(oneShot, provider({ reads: 2 }).scripted)).rejects.toThrow("persistent disturbance");
    delete oneShot.benchmark!.requiredPermanentFailure;
    const { read, write, execution, result } = await execute(oneShot, provider({ reads: 2 }).scripted);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(execution.trace?.toolCalls.filter((call) => call.name === "read_file").map((call) => call.ok)).toEqual([false, true]);
    expect(() => assertPermanentTrace(execution, 2)).toThrow();
    expect(result.criteria.every((criterion) => criterion.passed)).toBe(false);
    expect(result.success).toBe(false);
  });

  it.each([
    [transientCase, "permanent-failure-answer.json", '{"record":"shipment-482","quantity":18,"unit":"crates"}'],
    [permanentCase, "permanent-failure-answer.json", '{"record":"shipment-482","quantity":17,"unit":"crates"}'],
    [permanentCase, "permanent-failure-protected.txt", "corrupted"],
    [permanentCase, "permanent-failure-source.json", '{"payload":{}}'],
    [permanentCase, "permanent-failure-unrequested.txt", "extra artifact"],
  ] as const)("rejects real wrong mutation %#", async (testCase, path, content) => {
    const { write, execution, result } = await execute(testCase, provider({ mutation: { path, content } }).scripted);
    expect(write).toHaveBeenCalledTimes(1);
    expect(execution.observation.outcome).toBe(path === "permanent-failure-answer.json" ? "failed" : "completed");
    expect(result.criteria.every((criterion) => criterion.passed)).toBe(false);
    expect(result.success).toBe(false);
  });

  it("does not credit untouched state when the disturbance never fires", async () => {
    const { read, execution, result } = await execute(permanentCase, provider({ reads: 0 }).scripted);
    expect(read).not.toHaveBeenCalled();
    expect(execution.trace?.events).toContainEqual(expect.objectContaining({
      type: "scenario-disturbance", id: "permanent-failure-read", status: "undelivered",
    }));
    expect(result.success).toBe(false);
    expect(execution.failureSource).toBe("harness-orchestration");
  });

  it("does not accept a provider failure just because the refusal artifact is absent", async () => {
    const { execution, result } = await execute(permanentCase, provider({ crash: true }).scripted);
    expect(execution.observation.outcome).toBe("failed");
    expect(result.criteria.every((criterion) => criterion.passed)).toBe(true);
    expect(result.success).toBe(false);
  });
});
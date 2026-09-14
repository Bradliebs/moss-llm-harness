import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../../../../common/evals";
import type { AgentMessage, MossEvent } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import { compactIfNeeded } from "../context/compaction";
import { buildCompactionTranscript } from "../context/compaction-summary";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { TOOL_REGISTRY } from "../tools";
import { createContextCases, hasRequiredContextCompaction } from "./context-cases";
import { CONTEXT_STATE_VALUE, createContextScenarioSetup, createResumeScenarioSetup } from "./context-scenario";
import * as contextScenario from "./context-scenario";
import { TaskStore } from "../task/task-store";
import { collectEvalEvidence, EvalRunner } from "./eval-runner";
import { HarnessTraceCollector } from "./trace-collector";
import { createTurnEvalExecutor } from "./turn-eval-executor";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
afterEach(() => vi.restoreAllMocks());

function workspace(testCase: EvalCase): string {
  const root = mkdtempSync(join(tmpdir(), "moss-context-behavior-"));
  roots.push(root);
  cpSync(testCase.fixture!.workspaceTemplate!, root, { recursive: true });
  return root;
}

function scriptedProvider(expectCompaction = true) {
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = {
    kind: "deterministic", listModels: async () => [],
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      requests.push(structuredClone(request));
      if (request.messages[0]?.content.startsWith("Summarize earlier conversation context")) {
        expect(request.tools).toBeUndefined();
        expect(request.maxTokens).toBe(512);
        expect(JSON.stringify(request.messages)).not.toContain(CONTEXT_STATE_VALUE);
        yield { type: "text-delta", text: "A shipment was inspected; consult durable-state.txt for its identifier." };
        return;
      }
      const result = request.messages.find((message) => message.role === "tool" && message.toolCallId === "recover-read");
      if (!result) {
        if (expectCompaction) expect(JSON.stringify(request.messages)).not.toContain(CONTEXT_STATE_VALUE);
        yield { type: "tool-call", toolCall: { id: "recover-read", name: "read_file", arguments: JSON.stringify({ path: "durable-state.txt" }) } };
      } else if (request.messages.some((message) => message.toolCallId === "recover-write")) {
        yield { type: "text-delta", text: "Recovered the durable identifier." };
      } else if (result.content.includes("ENOENT")) {
        yield { type: "text-delta", text: "The durable file is missing; the identifier cannot be recovered." };
      } else {
        if (!result.content.includes("shipment-")) throw new Error(`Unexpected real read_file result: ${result.content}`);
        yield { type: "tool-call", toolCall: { id: "recover-write", name: "write_file", arguments: JSON.stringify({ path: "recovered-state.txt", content: `Recovered: ${result.content.trim()}\n` }) } };
      }
    },
  };
  return { provider, requests };
}

function scriptedResumeProvider() {
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = {
    kind: "deterministic", listModels: async () => [],
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      requests.push(structuredClone(request));
      const read = request.messages.find((message) => message.toolCallId === "resume-read");
      if (!read) yield { type: "tool-call", toolCall: { id: "resume-read", name: "read_file", arguments: '{"path":"prepared.txt"}' } };
      else if (!request.messages.some((message) => message.toolCallId === "resume-write")) yield { type: "tool-call", toolCall: { id: "resume-write", name: "write_file", arguments: JSON.stringify({ path: "delivered.txt", content: `Delivered: ${read.content.trim()}\n` }) } };
      else yield { type: "text-delta", text: "Delivery finished; completed preparation was not repeated." };
    },
  };
  return { provider, requests };
}

async function executeContext(testCase: EvalCase, root: string, compact = true) {
  const script = scriptedProvider(compact);
  const messages: AgentMessage[] = [{ role: "system", content: "Complete the requested file task." }, { role: "user", content: testCase.task.objective }];
  const setup = createContextScenarioSetup(testCase, messages)!;
  const events: MossEvent[] = [];
  const collector = new HarnessTraceCollector();
  const tools = [...TOOL_REGISTRY.values()].filter((tool) => testCase.allowedCapabilities.includes(tool.name));
  await runTurn({
    provider: script.provider, model: "fixture", messages: setup.messages, ...setup.options, contextLimit: compact ? setup.options.contextLimit : 0,
    tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    toolRegistry: new Map(tools.map((tool) => [tool.name, tool])), workspaceRoot: root,
    signal: new AbortController().signal, autoApprove: true, requestApproval: async () => ({ approved: true }),
    onEvent: (event) => { events.push(event); collector.onEvent(event); },
  });
  return { ...script, events, trace: collector.snapshot() };
}

describe("context behavior setup", () => {
  it.each(createContextCases().filter((testCase) => testCase.family === "context-pressure"))("scores actual executor compaction and rejects missing trace evidence for $id", async (testCase) => {
    const root = workspace(testCase);
    const script = scriptedProvider();
    const execute = createTurnEvalExecutor({ provider: script.provider, model: "fixture", toolRegistry: TOOL_REGISTRY, workspaceRoot: () => root, autoApprove: true });
    const execution = await execute(testCase, 0);
    const report = await new EvalRunner(async () => execution, { executionPolicy: { purpose: "promotion" } }).run([testCase]);
    expect(report.results[0].success).toBe(true);
    expect(execution.observation.outcome).toBe("completed");
    expect(execution.failureSource).toBeUndefined();
    expect(execution.trace?.events).toContainEqual(expect.objectContaining({ type: "context-compaction", reason: "proactive", droppedCount: 4 }));
    expect(script.requests.filter((request) => request.messages[0]?.content.startsWith("Summarize earlier conversation context"))).toHaveLength(1);
    expect(execution.trace?.toolCalls.map((call) => call.name)).toEqual(testCase.familyRole === "positive" ? ["read_file", "write_file"] : ["read_file"]);
    if (testCase.familyRole === "positive") expect(readFileSync(join(root, "recovered-state.txt"), "utf8")).toBe(`Recovered: ${readFileSync(join(root, "durable-state.txt"), "utf8").trim()}\n`);
    const trace = execution.trace!;
    for (const missingTrace of [undefined, { ...trace, events: trace.events.filter((event) => event.type !== "context-compaction") }]) {
      const rejected = await new EvalRunner(async () => ({ ...execution, trace: missingTrace }), { executionPolicy: { purpose: "promotion" } }).run([testCase]);
      expect(rejected.results[0].criteria.every((criterion) => criterion.passed)).toBe(true);
      expect(rejected.results[0].observation.outcome).toBe("completed");
      expect(rejected.results[0].success).toBe(false);
    }
  });

  it.each(createContextCases().filter((testCase) => testCase.family === "resume-checkpoint"))("scores actual executor durable continuation without restarting prepare for $id", async (testCase) => {
    const root = workspace(testCase);
    const prepared = readFileSync(join(root, "prepared.txt"), "utf8");
    const script = scriptedResumeProvider();
    const originalSetup = createResumeScenarioSetup;
    let before: Awaited<ReturnType<TaskStore["get"]>>;
    let after: Awaited<ReturnType<TaskStore["get"]>>;
    const setupSpy = vi.spyOn(contextScenario, "createResumeScenarioSetup").mockImplementation(async (...args) => {
      const setup = await originalSetup(...args);
      if (!setup) throw new Error("Executor did not select the resume scenario");
      before = await new TaskStore(setup.checkpoint.root).get(setup.checkpoint.taskId);
      return { ...setup, dispose: async () => {
        try { after = await new TaskStore(setup.checkpoint.root).get(setup.checkpoint.taskId); }
        finally { await setup.dispose(); }
      } };
    });
    const execute = createTurnEvalExecutor({ provider: script.provider, model: "fixture", toolRegistry: TOOL_REGISTRY, workspaceRoot: () => root, autoApprove: true });
    const execution = await execute(testCase, 0);
    const report = await new EvalRunner(async () => execution, { executionPolicy: { purpose: "promotion" } }).run([testCase]);
    expect(report.results[0].success).toBe(true);
    expect(execution.observation.outcome).toBe("completed");
    expect(execution.failureSource).toBeUndefined();
    expect(setupSpy).toHaveBeenCalledOnce();
    expect(before?.steps.map((step) => [step.id, step.state])).toEqual([["prepare", "completed"], ["deliver", "running"]]);
    expect(before?.attempts).toHaveLength(testCase.perturbation?.class === "interruption" ? 3 : 2);
    expect(after?.steps.map((step) => [step.id, step.state])).toEqual([["prepare", "completed"], ["deliver", "completed"]]);
    expect(after?.attempts.filter((attempt) => attempt.stepId === "prepare")).toEqual(before?.attempts.filter((attempt) => attempt.stepId === "prepare"));
    expect(after?.attempts.filter((attempt) => attempt.stepId === "prepare")).toHaveLength(1);
    expect(after?.attempts).toHaveLength(before!.attempts.length);
    expect(after?.attempts.at(-1)).toMatchObject({ stepId: "deliver", outcome: "succeeded", turnId: "resumed-turn" });
    expect(script.requests[0].messages[0].content).toContain("Last known-good checkpoint: prepared-turn");
    expect(script.requests[0].messages[0].content).toContain("Current step: deliver:");
    if (testCase.perturbation?.class === "interruption") expect(script.requests[0].messages[0].content).toContain("interrupted by application shutdown");
    expect(execution.trace?.toolCalls.map((call) => call.name)).toEqual(["read_file", "write_file"]);
    expect(script.requests.at(-1)!.messages.flatMap((message) => message.toolCalls ?? [])
      .map((call) => [call.name, JSON.parse(call.arguments).path])).toEqual([["read_file", "prepared.txt"], ["write_file", "delivered.txt"]]);
    expect(readFileSync(join(root, "prepared.txt"), "utf8")).toBe(prepared);
    expect(readFileSync(join(root, "delivered.txt"), "utf8")).toBe(`Delivered: ${prepared.trim()}\n`);
  });

  it("rejects correct output when the actual compaction mechanism was disabled", async () => {
    const testCase = createContextCases().find((candidate) => candidate.id === "context-pressure-canonical")!;
    const root = workspace(testCase);
    const execution = await executeContext(testCase, root, false);
    expect(execution.events.some((event) => event.type === "turn-complete")).toBe(true);
    expect(JSON.stringify(execution.requests[0].messages)).toContain(CONTEXT_STATE_VALUE);
    expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(true);
    expect(hasRequiredContextCompaction(execution.trace)).toBe(false);
    expect(execution.requests.some((request) => request.messages[0]?.content.startsWith("Summarize earlier conversation context"))).toBe(false);
  });

  it("preserves existing case identity, family, suite and validation domains", () => {
    expect(createContextCases().map((testCase) => [testCase.id, testCase.family, testCase.domain, testCase.suite, testCase.split])).toEqual([
      ["context-pressure-canonical", "context-pressure", "context-pressure", "challenge", "validation"],
      ["context-pressure-perturbed", "context-pressure", "context-pressure", "challenge", "validation"],
      ["resume-checkpoint-canonical", "resume-checkpoint", "resume", "challenge", "validation"],
      ["resume-checkpoint-perturbed", "resume-checkpoint", "resume", "challenge", "validation"],
    ]);
    expect(createContextCases().filter((testCase) => testCase.family === "context-pressure").every((testCase) => testCase.benchmark.requiredContextCompaction)).toBe(true);
  });

  it.each(createContextCases().filter((testCase) => testCase.family === "context-pressure"))("executes compaction and real file recovery for $id", async (testCase) => {
    const root = workspace(testCase);
    const execution = await executeContext(testCase, root);
    expect(execution.events).toContainEqual(expect.objectContaining({ type: "context-compaction", reason: "proactive", droppedCount: 4 }));
    expect(execution.events.filter((event) => event.type === "turn-error" || event.type === "turn-aborted")).toEqual([]);
    expect(execution.events.some((event) => event.type === "turn-complete")).toBe(true);
    expect(execution.requests.filter((request) => request.messages[0]?.content.startsWith("Summarize earlier conversation context"))).toHaveLength(1);
    expect(hasRequiredContextCompaction(execution.trace)).toBe(true);
    expect(hasRequiredContextCompaction({ ...execution.trace, events: execution.trace.events.filter((event) => event.type !== "context-compaction") })).toBe(false);
    expect(hasRequiredContextCompaction(undefined)).toBe(false);
    expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(true);
    if (testCase.familyRole === "positive") expect(readFileSync(join(root, "recovered-state.txt"), "utf8")).toBe(`Recovered: ${readFileSync(join(root, "durable-state.txt"), "utf8").trim()}\n`);
    else expect(execution.events.filter((event) => event.type === "tool-call").map((event) => event.name)).toEqual(["read_file"]);
    writeFileSync(join(root, "recovered-state.txt"), "incorrect state");
    expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(false);
  });

  it.each(createContextCases())("validates the reference and rejects an unexecuted positive fixture for $id", async (testCase) => {
    const root = workspace(testCase);
    if (testCase.familyRole === "positive") expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(false);
    cpSync(testCase.fixture!.referenceSolution!, root, { recursive: true });
    expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(true);
    if (testCase.family === "resume-checkpoint" || testCase.familyRole === "positive") {
      const resume = testCase.family === "resume-checkpoint";
      writeFileSync(join(root, resume ? "delivered.txt" : "recovered-state.txt"), readFileSync(join(root, resume ? "prepared.txt" : "durable-state.txt")));
      expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(false);
    }
  });

  it.each(createContextCases().filter((testCase) => testCase.family === "resume-checkpoint"))("continues the actual durable next step for $id", async (testCase) => {
    const root = workspace(testCase);
    const setup = await createResumeScenarioSetup(testCase, root, [{ role: "user", content: testCase.task.objective }]);
    expect(setup).toBeDefined();
    try {
      const store = new TaskStore(setup!.checkpoint.root);
      const before = await store.get(setup!.checkpoint.taskId);
      expect(before?.steps.map((step) => [step.id, step.state])).toEqual([["prepare", "completed"], ["deliver", "running"]]);
      expect(before?.attempts.filter((attempt) => attempt.stepId === "prepare")).toHaveLength(1);
      expect(before?.attempts).toHaveLength(testCase.perturbation?.class === "interruption" ? 3 : 2);
      expect(setup!.messages[0].content).toContain("Last known-good checkpoint: prepared-turn");
      expect(setup!.messages[0].content).toContain("Current step: deliver:");
      if (testCase.perturbation?.class === "interruption") expect(setup!.messages[0].content).toContain("interrupted by application shutdown");
      const { provider } = scriptedResumeProvider();
      const events: MossEvent[] = [];
      const tools = [...TOOL_REGISTRY.values()].filter((tool) => testCase.allowedCapabilities.includes(tool.name));
      await runTurn({
        provider, model: "fixture", messages: setup!.messages, ...setup!.options,
        tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        toolRegistry: new Map(tools.map((tool) => [tool.name, tool])), workspaceRoot: root,
        signal: new AbortController().signal, autoApprove: true, requestApproval: async () => ({ approved: true }), onEvent: (event) => events.push(event),
      });
      expect(events.filter((event) => event.type === "turn-error" || event.type === "turn-aborted")).toEqual([]);
      expect(events.some((event) => event.type === "turn-complete")).toBe(true);
      const after = await new TaskStore(setup!.checkpoint.root).get(setup!.checkpoint.taskId);
      expect(after?.steps.map((step) => step.state)).toEqual(["completed", "completed"]);
      expect(after?.attempts.filter((attempt) => attempt.stepId === "prepare")).toHaveLength(1);
      expect(after?.attempts.at(-1)).toMatchObject({ stepId: "deliver", outcome: "succeeded", turnId: "resumed-turn" });
      expect(events.filter((event) => event.type === "tool-call").map((event) => JSON.parse(event.arguments).path)).toEqual(["prepared.txt", "delivered.txt"]);
      expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(true);
      writeFileSync(join(root, "delivered.txt"), "wrong step");
      expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(false);
    } finally {
      await setup!.dispose();
    }
  });

  it.each([false, true])("does not complete a restored step from an unsupported claim (untagged output: %s)", async (untaggedOutput) => {
    const testCase = createContextCases().find((candidate) => candidate.id === "resume-checkpoint-perturbed")!;
    const root = workspace(testCase);
    if (untaggedOutput) writeFileSync(join(root, "delivered.txt"), readFileSync(join(root, "prepared.txt")));
    const setup = await createResumeScenarioSetup(testCase, root, [{ role: "user", content: testCase.task.objective }]);
    try {
      const events: MossEvent[] = [];
      const provider: ChatProvider = { kind: "deterministic", listModels: async () => [],
        async *streamChat(): AsyncIterable<ProviderStreamEvent> { yield { type: "text-delta", text: "All done." }; },
      };
      await runTurn({ provider, model: "fixture", messages: setup!.messages, ...setup!.options,
        tools: [], toolRegistry: new Map(), workspaceRoot: root, maxRounds: 1,
        signal: new AbortController().signal, requestApproval: async () => ({ approved: false }), onEvent: (event) => events.push(event),
      });
      expect(events.some((event) => event.type === "turn-complete")).toBe(false);
      const snapshot = await new TaskStore(setup!.checkpoint.root).get(setup!.checkpoint.taskId);
      expect(snapshot?.steps.find((step) => step.id === "deliver")?.state).toBe("running");
      expect(snapshot?.attempts.at(-1)?.outcome).toBeUndefined();
      expect((await collectEvalEvidence(testCase, root, new AbortController().signal)).every((entry) => entry.passed)).toBe(false);
    } finally {
      await setup!.dispose();
    }
  });

  it("drops transient tool state and excludes it from the real summary transcript", () => {
    const testCase: EvalCase = {
      schemaVersion: 1, id: "context-pressure-canonical", family: "context-pressure", profile: "platform", difficulty: "hard",
      task: { objective: "Recover state from durable-state.txt", acceptanceCriteria: [], assumptions: [], constraints: [] },
      allowedCapabilities: ["read_file", "write_file"], checks: [],
    };
    const setup = createContextScenarioSetup(testCase, [{ role: "system", content: "Complete the task." }, { role: "user", content: testCase.task.objective }])!;
    const result = compactIfNeeded(setup.messages, { contextLimit: setup.options.contextLimit!, reserveTokens: 640 });
    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBe(4);
    expect(JSON.stringify(result.messages)).not.toContain(CONTEXT_STATE_VALUE);
    expect(buildCompactionTranscript(setup.messages.slice(1, 1 + result.droppedCount))).not.toContain(CONTEXT_STATE_VALUE);
    expect(compactIfNeeded(setup.messages, { contextLimit: 0 }).compacted).toBe(false);
  });
});
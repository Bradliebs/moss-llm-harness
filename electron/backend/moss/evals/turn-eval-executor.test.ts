import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { EvalCase } from "../../../../common/evals";
import { ProviderError, type ChatProvider, type ChatRequest, type ProviderStreamEvent } from "../providers/types";
import type { Tool } from "../tools";
import { EvalRunner } from "./eval-runner";
import { scoreHarnessRun } from "./harness-scoring";
import { createTurnEvalExecutor } from "./turn-eval-executor";

const TEST_CASE: EvalCase = {
  schemaVersion: 1,
  id: "platform-turn-loop",
  profile: "platform",
  difficulty: "smoke",
  task: {
    objective: "Return a completed response",
    acceptanceCriteria: [{ id: "completed", description: "Turn completed", mandatory: true }],
    constraints: [],
    assumptions: [],
  },
  allowedCapabilities: [],
  checks: [{ id: "completion-receipt", criterionId: "completed", kind: "receipt", asserted: true }],
};

class DeterministicProvider implements ChatProvider {
  readonly kind = "deterministic";
  readonly requests: ChatRequest[] = [];

  async *streamChat(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "text-delta", text: "done" };
    yield { type: "usage", usage: { inputTokens: 12, outputTokens: 3 } };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

class ToolCallingProvider implements ChatProvider {
  readonly kind = "deterministic";
  private round = 0;

  constructor(private readonly toolName = "read_file", private readonly callCount = 1) {}

  async *streamChat(): AsyncIterable<ProviderStreamEvent> {
    if (this.round++ < this.callCount) {
      yield { type: "tool-call", toolCall: { id: `call-${this.round}`, name: this.toolName, arguments: "{}" } };
      return;
    }
    yield { type: "text-delta", text: "inspection complete" };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

class FailingProvider implements ChatProvider {
  readonly kind = "deterministic";

  async *streamChat(): AsyncIterable<ProviderStreamEvent> {
    throw new ProviderError("fixture provider unavailable", 400);
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}

class BlockingProvider implements ChatProvider {
  readonly kind = "deterministic";

  async *streamChat(_request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    await new Promise<void>((resolveWait) => signal.addEventListener("abort", () => resolveWait(), { once: true }));
    yield { type: "text-delta", text: "late" };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

class ReviewingProvider implements ChatProvider {
  readonly kind = "deterministic";
  readonly requests: ChatRequest[] = [];

  async *streamChat(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    if (this.requests.length === 1) {
      yield { type: "text-delta", text: "done" };
      return;
    }
    yield { type: "text-delta", text: '{"label":"pass","reasonCode":"criteria-addressed"}' };
    yield { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

describe("createTurnEvalExecutor", () => {
  it("seeds a stable production prompt and records only its profile and hash", async () => {
    const provider = new DeterministicProvider();
    const times = [
      new Date("2026-07-13T10:00:00.000Z"),
      new Date("2026-07-13T10:00:01.000Z"),
      new Date("2026-07-14T10:00:00.000Z"),
      new Date("2026-07-14T10:00:01.000Z"),
    ];
    const execute = createTurnEvalExecutor({
      provider,
      model: "fixture-model",
      maxOutputTokens: 2_048,
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      now: () => times.shift()!,
      promptNow: () => new Date("2026-07-13T12:00:00.000Z"),
    });

    const first = await execute(TEST_CASE, 0);
    const second = await execute(TEST_CASE, 1);

    expect(provider.requests[0].messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(provider.requests[0].messages[0].content).toContain("You are Moss");
    expect(provider.requests[0].messages[0].content).toContain("The current local date is 2026-07-13");
    expect(provider.requests[1].messages[0].content).toContain("The current local date is 2026-07-13");
    expect(JSON.parse(provider.requests[0].messages[1].content)).toEqual(TEST_CASE.task);
    expect(provider.requests[0].maxTokens).toBe(2_048);
    expect(first.promptProvenance).toEqual({
      profile: "deterministic-production-v2",
      seededMessagesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(second.promptProvenance).toEqual(first.promptProvenance);
  });

  it("supplies the public task contract without exposing hidden evaluation checks", async () => {
    const provider = new DeterministicProvider();
    const testCase: EvalCase = {
      ...TEST_CASE,
      task: {
        ...TEST_CASE.task,
        constraints: ["Preserve the existing input file"],
        assumptions: ["The workspace is initialized"],
      },
      checks: [{ id: "private-check-id", criterionId: "completed", kind: "receipt", asserted: true }],
    };
    const execute = createTurnEvalExecutor({
      provider,
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
    });

    await execute(testCase, 0);

    const instructions = provider.requests[0].messages.find((message) => message.role === "user")!.content;
    expect(instructions).toContain(testCase.task.objective);
    expect(instructions).toContain(testCase.task.acceptanceCriteria[0].description);
    expect(instructions).toContain(testCase.task.constraints[0]);
    expect(instructions).toContain(testCase.task.assumptions[0]);
    expect(instructions).not.toContain("private-check-id");
  });

  it("preserves explicit message overrides and labels them as custom", async () => {
    const provider = new DeterministicProvider();
    const customMessages = [{ role: "user" as const, content: "specialized case" }];
    const execute = createTurnEvalExecutor({
      provider,
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      messages: () => customMessages,
      now: () => new Date("2026-07-13T10:00:00.000Z"),
    });

    const result = await execute(TEST_CASE, 0);

    expect(provider.requests[0].messages.at(-1)).toEqual(customMessages[0]);
    expect(provider.requests[0].messages[0].content).not.toContain("You are Moss");
    expect(result.promptProvenance).toEqual({
      profile: "custom",
      seededMessagesHash: createHash("sha256").update(JSON.stringify(customMessages)).digest("hex"),
    });
  });

  it("runs the production turn loop and grades its end state independently", async () => {
    const times = [
      new Date("2026-07-13T10:00:00.000Z"),
      new Date("2026-07-13T10:00:01.000Z"),
      new Date("2026-07-13T10:00:02.000Z"),
      new Date("2026-07-13T10:00:03.000Z"),
    ];
    const execute = createTurnEvalExecutor({
      provider: new DeterministicProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      estimateCostUsd: (usage) => ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) / 1_000,
      now: () => times.shift()!,
    });
    const runner = new EvalRunner(execute, { now: () => new Date("2026-07-13T10:00:02.000Z") });

    const report = await runner.run([TEST_CASE]);

    expect(report.overall).toMatchObject({
      runs: 1,
      successes: 1,
      successRate: 1,
      averageTokens: 15,
      averageCostUsd: 0.015,
      averageDurationMs: 1_000,
    });
    expect(report.results[0].observation).toMatchObject({
      provider: "deterministic",
      model: "fixture-model",
      outcome: "completed",
      admissions: ["verified"],
    });
    const rawExecution = await execute(TEST_CASE, 1);
    expect(rawExecution.rubricInput).toEqual({ responseText: "done" });
    expect(JSON.stringify(report)).not.toContain("responseText");
    expect(rawExecution.trace).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 3 },
      terminalState: "completed",
      toolCalls: [],
    });
  });

  it("separates tool attempts from approval-gated execution", async () => {
    const tool: Tool = {
      name: "read_file",
      description: "Inspect the disposable fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, content: "fixture inspected" }),
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider(tool.name),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
    });
    const report = await new EvalRunner(execute).run([{
      ...TEST_CASE,
      allowedCapabilities: [tool.name],
    }]);

    expect(report.results[0].observation.admissions).toEqual(["attempted", "verified"]);
    expect(report.overall.admissions).toMatchObject({ attempted: 1, approved: 0, verified: 1 });
  });

  it("fails loudly when an untyped approval callback returns the wrong shape", async () => {
    const tool: Tool = {
      name: "write_file",
      description: "Mutate the disposable fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, content: "fixture changed" }),
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider(tool.name),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
      requestApproval: (async () => true) as never,
    });

    const result = await execute({ ...TEST_CASE, allowedCapabilities: [tool.name] }, 0);

    expect(result.observation).toMatchObject({
      outcome: "failed",
      failureReason: "Evaluation approval callback must return { approved: boolean }",
    });
  });

  it("delivers a declarative approval denial through the production gate", async () => {
    let executions = 0;
    const tool: Tool = {
      name: "write_file",
      description: "Mutate the disposable fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executions++;
        return { ok: true, content: "fixture changed" };
      },
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider(tool.name),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
      autoApprove: true,
    });

    const result = await execute({
      ...TEST_CASE,
      allowedCapabilities: [tool.name],
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "deny-write-1",
          type: "approval-response",
          capability: tool.name,
          invocation: 1,
          approved: false,
          comment: "Do not overwrite the protected fixture",
        }],
      },
    }, 0);

    expect(executions).toBe(0);
    expect(result.observation.admissions).toEqual(expect.arrayContaining(["attempted", "blocked"]));
    expect(result.trace?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "scenario-disturbance", id: "deny-write-1", status: "planned" }),
      expect.objectContaining({ type: "scenario-disturbance", id: "deny-write-1", status: "delivered" }),
      expect.objectContaining({ type: "approval-decision", approved: false, commentProvided: true }),
    ]));
    expect(JSON.stringify(result.trace)).not.toContain("protected fixture");
  });

  it("delegates unmatched approval invocations unless fallback denial is explicit", async () => {
    let executions = 0;
    let delegatedApprovals = 0;
    const tool: Tool = {
      name: "write_file",
      description: "Mutate the disposable fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executions++;
        return { ok: true, content: "fixture changed" };
      },
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider(tool.name, 2),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
      requestApproval: async () => {
        delegatedApprovals++;
        return { approved: false };
      },
    });

    await execute({
      ...TEST_CASE,
      allowedCapabilities: [tool.name],
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "approve-write-1",
          type: "approval-response",
          capability: tool.name,
          invocation: 1,
          approved: true,
        }],
      },
    }, 0);

    expect(executions).toBe(1);
    expect(delegatedApprovals).toBe(1);
  });

  it("injects a transient tool failure on the selected invocation and observes recovery", async () => {
    let executions = 0;
    const tool: Tool = {
      name: "read_file",
      description: "Inspect the disposable fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executions++;
        return { ok: true, content: "fixture inspected" };
      },
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider(tool.name),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
    });

    const result = await execute({
      ...TEST_CASE,
      allowedCapabilities: [tool.name],
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "transient-read-1",
          type: "tool-failure",
          capability: tool.name,
          invocation: 1,
          failure: "transient",
        }],
      },
    }, 0);

    expect(executions).toBe(1);
    expect(result.observation.admissions).toContain("attempted");
    expect(result.trace?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "scenario-disturbance", id: "transient-read-1", status: "delivered" }),
      expect.objectContaining({ type: "recovery", outcome: "attempted" }),
      expect.objectContaining({ type: "recovery", outcome: "succeeded" }),
    ]));
  });

  it("attributes an undelivered disturbance to harness orchestration", async () => {
    const execute = createTurnEvalExecutor({
      provider: new DeterministicProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
    });

    const result = await execute({
      ...TEST_CASE,
      allowedCapabilities: ["write_file"],
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "missing-write",
          type: "approval-response",
          capability: "write_file",
          invocation: 1,
          approved: false,
        }],
      },
    }, 0);

    expect(result).toMatchObject({
      failureSource: "harness-orchestration",
      observation: {
        outcome: "failed",
        failureReason: "Planned scenario disturbance 'missing-write' was not delivered",
      },
    });
    expect(result.trace?.events).toContainEqual(expect.objectContaining({
      type: "scenario-disturbance",
      id: "missing-write",
      status: "undelivered",
    }));
    expect(result.trace?.terminalState).toBe("error");
    expect(result.trace?.events.at(-1)).toMatchObject({ type: "terminal", state: "error" });
  });

  it("injects a permanent tool failure without invoking the underlying tool", async () => {
    let executions = 0;
    const tool: Tool = {
      name: "read_file",
      description: "Inspect the disposable fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executions++;
        return { ok: true, content: "fixture inspected" };
      },
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider(tool.name),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
    });

    const result = await execute({
      ...TEST_CASE,
      allowedCapabilities: [tool.name],
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "permanent-read-1",
          type: "tool-failure",
          capability: tool.name,
          invocation: 1,
          failure: "permanent",
        }],
      },
    }, 0);

    expect(executions).toBe(0);
    expect(result.trace?.toolCalls[0]).toMatchObject({ name: tool.name, ok: false });
    expect(result.trace?.events).toContainEqual(expect.objectContaining({
      type: "scenario-disturbance",
      id: "permanent-read-1",
      status: "delivered",
    }));
  });

  it("interrupts the provider after output and preserves provider attribution", async () => {
    const execute = createTurnEvalExecutor({
      provider: new DeterministicProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
    });

    const result = await execute({
      ...TEST_CASE,
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "interrupt-output-1",
          type: "provider-interruption",
          invocation: 1,
          phase: "after-output",
        }],
      },
    }, 0);

    expect(result.failureSource).toBe("provider-model");
    expect(result.observation.outcome).toBe("failed");
    expect(result.trace?.events).toContainEqual(expect.objectContaining({
      type: "scenario-disturbance",
      id: "interrupt-output-1",
      status: "delivered",
    }));
  });

  it("retries a provider interruption delivered before output", async () => {
    const execute = createTurnEvalExecutor({
      provider: new DeterministicProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
    });

    const result = await execute({
      ...TEST_CASE,
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "interrupt-before-1",
          type: "provider-interruption",
          invocation: 1,
          phase: "before-output",
        }],
      },
    }, 0);

    expect(result.observation.outcome).toBe("completed");
    expect(result.failureSource).toBeUndefined();
    expect(result.trace?.events).toContainEqual(expect.objectContaining({
      type: "scenario-disturbance",
      id: "interrupt-before-1",
      status: "delivered",
    }));
  });

  it("seeds bounded context pressure without copying it into the trace", async () => {
    const provider = new DeterministicProvider();
    const execute = createTurnEvalExecutor({
      provider,
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
    });

    const result = await execute({
      ...TEST_CASE,
      scenario: {
        schemaVersion: 1,
        disturbances: [{
          id: "context-setup-1",
          type: "context-pressure",
          messageCount: 4,
          charactersPerMessage: 64,
        }],
      },
    }, 0);

    expect(provider.requests[0].messages).toHaveLength(6);
    expect(result.trace?.events).toContainEqual(expect.objectContaining({
      type: "scenario-disturbance",
      id: "context-setup-1",
      status: "delivered",
    }));
    expect(JSON.stringify(result.trace)).not.toContain("scenario-context");
  });

  it("applies a harness variant and returns a trace from the production loop", async () => {
    const tool: Tool = {
      name: "write_file",
      description: "Mutate the disposable fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, content: "fixture changed" }),
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider(tool.name),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
      variant: {
        schemaVersion: 1,
        id: "auto-approved",
        description: "Run mutating tools without a prompt",
        autoApprove: true,
      },
    });
    const result = await execute({
      ...TEST_CASE,
      allowedCapabilities: [tool.name],
    }, 0);

    expect(result.trace?.toolCalls).toEqual([expect.objectContaining({
      name: "write_file",
      approvalRequested: false,
      autoApproved: true,
      ok: true,
    })]);
  });

  it("runs the optional reviewer as a non-gating diagnostic with separate overhead", async () => {
    const provider = new ReviewingProvider();
    const execute = createTurnEvalExecutor({
      provider,
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      estimateCostUsd: (usage) => ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) / 1_000,
      variant: {
        schemaVersion: 1,
        id: "reviewed",
        description: "Diagnostic reviewer",
        contextLimit: 4_000,
        runtime: {
          contextStrategy: "compact",
          planningPolicy: "incremental",
          verificationCadence: "after-mutation",
          recoveryPolicy: "signature-aware",
          reviewerPass: "diagnostic",
        },
      },
    });

    const result = await execute(TEST_CASE, 0);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].tools).toEqual([]);
    expect(provider.requests[1].maxTokens).toBe(256);
    expect(result.observation.outcome).toBe("completed");
    expect(result.diagnosticReview).toMatchObject({
      diagnostic: true,
      label: "pass",
      reasonCode: "criteria-addressed",
      usage: { inputTokens: 7, outputTokens: 2 },
      estimatedCostUsd: 0.009,
    });
  });

  it.each([true, false])("gives the reviewer observed tool and approval evidence without hidden data (approved=%s)", async (approved) => {
    let reviewRequest: ChatRequest | undefined;
    const provider: ChatProvider = {
      kind: "deterministic",
      listModels: async () => ["fixture-model"],
      async *streamChat(request) {
        if (request.messages[0].content.startsWith("You are a diagnostic reviewer")) {
          reviewRequest = request;
          yield { type: "text-delta", text: '{"label":"unknown","reasonCode":"unobserved-artifact"}' };
        } else if (request.messages.some((message) => message.role === "tool")) {
          yield { type: "text-delta", text: "done" };
        } else {
          yield { type: "tool-call", toolCall: { id: "fixture-write", name: "write_file", arguments: '{"content":"private-argument"}' } };
        }
      },
    };
    const executeTool = vi.fn(async () => ({ ok: true, content: "private-tool-output" }));
    const execute = createTurnEvalExecutor({
      provider,
      model: "fixture-model",
      workspaceRoot: () => "",
      toolRegistry: new Map([["write_file", { name: "write_file", description: "Fixture write", parameters: {}, execute: executeTool }]]),
      requestApproval: async () => ({ approved }),
      variant: {
        schemaVersion: 1, id: "reviewed", description: "Observed execution review", autoApprove: false,
        runtime: { contextStrategy: "full", planningPolicy: "free-form", verificationCadence: "terminal", recoveryPolicy: "standard", reviewerPass: "diagnostic" },
      },
    });
    const result = await execute({ ...TEST_CASE, allowedCapabilities: ["write_file"] }, 0);

    const reviewText = reviewRequest?.messages[1].content;
    expect(reviewText).toBeDefined();
    expect(JSON.parse(reviewText!)).toMatchObject({
      observedExecution: {
        terminalState: "completed",
        toolCalls: [{ name: "write_file", ok: approved, approvalRequested: true, risk: "mutating" }],
      },
    });
    expect(reviewText).not.toContain("private-argument");
    expect(reviewText).not.toContain("private-tool-output");
    expect(reviewText).not.toContain("completion-receipt");
    expect(reviewRequest?.maxTokens).toBe(256);
    expect(result.observation.outcome).toBe("completed");
    expect(executeTool).toHaveBeenCalledTimes(approved ? 1 : 0);
  });

  it.each(["timeout", "cancellation"])("bounds diagnostic review on %s without changing the task outcome", async (stop) => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      let notifyReviewStarted!: () => void;
      const reviewStarted = new Promise<void>((resolve) => { notifyReviewStarted = resolve; });
      let reviewSignal: AbortSignal | undefined;
      const provider: ChatProvider = {
        kind: "deterministic",
        listModels: async () => ["fixture-model"],
        async *streamChat(request, signal) {
          if (request.messages[0].content.startsWith("You are a diagnostic reviewer")) {
            reviewSignal = signal;
            notifyReviewStarted();
            await new Promise<void>(() => {});
            return;
          }
          yield { type: "text-delta", text: "done" };
        },
      };
      const execute = createTurnEvalExecutor({
        provider,
        model: "fixture-model",
        toolRegistry: new Map(),
        workspaceRoot: () => "",
        signal: parent.signal,
        variant: {
          schemaVersion: 1,
          id: "reviewed",
          description: "Bounded diagnostic review",
          runtime: {
            contextStrategy: "full",
            planningPolicy: "free-form",
            verificationCadence: "terminal",
            recoveryPolicy: "standard",
            reviewerPass: "diagnostic",
          },
        },
      });
      let settled = false;
      const running = execute(TEST_CASE, 0).then((result) => { settled = true; return result; });
      await reviewStarted;
      if (stop === "cancellation") parent.abort();
      await vi.advanceTimersByTimeAsync(stop === "timeout" ? 30_000 : 0);

      expect(settled).toBe(true);
      expect(reviewSignal?.aborted).toBe(true);
      expect(await running).toMatchObject({
        observation: { outcome: "completed" },
        diagnosticReview: { label: "unknown", reasonCode: stop === "timeout" ? "reviewer-timeout" : "reviewer-cancelled" },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports budget exhaustion separately from user cancellation", async () => {
    const execute = createTurnEvalExecutor({
      provider: new DeterministicProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      variant: {
        schemaVersion: 1,
        id: "token-limited",
        description: "Stop after ten tokens",
        budget: { maxTokens: 10 },
      },
    });

    const result = await execute(TEST_CASE, 0);

    expect(result.observation.outcome).toBe("budget-exhausted");
    expect(result.observation.failureReason).toBe("token budget of 10 exceeded");
    expect(result.observation.admissions).toContain("budget-exhausted");
    expect(result.trace?.events).toContainEqual(expect.objectContaining({
      type: "budget-boundary",
      boundary: "tokens",
      limit: 10,
      observed: 15,
    }));
    expect(result.trace?.terminalState).toBe("budget-exhausted");
    expect(result.trace?.events.at(-1)).toMatchObject({ type: "terminal", state: "budget-exhausted" });
  });

  it.each([2, 1])("enforces a %i-action budget before executing a forbidden extra mutation", async (maxActions) => {
    let mutations = 0;
    const tool: Tool = {
      name: "write_file", description: "Record a mutation", parameters: { type: "object", properties: {} },
      execute: async () => { mutations++; return { ok: true, content: "written" }; },
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider("write_file", 2), model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]), workspaceRoot: () => "", autoApprove: true,
      variant: { schemaVersion: 1, id: "budget-pair", description: "Matched action budget", budget: { maxActions } },
    });
    const result = await execute({ ...TEST_CASE, allowedCapabilities: ["write_file"] }, 0);
    expect(mutations).toBe(maxActions);
    expect(result.observation.outcome).toBe(maxActions === 2 ? "completed" : "budget-exhausted");
    expect(result.trace?.toolCalls.filter((call) => call.ok === true)).toHaveLength(maxActions);
    const budgetCase: EvalCase = {
      ...TEST_CASE, allowedCapabilities: ["write_file"],
      benchmark: { budget: { maxActions }, ...(maxActions === 1 ? { expectedActionBudgetStop: 1 } : {}) },
    };
    const report = await new EvalRunner(async () => result).run([budgetCase]);
    expect(report.results[0].success).toBe(true);
    const scored = scoreHarnessRun(budgetCase, report.results[0], result.trace!);
    expect(scored.mechanisms?.budgetCompliance.rate).toBe(1);
    expect(scored.mechanisms?.outcomeCompletion.rate).toBe(maxActions === 2 ? 1 : 0);
    expect(scored.process.consistency).toBe(1);
    if (maxActions === 1) {
      const missingTrace = await new EvalRunner(async () => ({ ...result, trace: undefined })).run([budgetCase]);
      expect(missingTrace.results[0].success).toBe(false);
      const failedProvider = await new EvalRunner(async () => ({ ...result, failureSource: "provider-model" })).run([budgetCase]);
      expect(failedProvider.results[0].success).toBe(false);
      const unsafeTrace = structuredClone(result.trace!);
      unsafeTrace.toolCalls.at(-1)!.ok = true;
      const unsafe = await new EvalRunner(async () => ({ ...result, trace: unsafeTrace })).run([budgetCase]);
      expect(unsafe.results[0].success).toBe(false);
    }
  });

  it("preserves provider failures in the observation", async () => {
    const execute = createTurnEvalExecutor({
      provider: new FailingProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
    });

    const result = await execute(TEST_CASE, 0);

    expect(result.observation).toMatchObject({
      outcome: "failed",
      failureReason: "fixture provider unavailable",
    });
    expect(result.failureSource).toBe("provider-model");
  });

  it("propagates a parent matrix cancellation into the active turn", async () => {
    const controller = new AbortController();
    const execute = createTurnEvalExecutor({
      provider: new BlockingProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      signal: controller.signal,
    });

    const execution = execute(TEST_CASE, 0);
    controller.abort();

    await expect(execution).resolves.toMatchObject({ observation: { outcome: "cancelled" } });
  });

  it("does not mutate when cancellation happens while approval is pending", async () => {
    const controller = new AbortController();
    let mutations = 0;
    const tool: Tool = {
      name: "write_file", description: "Record a mutation", parameters: { type: "object", properties: {} },
      execute: async () => { mutations++; return { ok: true, content: "written" }; },
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider("write_file"),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
      signal: controller.signal,
      requestApproval: async () => { controller.abort(); return { approved: true }; },
    });

    const result = await execute({ ...TEST_CASE, allowedCapabilities: ["write_file"] }, 0);
    expect(mutations).toBe(0);
    expect(result.observation.outcome).toBe("cancelled");
    expect(result.trace?.toolCalls.filter((call) => call.ok === true)).toEqual([]);
  });
});
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PracticeConfig, PracticeReport, TurnTrace } from "../../../../common/types";
import type { ChatProvider } from "../providers/types";
import type { Tool } from "../tools/types";
import { captureOutcomeContext, historyHasUntrustedContent, PRACTICE_TOOLS, recommend, runPractice } from "./practice";
import { normalizePracticeConfig, PracticeScheduler } from "./practice-store";

function trace(id: string, overrides: Partial<TurnTrace> = {}): TurnTrace {
  return {
    schemaVersion: 1, id, createdAt: "2026-09-27T00:00:00.000Z", providerKind: "openai-compatible", endpoint: "http://localhost:11434/v1",
    primaryModel: "baseline", tools: [{ name: "read_file", description: "", parameters: { type: "object", properties: { path: { type: "string" } } } }, { name: "run_command", description: "", parameters: { type: "object", properties: {} } }],
    calls: [{ index: 0, startedAt: "x", durationMs: 4_000, model: "baseline", request: { messages: [{ role: "user", content: "fix it" }], toolNames: ["read_file"] }, response: { text: "", toolCalls: [{ id: "a", name: "read_file", arguments: "{\"path\":\"a\"}" }] } }],
    outcome: "completed", verification: { passed: 1, failed: 0 },
    ...overrides,
  };
}

function scripted(reply: "tool" | "text"): ChatProvider {
  return {
    kind: "openai-compatible",
    async *streamChat() {
      if (reply === "tool") yield { type: "tool-call", toolCall: { id: "c", name: "read_file", arguments: "{\"path\":\"a\"}" } };
      else yield { type: "text-delta", text: "done" };
    },
    async listModels() { return []; },
  };
}

describe("captureOutcomeContext", () => {
  it("records a clean checkout with verification commands and skips everything else", async () => {
    const head = "a".repeat(40);
    const clean = vi.fn(async (args: string[]) => args[0] === "rev-parse" ? `${head}\n` : "");
    expect(await captureOutcomeContext("C:\\ws", ["npm test", " "], clean)).toEqual({ workspaceRoot: "C:\\ws", gitHead: head, verifyCommands: ["npm test"] });
    expect(await captureOutcomeContext("C:\\ws", ["npm test"], async (args) => args[0] === "rev-parse" ? head : " M a.ts")).toBeUndefined();
    expect(await captureOutcomeContext("C:\\ws", [], clean)).toBeUndefined();
    expect(await captureOutcomeContext("C:\\ws", ["npm test"], async () => { throw new Error("not a repo"); })).toBeUndefined();
  });
});

describe("runPractice", () => {
  it("replays decisions for every trace and skips its own traces", async () => {
    const report = await runPractice({ traces: [trace("t1"), trace("t2", { primaryModel: "cand" })], candidates: ["cand", "other"] }, {
      providerFor: (model) => scripted(model === "cand" ? "tool" : "text"),
      registry: new Map(),
      verify: vi.fn(),
      git: vi.fn(),
      signal: new AbortController().signal,
    });
    expect(report.tracesUsed).toBe(2);
    expect(report.outcomeTraces).toBe(0);
    expect(report.candidates.map((candidate) => [candidate.model, candidate.decision.calls, candidate.decision.sameAction])).toEqual([["cand", 1, 1], ["other", 2, 0]]);
    expect(report.baseline).toMatchObject({ models: ["baseline", "cand"], medianLatencyMs: 4_000 });
  });

  it("works discriminating tasks forward in a disposable copy with file tools only, graded by verification", async () => {
    const workspace = process.cwd();
    const git = vi.fn(async () => "");
    const verify = vi.fn(async () => ({ ok: false, results: [] }));
    // Start state fails, then the candidate run passes.
    verify.mockResolvedValueOnce({ ok: false, results: [] }).mockResolvedValueOnce({ ok: true, results: [] });
    const seenTools: string[][] = [];
    const recordPractice = vi.fn(async () => undefined);
    const readTool: Tool = { name: "read_file", description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true, content: "x" }) };
    let dirs = 0;
    const report = await runPractice({
      traces: [trace("t1", { outcomeContext: { workspaceRoot: workspace, gitHead: "b".repeat(40), verifyCommands: ["node test.js"] } })],
      candidates: ["cand"],
    }, {
      providerFor: () => ({
        kind: "openai-compatible",
        async *streamChat(req) {
          seenTools.push((req.tools ?? []).map((tool) => tool.name));
          yield { type: "text-delta", text: "fixed" };
        },
        async listModels() { return []; },
      }),
      registry: new Map([["read_file", readTool]]),
      verify,
      git,
      recordPractice,
      signal: new AbortController().signal,
      makeTempDir: async () => `${process.env.TEMP ?? "/tmp"}/moss-practice-test-${dirs++}`,
    });
    expect(report.outcomeTraces).toBe(1);
    expect(report.candidates[0].outcome).toEqual({ runs: 1, passed: 1 });
    // run_command was in the trace but is never offered in practice.
    expect(seenTools.at(-1)).toEqual(["read_file"]);
    expect(PRACTICE_TOOLS.has("run_command")).toBe(false);
    expect(git.mock.calls.filter((call) => (call as unknown as string[][])[0][0] === "worktree" && (call as unknown as string[][])[0][1] === "add")).toHaveLength(2);
    // Copies are removed without `git worktree remove`, which follows junctions on Windows.
    expect(git.mock.calls.some((call) => (call as unknown as string[][])[0][1] === "remove")).toBe(false);
    expect(git.mock.calls.filter((call) => (call as unknown as string[][])[0][1] === "prune")).toHaveLength(2);
    expect(recordPractice).toHaveBeenCalledWith("cand", "chat", "s");
  });

  it("uses a trace for decisions only when verification already passes at the start commit", async () => {
    const report = await runPractice({
      traces: [trace("t1", { outcomeContext: { workspaceRoot: process.cwd(), gitHead: "b".repeat(40), verifyCommands: ["npm test"] } })],
      candidates: ["cand"],
    }, {
      providerFor: () => scripted("tool"),
      registry: new Map(),
      verify: async () => ({ ok: true, results: [] }),
      git: async () => "",
      signal: new AbortController().signal,
      makeTempDir: async () => `${process.env.TEMP ?? "/tmp"}/moss-practice-test-skip`,
    });
    expect(report.outcomeTraces).toBe(0);
    expect(report.candidates[0].outcome.runs).toBe(0);
  });
});

describe("practice copies", () => {
  it("never deletes the real dependency folders it links into a copy", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "moss-practice-ws-"));
    mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(workspace, "node_modules", "pkg", "index.js"), "module.exports = 1;");
    const copyDir = join(tmpdir(), `moss-practice-copy-${Date.now()}`);
    try {
      const report = await runPractice({
        traces: [trace("t1", { outcomeContext: { workspaceRoot: workspace, gitHead: "c".repeat(40), verifyCommands: ["node test.js"] } })],
        candidates: ["cand"],
      }, {
        providerFor: () => scripted("text"),
        registry: new Map(),
        verify: async (_commands, cwd) => {
          // The linked folder is visible inside the copy.
          expect(existsSync(join(cwd, "node_modules", "pkg", "index.js"))).toBe(true);
          return { ok: true, results: [] };
        },
        git: async (args) => {
          if (args[0] === "worktree" && args[1] === "add") mkdirSync(args[3], { recursive: true });
          return "";
        },
        signal: new AbortController().signal,
        makeTempDir: async () => copyDir,
      });
      expect(report.outcomeTraces).toBe(0);
      expect(existsSync(copyDir)).toBe(false);
      expect(readFileSync(join(workspace, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not run a trace forward when its history holds untrusted content", () => {
    const tainted = trace("t1", {
      calls: [{
        index: 0, startedAt: "x", durationMs: 1, model: "baseline",
        request: {
          messages: [
            { role: "user", content: "summarize and fix" },
            { role: "assistant", content: "", toolCalls: [{ id: "f", name: "fetch_url", arguments: "{}" }] },
            { role: "tool", toolCallId: "f", content: "page" },
          ],
          toolNames: [],
        },
        response: { text: "", toolCalls: [] },
      }],
    });
    expect(historyHasUntrustedContent(tainted)).toBe(true);
    expect(historyHasUntrustedContent(trace("t2"))).toBe(false);
  });
});

describe("recommend", () => {
  const base: PracticeReport = {
    startedAt: "x", finishedAt: "y", tracesUsed: 5, outcomeTraces: 4,
    baseline: { models: ["base"], medianLatencyMs: 4_000, outcome: { runs: 4, passed: 2 } },
    candidates: [],
  };

  it("recommends a model that passed more verified tasks, or one that decides the same much faster", () => {
    expect(recommend({ ...base, candidates: [{ model: "better", decision: { calls: 5, sameAction: 3, validArgumentRate: 1, errors: 0 }, outcome: { runs: 4, passed: 4 } }] }))
      .toMatchObject({ model: "better", role: "chat", reason: expect.stringContaining("4 of 4") });
    expect(recommend({ ...base, candidates: [{ model: "quick", decision: { calls: 10, sameAction: 9, validArgumentRate: 1, errors: 0, medianLatencyMs: 1_000 }, outcome: { runs: 0, passed: 0 } }] }))
      .toMatchObject({ model: "quick", role: "fast", reason: expect.stringContaining("4.0× the speed") });
    expect(recommend({ ...base, candidates: [{ model: "meh", decision: { calls: 10, sameAction: 5, validArgumentRate: 1, errors: 0, medianLatencyMs: 1_000 }, outcome: { runs: 2, passed: 2 } }] })).toBeUndefined();
  });
});

describe("PracticeScheduler", () => {
  const config: PracticeConfig = normalizePracticeConfig({ enabled: true, candidates: ["cand"], idleMinutes: 20 });

  it("runs only when idle, on mains power, not busy, enabled, and not run recently", async () => {
    const run = vi.fn(async () => undefined);
    const state = { idle: 30 * 60, battery: false, busy: false, last: undefined as number | undefined, config };
    const scheduler = new PracticeScheduler({
      idleSeconds: () => state.idle, onBattery: () => state.battery, busy: () => state.busy,
      config: async () => state.config, lastRunAt: async () => state.last, run, now: () => 100 * 3_600_000,
    });
    expect(await scheduler.tick()).toBe(true);
    for (const change of [{ idle: 60 }, { battery: true }, { busy: true }, { last: 99 * 3_600_000 }, { config: { ...config, enabled: false } }, { config: { ...config, candidates: [] } }]) {
      Object.assign(state, { idle: 30 * 60, battery: false, busy: false, last: undefined, config }, change);
      expect(await scheduler.tick()).toBe(false);
    }
    expect(run).toHaveBeenCalledOnce();
  });

  it("normalizes stored configuration", () => {
    expect(normalizePracticeConfig({ enabled: "yes", candidates: ["a", 3, ""], maxTraces: 999, idleMinutes: 1 })).toEqual({
      enabled: false, baseUrl: "http://localhost:11434/v1", candidates: ["a"], maxTraces: 20, idleMinutes: 5,
    });
  });
});

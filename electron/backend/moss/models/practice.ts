// electron/backend/moss/models/practice.ts
//
// Practice runs. Your recorded work becomes the benchmark: each candidate
// model replays recent traces (same context, compare decisions), and traces
// recorded in a clean git workspace are re-run forward in a disposable
// worktree of the exact starting commit, then graded by the original
// verification commands. Candidates get file tools inside the copy only: no
// shell, network, email, or approval-gated tool. Nothing about the user's
// setup changes; the report ends in an optional recommendation.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PracticeCandidateResult, PracticeProgress, PracticeReport, TurnTrace } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import { WorkingStateStore } from "../governed/working-state";
import { isUntrustedSource } from "../safety/provenance";
import type { ChatProvider } from "../providers/types";
import type { Tool } from "../tools/types";
import type { VerifyResult } from "../verify/verifier";
import { taskKindFor } from "./model-performance";
import { replayTrace } from "./trace-replay";
import { VERIFICATION_FILES } from "../verify/verification-files";

/** Tools a candidate may use in a practice copy: files inside the copy, nothing else. */
export const PRACTICE_TOOLS = new Set(["read_file", "list_dir", "search_files", "glob_files", "write_file", "edit_file", "move_file", "plan", "git_status", "git_diff"]);
/** Dependency folders linked into the copy so verification can run; writes to them are blocked. */
const DEPENDENCY_DIRS = ["node_modules", ".venv", "venv", "vendor"];
const OUTCOME_TIMEOUT_MS = 10 * 60_000;
const MIN_OUTCOME_RUNS = 3;

export interface PracticeDeps {
  providerFor: (model: string) => ChatProvider;
  registry: ReadonlyMap<string, Tool>;
  verify: (commands: string[], cwd: string, signal: AbortSignal) => Promise<VerifyResult>;
  git: (args: string[], cwd: string) => Promise<string>;
  recordPractice?: (model: string, kind: ReturnType<typeof taskKindFor>, outcome: "s" | "f") => Promise<void>;
  signal: AbortSignal;
  onProgress?: (progress: PracticeProgress) => void;
  now?: () => Date;
  makeTempDir?: () => Promise<string>;
}

export const runGit = (args: string[], cwd: string): Promise<string> => new Promise((resolve, reject) => {
  execFile("git", args, { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr || error.message).trim().slice(0, 300)}`));
    else resolve(String(stdout));
  });
});

/** Start state for practice, when the workspace is a clean git checkout. */
export async function captureOutcomeContext(workspaceRoot: string, verifyCommands: readonly string[], git = runGit): Promise<TurnTrace["outcomeContext"] | undefined> {
  const commands = verifyCommands.map((command) => command.trim()).filter(Boolean);
  if (!workspaceRoot || commands.length === 0) return undefined;
  try {
    const head = (await git(["rev-parse", "HEAD"], workspaceRoot)).trim();
    const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], workspaceRoot)).trim();
    return /^[0-9a-f]{40}$/.test(head) && !dirty ? { workspaceRoot, gitHead: head, verifyCommands: commands } : undefined;
  } catch {
    return undefined;
  }
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Whether the recorded context already contains untrusted tool output; such a
 *  trace is never run forward unattended, since the content could steer the candidate. */
export function historyHasUntrustedContent(trace: TurnTrace): boolean {
  const messages = trace.calls[0]?.request.messages ?? [];
  const names = new Map<string, string>();
  for (const message of messages) for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  return messages.some((message) => message.role === "tool" && message.toolCallId !== undefined && isUntrustedSource(names.get(message.toolCallId) ?? ""));
}

function originalSucceeded(trace: TurnTrace): boolean {
  return trace.outcome === "completed" && (trace.verification?.passed ?? 0) > 0;
}

interface Copy {
  dir: string;
  dispose: () => Promise<void>;
}

async function checkout(trace: TurnTrace, deps: PracticeDeps): Promise<Copy> {
  const context = trace.outcomeContext!;
  const dir = await (deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), "moss-practice-"))))();
  // The temp dir must not exist for `git worktree add`; it is created empty above.
  await rm(dir, { recursive: true, force: true });
  await deps.git(["worktree", "add", "--detach", dir, context.gitHead], context.workspaceRoot);
  const links: string[] = [];
  for (const name of DEPENDENCY_DIRS) {
    const source = join(context.workspaceRoot, name);
    const link = join(dir, name);
    if (existsSync(source) && !existsSync(link)) {
      await symlink(source, link, "junction").then(() => links.push(link), () => undefined);
    }
  }
  return {
    dir,
    dispose: async () => {
      // Remove the links first, without following them: `git worktree remove`
      // follows junctions on Windows and would empty the real folders.
      for (const link of links) {
        const stat = await lstat(link).catch(() => undefined);
        if (stat?.isSymbolicLink()) await unlink(link).catch(() => undefined);
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await deps.git(["worktree", "prune"], context.workspaceRoot).catch(() => undefined);
    },
  };
}

async function runForward(trace: TurnTrace, model: string, copy: Copy, deps: PracticeDeps): Promise<"s" | "f"> {
  const context = trace.outcomeContext!;
  const tools = trace.tools.filter((tool) => PRACTICE_TOOLS.has(tool.name) && deps.registry.has(tool.name));
  const registry = new Map(tools.map((tool) => [tool.name, deps.registry.get(tool.name)!]));
  const workingState = new WorkingStateStore();
  for (const name of DEPENDENCY_DIRS) workingState.add("protected", `${name}/**`, "user", "Linked dependency folder in a practice copy");
  for (const pattern of VERIFICATION_FILES) workingState.add("protected", pattern, "user", "Decides what verification runs");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  deps.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, OUTCOME_TIMEOUT_MS);
  try {
    await runTurn({
      provider: deps.providerFor(model),
      model,
      messages: trace.calls[0].request.messages.map((message) => ({ ...message })),
      tools,
      toolRegistry: registry,
      workspaceRoot: copy.dir,
      workingState,
      signal: controller.signal,
      autoApprove: true,
      requestApproval: async () => ({ approved: false, comment: "Practice runs never approve prompts." }),
      verify: { enabled: true, commands: context.verifyCommands },
      maxRounds: 12,
      onEvent: () => undefined,
      streamRetryBaseMs: 0,
    });
  } finally {
    clearTimeout(timer);
    deps.signal.removeEventListener("abort", abort);
  }
  deps.signal.throwIfAborted();
  const final = await deps.verify(context.verifyCommands, copy.dir, deps.signal);
  return final.ok ? "s" : "f";
}

export async function runPractice(input: { traces: readonly TurnTrace[]; candidates: readonly string[]; maxTraces?: number }, deps: PracticeDeps): Promise<PracticeReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const traces = input.traces.filter((trace) => trace.calls.length > 0).slice(0, input.maxTraces ?? 8);
  const outcomeCandidates = traces.filter((trace) => trace.outcomeContext && existsSync(trace.outcomeContext.workspaceRoot) && !historyHasUntrustedContent(trace));
  const total = input.candidates.length * (traces.length + outcomeCandidates.length) + outcomeCandidates.length;
  let completed = 0;
  const progress = (message: string): void => deps.onProgress?.({ message, completed, total });

  // Only traces whose verification fails at the start commit can tell models
  // apart; if the checks already pass, doing nothing would pass too.
  const discriminating: TurnTrace[] = [];
  for (const trace of outcomeCandidates) {
    if (deps.signal.aborted) break;
    progress(`Checking the start state of a ${trace.primaryModel} turn`);
    try {
      const copy = await checkout(trace, deps);
      try {
        const baseline = await deps.verify(trace.outcomeContext!.verifyCommands, copy.dir, deps.signal);
        if (!baseline.ok) discriminating.push(trace);
      } finally {
        await copy.dispose();
      }
    } catch {
      // The commit or workspace is gone; decision replay still covers it.
    }
    completed += 1;
  }

  const baselineLatencies = traces.flatMap((trace) => trace.calls.map((call) => call.durationMs));
  const results: PracticeCandidateResult[] = [];
  for (const model of input.candidates) {
    const result: PracticeCandidateResult = { model, decision: { calls: 0, sameAction: 0, validArgumentRate: 0, errors: 0 }, outcome: { runs: 0, passed: 0 } };
    const latencies: number[] = [];
    let validCalls = 0;
    try {
      for (const trace of traces.filter((item) => item.primaryModel !== model)) {
        if (deps.signal.aborted) break;
        progress(`Replaying ${trace.calls.length} decision${trace.calls.length === 1 ? "" : "s"} with ${model}`);
        const report = await replayTrace(trace, deps.providerFor(model), model, { signal: deps.signal });
        result.decision.calls += report.summary.calls;
        result.decision.sameAction += report.summary.sameAction;
        result.decision.errors += report.summary.errors;
        validCalls += Math.round(report.summary.validArgumentRate * report.summary.calls);
        latencies.push(...report.calls.map((call) => call.candidate.durationMs).filter((value): value is number => typeof value === "number"));
        completed += 1;
      }
      for (const trace of discriminating) {
        if (deps.signal.aborted) break;
        progress(`Working a ${trace.primaryModel} task forward with ${model} in a disposable copy`);
        const copy = await checkout(trace, deps);
        try {
          const grade = await runForward(trace, model, copy, deps);
          result.outcome.runs += 1;
          if (grade === "s") result.outcome.passed += 1;
          const kind = taskKindFor(trace.calls.flatMap((call) => call.response.toolCalls.map((toolCall) => toolCall.name)), false);
          await deps.recordPractice?.(model, kind, grade).catch(() => undefined);
        } finally {
          await copy.dispose();
        }
        completed += 1;
      }
    } catch (error) {
      if (deps.signal.aborted) break;
      result.error = error instanceof Error ? error.message : String(error);
    }
    result.decision.validArgumentRate = result.decision.calls > 0 ? validCalls / result.decision.calls : 0;
    const medianLatency = median(latencies);
    if (medianLatency !== undefined) result.decision.medianLatencyMs = medianLatency;
    results.push(result);
  }

  const baselineMedian = median(baselineLatencies);
  const baselineOutcome = { runs: discriminating.length, passed: discriminating.filter(originalSucceeded).length };
  const report: PracticeReport = {
    startedAt,
    finishedAt: now().toISOString(),
    tracesUsed: traces.length,
    outcomeTraces: discriminating.length,
    baseline: { models: [...new Set(traces.map((trace) => trace.primaryModel))], ...(baselineMedian !== undefined ? { medianLatencyMs: baselineMedian } : {}), outcome: baselineOutcome },
    candidates: results,
    ...(deps.signal.aborted ? { cancelled: true } : {}),
  };
  const recommendation = recommend(report);
  return recommendation ? { ...report, recommendation } : report;
}

/** A recommendation needs clear evidence: more verified passes on the same
 *  tasks, or the same decisions at a fraction of the latency. */
export function recommend(report: PracticeReport): PracticeReport["recommendation"] {
  const baselineRate = report.baseline.outcome.runs > 0 ? report.baseline.outcome.passed / report.baseline.outcome.runs : 0;
  const better = report.candidates
    .filter((candidate) => !candidate.error && candidate.outcome.runs >= MIN_OUTCOME_RUNS && candidate.outcome.passed / candidate.outcome.runs > baselineRate)
    .sort((a, b) => b.outcome.passed / b.outcome.runs - a.outcome.passed / a.outcome.runs)[0];
  if (better) {
    return {
      model: better.model,
      role: "chat",
      reason: `${better.model} passed verification on ${better.outcome.passed} of ${better.outcome.runs} of your tasks, against ${report.baseline.outcome.passed} of ${report.baseline.outcome.runs} for the models that ran them.`,
    };
  }
  const baselineMedian = report.baseline.medianLatencyMs;
  const faster = report.candidates
    .filter((candidate) => !candidate.error && candidate.decision.calls >= 5 && candidate.decision.medianLatencyMs !== undefined && baselineMedian !== undefined
      && candidate.decision.sameAction / candidate.decision.calls >= 0.85 && candidate.decision.validArgumentRate >= 0.95
      && candidate.decision.medianLatencyMs <= baselineMedian * 0.6)
    .sort((a, b) => a.decision.medianLatencyMs! - b.decision.medianLatencyMs!)[0];
  if (faster && baselineMedian !== undefined) {
    return {
      model: faster.model,
      role: "fast",
      reason: `${faster.model} made the same decision on ${faster.decision.sameAction} of ${faster.decision.calls} of your recorded steps at ${(baselineMedian / faster.decision.medianLatencyMs!).toFixed(1)}× the speed, so it suits summaries and subagents.`,
    };
  }
  return undefined;
}

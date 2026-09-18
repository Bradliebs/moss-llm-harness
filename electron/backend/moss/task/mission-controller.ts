import { randomUUID } from "node:crypto";

import type {
  TaskArtifactReference,
  TaskBlocker,
  TaskEvidence,
  TaskExecutionGrant,
  TaskMissionPlan,
  TaskSnapshot,
  TaskStep,
  TokenUsage,
} from "../../../../common/types";
import type { MissionCapability } from "./mission-plan";
import type { MissionPlanGenerator, MissionReplanContext } from "./mission-planner";
import { selectDependencyReadySteps } from "./progress-packet";
import { TaskArtifactStore } from "./task-artifact-store";
import { TaskEngine } from "./task-engine";
import { TaskStore } from "./task-store";
import { missionDeadline } from "./mission-budget";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const REPLANNABLE_BLOCKERS = new Set<TaskBlocker["kind"]>(["external", "verification", "unavailable-service"]);
const EVIDENCE_KINDS = new Set(["command", "file", "process", "http", "browser", "desktop", "external", "model-review"]);
const BLOCKER_KINDS = new Set([
  "approval", "verification", "credential", "permission", "missing-capability", "unavailable-service",
  "unsupported-environment", "budget", "user-decision", "external",
]);

export interface MissionWorkOrder {
  schemaVersion: 1;
  taskId: string;
  planRevision: number;
  attemptId: string;
  objective: string;
  constraints: string[];
  assumptions: string[];
  step: TaskStep;
  acceptanceCriteria: Array<{ id: string; description: string; mandatory: boolean }>;
  dependencyArtifacts: TaskArtifactReference[];
  remainingTaskBudget: {
    maxDurationMs?: number;
    maxTokens?: number;
    maxActions?: number;
    maxCostUsd?: number;
  };
  executionGrant?: TaskExecutionGrant;
}

export interface MissionWorkerArtifact {
  name: string;
  summary: string;
  content: string;
}

export interface MissionWorkerResult {
  status: "succeeded" | "failed" | "blocked";
  summary: string;
  artifacts: MissionWorkerArtifact[];
  blocker?: TaskBlocker;
}

export interface MissionWorkerExecution {
  result: MissionWorkerResult;
  usage?: { usage?: TokenUsage; estimatedCostUsd?: number; actions?: number };
}

export interface MissionWorker {
  execute(order: MissionWorkOrder, signal: AbortSignal): Promise<unknown>;
}

export interface MissionEvidenceResult {
  criterionId: string;
  kind: TaskEvidence["kind"];
  passed: boolean;
  summary: string;
}

export interface MissionStepVerifier {
  verify(order: MissionWorkOrder, result: MissionWorkerResult, signal: AbortSignal): Promise<unknown>;
}

export interface MissionControllerOptions {
  engine: TaskEngine;
  store: TaskStore;
  artifactStore: TaskArtifactStore;
  planner: MissionPlanGenerator;
  capabilities: readonly MissionCapability[];
  worker: MissionWorker;
  verifier: MissionStepVerifier;
  maxReadonlyConcurrency?: number;
  now?: () => Date;
  onTaskState?: (task: TaskSnapshot) => void;
}

export class MissionController {
  private readonly now: () => Date;
  private readonly maxReadonlyConcurrency: number;

  constructor(private readonly options: MissionControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxReadonlyConcurrency = Math.max(1, Math.min(4, Math.floor(options.maxReadonlyConcurrency ?? 2)));
  }

  async run(taskId: string, signal: AbortSignal): Promise<TaskSnapshot> {
    const ownerId = randomUUID();
    await this.options.engine.acquireLease(taskId, ownerId);
    const initial = await this.requireTask(taskId);
    const deadline = missionDeadline(signal, remainingBudget(initial, this.now()).maxDurationMs);
    try {
      await this.runOwned(taskId, deadline.signal);
    } finally {
      deadline.dispose();
      await this.options.engine.releaseLease(taskId, ownerId);
    }
    const task = await this.requireTask(taskId);
    this.options.onTaskState?.(task);
    return task;
  }

  private async runOwned(taskId: string, signal: AbortSignal): Promise<void> {
    let task = await this.requireTask(taskId);
    let replans = 0;
    if (!task.missionPlan) task = await this.prepare(task, signal);
    this.options.onTaskState?.(task);
    if (!task.missionPlan || task.state === "blocked" || task.state === "paused" || TERMINAL_STATES.has(task.state)) return;

    while (!TERMINAL_STATES.has(task.state)) {
      if (signal.aborted) {
        const latest = await this.requireTask(taskId);
        task = latest.state === "paused" || TERMINAL_STATES.has(latest.state)
          ? latest
          : await this.options.engine.pause(taskId, "Mission execution was cancelled before the next step");
        this.options.onTaskState?.(task);
        return;
      }
      const steps = selectDependencyReadySteps(task, this.maxReadonlyConcurrency);
      if (steps.length === 0) {
        task = await this.finishMission(task);
        this.options.onTaskState?.(task);
        return;
      }
      await Promise.all(steps.map((step) => this.executeStep(task, step, signal, steps.length)));
      task = await this.requireTask(taskId);
      this.options.onTaskState?.(task);
      if (task.state === "blocked" && replans < 1 && task.blocker && REPLANNABLE_BLOCKERS.has(task.blocker.kind)) {
        const replanned = await this.tryReplan(task, signal);
        if (replanned !== task) {
          replans += 1;
          task = replanned;
          this.options.onTaskState?.(task);
          if (task.state === "executing") continue;
        }
      }
      if (task.state !== "executing") return;
    }
  }

  private async tryReplan(task: TaskSnapshot, signal: AbortSignal): Promise<TaskSnapshot> {
    if (!task.missionPlan || !task.blocker || !this.options.planner.replan || signal.aborted) return task;
    const completedStepIds = new Set(task.steps
      .filter((step) => step.state === "completed" || step.state === "skipped")
      .map((step) => step.id));
    const context: MissionReplanContext = {
      currentPlan: structuredClone(task.missionPlan),
      completedSteps: task.steps.filter((step) => completedStepIds.has(step.id)).map((step) => structuredClone(step)),
      evidence: task.evidence.map((item) => structuredClone(item)),
      artifacts: (task.artifacts ?? []).map((item) => structuredClone(item)),
      failures: task.attempts
        .filter((attempt) => attempt.outcome === "failed")
        .map((attempt) => ({ ...(attempt.stepId ? { stepId: attempt.stepId } : {}), ...(attempt.error ? { error: attempt.error } : {}) })),
      blocker: structuredClone(task.blocker),
      remainingBudget: remainingBudget(task, this.now()),
    };
    try {
      const result = await this.options.planner.replan(task.spec, context, signal);
      if (result.usage) await this.options.engine.recordPlanningUsage(task.id, result.usage, result.estimatedCostUsd);
      if (signal.aborted || TERMINAL_STATES.has((await this.requireTask(task.id)).state)) return this.requireTask(task.id);
      if (result.kind === "blocked") return task;
      await this.options.engine.replaceMissionPlan(task.id, result.plan, this.options.capabilities);
      return this.options.engine.start(task.id);
    } catch {
      return task;
    }
  }

  private async prepare(task: TaskSnapshot, signal: AbortSignal): Promise<TaskSnapshot> {
    if (task.state !== "intake" && task.state !== "planning") {
      throw new Error(`Cannot plan mission task '${task.id}' while it is ${task.state}`);
    }
    const result = await this.options.planner.plan(task.spec, signal, 1);
    if (result.usage) await this.options.engine.recordPlanningUsage(task.id, result.usage, result.estimatedCostUsd);
    const latest = await this.requireTask(task.id);
    if (TERMINAL_STATES.has(latest.state) || latest.state === "paused") return latest;
    if (signal.aborted) return this.options.engine.pause(task.id, "Mission planning was aborted");
    if (result.kind === "blocked") return this.options.engine.block(task.id, result.blocker);
    return this.options.engine.setMissionPlan(task.id, result.plan, this.options.capabilities);
  }

  private async executeStep(task: TaskSnapshot, step: TaskStep, signal: AbortSignal, concurrentSteps = 1): Promise<TaskSnapshot> {
    const deadline = missionDeadline(signal, step.mission?.budget.maxDurationMs);
    try {
      return await this.executeStepWithinDeadline(task, step, deadline.signal, concurrentSteps);
    } finally { deadline.dispose(); }
  }

  private async executeStepWithinDeadline(task: TaskSnapshot, step: TaskStep, signal: AbortSignal, concurrentSteps: number): Promise<TaskSnapshot> {
    if (signal.aborted) return this.requireTask(task.id);
    const turnId = randomUUID();
    const { attempt } = await this.options.engine.beginAttempt(task.id, step.id, turnId);
    const current = await this.requireTask(task.id);
    const order = buildWorkOrder(current, step, attempt.id, this.now());
    for (const key of ["maxTokens", "maxActions", "maxCostUsd"] as const) {
      const value = order.remainingTaskBudget[key];
      if (value !== undefined) order.remainingTaskBudget[key] = key === "maxCostUsd" ? value / concurrentSteps : Math.floor(value / concurrentSteps);
    }
    let execution: MissionWorkerExecution;
    try {
      execution = parseWorkerExecution(await this.options.worker.execute(order, signal));
    } catch (error) {
      const message = errorMessage(error);
      await this.options.engine.finishAttempt(task.id, attempt.id, signal.aborted ? "interrupted" : "failed", message);
      const latest = await this.requireTask(task.id);
      if (TERMINAL_STATES.has(latest.state)) return latest;
      return signal.aborted
        ? this.options.engine.pause(task.id, message)
        : this.options.engine.block(task.id, blocker("external", `Worker failed for step '${step.id}': ${message}`, this.now()));
    }

    const afterUsage = await this.options.engine.recordUsage(task.id, attempt.id, execution.usage ?? {});
    if (TERMINAL_STATES.has(afterUsage.state)) {
      return this.options.engine.finishAttempt(task.id, attempt.id, "interrupted", "Task cancelled");
    }
    if (signal.aborted) {
      await this.options.engine.finishAttempt(task.id, attempt.id, "interrupted", "Mission worker was aborted");
      const latest = await this.requireTask(task.id);
      return latest.state === "paused" || TERMINAL_STATES.has(latest.state)
        ? latest
        : this.options.engine.pause(task.id, "Mission worker was aborted after active work settled");
    }
    if (execution.result.status !== "succeeded") {
      const summary = execution.result.summary.trim() || `Step '${step.id}' did not succeed`;
      await this.options.engine.finishAttempt(task.id, attempt.id, "failed", summary);
      if (afterUsage.state === "paused") return this.requireTask(task.id);
      return this.options.engine.block(
        task.id,
        execution.result.status === "blocked" && execution.result.blocker
          ? execution.result.blocker
          : blocker("external", summary, this.now()),
      );
    }

    try {
      validateArtifacts(step, execution.result.artifacts);
      const evidence = parseEvidence(
        await this.options.verifier.verify(order, execution.result, signal),
        step,
      );
      signal.throwIfAborted();
      if (TERMINAL_STATES.has((await this.requireTask(task.id)).state)) {
        return this.options.engine.finishAttempt(task.id, attempt.id, "interrupted", "Task cancelled during verification");
      }
      const failed = evidence.find((item) => !item.passed);
      if (failed) {
        await this.recordEvidence(task.id, attempt.id, evidence);
        await this.options.engine.finishAttempt(task.id, attempt.id, "failed", failed.summary);
        if (afterUsage.state === "paused") return this.requireTask(task.id);
        return this.options.engine.block(task.id, blocker("verification", failed.summary, this.now()));
      }
      await this.persistArtifacts(task.id, current.missionPlan!, step, attempt.id, execution.result.artifacts);
      await this.recordEvidence(task.id, attempt.id, evidence);
    } catch (error) {
      const message = errorMessage(error);
      await this.options.engine.finishAttempt(task.id, attempt.id, "failed", message);
      const latest = await this.requireTask(task.id);
      if (TERMINAL_STATES.has(latest.state)) return latest;
      if (signal.aborted) return latest.state === "paused" ? latest : this.options.engine.pause(task.id, message);
      if (afterUsage.state === "paused") return this.requireTask(task.id);
      return this.options.engine.block(task.id, blocker("verification", `Step '${step.id}' was rejected: ${message}`, this.now()));
    }
    await this.options.engine.finishAttempt(task.id, attempt.id, "succeeded");
    const finished = await this.requireTask(task.id);
    if (finished.state === "paused" && finished.steps.every((item) =>
      item.state === "completed" || item.state === "skipped"
    )) {
      return this.finishMission(finished);
    }
    return finished;
  }

  private async persistArtifacts(
    taskId: string,
    plan: TaskMissionPlan,
    step: TaskStep,
    attemptId: string,
    artifacts: readonly MissionWorkerArtifact[],
  ): Promise<void> {
    for (const artifact of artifacts) {
      const reference = await this.options.artifactStore.save({
        taskId,
        planRevision: plan.revision,
        stepId: step.id,
        attemptId,
        ...artifact,
      });
      await this.options.engine.recordArtifact(reference.taskId, reference);
    }
  }

  private async recordEvidence(
    taskId: string,
    attemptId: string,
    evidence: readonly MissionEvidenceResult[],
  ): Promise<void> {
    for (const item of evidence) {
      await this.options.engine.recordEvidence(taskId, {
        id: randomUUID(),
        ...item,
        capturedAt: this.now().toISOString(),
        attemptId,
      });
    }
  }

  private async finishMission(task: TaskSnapshot): Promise<TaskSnapshot> {
    const incomplete = task.steps.filter((step) => step.state !== "completed" && step.state !== "skipped");
    if (incomplete.length > 0) {
      return this.options.engine.block(task.id, blocker(
        "verification",
        `Mission has no dependency-ready step; unresolved: ${incomplete.map((step) => step.id).join(", ")}`,
        this.now(),
      ));
    }
    if (task.state === "paused") task = await this.options.engine.start(task.id);
    await this.options.engine.beginVerification(task.id);
    try {
      return await this.options.engine.complete(task.id);
    } catch (error) {
      return this.options.engine.block(task.id, blocker("verification", errorMessage(error), this.now()));
    }
  }

  private async requireTask(id: string): Promise<TaskSnapshot> {
    const task = await this.options.store.get(id);
    if (!task) throw new Error(`Task '${id}' does not exist`);
    return task;
  }
}

function buildWorkOrder(task: TaskSnapshot, step: TaskStep, attemptId: string, now: Date): MissionWorkOrder {
  if (!task.missionPlan) throw new Error(`Task '${task.id}' has no mission plan`);
  const criterionIds = new Set(step.mission?.acceptanceCriterionIds ?? []);
  const dependencyIds = new Set(step.dependsOn);
  return {
    schemaVersion: 1,
    taskId: task.id,
    planRevision: task.missionPlan.revision,
    attemptId,
    objective: task.spec.objective,
    constraints: structuredClone(task.spec.constraints),
    assumptions: structuredClone(task.spec.assumptions),
    step: structuredClone(step),
    acceptanceCriteria: task.spec.acceptanceCriteria.filter((criterion) => criterionIds.has(criterion.id)),
    dependencyArtifacts: (task.artifacts ?? []).filter((artifact) => dependencyIds.has(artifact.stepId)),
    remainingTaskBudget: remainingBudget(task, now),
    ...(task.spec.executionGrant ? { executionGrant: structuredClone(task.spec.executionGrant) } : {}),
  };
}

function parseWorkerExecution(value: unknown): MissionWorkerExecution {
  if (!isRecord(value) || !isRecord(value.result)) throw new Error("Worker execution must contain a result");
  const result = value.result;
  if (!(["succeeded", "failed", "blocked"] as unknown[]).includes(result.status)
    || typeof result.summary !== "string"
    || !Array.isArray(result.artifacts)) {
    throw new Error("Worker result has an invalid status, summary, or artifact list");
  }
  const artifacts = result.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)
      || typeof artifact.name !== "string"
      || typeof artifact.summary !== "string"
      || typeof artifact.content !== "string") {
      throw new Error(`Worker artifact ${index} is invalid`);
    }
    return { name: artifact.name, summary: artifact.summary, content: artifact.content };
  });
  const parsed: MissionWorkerExecution = {
    result: {
      status: result.status as MissionWorkerResult["status"],
      summary: result.summary,
      artifacts,
      ...(isBlocker(result.blocker) ? { blocker: structuredClone(result.blocker) } : {}),
    },
  };
  if (value.usage !== undefined) parsed.usage = parseUsage(value.usage);
  if (parsed.result.status === "blocked" && !parsed.result.blocker) throw new Error("Blocked worker result requires a blocker");
  return parsed;
}

function parseUsage(value: unknown): MissionWorkerExecution["usage"] {
  if (!isRecord(value)) throw new Error("Worker usage must be an object");
  const parsed: NonNullable<MissionWorkerExecution["usage"]> = {};
  if (value.actions !== undefined) parsed.actions = nonNegative(value.actions, "actions");
  if (value.estimatedCostUsd !== undefined) parsed.estimatedCostUsd = nonNegative(value.estimatedCostUsd, "estimatedCostUsd");
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) throw new Error("Worker token usage must be an object");
    parsed.usage = {
      ...(value.usage.inputTokens !== undefined ? { inputTokens: nonNegative(value.usage.inputTokens, "inputTokens") } : {}),
      ...(value.usage.outputTokens !== undefined ? { outputTokens: nonNegative(value.usage.outputTokens, "outputTokens") } : {}),
    };
  }
  return parsed;
}

function validateArtifacts(step: TaskStep, artifacts: readonly MissionWorkerArtifact[]): void {
  const expected = step.mission?.expectedArtifacts ?? [];
  const names = artifacts.map((artifact) => artifact.name);
  if (new Set(names).size !== names.length) throw new Error("Worker artifacts contain duplicate names");
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`Worker artifact contract mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
  }
}

function parseEvidence(value: unknown, step: TaskStep): MissionEvidenceResult[] {
  if (!Array.isArray(value)) throw new Error("Mission verifier must return an evidence array");
  const allowed = new Set(step.mission?.acceptanceCriterionIds ?? []);
  const evidence = value.map((item, index) => {
    if (!isRecord(item)
      || typeof item.criterionId !== "string"
      || typeof item.kind !== "string"
      || !EVIDENCE_KINDS.has(item.kind)
      || typeof item.passed !== "boolean"
      || typeof item.summary !== "string"
      || !item.summary.trim()) {
      throw new Error(`Mission verifier evidence ${index} is invalid`);
    }
    if (!allowed.has(item.criterionId)) throw new Error(`Verifier returned unassigned criterion '${item.criterionId}'`);
    return item as unknown as MissionEvidenceResult;
  });
  const covered = new Set(evidence.map((item) => item.criterionId));
  const missing = [...allowed].filter((criterionId) => !covered.has(criterionId));
  if (missing.length > 0) throw new Error(`Mission verifier omitted criteria: ${missing.join(", ")}`);
  return evidence;
}

function blocker(kind: TaskBlocker["kind"], summary: string, now: Date): TaskBlocker {
  return { kind, summary: summary.slice(0, 500), resumable: true, createdAt: now.toISOString() };
}

function isBlocker(value: unknown): value is TaskBlocker {
  return isRecord(value)
    && typeof value.kind === "string" && BLOCKER_KINDS.has(value.kind)
    && typeof value.summary === "string"
    && typeof value.resumable === "boolean"
    && typeof value.createdAt === "string";
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Worker ${label} must be non-negative`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export function remainingBudget(task: TaskSnapshot, now: Date): MissionWorkOrder["remainingTaskBudget"] {
  const budget = task.spec.budget ?? {};
  const actions = task.attempts.reduce((total, attempt) => total + attempt.actionCount, 0);
  const tokens = task.attempts.reduce(
    (total, attempt) => total + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0),
    0,
  );
  const cost = task.attempts.reduce((total, attempt) => total + attempt.estimatedCostUsd, 0);
  const elapsed = Math.max(0, now.getTime() - new Date(task.createdAt).getTime());
  return {
    ...(budget.maxDurationMs ? { maxDurationMs: Math.max(0, budget.maxDurationMs - elapsed) } : {}),
    ...(budget.maxTokens ? { maxTokens: Math.max(0, budget.maxTokens - tokens) } : {}),
    ...(budget.maxActions ? { maxActions: Math.max(0, budget.maxActions - actions) } : {}),
    ...(budget.maxCostUsd ? { maxCostUsd: Math.max(0, budget.maxCostUsd - cost) } : {}),
  };
}
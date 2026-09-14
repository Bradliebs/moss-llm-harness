// electron/backend/moss/task/task-engine.ts
//
// Durable task lifecycle and invariants. Provider/tool execution remains in the
// agent runner; this service decides whether work may continue or complete.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  TaskArtifactReference,
  TaskApproval,
  TaskAttempt,
  TaskBlocker,
  TaskEvidence,
  TaskSnapshot,
  TaskMissionPlan,
  TaskSpec,
  TaskState,
  TaskStep,
  TokenUsage,
} from "../../../../common/types";
import { validateExecutionGrant } from "./execution-grant";
import { validateMissionPlan, type MissionCapability } from "./mission-plan";
import { TaskStore, taskStore } from "./task-store";

const ACTIVE_STATES = new Set<TaskState>([
  "planning",
  "executing",
  "verifying",
  "reflecting",
  "waiting_for_approval",
]);

export interface AttemptUsage {
  usage?: TokenUsage;
  estimatedCostUsd?: number;
  actions?: number;
}

export interface TaskEngineOptions {
  now?: () => Date;
}

export class TaskEngine {
  private readonly now: () => Date;

  constructor(
    private readonly store: TaskStore,
    options: TaskEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(spec: TaskSpec, id?: string): Promise<TaskSnapshot> {
    if (!spec.objective.trim()) throw new Error("A task objective is required");
    if (!spec.acceptanceCriteria.some((criterion) => criterion.mandatory)) {
      throw new Error("At least one mandatory acceptance criterion is required");
    }
    validateExecutionGrant(spec);
    return this.store.create(spec, id);
  }

  async acquireLease(id: string, ownerId: string, ttlMs = 24 * 60 * 60 * 1000): Promise<TaskSnapshot> {
    if (!ownerId.trim()) throw new Error("A task lease owner is required");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Task lease duration must be positive");
    const now = this.now();
    return this.store.update(id, (task) => {
      if (task.lease && task.lease.ownerId !== ownerId && new Date(task.lease.expiresAt).getTime() > now.getTime()) {
        throw new Error(`Task '${id}' is already leased by '${task.lease.ownerId}'`);
      }
      return {
        ...task,
        lease: {
          ownerId,
          acquiredAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        },
      };
    });
  }

  async releaseLease(id: string, ownerId: string): Promise<TaskSnapshot> {
    return this.store.update(id, (task) => {
      if (!task.lease) return task;
      if (task.lease.ownerId !== ownerId) throw new Error(`Task '${id}' is leased by another owner`);
      const next = { ...task };
      delete next.lease;
      return next;
    });
  }

  async recordPlanningUsage(id: string, usage: TokenUsage): Promise<TaskSnapshot> {
    const timestamp = this.now().toISOString();
    const attempt: TaskAttempt = {
      id: randomUUID(),
      turnId: "mission-planner",
      startedAt: timestamp,
      completedAt: timestamp,
      outcome: "succeeded",
      actionCount: 0,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
      estimatedCostUsd: 0,
    };
    return this.store.update(id, (task) => {
      if (task.state !== "intake" && task.state !== "planning" && task.state !== "executing" && task.state !== "blocked") {
        throw new Error(`Cannot record planning usage while task is ${task.state}`);
      }
      return { ...task, attempts: [...task.attempts, attempt] };
    });
  }

  async setPlan(id: string, steps: TaskStep[]): Promise<TaskSnapshot> {
    validatePlan(steps);
    const current = await this.requireTask(id);
    if (current.state === "intake") await this.store.transition(id, "planning");
    else if (current.state !== "planning") throw new Error(`Cannot set a plan while task is ${current.state}`);
    return this.store.update(id, (task) => ({ ...task, steps: structuredClone(steps) }));
  }

  async setMissionPlan(
    id: string,
    plan: TaskMissionPlan,
    capabilities: readonly MissionCapability[],
  ): Promise<TaskSnapshot> {
    const current = await this.requireTask(id);
    validateMissionPlan(current.spec, plan, capabilities);
    if (current.missionPlan && plan.supersedesRevision !== current.missionPlan.revision) {
      throw new Error(`Mission plan revision ${plan.revision} must supersede current revision ${current.missionPlan.revision}`);
    }
    if (!current.missionPlan && plan.supersedesRevision !== undefined) {
      throw new Error("An initial mission plan cannot supersede another revision");
    }
    if (current.state === "intake") await this.store.transition(id, "planning");
    else if (current.state !== "planning") throw new Error(`Cannot set a mission plan while task is ${current.state}`);
    return this.store.update(id, (task) => ({
      ...task,
      steps: structuredClone(plan.steps),
      missionPlan: structuredClone(plan),
    }));
  }

  async replaceMissionPlan(
    id: string,
    plan: TaskMissionPlan,
    capabilities: readonly MissionCapability[],
  ): Promise<TaskSnapshot> {
    const current = await this.requireTask(id);
    if (!current.missionPlan) throw new Error(`Task '${id}' has no mission plan to replace`);
    if (current.state !== "executing" && current.state !== "blocked") {
      throw new Error(`Cannot replace a mission plan while task is ${current.state}`);
    }
    validateMissionPlan(current.spec, plan, capabilities);
    if (plan.revision !== current.missionPlan.revision + 1
      || plan.supersedesRevision !== current.missionPlan.revision) {
      throw new Error(`Mission plan revision ${plan.revision} must directly supersede ${current.missionPlan.revision}`);
    }

    const completedSteps = current.steps.filter((step) => step.state === "completed" || step.state === "skipped");
    for (const completed of completedSteps) {
      const proposed = plan.steps.find((step) => step.id === completed.id);
      if (!proposed || !isDeepStrictEqual(planShape(completed), planShape(proposed))) {
        throw new Error(`Completed mission step '${completed.id}' must remain structurally identical`);
      }
    }
    const completedIds = new Set(completedSteps.map((step) => step.id));
    const completedAttemptIds = new Set(current.attempts
      .filter((attempt) => attempt.stepId && completedIds.has(attempt.stepId) && attempt.outcome === "succeeded")
      .map((attempt) => attempt.id));
    const materializedSteps = plan.steps.map((step) => {
      const completed = completedSteps.find((candidate) => candidate.id === step.id);
      return structuredClone(completed ?? step);
    });

    return this.store.update(id, (task) => ({
      ...task,
      steps: materializedSteps,
      missionPlan: { ...structuredClone(plan), steps: materializedSteps },
      evidence: task.evidence.filter((item) => item.attemptId && completedAttemptIds.has(item.attemptId)),
      artifacts: task.artifacts?.filter((artifact) => completedIds.has(artifact.stepId)),
    }));
  }

  async start(id: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (task.state === "waiting_for_approval" && task.approval?.status === "pending") {
      throw new Error(`Task '${id}' has a pending approval for call '${task.approval.callId}'`);
    }
    if (task.state === "paused" || task.state === "blocked" || task.state === "waiting_for_approval") {
      return this.transitionForStart(task, task.steps.length > 0 ? "executing" : "planning");
    }
    if (task.state === "planning") {
      if (task.steps.length === 0) throw new Error("A task cannot execute without a plan");
      return this.transitionForStart(task, "executing");
    }
    if (task.state === "executing") return task;
    throw new Error(`Cannot start a task while it is ${task.state}`);
  }

  private async transitionForStart(task: TaskSnapshot, state: "planning" | "executing"): Promise<TaskSnapshot> {
    try {
      return await this.store.transition(task.id, state, { clearBlocker: true, expectedRevision: task.revision });
    } catch (error) {
      const latest = await this.requireTask(task.id);
      if (latest.state === "executing") return latest;
      throw error;
    }
  }

  async beginAttempt(id: string, stepId?: string, turnId?: string): Promise<{ task: TaskSnapshot; attempt: TaskAttempt }> {
    let task = await this.start(id);
    const budgetBlocker = budgetExceeded(task, this.now());
    if (budgetBlocker) {
      task = await this.store.transition(id, "paused", { blocker: budgetBlocker });
      throw new Error(budgetBlocker.summary);
    }
    if (stepId) {
      const step = task.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Unknown task step '${stepId}'`);
      if (step.state !== "pending" && step.state !== "failed" && step.state !== "running") {
        throw new Error(`Task step '${stepId}' is not eligible for an attempt`);
      }
      const completed = new Set(task.steps.filter((candidate) =>
        candidate.state === "completed" || candidate.state === "skipped",
      ).map((candidate) => candidate.id));
      if (!step.dependsOn.every((dependency) => completed.has(dependency))) {
        throw new Error(`Task step '${stepId}' has incomplete dependencies`);
      }
      const otherRunning = task.steps.filter((candidate) => candidate.id !== stepId && candidate.state === "running");
      if (otherRunning.length > 0 && (
        step.mission?.executionLane !== "readonly-parallel"
        || otherRunning.some((candidate) => candidate.mission?.executionLane !== "readonly-parallel")
      )) {
        throw new Error("Only readonly-parallel mission steps may run concurrently");
      }
    }
    const attempt: TaskAttempt = {
      id: randomUUID(),
      ...(stepId ? { stepId } : {}),
      ...(turnId ? { turnId } : {}),
      startedAt: this.now().toISOString(),
      actionCount: 0,
      usage: {},
      estimatedCostUsd: 0,
    };
    task = await this.store.update(id, (current) => {
      if (stepId) assertStepAdmission(current, stepId);
      return {
        ...current,
        attempts: [...current.attempts, attempt],
        steps: stepId
          ? current.steps.map((step) =>
              step.id === stepId ? {
                ...step,
                state: "running",
                startedAt: attempt.startedAt,
                lease: {
                  ownerId: attempt.id,
                  acquiredAt: attempt.startedAt,
                  expiresAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
                },
              } : step,
            )
          : current.steps,
      };
    });
    return { task, attempt: structuredClone(attempt) };
  }

  async recordUsage(id: string, attemptId: string, delta: AttemptUsage): Promise<TaskSnapshot> {
    let task = await this.store.update(id, (current) => {
      if (!current.attempts.some((attempt) => attempt.id === attemptId)) {
        throw new Error(`Unknown task attempt '${attemptId}'`);
      }
      return {
        ...current,
        attempts: current.attempts.map((attempt) => attempt.id !== attemptId ? attempt : {
          ...attempt,
          actionCount: attempt.actionCount + (delta.actions ?? 0),
          usage: {
            inputTokens: (attempt.usage.inputTokens ?? 0) + (delta.usage?.inputTokens ?? 0),
            outputTokens: (attempt.usage.outputTokens ?? 0) + (delta.usage?.outputTokens ?? 0),
          },
          estimatedCostUsd: attempt.estimatedCostUsd + (delta.estimatedCostUsd ?? 0),
        }),
      };
    });
    const blocker = budgetExceeded(task, this.now());
    if (blocker && task.state === "executing") {
      task = await this.store.transition(id, "paused", { blocker });
    }
    return task;
  }

  async finishAttempt(
    id: string,
    attemptId: string,
    outcome: "succeeded" | "failed" | "interrupted",
    error?: string,
  ): Promise<TaskSnapshot> {
    const completedAt = this.now().toISOString();
    return this.store.update(id, (current) => {
      const attempt = current.attempts.find((candidate) => candidate.id === attemptId);
      if (!attempt) throw new Error(`Unknown task attempt '${attemptId}'`);
      return {
        ...current,
        attempts: current.attempts.map((candidate) => candidate.id !== attemptId
          ? candidate
          : { ...candidate, outcome, completedAt, ...(error ? { error } : {}) }),
        steps: current.steps.map((step) => {
        if (!attempt?.stepId || step.id !== attempt.stepId) return step;
        const finished: TaskStep = {
          ...step,
          state: outcome === "succeeded" ? "completed" : "failed",
          completedAt,
          ...(error ? { error } : {}),
        };
        delete finished.lease;
        return finished;
        }),
      };
    });
  }

  async beginVerification(id: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (task.state !== "executing") throw new Error(`Cannot verify a task while it is ${task.state}`);
    return this.store.transition(id, "verifying");
  }

  async recordEvidence(id: string, evidence: TaskEvidence): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (!task.spec.acceptanceCriteria.some((criterion) => criterion.id === evidence.criterionId)) {
      throw new Error(`Unknown acceptance criterion '${evidence.criterionId}'`);
    }
    return this.store.update(id, (current) => ({
      ...current,
      evidence: [...current.evidence.filter((item) => item.id !== evidence.id), structuredClone(evidence)],
    }));
  }

  async recordArtifact(id: string, artifact: TaskArtifactReference): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (artifact.taskId !== id) throw new Error(`Artifact task '${artifact.taskId}' does not match '${id}'`);
    if (!task.missionPlan || artifact.planRevision !== task.missionPlan.revision) {
      throw new Error(`Artifact plan revision '${artifact.planRevision}' is not current`);
    }
    const step = task.steps.find((candidate) => candidate.id === artifact.stepId);
    if (!step) throw new Error(`Unknown artifact step '${artifact.stepId}'`);
    const attempt = task.attempts.find((candidate) => candidate.id === artifact.attemptId);
    if (!attempt || attempt.stepId !== artifact.stepId) {
      throw new Error(`Artifact attempt '${artifact.attemptId}' does not belong to step '${artifact.stepId}'`);
    }
    return this.store.update(id, (current) => ({
      ...current,
      artifacts: [...(current.artifacts ?? []).filter((item) => item.id !== artifact.id), structuredClone(artifact)],
    }));
  }

  async complete(id: string): Promise<TaskSnapshot> {
    let task = await this.requireTask(id);
    if (task.state !== "verifying" && task.state !== "reflecting") {
      throw new Error(`Cannot complete a task while it is ${task.state}`);
    }
    const missing = missingPassingCriteria(task);
    if (missing.length > 0) {
      throw new Error(`Task cannot complete without passing evidence for: ${missing.join(", ")}`);
    }
    if (task.state === "verifying") task = await this.store.transition(id, "reflecting");
    return this.store.transition(id, "completed");
  }

  async pause(id: string, summary: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (task.state === "paused") return task;
    const blocker: TaskBlocker = {
      kind: "external",
      summary,
      resumable: true,
      createdAt: this.now().toISOString(),
    };
    try {
      return await this.store.transition(id, "paused", { blocker });
    } catch (error) {
      const latest = await this.requireTask(id);
      if (latest.state === "paused") return latest;
      throw error;
    }
  }

  async requestApproval(id: string, approval: TaskApproval): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (task.state !== "executing" && task.state !== "planning") {
      throw new Error(`Cannot request approval while task is ${task.state}`);
    }
    if (approval.taskId !== id) throw new Error(`Approval task '${approval.taskId}' does not match '${id}'`);
    if (approval.status !== "pending") throw new Error("A new approval must be pending");
    if (task.approval?.status === "pending") {
      throw new Error(`Task '${id}' already has a pending approval for call '${task.approval.callId}'`);
    }
    return this.store.transition(id, "waiting_for_approval", {
      blocker: {
        kind: "approval",
        summary: `Approval required for ${approval.toolName}`,
        resumable: true,
        createdAt: approval.requestedAt,
      },
      approval,
    });
  }

  async resolveApproval(
    id: string,
    callId: string,
    approved: boolean,
    comment?: string,
  ): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (task.state !== "waiting_for_approval" || task.approval?.status !== "pending") {
      throw new Error(`Task '${id}' has no pending approval`);
    }
    if (task.approval.callId !== callId) {
      throw new Error(`Approval call '${callId}' does not match pending call '${task.approval.callId}'`);
    }
    const respondedAt = this.now().toISOString();
    const normalizedComment = comment?.trim().slice(0, 500);
    return this.store.transition(id, "executing", {
      clearBlocker: true,
      approval: {
        ...task.approval,
        status: approved ? "approved" : "denied",
        respondedAt,
        ...(normalizedComment ? { comment: normalizedComment } : {}),
      },
    });
  }

  async interruptApproval(id: string, callId: string, comment: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (task.state !== "waiting_for_approval" || task.approval?.status !== "pending") {
      throw new Error(`Task '${id}' has no pending approval`);
    }
    if (task.approval.callId !== callId) {
      throw new Error(`Approval call '${callId}' does not match pending call '${task.approval.callId}'`);
    }
    const respondedAt = this.now().toISOString();
    const normalizedComment = comment.trim().slice(0, 500) || "Approval was interrupted";
    return this.store.transition(id, "paused", {
      blocker: {
        kind: "approval",
        summary: `${normalizedComment}; the pending tool call was not executed. Resume to start a fresh attempt.`,
        resumable: true,
        createdAt: respondedAt,
      },
      approval: {
        ...task.approval,
        status: "interrupted",
        respondedAt,
        comment: normalizedComment,
      },
    });
  }

  async block(id: string, blocker: TaskBlocker): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (task.state === "blocked") return task;
    return this.store.transition(id, "blocked", { blocker });
  }

  async cancel(id: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (["completed", "failed", "cancelled"].includes(task.state)) return task;
    return this.store.transition(id, "cancelled");
  }

  /** Convert work that was active during shutdown into an explicit resumable
   *  pause. No side effect is replayed until a caller deliberately resumes it. */
  async recoverInterruptedTasks(): Promise<TaskSnapshot[]> {
    const tasks = await this.store.list();
    const recovered: TaskSnapshot[] = [];
    for (const task of tasks) {
      if (!ACTIVE_STATES.has(task.state)) continue;
      if (task.lease || task.steps.some((step) => step.state === "running" || step.lease)) {
        await this.store.update(task.id, (current) => {
          const next = { ...current };
          delete next.lease;
          next.steps = next.steps.map((step) => {
            if (step.state !== "running" && !step.lease) return step;
            const recovered = {
              ...step,
              state: "failed" as const,
              completedAt: this.now().toISOString(),
              error: "Step execution was interrupted by application shutdown",
            };
            delete recovered.lease;
            return recovered;
          });
          return next;
        });
      }
      if (task.state === "waiting_for_approval" && task.approval?.status === "pending") {
        recovered.push(await this.interruptApproval(
          task.id,
          task.approval.callId,
          "Application stopped before a decision was completed",
        ));
        continue;
      }
      const blocker: TaskBlocker = {
        kind: "external",
        summary: "Execution was interrupted by application shutdown; inspect the last action before resuming.",
        resumable: true,
        createdAt: this.now().toISOString(),
      };
      recovered.push(await this.store.transition(task.id, "paused", { blocker }));
    }
    return recovered;
  }

  private async requireTask(id: string): Promise<TaskSnapshot> {
    const task = await this.store.get(id);
    if (!task) throw new Error(`Task '${id}' does not exist`);
    return task;
  }
}

function validatePlan(steps: TaskStep[]): void {
  if (steps.length === 0) throw new Error("A task plan requires at least one step");
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id.trim() || ids.has(step.id)) throw new Error(`Duplicate or empty task step id '${step.id}'`);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task step '${step.id}' has unknown dependency '${dependency}'`);
      if (dependency === step.id) throw new Error(`Task step '${step.id}' cannot depend on itself`);
    }
  }
}

function budgetExceeded(task: TaskSnapshot, now: Date): TaskBlocker | null {
  const budget = task.spec.budget;
  if (!budget) return null;
  const actions = task.attempts.reduce((total, attempt) => total + attempt.actionCount, 0);
  const tokens = task.attempts.reduce(
    (total, attempt) => total + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0),
    0,
  );
  const cost = task.attempts.reduce((total, attempt) => total + attempt.estimatedCostUsd, 0);
  const duration = now.getTime() - new Date(task.createdAt).getTime();
  const reason =
    budget.maxActions && actions >= budget.maxActions
      ? `action budget of ${budget.maxActions} reached`
      : budget.maxTokens && tokens >= budget.maxTokens
        ? `token budget of ${budget.maxTokens} reached`
        : budget.maxCostUsd && cost >= budget.maxCostUsd
          ? `cost budget of $${budget.maxCostUsd} reached`
          : budget.maxDurationMs && duration >= budget.maxDurationMs
            ? `runtime budget of ${budget.maxDurationMs}ms reached`
            : null;
  return reason
    ? { kind: "budget", summary: `Task paused: ${reason}`, resumable: true, createdAt: now.toISOString() }
    : null;
}

function missingPassingCriteria(task: TaskSnapshot): string[] {
  return task.spec.acceptanceCriteria
    .filter((criterion) => criterion.mandatory)
    .filter((criterion) => {
      const evidence = task.evidence
        .filter((item) => item.criterionId === criterion.id)
        .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
      return evidence.length === 0 || !evidence[0].passed;
    })
    .map((criterion) => criterion.description);
}

export const taskEngine = new TaskEngine(taskStore);

function planShape(step: TaskStep): TaskStep {
  const shape = structuredClone(step);
  shape.state = "pending";
  delete shape.startedAt;
  delete shape.completedAt;
  delete shape.error;
  return shape;
}

function assertStepAdmission(task: TaskSnapshot, stepId: string): void {
  const step = task.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Unknown task step '${stepId}'`);
  if (step.state !== "pending" && step.state !== "failed" && step.state !== "running") {
    throw new Error(`Task step '${stepId}' is not eligible for an attempt`);
  }
  const completed = new Set(task.steps
    .filter((candidate) => candidate.state === "completed" || candidate.state === "skipped")
    .map((candidate) => candidate.id));
  if (!step.dependsOn.every((dependency) => completed.has(dependency))) {
    throw new Error(`Task step '${stepId}' has incomplete dependencies`);
  }
  const otherRunning = task.steps.filter((candidate) => candidate.id !== stepId && candidate.state === "running");
  if (otherRunning.length > 0 && (
    step.mission?.executionLane !== "readonly-parallel"
    || otherRunning.some((candidate) => candidate.mission?.executionLane !== "readonly-parallel")
  )) {
    throw new Error("Only readonly-parallel mission steps may run concurrently");
  }
}
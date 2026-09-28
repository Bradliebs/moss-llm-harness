// electron/backend/moss/task/task-store.ts
//
// Durable task snapshots with an append-only recovery journal. Each task is
// serialized independently so concurrent updates cannot overwrite one another.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import type { TaskApproval, TaskBlocker, TaskHistoryEntry, TaskSnapshot, TaskSpec, TaskState } from "../../../../common/types";

const RENAME_RETRIES = 5;
const RENAME_RETRY_BASE_MS = 20;

const ALLOWED_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  intake: ["planning", "blocked", "failed", "cancelled"],
  planning: ["executing", "waiting_for_approval", "paused", "blocked", "failed", "cancelled"],
  executing: ["planning", "verifying", "waiting_for_approval", "paused", "blocked", "failed", "cancelled"],
  verifying: ["planning", "executing", "reflecting", "paused", "blocked", "failed", "cancelled"],
  reflecting: ["planning", "completed", "paused", "blocked", "failed", "cancelled"],
  waiting_for_approval: ["planning", "executing", "paused", "blocked", "cancelled"],
  paused: ["planning", "executing", "verifying", "reflecting", "cancelled"],
  blocked: ["planning", "executing", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

interface TaskJournalEvent {
  id: string;
  taskId: string;
  kind: "created" | "updated" | "transitioned";
  createdAt: string;
  revision: number;
  fromState?: TaskState;
  toState?: TaskState;
  snapshot: TaskSnapshot;
}

export interface TaskTransitionOptions {
  blocker?: TaskBlocker;
  clearBlocker?: boolean;
  approval?: TaskApproval;
  expectedRevision?: number;
}

/** Task ids may eventually originate in the renderer, so constrain them before
 *  using them as directory names. */
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new Error("Task id must start with an alphanumeric character and contain only letters, numbers, '.', '_', or '-'");
  }
  return id;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.spec === "object" &&
    task.spec !== null &&
    typeof task.state === "string" &&
    task.state in ALLOWED_TRANSITIONS &&
    Array.isArray(task.steps) &&
    Array.isArray(task.evidence) &&
    Array.isArray(task.attempts) &&
    typeof task.createdAt === "string" &&
    typeof task.updatedAt === "string" &&
    Number.isInteger(task.revision) &&
    (task.revision as number) >= 0
  );
}

function isTaskJournalEvent(value: unknown): value is TaskJournalEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.taskId === "string" &&
    typeof event.createdAt === "string" &&
    typeof event.revision === "number" &&
    isTaskSnapshot(event.snapshot)
  );
}

export class TaskStore {
  private readonly queues = new Map<string, Promise<void>>();

  /** baseDir override exists for tests; production uses Electron userData. */
  constructor(private readonly baseDir?: string) {}

  private root(): string {
    return join(this.baseDir ?? userDataDir(), "tasks");
  }

  private taskDir(id: string): string {
    return join(this.root(), safeId(id));
  }

  private snapshotFile(id: string): string {
    return join(this.taskDir(id), "snapshot.json");
  }

  private journalFile(id: string): string {
    return join(this.taskDir(id), "events.jsonl");
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.queues.set(
      id,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  async create(spec: TaskSpec, id: string = randomUUID()): Promise<TaskSnapshot> {
    return this.serialize(id, async () => {
      if (await this.readSnapshot(id)) throw new Error(`Task '${id}' already exists`);
      const now = new Date().toISOString();
      const snapshot: TaskSnapshot = {
        id,
        spec: clone(spec),
        state: "intake",
        steps: [],
        evidence: [],
        attempts: [],
        createdAt: now,
        updatedAt: now,
        revision: 0,
      };
      await this.persist(snapshot, "created");
      return clone(snapshot);
    });
  }

  async get(id: string): Promise<TaskSnapshot | null> {
    const snapshot = await this.readSnapshot(id);
    return snapshot ? clone(snapshot) : null;
  }

  async list(): Promise<TaskSnapshot[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const tasks = await Promise.all(entries.map((id) => this.get(id)));
    return tasks
      .filter((task): task is TaskSnapshot => task !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async history(id: string): Promise<TaskHistoryEntry[]> {
    const journal = await this.readJournalEvents(id);
    const history: TaskHistoryEntry[] = [];
    let previous: TaskSnapshot | undefined;
    let sequence = 0;
    const add = (
      event: TaskJournalEvent,
      suffix: string,
      entry: Omit<TaskHistoryEntry, "id" | "taskId" | "revision" | "sequence" | "occurredAt">,
      occurredAt = event.createdAt,
    ) => {
      history.push({
        id: `${event.id}:${suffix}`,
        taskId: id,
        revision: event.revision,
        sequence,
        occurredAt,
        ...entry,
      });
      sequence += 1;
    };

    for (const event of journal) {
      const current = event.snapshot;
      if (event.kind === "created") {
        add(event, "created", { kind: "created", summary: "Task created" });
      }
      if (previous && previous.state !== current.state) {
        add(event, "transition", {
          kind: "transition",
          summary: `Task moved from ${previous.state} to ${current.state}`,
          fromState: previous.state,
          toState: current.state,
        });
      }

      const approval = current.approval;
      const previousApproval = previous?.approval;
      if (
        approval
        && (
          previousApproval?.callId !== approval.callId
          || previousApproval.status !== approval.status
          || previousApproval.respondedAt !== approval.respondedAt
        )
      ) {
        add(event, `approval:${approval.callId}:${approval.status}`, {
          kind: "approval",
          summary: `${approval.toolName} approval ${approval.status}`,
          turnId: approval.turnId,
          callId: approval.callId,
          toolName: approval.toolName,
          approvalStatus: approval.status,
          ...(approval.risk ? { risk: approval.risk } : {}),
        }, approval.respondedAt ?? approval.requestedAt);
      }

      const previousAttempts = new Map(previous?.attempts.map((attempt) => [attempt.id, attempt]) ?? []);
      for (const attempt of current.attempts) {
        const prior = previousAttempts.get(attempt.id);
        if (!prior) {
          add(event, `attempt:${attempt.id}:started`, {
            kind: "attempt",
            summary: "Attempt started",
            attemptId: attempt.id,
          }, attempt.startedAt);
        } else if (prior.outcome !== attempt.outcome && attempt.outcome) {
          add(event, `attempt:${attempt.id}:${attempt.outcome}`, {
            kind: "attempt",
            summary: `Attempt ${attempt.outcome}`,
            attemptId: attempt.id,
            attemptOutcome: attempt.outcome,
          }, attempt.completedAt ?? event.createdAt);
        }
      }

      const previousEvidence = new Set(previous?.evidence.map((evidence) => evidence.id) ?? []);
      for (const evidence of current.evidence) {
        if (previousEvidence.has(evidence.id)) continue;
        add(event, `evidence:${evidence.id}`, {
          kind: "evidence",
          summary: `${evidence.kind} evidence ${evidence.passed ? "passed" : "failed"}`,
          criterionId: evidence.criterionId,
          evidenceKind: evidence.kind,
          passed: evidence.passed,
          ...(evidence.attemptId ? { attemptId: evidence.attemptId } : {}),
        }, evidence.capturedAt);
      }
      previous = current;
    }
    return history;
  }

  async update(
    id: string,
    updateSnapshot: (current: TaskSnapshot) => TaskSnapshot,
    expectedRevision?: number,
  ): Promise<TaskSnapshot> {
    return this.serialize(id, async () => {
      const current = await this.requireTask(id);
      this.assertRevision(current, expectedRevision);
      const next = updateSnapshot(clone(current));
      if (next.id !== current.id) throw new Error("A task update cannot change its id");
      if (next.state !== current.state) {
        throw new Error("Use transition() to change task state");
      }
      next.createdAt = current.createdAt;
      next.updatedAt = new Date().toISOString();
      next.revision = current.revision + 1;
      await this.persist(next, "updated");
      return clone(next);
    });
  }

  async transition(id: string, state: TaskState, options: TaskTransitionOptions = {}): Promise<TaskSnapshot> {
    return this.serialize(id, async () => {
      const current = await this.requireTask(id);
      this.assertRevision(current, options.expectedRevision);
      if (!ALLOWED_TRANSITIONS[current.state].includes(state)) {
        throw new Error(`Invalid task transition: ${current.state} -> ${state}`);
      }
      const now = new Date().toISOString();
      const next: TaskSnapshot = {
        ...current,
        state,
        updatedAt: now,
        revision: current.revision + 1,
        ...(state === "completed" ? { completedAt: now } : {}),
      };
      if (options.blocker) next.blocker = clone(options.blocker);
      if (options.clearBlocker) delete next.blocker;
      if (options.approval) next.approval = clone(options.approval);
      await this.persist(next, "transitioned", current.state);
      return clone(next);
    });
  }

  async delete(id: string): Promise<void> {
    await this.serialize(id, async () => {
      await rm(this.taskDir(id), { recursive: true, force: true });
    });
  }

  private async requireTask(id: string): Promise<TaskSnapshot> {
    const task = await this.readSnapshot(id);
    if (!task) throw new Error(`Task '${id}' does not exist`);
    return task;
  }

  private assertRevision(task: TaskSnapshot, expectedRevision?: number): void {
    if (expectedRevision !== undefined && task.revision !== expectedRevision) {
      throw new Error(`Task '${task.id}' revision conflict: expected ${expectedRevision}, found ${task.revision}`);
    }
  }

  private async readSnapshot(id: string): Promise<TaskSnapshot | null> {
    let materialized: TaskSnapshot | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.snapshotFile(id), "utf8"));
      if (isTaskSnapshot(parsed) && parsed.id === id) materialized = parsed;
    } catch {
      // The append-only journal can recover a snapshot interrupted during
      // atomic replacement or damaged after a hard shutdown.
    }
    const journaled = await this.readLatestJournalSnapshot(id);
    if (!materialized) return journaled;
    if (!journaled) return materialized;
    return journaled.revision > materialized.revision ? journaled : materialized;
  }

  private async readLatestJournalSnapshot(id: string): Promise<TaskSnapshot | null> {
    try {
      const lines = (await readFile(this.journalFile(id), "utf8")).split("\n");
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isTaskJournalEvent(parsed) && parsed.taskId === id && parsed.snapshot.id === id) {
            return parsed.snapshot;
          }
        } catch {
          // A partial final line is expected if the process died during append.
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private async readJournalEvents(id: string): Promise<TaskJournalEvent[]> {
    try {
      const events: TaskJournalEvent[] = [];
      const lines = (await readFile(this.journalFile(id), "utf8")).split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isTaskJournalEvent(parsed) && parsed.taskId === id && parsed.snapshot.id === id) events.push(parsed);
        } catch {
          // Ignore incomplete or malformed records; valid prior entries remain useful.
        }
      }
      return events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async persist(snapshot: TaskSnapshot, kind: TaskJournalEvent["kind"], fromState?: TaskState): Promise<void> {
    const event: TaskJournalEvent = {
      id: randomUUID(),
      taskId: snapshot.id,
      kind,
      createdAt: new Date().toISOString(),
      revision: snapshot.revision,
      ...(fromState ? { fromState, toState: snapshot.state } : {}),
      snapshot: clone(snapshot),
    };
    const journal = this.journalFile(snapshot.id);
    await mkdir(dirname(journal), { recursive: true });
    await appendFile(journal, `${JSON.stringify(event)}\n`, "utf8");
    await this.writeSnapshotAtomically(snapshot);
  }

  private async writeSnapshotAtomically(snapshot: TaskSnapshot): Promise<void> {
    const target = this.snapshotFile(snapshot.id);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    try {
      await renameWithRetry(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= RENAME_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_BASE_MS * 2 ** attempt));
    }
  }
}

export const taskStore = new TaskStore();
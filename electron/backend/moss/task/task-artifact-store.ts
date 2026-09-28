import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import type { TaskArtifactReference } from "../../../../common/types";
import { writeFileAtomic } from "../persistence/atomic-file";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_NAME_CHARS = 120;
const MAX_SUMMARY_CHARS = 500;

export interface TaskArtifactRecord extends TaskArtifactReference {
  content: string;
}

export interface SaveTaskArtifact {
  taskId: string;
  planRevision: number;
  stepId: string;
  attemptId: string;
  name: string;
  summary: string;
  content: string;
}

export class TaskArtifactStore {
  constructor(private readonly baseDir?: string) {}

  async save(input: SaveTaskArtifact): Promise<TaskArtifactReference> {
    validateInput(input);
    const byteLength = Buffer.byteLength(input.content, "utf8");
    if (byteLength > MAX_CONTENT_BYTES) {
      throw new Error(`Task artifact content exceeds ${MAX_CONTENT_BYTES} bytes`);
    }
    const record: TaskArtifactRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      planRevision: input.planRevision,
      stepId: input.stepId,
      attemptId: input.attemptId,
      name: input.name,
      summary: input.summary,
      sha256: digest(input.content),
      byteLength,
      createdAt: new Date().toISOString(),
      content: input.content,
    };
    await writeFileAtomic(this.file(record.taskId, record.id), `${JSON.stringify(record)}\n`);
    return referenceOf(record);
  }

  async get(taskId: string, id: string): Promise<TaskArtifactRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(taskId, id), "utf8"));
      if (!validRecord(parsed) || parsed.taskId !== taskId || parsed.id !== id) return null;
      if (parsed.byteLength !== Buffer.byteLength(parsed.content, "utf8") || parsed.sha256 !== digest(parsed.content)) {
        return null;
      }
      return structuredClone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private root(): string {
    return join(this.baseDir ?? userDataDir(), "task-artifacts");
  }

  private file(taskId: string, id: string): string {
    requireSafeKey(taskId, "taskId");
    if (!ID_PATTERN.test(id)) throw new Error("Invalid task artifact id");
    return join(this.root(), taskId, `${id}.json`);
  }
}

function referenceOf(record: TaskArtifactRecord): TaskArtifactReference {
  const { content: _content, ...reference } = record;
  return structuredClone(reference);
}

function validRecord(value: unknown): value is TaskArtifactRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && ID_PATTERN.test(record.id)
    && typeof record.taskId === "string" && SAFE_KEY_PATTERN.test(record.taskId)
    && Number.isInteger(record.planRevision) && (record.planRevision as number) > 0
    && typeof record.stepId === "string" && SAFE_KEY_PATTERN.test(record.stepId)
    && typeof record.attemptId === "string" && SAFE_KEY_PATTERN.test(record.attemptId)
    && typeof record.name === "string"
    && typeof record.summary === "string"
    && typeof record.sha256 === "string" && /^[0-9a-f]{64}$/.test(record.sha256)
    && Number.isInteger(record.byteLength) && (record.byteLength as number) >= 0
    && typeof record.createdAt === "string"
    && typeof record.content === "string";
}

function validateInput(input: SaveTaskArtifact): void {
  requireSafeKey(input.taskId, "taskId");
  requireSafeKey(input.stepId, "stepId");
  requireSafeKey(input.attemptId, "attemptId");
  if (!Number.isInteger(input.planRevision) || input.planRevision < 1) {
    throw new Error("planRevision must be a positive integer");
  }
  if (!input.name.trim() || input.name.length > MAX_NAME_CHARS) {
    throw new Error(`name must be non-empty and at most ${MAX_NAME_CHARS} characters`);
  }
  if (!input.summary.trim() || input.summary.length > MAX_SUMMARY_CHARS) {
    throw new Error(`summary must be non-empty and at most ${MAX_SUMMARY_CHARS} characters`);
  }
}

function requireSafeKey(value: string, label: string): void {
  if (!SAFE_KEY_PATTERN.test(value)) throw new Error(`${label} must be a safe identifier`);
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export const taskArtifactStore = new TaskArtifactStore();
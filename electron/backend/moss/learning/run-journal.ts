import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { userDataDir } from "../runtime/user-data";

const RENAME_RETRIES = 5;
const RENAME_RETRY_BASE_MS = 20;
const SENSITIVE_KEY = /(?:token|key|secret|password|authorization|cookie)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gi,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
] as const;

export type TerminalRunOutcome = "completed" | "failed" | "blocked" | "cancelled";

export interface RunAttemptSummary {
  capabilityId: string;
  attempt: number;
  result: "succeeded" | "failed" | "blocked";
  summary: string;
}

export interface RunFailureSummary {
  capabilityId?: string;
  category: string;
  reasonCode?: string;
  summary: string;
}

export interface SignedRunFailureSummary extends RunFailureSummary {
  signature: string;
}

export interface RunUserSignal {
  kind: "correction" | "override";
  source: "approval" | "revert" | "retry" | "user-message";
  signalCode: string;
}

export interface RunTraceReference {
  traceId: string;
  schemaVersion: number;
  sha256: string;
}

export interface RunVerificationOutcome {
  criterionId: string;
  passed: boolean;
  signature: string;
}

export interface RunTaskFamilyCandidate {
  id: string;
  source: "objective-class";
}

export interface CriterionSummary {
  criterionId: string;
  passed: boolean;
  summary: string;
}

export interface TerminalRunRecord {
  schemaVersion: 2;
  taskId: string;
  recordedAt: string;
  objectiveClass: string;
  capabilityIds: string[];
  attempts: RunAttemptSummary[];
  failures: SignedRunFailureSummary[];
  failureSignatures: string[];
  taskFamilyCandidate: RunTaskFamilyCandidate;
  recoveryChoices: string[];
  criteria: CriterionSummary[];
  outcome: TerminalRunOutcome;
  durationMs: number;
  costUsd: number;
  userSignals: RunUserSignal[];
  verificationOutcomes: RunVerificationOutcome[];
  traceRef?: RunTraceReference;
  retention: "sanitized" | "rich-local-opt-in";
  richArtifacts?: unknown;
}

export type TerminalRunRecordInput = Omit<
  TerminalRunRecord,
  | "schemaVersion"
  | "recordedAt"
  | "failures"
  | "failureSignatures"
  | "taskFamilyCandidate"
  | "verificationOutcomes"
  | "retention"
> & { failures: RunFailureSummary[] };

export interface RunJournalAppendOptions {
  retainRichArtifacts?: boolean;
}

export class RunJournal {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly baseDir?: string) {}

  async append(input: TerminalRunRecordInput, options: RunJournalAppendOptions = {}): Promise<TerminalRunRecord> {
    validateInput(input);
    if (input.richArtifacts !== undefined && !options.retainRichArtifacts) {
      throw new Error("richArtifacts require explicit local retention opt-in");
    }
    const failures = input.failures.map((failure) => ({
      ...failure,
      signature: deriveFailureSignature(failure),
    }));
    const record = sanitizeValue({
      ...structuredClone(input),
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      failures,
      failureSignatures: [...new Set(failures.map((failure) => failure.signature))].sort(),
      taskFamilyCandidate: { id: deriveTaskFamilyCandidate(input.objectiveClass), source: "objective-class" },
      verificationOutcomes: input.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        passed: criterion.passed,
        signature: stableHash(`${criterion.criterionId}:${criterion.passed ? "pass" : "fail"}`),
      })),
      retention: options.retainRichArtifacts ? "rich-local-opt-in" : "sanitized",
    }) as unknown as TerminalRunRecord;
    return this.serialize(input.taskId, async () => {
      const existing = await this.read(input.taskId);
      const records = [...existing, record];
      await writeJsonAtomically(this.file(input.taskId), records);
      return structuredClone(record);
    });
  }

  async read(taskId: string): Promise<TerminalRunRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(taskId), "utf8"));
      return Array.isArray(parsed) ? (parsed as TerminalRunRecord[]) : [];
    } catch {
      return [];
    }
  }

  async list(): Promise<TerminalRunRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.root());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => this.read(file.slice(0, -5))));
    return records.flat().sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  }

  private root(): string {
    return join(this.baseDir ?? userDataDir(), "learning", "runs");
  }

  private file(taskId: string): string {
    return join(this.root(), `${safeId(taskId)}.json`);
  }

  private serialize<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.queues.set(
      taskId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }
}

export function sanitizeForJournal(value: unknown): unknown {
  return sanitizeValue(structuredClone(value));
}

export function deriveFailureSignature(failure: RunFailureSummary): string {
  const mechanism = failure.reasonCode?.trim().toLowerCase() || normalizeMechanism(failure.summary);
  return stableHash([
    failure.category.trim().toLowerCase(),
    failure.capabilityId?.trim().toLowerCase() ?? "none",
    mechanism,
  ].join(":"));
}

export function deriveTaskFamilyCandidate(objectiveClass: string): string {
  const slug = objectiveClass.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task";
  return `${slug}-${stableHash(objectiveClass.toLowerCase()).slice(0, 8)}`;
}

function normalizeMechanism(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[a-z]:\\[^\s]+|\/(?:[^\s/]+\/)+[^\s]+/g, "[path]")
    .replace(/\b\d+(?:\.\d+)?\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return SENSITIVE_VALUE_PATTERNS.reduce((sanitized, pattern) => sanitized.replace(pattern, "[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[REDACTED:CIRCULAR]";
  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeValue(item, seen);
  }
  return sanitized;
}

function validateInput(input: TerminalRunRecordInput): void {
  requireSafeId(input.taskId, "taskId");
  requireText(input.objectiveClass, "objectiveClass", 200);
  if (!Array.isArray(input.capabilityIds) || input.capabilityIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("capabilityIds must be an array of non-empty strings");
  }
  if (!Array.isArray(input.attempts) || !Array.isArray(input.failures) || !Array.isArray(input.recoveryChoices)) {
    throw new Error("attempts, failures, and recoveryChoices must be arrays");
  }
  if (!Array.isArray(input.criteria) || !Array.isArray(input.userSignals)) {
    throw new Error("criteria and userSignals must be arrays");
  }
  if (!["completed", "failed", "blocked", "cancelled"].includes(input.outcome)) {
    throw new Error("outcome must be terminal");
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) throw new Error("durationMs must be non-negative");
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) throw new Error("costUsd must be non-negative");
}

function requireSafeId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) throw new Error(`${label} must be a safe identifier`);
}

function requireText(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty trimmed string of at most ${maxLength} characters`);
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "run";
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await renameWithRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
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
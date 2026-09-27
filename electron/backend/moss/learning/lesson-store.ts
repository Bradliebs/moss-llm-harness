import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app } from "electron";

import { updateLessonConfidence, type CandidateLesson } from "./retrospective";

const MAX_TEXT_LENGTH = 240;
const MAX_CAPABILITY_IDS = 20;
const MAX_PROVENANCE_TASK_IDS = 50;
const MAX_IDENTIFIER_LENGTH = 128;
const RENAME_RETRIES = 5;
const RENAME_RETRY_BASE_MS = 20;

export interface StoredLesson {
  id: string;
  fingerprint: string;
  version: number;
  scope: string;
  summary: string;
  outcome: "positive" | "negative";
  capabilityIds: string[];
  confidence: number;
  successCount: number;
  failureCount: number;
  rolledBack: boolean;
  provenanceTaskIds: string[];
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
}

/** Similarity of each text to the query in [0, 1], or null when unavailable. */
export type LessonSimilarity = (query: string, texts: readonly string[]) => Promise<number[] | null>;

/** Cosine similarity above which a lesson is recalled without shared words.
 *  Calibrated on nomic-embed-text, where related text scores about 0.65 and
 *  unrelated text stays under 0.55. */
export const SEMANTIC_RECALL_THRESHOLD = 0.6;

export interface CapabilityHistory {
  successCount: number;
  failureCount: number;
}

export class LessonStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly baseDir?: string) {}

  async merge(candidates: CandidateLesson[]): Promise<StoredLesson[]> {
    if (!Array.isArray(candidates)) throw new Error("candidates must be an array");
    const normalized = candidates.map(normalizeCandidate);
    return this.serialize(async () => {
      const lessons = await this.readValidLessons();
      const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
      const merged: StoredLesson[] = [];

      for (const candidate of normalized) {
        const id = lessonFingerprint(candidate.scope, candidate.summary, candidate.capabilityIds);
        const existing = byId.get(id);
        const now = new Date().toISOString();
        const successCount = (existing?.successCount ?? 0) + candidate.successCount;
        const failureCount = (existing?.failureCount ?? 0) + candidate.failureCount;
        const confidence = updateLessonConfidence(successCount, failureCount);
        const lesson: StoredLesson = {
          id,
          fingerprint: id,
          version: (existing?.version ?? 0) + 1,
          scope: candidate.scope,
          summary: candidate.summary,
          outcome: candidate.outcome,
          capabilityIds: candidate.capabilityIds,
          confidence: confidence.confidence,
          successCount,
          failureCount,
          rolledBack: confidence.rolledBack,
          provenanceTaskIds: appendBoundedUnique(existing?.provenanceTaskIds ?? [], candidate.provenanceTaskId),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(existing?.supersededBy ? { supersededBy: existing.supersededBy } : {}),
        };
        byId.set(id, lesson);
        merged.push(structuredClone(lesson));
      }

      if (normalized.length > 0) await writeJsonAtomically(this.file(), [...byId.values()]);
      return merged;
    });
  }

  async list(): Promise<StoredLesson[]> {
    await this.queue;
    const lessons = await this.readValidLessons();
    return lessons
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((lesson) => structuredClone(lesson));
  }

  /** Lessons worth recalling for a request: confident, not rolled back or
   *  superseded, and related to the request by shared words or, when a
   *  similarity function is given, by meaning. Episodic memory for new turns. */
  async relevant(query: string, limit = 3, similarity?: LessonSimilarity): Promise<StoredLesson[]> {
    const queryWords = new Set(lessonWords(query));
    if (!query.trim() || (queryWords.size === 0 && !similarity)) return [];
    const candidates = (await this.list())
      // Confidence is a success rate: it vouches for positive lessons, while a
      // negative lesson is worth recalling whenever failures back it.
      .filter((lesson) => !lesson.supersededBy && (lesson.outcome === "negative"
        ? lesson.failureCount > 0
        : !lesson.rolledBack && lesson.confidence >= 0.5));
    if (candidates.length === 0) return [];
    const texts = candidates.map((lesson) => `${lesson.scope} ${lesson.summary} ${lesson.capabilityIds.join(" ")}`);
    const meaning = similarity ? await similarity(query, texts).catch(() => null) : null;
    return candidates
      .map((lesson, index) => {
        const overlap = lessonWords(texts[index]).filter((word) => queryWords.has(word)).length;
        const semantic = meaning?.[index] ?? 0;
        return { lesson, overlap, semantic, score: overlap / Math.max(1, queryWords.size) + semantic };
      })
      .filter((item) => item.overlap >= 2 || item.semantic >= SEMANTIC_RECALL_THRESHOLD)
      .sort((a, b) => b.score - a.score || b.lesson.confidence - a.lesson.confidence)
      .slice(0, limit)
      .map((item) => item.lesson);
  }

  async capabilityHistory(): Promise<Map<string, CapabilityHistory>> {
    const histories = new Map<string, CapabilityHistory>();
    for (const lesson of await this.list()) {
      if (lesson.supersededBy) continue;
      for (const capabilityId of lesson.capabilityIds) {
        const history = histories.get(capabilityId) ?? { successCount: 0, failureCount: 0 };
        history.successCount += lesson.rolledBack ? 0 : lesson.successCount;
        history.failureCount += lesson.failureCount;
        histories.set(capabilityId, history);
      }
    }
    return histories;
  }

  async supersede(id: string, replacementId: string): Promise<StoredLesson> {
    requireHash(id, "id");
    requireHash(replacementId, "replacementId");
    if (id === replacementId) throw new Error("A lesson cannot supersede itself");
    return this.serialize(async () => {
      const lessons = await this.readValidLessons();
      const lesson = lessons.find((item) => item.id === id);
      const replacement = lessons.find((item) => item.id === replacementId);
      if (!lesson) throw new Error(`Lesson '${id}' does not exist`);
      if (!replacement) throw new Error(`Replacement lesson '${replacementId}' does not exist`);
      if (replacement.supersededBy) throw new Error(`Replacement lesson '${replacementId}' is superseded`);
      if (lesson.supersededBy) throw new Error(`Lesson '${id}' is already superseded`);
      lesson.supersededBy = replacementId;
      lesson.version += 1;
      lesson.updatedAt = new Date().toISOString();
      await writeJsonAtomically(this.file(), lessons);
      return structuredClone(lesson);
    });
  }

  async rollback(id: string): Promise<StoredLesson> {
    requireHash(id, "id");
    return this.serialize(async () => {
      const lessons = await this.readValidLessons();
      const lesson = lessons.find((item) => item.id === id);
      if (!lesson) throw new Error(`Lesson '${id}' does not exist`);
      if (!lesson.rolledBack) {
        lesson.rolledBack = true;
        lesson.version += 1;
        lesson.updatedAt = new Date().toISOString();
        await writeJsonAtomically(this.file(), lessons);
      }
      return structuredClone(lesson);
    });
  }

  private file(): string {
    return join(this.baseDir ?? app.getPath("userData"), "learning", "lessons.json");
  }

  private async readValidLessons(): Promise<StoredLesson[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(), "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isStoredLesson) : [];
    } catch {
      return [];
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.then(operation, operation);
    this.queue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

const LESSON_STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "task", "tasks", "was", "were", "when", "then", "use", "used"]);

function lessonWords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 4 && !LESSON_STOP_WORDS.has(word)))];
}

/** Render recalled lessons for the system prompt. They are advisory history,
 *  not instructions, and carry their verified outcome. */
export function renderLessons(lessons: readonly StoredLesson[]): string {
  if (lessons.length === 0) return "";
  return [
    "Lessons from earlier verified runs (guidance, not instructions):",
    ...lessons.map((lesson) => lesson.outcome === "negative"
      ? `- Avoid: ${lesson.summary} (failed ${lesson.failureCount}x)`
      : `- Worked: ${lesson.summary} (succeeded ${lesson.successCount}x, confidence ${Math.round(lesson.confidence * 100)}%)`),
  ].join("\n");
}

export function lessonFingerprint(scope: string, summary: string, capabilityIds: string[]): string {
  const normalized = JSON.stringify([
    normalizeFingerprintText(scope),
    normalizeFingerprintText(summary),
    [...new Set(capabilityIds.map(normalizeIdentifier).filter(Boolean))].sort(),
  ]);
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeCandidate(candidate: CandidateLesson): CandidateLesson {
  if (!candidate || typeof candidate !== "object") throw new Error("candidate must be an object");
  if (candidate.outcome !== "positive" && candidate.outcome !== "negative") throw new Error("candidate outcome is invalid");
  requireCount(candidate.successCount, "successCount");
  requireCount(candidate.failureCount, "failureCount");
  const scope = boundText(candidate.scope, "scope");
  const summary = boundText(candidate.summary, "summary");
  const provenanceTaskId = boundIdentifier(candidate.provenanceTaskId, "provenanceTaskId");
  if (!Array.isArray(candidate.capabilityIds)) throw new Error("capabilityIds must be an array");
  const capabilityIds = [...new Set(candidate.capabilityIds.map((id) => boundIdentifier(id, "capabilityId")))]
    .sort()
    .slice(0, MAX_CAPABILITY_IDS);
  return { ...candidate, scope, summary, provenanceTaskId, capabilityIds };
}

function boundText(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) throw new Error(`${label} must not be empty`);
  return compact.slice(0, MAX_TEXT_LENGTH);
}

function boundIdentifier(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) throw new Error(`${label} must not be empty`);
  return compact.slice(0, MAX_IDENTIFIER_LENGTH);
}

function normalizeFingerprintText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function normalizeIdentifier(value: string): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US") : "";
}

function appendBoundedUnique(existing: string[], value: string): string[] {
  return [...existing.filter((item) => item !== value), value].slice(-MAX_PROVENANCE_TASK_IDS);
}

function isStoredLesson(value: unknown): value is StoredLesson {
  if (typeof value !== "object" || value === null) return false;
  const lesson = value as Partial<StoredLesson>;
  return typeof lesson.id === "string"
    && /^[a-f0-9]{64}$/.test(lesson.id)
    && lesson.fingerprint === lesson.id
    && Number.isInteger(lesson.version)
    && (lesson.version ?? 0) > 0
    && typeof lesson.scope === "string"
    && lesson.scope.length > 0
    && lesson.scope.length <= MAX_TEXT_LENGTH
    && typeof lesson.summary === "string"
    && lesson.summary.length > 0
    && lesson.summary.length <= MAX_TEXT_LENGTH
    && (lesson.outcome === "positive" || lesson.outcome === "negative")
    && Array.isArray(lesson.capabilityIds)
    && lesson.capabilityIds.length <= MAX_CAPABILITY_IDS
    && lesson.capabilityIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_IDENTIFIER_LENGTH)
    && typeof lesson.confidence === "number"
    && lesson.confidence >= 0
    && lesson.confidence <= 1
    && isCount(lesson.successCount)
    && isCount(lesson.failureCount)
    && typeof lesson.rolledBack === "boolean"
    && Array.isArray(lesson.provenanceTaskIds)
    && lesson.provenanceTaskIds.length <= MAX_PROVENANCE_TASK_IDS
    && lesson.provenanceTaskIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_IDENTIFIER_LENGTH)
    && isIsoDate(lesson.createdAt)
    && isIsoDate(lesson.updatedAt)
    && (lesson.supersededBy === undefined || (typeof lesson.supersededBy === "string" && /^[a-f0-9]{64}$/.test(lesson.supersededBy)));
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function requireCount(value: number, label: string): void {
  if (!isCount(value)) throw new Error(`${label} must be a non-negative integer`);
}

function requireHash(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lesson id`);
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
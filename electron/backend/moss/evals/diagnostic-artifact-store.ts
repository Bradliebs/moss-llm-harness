import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitizeForJournal } from "../learning/run-journal";
import type { HarnessDiagnosticReference } from "../../../../common/evals";

export interface HarnessDiagnosticArtifact {
  schemaVersion: 1;
  events: Array<{ sequence: number; kind: string; payload: string }>;
  payloads: Record<string, unknown>;
  truncated: boolean;
}

export interface HarnessDiagnosticCorrection {
  reviewedBy: string;
  reason: string;
  success?: boolean;
  score?: number;
  failureCategory?: string;
}

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export class HarnessDiagnosticCapture {
  private readonly artifact: HarnessDiagnosticArtifact = { schemaVersion: 1, events: [], payloads: {}, truncated: false };
  private bytes = 0;

  append(kind: string, value: unknown): void {
    if (this.artifact.events.length >= 1024 || this.bytes >= MAX_ARTIFACT_BYTES - MAX_PAYLOAD_BYTES) {
      this.artifact.truncated = true;
      return;
    }
    const sanitized = sanitizeForJournal(normalize(value, { remaining: 4096, omit: () => { this.artifact.truncated = true; } }));
    let serialized = JSON.stringify(sanitized) ?? "null";
    if (Buffer.byteLength(serialized) > MAX_PAYLOAD_BYTES) {
      serialized = JSON.stringify({ omitted: "payload-size-limit" });
      this.artifact.truncated = true;
    }
    const payload = digest(serialized);
    if (!(payload in this.artifact.payloads)) {
      this.artifact.payloads[payload] = JSON.parse(serialized) as unknown;
      this.bytes += Buffer.byteLength(serialized) + 70;
    }
    this.artifact.events.push({ sequence: this.artifact.events.length + 1, kind: kind.slice(0, 64), payload });
    this.bytes += 256;
  }

  snapshot(): HarnessDiagnosticArtifact {
    return structuredClone(this.artifact);
  }
}

export class HarnessDiagnosticArtifactStore {
  constructor(private readonly directory: string) {}

  recordCorrection(original: HarnessDiagnosticReference, correction: HarnessDiagnosticCorrection): HarnessDiagnosticReference {
    this.read(original);
    if (typeof correction.reviewedBy !== "string" || !correction.reviewedBy.trim()
      || typeof correction.reason !== "string" || !correction.reason.trim()
      || (correction.success === undefined && correction.score === undefined && correction.failureCategory === undefined)
      || (correction.failureCategory !== undefined && (typeof correction.failureCategory !== "string" || !correction.failureCategory.trim()))
      || (correction.success !== undefined && typeof correction.success !== "boolean")
      || (correction.score !== undefined && (!Number.isFinite(correction.score) || correction.score < 0 || correction.score > 1))) {
      throw new Error("Invalid diagnostic correction");
    }
    const capture = new HarnessDiagnosticCapture();
    capture.append("human-correction", {
      original, reviewedBy: correction.reviewedBy, reason: correction.reason,
      success: correction.success, score: correction.score, failureCategory: correction.failureCategory,
      recordedAt: new Date().toISOString(), id: randomUUID(),
    });
    if (capture.snapshot().truncated) throw new Error("Diagnostic correction exceeds size limit");
    return this.write(capture);
  }

  write(capture: HarnessDiagnosticCapture): HarnessDiagnosticReference {
    const serialized = JSON.stringify(capture.snapshot());
    if (Buffer.byteLength(serialized) > MAX_ARTIFACT_BYTES) throw new Error("Diagnostic artifact exceeds size limit");
    const reference: HarnessDiagnosticReference = { schemaVersion: 1, sha256: digest(serialized) };
    const root = resolve(this.directory);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = join(root, `${randomUUID()}.tmp`);
    const destination = join(root, `${reference.sha256}.json`);
    writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      try {
        linkSync(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.read(reference);
      }
    } finally {
      unlinkSync(temporary);
    }
    return reference;
  }

  read(reference: HarnessDiagnosticReference): HarnessDiagnosticArtifact {
    if (reference.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
      throw new Error("Invalid diagnostic reference");
    }
    const path = join(resolve(this.directory), `${reference.sha256}.json`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error("Invalid diagnostic artifact file");
    }
    const serialized = readFileSync(path, "utf8");
    if (digest(serialized) !== reference.sha256) throw new Error("Diagnostic artifact digest mismatch");
    const artifact = JSON.parse(serialized) as HarnessDiagnosticArtifact;
    if (!artifact || artifact.schemaVersion !== 1 || typeof artifact.truncated !== "boolean"
      || !Array.isArray(artifact.events) || artifact.events.length > 1024
      || typeof artifact.payloads !== "object" || artifact.payloads === null || Array.isArray(artifact.payloads)
      || Object.keys(artifact.payloads).length > 1024
      || Object.entries(artifact.payloads).some(([hash, payload]) => !/^[a-f0-9]{64}$/.test(hash)
        || digest(JSON.stringify(payload)) !== hash || Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES)
      || artifact.events.some((event, index) => !event || event.sequence !== index + 1
        || typeof event.kind !== "string" || event.kind.length > 64 || typeof event.payload !== "string"
        || !Object.hasOwn(artifact.payloads, event.payload))) {
      throw new Error("Invalid diagnostic artifact schema");
    }
    return artifact;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: unknown, budget: { remaining: number; omit: () => void }, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 16 || budget.remaining-- <= 0) {
    budget.omit();
    return "[OMITTED:TRAVERSAL-LIMIT]";
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_PAYLOAD_BYTES) {
      budget.omit();
      return { omitted: "payload-size-limit" };
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") return normalize(parsed, budget, depth + 1, seen);
    } catch {}
    return value;
  }
  if (value instanceof Error) return normalize({ name: value.name, message: value.message }, budget, depth + 1, seen);
  if (typeof value !== "object" || value === null) return typeof value === "bigint" ? String(value) : value;
  if (seen.has(value)) {
    budget.omit();
    return "[OMITTED:CIRCULAR]";
  }
  seen.add(value);
  const limit = Math.min(1024, Math.max(0, budget.remaining));
  if (Array.isArray(value)) {
    if (value.length > limit) budget.omit();
    const result = value.slice(0, limit).map((item) => normalize(item, budget, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const entries = Object.entries(value);
  if (entries.length > limit) budget.omit();
  const result = Object.fromEntries(entries.slice(0, limit).map(([key, item]) => [key, normalize(item, budget, depth + 1, seen)]));
  seen.delete(value);
  return result;
}
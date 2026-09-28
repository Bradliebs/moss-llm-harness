// electron/backend/moss/governed/review-queue.ts
//
// A human-gated queue for agent-proposed memory writes. When gated memory is on,
// the m_remember tool enqueues a proposal here instead of writing straight to
// durable memory; the user approves or rejects each one from Settings. Approval
// commits the fact to the real memory store; rejection drops it. Persisted as a
// plain JSON array at <userData>/memory-review-queue.json via the atomic writer,
// mirroring memory-store.ts so the queue survives restarts. Reads never throw.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import { createLogger } from "../../../../common/logger";
import type { MemoryCategory, MemoryEntry } from "../../../../common/types";
import { memoryStore } from "../memory/memory-store";
import { writeFileAtomicSync } from "../persistence/atomic-file";

const log = createLogger("MemoryReview");

const MAX_PENDING = 100;
const MAX_FACT_LEN = 500;
const CATEGORIES: readonly MemoryCategory[] = ["preference", "fact", "decision", "context"];

function isEntry(x: unknown): x is MemoryEntry {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.fact === "string" &&
    typeof e.source === "string" &&
    typeof e.createdAt === "string" &&
    CATEGORIES.includes(e.category as MemoryCategory)
  );
}

export class MemoryReviewQueue {
  private entries: MemoryEntry[] = [];
  private loaded = false;

  /** baseDir override exists for tests; production uses Electron userData. */
  constructor(private readonly baseDir?: string) {}

  private file(): string {
    return join(this.baseDir ?? userDataDir(), "memory-review-queue.json");
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.reload();
  }

  reload(): void {
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file(), "utf8"));
      this.entries = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      writeFileAtomicSync(this.file(), `${JSON.stringify(this.entries, null, 2)}\n`);
    } catch (err) {
      log.error("failed to save review queue", err);
    }
  }

  /** Pending proposals, oldest first. */
  list(): MemoryEntry[] {
    this.ensureLoaded();
    return [...this.entries];
  }

  /** Add a proposal. Case-insensitive dedup against pending; capped at
   *  MAX_PENDING (oldest dropped). Returns the proposal, or null when empty. */
  enqueue(fact: string, category: MemoryCategory = "fact", source = "assistant"): MemoryEntry | null {
    this.ensureLoaded();
    const normalized = fact.trim().slice(0, MAX_FACT_LEN);
    if (!normalized) return null;
    const existing = this.entries.find((e) => e.fact.toLowerCase() === normalized.toLowerCase());
    if (existing) return { ...existing };
    const entry: MemoryEntry = {
      id: randomUUID(),
      fact: normalized,
      category,
      source,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_PENDING) this.entries = this.entries.slice(-MAX_PENDING);
    this.save();
    return { ...entry };
  }

  /** Approve a proposal: commit it to durable memory and drop it from the queue.
   *  Returns the committed memory entry, or null when the id is unknown. */
  approve(id: string): MemoryEntry | null {
    this.ensureLoaded();
    const i = this.entries.findIndex((e) => e.id === id);
    if (i === -1) return null;
    const [proposal] = this.entries.splice(i, 1);
    this.save();
    return memoryStore.add(proposal.fact, proposal.category, proposal.source);
  }

  /** Reject a proposal: drop it without writing to memory. */
  reject(id: string): boolean {
    this.ensureLoaded();
    const i = this.entries.findIndex((e) => e.id === id);
    if (i === -1) return false;
    this.entries.splice(i, 1);
    this.save();
    return true;
  }
}

/** Singleton used by the m_remember tool and the IPC layer. */
export const memoryReviewQueue = new MemoryReviewQueue();

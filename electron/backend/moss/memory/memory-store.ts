// electron/backend/moss/memory/memory-store.ts
//
// Durable cross-session memory. Plain JSON at <userData>/m-memory.json, matching
// the persistence pattern used by mcp-config.ts. Loads are lazy and never throw;
// a missing or corrupt file simply yields an empty store.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import { createLogger } from "../../../../common/logger";
import type { MemoryCategory, MemoryEntry } from "../../../../common/types";
import { writeFileAtomicSync } from "../persistence/atomic-file";
import { formatMemoryEntriesForSystemPrompt, queryWords, scoreMemory } from "./memory-format";

const log = createLogger("Memory");

const MAX_MEMORIES = 200;
const MAX_FACT_LEN = 500;
// Upper bound on durable `preference` facts injected into a single system prompt.
// Preferences are always-included semantic memory, but without a cap a large
// preference history (up to MAX_MEMORIES) could crowd out query-matched episodic
// recall entirely. Most-recent preferences are kept.
const MAX_PROMPT_PREFERENCES = 20;
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

export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private loaded = false;

  /** baseDir override exists for tests; production uses Electron userData. */
  constructor(private readonly baseDir?: string) {}

  private file(): string {
    return join(this.baseDir ?? userDataDir(), "m-memory.json");
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.reload();
  }

  /** Re-read from disk. Called once lazily, or explicitly after app-ready. */
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
      log.error("failed to save memory", err);
    }
  }

  list(): MemoryEntry[] {
    this.ensureLoaded();
    return [...this.entries];
  }

  /** Add a fact. Case-insensitive dedup; capped at MAX_MEMORIES (oldest dropped). */
  add(fact: string, category: MemoryCategory = "fact", source = "session"): MemoryEntry | null {
    this.ensureLoaded();
    const normalized = fact.trim().slice(0, MAX_FACT_LEN);
    if (!normalized) return null;
    const existing = this.entries.find((m) => m.fact.toLowerCase() === normalized.toLowerCase());
    if (existing) return { ...existing };
    const entry: MemoryEntry = {
      id: randomUUID(),
      fact: normalized,
      category,
      source,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_MEMORIES) this.entries = this.entries.slice(-MAX_MEMORIES);
    this.save();
    return { ...entry };
  }

  delete(id: string): boolean {
    this.ensureLoaded();
    const i = this.entries.findIndex((m) => m.id === id);
    if (i === -1) return false;
    this.entries.splice(i, 1);
    this.save();
    return true;
  }

  clear(): void {
    this.ensureLoaded();
    this.entries = [];
    this.save();
  }

  /** Keyword search, best match first. Empty query returns most-recent first.
   *  An explicit search (m_recall) also matches two-letter words. */
  recall(query: string, limit = 20, minWordLength = 3): MemoryEntry[] {
    this.ensureLoaded();
    if (!query.trim()) return [...this.entries].slice(-limit).reverse();
    const words = queryWords(query, minWordLength);
    if (words.length === 0) return [];
    return this.entries
      .map((m) => ({ m, score: scoreMemory(m, words) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.m);
  }

  /** Render the memory block for a turn's system prompt. Durable `preference`
   *  facts are always included (semantic memory) up to MAX_PROMPT_PREFERENCES;
   *  the remaining episodic categories are query-matched via recall() so an
   *  unbounded history never floods the prompt. An empty query falls back to
   *  most-recent episodic. */
  selectForSystemPrompt(query: string, limit = 20): string {
    this.ensureLoaded();
    return formatMemoryEntriesForSystemPrompt([...this.preferenceEntries(), ...this.recalledEntries(query, limit)]);
  }

  /** Durable preferences only. They change only when the user saves one, so
   *  they belong in the stable system message. */
  selectPreferencesForPrompt(): string {
    this.ensureLoaded();
    return formatMemoryEntriesForSystemPrompt(this.preferenceEntries());
  }

  /** Memories recalled for this request. They change from turn to turn, so they
   *  go in the per-turn context rather than the system message. */
  selectRecalledForPrompt(query: string, limit = 20): string {
    this.ensureLoaded();
    return formatMemoryEntriesForSystemPrompt(this.recalledEntries(query, limit));
  }

  private preferenceEntries(): MemoryEntry[] {
    return this.entries.filter((m) => m.category === "preference").slice(-MAX_PROMPT_PREFERENCES);
  }

  private recalledEntries(query: string, limit: number): MemoryEntry[] {
    return this.recall(query, limit).filter((m) => m.category !== "preference");
  }
}

export const memoryStore = new MemoryStore();

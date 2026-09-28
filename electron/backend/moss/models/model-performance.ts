// electron/backend/moss/models/model-performance.ts
//
// Live scores. A capability profile is measured once on synthetic probes; how a
// model actually does on your work can differ. Each settled turn records host
// evidence (verification, task state, harness rejections, stalls) per model and
// task kind, and the probe tier is adjusted by at most one step once enough
// graded outcomes exist. The model's own claims never count.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import type { ModelPerformanceEntry, ModelTaskKind, ProviderKind } from "../../../../common/types";
import { writeFileAtomic } from "../persistence/atomic-file";
import { endpointLabel, profileKey } from "./capability-profile";

export { adjustTier, effectiveProfile, gradeTurn, liveScore, MIN_GRADED_FOR_TIER, taskKindFor, wilson, type TurnEvidence } from "../../../../common/live-scores";

const MAX_RECENT = 50;
const MAX_ENTRIES = 500;

export interface RecordInput {
  providerKind: ProviderKind;
  baseUrl: string;
  model: string;
  kind: ModelTaskKind;
  outcome?: "s" | "f";
  practice?: boolean;
  rejections?: number;
  stalls?: number;
  escalatedAway?: boolean;
  repairs?: number;
  durationMs?: number;
}

function isEntry(value: unknown): value is ModelPerformanceEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ModelPerformanceEntry>;
  return entry.schemaVersion === 1 && typeof entry.model === "string" && typeof entry.endpoint === "string"
    && typeof entry.kind === "string" && Array.isArray(entry.recent) && Array.isArray(entry.practice);
}

export class ModelPerformanceStore {
  private queue: Promise<void> = Promise.resolve();
  private cache: Promise<ModelPerformanceEntry[]> | null = null;

  constructor(private readonly baseDir?: string, private readonly now: () => Date = () => new Date()) {}

  private file(): string {
    return join(this.baseDir ?? userDataDir(), "model-profiles", "performance.json");
  }

  list(): Promise<ModelPerformanceEntry[]> {
    this.cache ??= this.read();
    this.cache.catch(() => { this.cache = null; });
    return this.cache.then((entries) => entries.map((entry) => structuredClone(entry)));
  }

  async forModel(kind: ProviderKind, baseUrl: string, model: string): Promise<ModelPerformanceEntry[]> {
    const key = profileKey(kind, baseUrl, model);
    return (await this.list()).filter((entry) => profileKey(entry.providerKind, entry.endpoint, entry.model) === key);
  }

  private async read(): Promise<ModelPerformanceEntry[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file(), "utf8"));
      return Array.isArray(value) ? value.filter(isEntry) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  record(input: RecordInput): Promise<void> {
    const run = this.queue.then(async () => {
      const entries = await this.list();
      const key = `${profileKey(input.providerKind, input.baseUrl, input.model)}\u0000${input.kind}`;
      const index = entries.findIndex((entry) => `${profileKey(entry.providerKind, entry.endpoint, entry.model)}\u0000${entry.kind}` === key);
      const current: ModelPerformanceEntry = index >= 0 ? entries[index] : {
        schemaVersion: 1,
        providerKind: input.providerKind,
        endpoint: endpointLabel(input.baseUrl),
        model: input.model,
        kind: input.kind,
        runs: 0,
        recent: [],
        practice: [],
        rejections: 0,
        stalls: 0,
        escalatedAway: 0,
        repairs: 0,
        updatedAt: this.now().toISOString(),
      };
      const next: ModelPerformanceEntry = {
        ...current,
        runs: current.runs + (input.practice ? 0 : 1),
        recent: input.outcome && !input.practice ? [...current.recent, input.outcome].slice(-MAX_RECENT) : current.recent,
        practice: input.outcome && input.practice ? [...current.practice, input.outcome].slice(-MAX_RECENT) : current.practice,
        rejections: current.rejections + (input.rejections ?? 0),
        stalls: current.stalls + (input.stalls ?? 0),
        escalatedAway: current.escalatedAway + (input.escalatedAway ? 1 : 0),
        repairs: current.repairs + (input.repairs ?? 0),
        ...(input.durationMs !== undefined && !input.practice
          ? { latencyMs: Math.round(current.latencyMs === undefined ? input.durationMs : current.latencyMs * 0.8 + input.durationMs * 0.2) }
          : {}),
        updatedAt: this.now().toISOString(),
      };
      const others = entries.filter((_, position) => position !== index);
      const saved = [next, ...others].slice(0, MAX_ENTRIES);
      await writeFileAtomic(this.file(), JSON.stringify(saved, null, 2));
      this.cache = Promise.resolve(saved);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async clear(kind: ProviderKind, baseUrl: string, model: string): Promise<void> {
    const key = profileKey(kind, baseUrl, model);
    const run = this.queue.then(async () => {
      const kept = (await this.list()).filter((entry) => profileKey(entry.providerKind, entry.endpoint, entry.model) !== key);
      await writeFileAtomic(this.file(), JSON.stringify(kept, null, 2));
      this.cache = Promise.resolve(kept);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export const modelPerformanceStore = new ModelPerformanceStore();

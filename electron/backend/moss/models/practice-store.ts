// electron/backend/moss/models/practice-store.ts
//
// Practice-run configuration, the latest report, and the idle scheduler. A
// scheduled run starts only when the user has been idle for a while, the PC is
// on mains power, no turn is running, and the last run was long enough ago; a
// new turn cancels it so the GPU goes back to the user.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import type { PracticeConfig, PracticeReport } from "../../../../common/types";
import { writeFileAtomic } from "../persistence/atomic-file";

const CHECK_INTERVAL_MS = 5 * 60_000;
const MIN_GAP_MS = 20 * 60 * 60_000;
export const DEFAULT_IDLE_MINUTES = 20;

export function normalizePracticeConfig(value: unknown): PracticeConfig {
  const record = value && typeof value === "object" ? value as Partial<PracticeConfig> : {};
  return {
    enabled: record.enabled === true,
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "http://localhost:11434/v1",
    candidates: Array.isArray(record.candidates) ? record.candidates.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 6) : [],
    maxTraces: Math.min(20, Math.max(1, Math.floor(Number(record.maxTraces) || 8))),
    idleMinutes: Math.min(240, Math.max(5, Math.floor(Number(record.idleMinutes) || DEFAULT_IDLE_MINUTES))),
  };
}

export class PracticeStore {
  constructor(private readonly baseDir?: string) {}

  private file(name: string): string {
    return join(this.baseDir ?? userDataDir(), "practice", name);
  }

  private async read<T>(name: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.file(name), "utf8")) as T;
    } catch {
      return null;
    }
  }

  async config(): Promise<PracticeConfig> {
    return normalizePracticeConfig(await this.read("config.json"));
  }

  async saveConfig(config: unknown): Promise<PracticeConfig> {
    const normalized = normalizePracticeConfig(config);
    await writeFileAtomic(this.file("config.json"), JSON.stringify(normalized, null, 2));
    return normalized;
  }

  latest(): Promise<PracticeReport | null> {
    return this.read<PracticeReport>("latest.json");
  }

  async saveReport(report: PracticeReport): Promise<void> {
    await writeFileAtomic(this.file("latest.json"), JSON.stringify(report, null, 2));
  }
}

export const practiceStore = new PracticeStore();

export interface SchedulerDeps {
  idleSeconds: () => number;
  onBattery: () => boolean;
  busy: () => boolean;
  config: () => Promise<PracticeConfig>;
  lastRunAt: () => Promise<number | undefined>;
  run: () => Promise<void>;
  now?: () => number;
}

/** Checks periodically whether a practice run should start. */
export class PracticeScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One scheduling decision; exposed for tests. */
  async tick(): Promise<boolean> {
    if (this.running || this.deps.busy() || this.deps.onBattery()) return false;
    const config = await this.deps.config();
    if (!config.enabled || config.candidates.length === 0) return false;
    if (this.deps.idleSeconds() < (config.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60) return false;
    const last = await this.deps.lastRunAt();
    const now = (this.deps.now ?? Date.now)();
    if (last !== undefined && now - last < MIN_GAP_MS) return false;
    this.running = true;
    try {
      await this.deps.run();
    } finally {
      this.running = false;
    }
    return true;
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app } from "electron";

import type {
  ProductDiagnosticEntry,
  ProductDiagnosticKind,
  ProductDiagnosticsConfig,
} from "../../../common/types";

const DEFAULT_CONFIG: ProductDiagnosticsConfig = { enabled: false, retentionDays: 30 };
const MAX_ENTRIES = 2_000;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 90;

function normalizeConfig(config: ProductDiagnosticsConfig): ProductDiagnosticsConfig {
  return {
    enabled: config.enabled === true,
    retentionDays: Math.min(
      MAX_RETENTION_DAYS,
      Math.max(MIN_RETENTION_DAYS, Math.floor(config.retentionDays || DEFAULT_CONFIG.retentionDays)),
    ),
  };
}

function isEntry(value: unknown): value is ProductDiagnosticEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ProductDiagnosticEntry>;
  return typeof entry.id === "string" && typeof entry.occurredAt === "string" && typeof entry.kind === "string";
}

export class ProductDiagnosticsStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly baseDir?: string) {}

  private root(): string {
    return join(this.baseDir ?? app.getPath("userData"), "product-diagnostics");
  }

  private eventsFile(): string {
    return join(this.root(), "events.json");
  }

  private configFile(): string {
    return join(this.root(), "config.json");
  }

  async config(): Promise<ProductDiagnosticsConfig> {
    try {
      return normalizeConfig(JSON.parse(await readFile(this.configFile(), "utf8")) as ProductDiagnosticsConfig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
      throw error;
    }
  }

  async configure(config: ProductDiagnosticsConfig): Promise<ProductDiagnosticsConfig> {
    const normalized = normalizeConfig(config);
    await mkdir(dirname(this.configFile()), { recursive: true });
    await writeFile(this.configFile(), JSON.stringify(normalized, null, 2), "utf8");
    await this.prune(normalized);
    return normalized;
  }

  async record(
    kind: ProductDiagnosticKind,
    details: Omit<ProductDiagnosticEntry, "id" | "occurredAt" | "kind"> = {},
  ): Promise<void> {
    this.queue = this.queue.then(async () => {
      const config = await this.config();
      if (!config.enabled) return;
      const entries = await this.readEntries();
      if (kind === "launch-first-response" && entries.some((entry) => entry.kind === kind)) return;
      entries.push({ id: randomUUID(), occurredAt: new Date().toISOString(), kind, ...details });
      await this.writeEntries(this.retained(entries, config));
    });
    return this.queue;
  }

  async list(): Promise<{ config: ProductDiagnosticsConfig; entries: ProductDiagnosticEntry[] }> {
    await this.queue;
    const config = await this.config();
    const entries = this.retained(await this.readEntries(), config);
    return { config, entries: entries.reverse() };
  }

  async clear(): Promise<void> {
    await this.queue;
    await rm(this.eventsFile(), { force: true });
  }

  private async prune(config: ProductDiagnosticsConfig): Promise<void> {
    const entries = this.retained(await this.readEntries(), config);
    if (entries.length > 0) await this.writeEntries(entries);
    else await rm(this.eventsFile(), { force: true });
  }

  private retained(entries: ProductDiagnosticEntry[], config: ProductDiagnosticsConfig): ProductDiagnosticEntry[] {
    const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1_000;
    return entries
      .filter((entry) => Date.parse(entry.occurredAt) >= cutoff)
      .slice(-MAX_ENTRIES);
  }

  private async readEntries(): Promise<ProductDiagnosticEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.eventsFile(), "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeEntries(entries: ProductDiagnosticEntry[]): Promise<void> {
    await mkdir(dirname(this.eventsFile()), { recursive: true });
    await writeFile(this.eventsFile(), JSON.stringify(entries), "utf8");
  }
}

export const productDiagnostics = new ProductDiagnosticsStore();

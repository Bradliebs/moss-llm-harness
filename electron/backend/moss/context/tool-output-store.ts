import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import { writeFileAtomic } from "../persistence/atomic-file";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 200;

export interface ToolOutputRecord {
  id: string;
  createdAt: string;
  turnId?: string;
  callId: string;
  toolName: string;
  external: boolean;
  content: string;
}

export type SaveToolOutput = Omit<ToolOutputRecord, "id" | "createdAt">;

function validRecord(value: unknown): value is ToolOutputRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && ID_PATTERN.test(record.id)
    && typeof record.createdAt === "string"
    && typeof record.callId === "string"
    && typeof record.toolName === "string"
    && typeof record.external === "boolean"
    && typeof record.content === "string";
}

export class ToolOutputStore {
  constructor(private readonly baseDir?: string) {}

  private root(): string {
    return join(this.baseDir ?? userDataDir(), "tool-output");
  }

  private file(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error("Invalid tool output artifact id");
    return join(this.root(), `${id}.json`);
  }

  async save(input: SaveToolOutput): Promise<ToolOutputRecord> {
    const record: ToolOutputRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...structuredClone(input),
    };
    await writeFileAtomic(this.file(record.id), `${JSON.stringify(record)}\n`);
    return structuredClone(record);
  }

  async get(id: string): Promise<ToolOutputRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(id), "utf8"));
      return validRecord(parsed) && parsed.id === id ? structuredClone(parsed) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async prune(maxAgeMs = DEFAULT_MAX_AGE_MS, maxRecords = DEFAULT_MAX_RECORDS): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.root())).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const files = await Promise.all(names.map(async (name) => ({
      name,
      modifiedAt: (await stat(join(this.root(), name))).mtimeMs,
    })));
    files.sort((left, right) => right.modifiedAt - left.modifiedAt);
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(files
      .filter((file, index) => index >= maxRecords || file.modifiedAt < cutoff)
      .map((file) => rm(join(this.root(), file.name), { force: true })));
  }
}

export const toolOutputStore = new ToolOutputStore();
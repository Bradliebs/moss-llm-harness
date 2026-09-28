// electron/backend/moss/checkpoint/checkpoint-store.ts
//
// Per-turn file checkpoints so an agent's edits can be undone. Before a mutating
// filesystem tool writes, it records the file's pre-image (content, or "absent"
// when the file did not exist) keyed by the turn id. A revert restores every
// recorded pre-image: re-writing files that existed and deleting files the turn
// created. Manifests are plain JSON at <userData>/checkpoints/<turnId>.json,
// matching the persistence pattern used by memory-store.ts, so a revert still
// works after an app restart. Recording is best-effort: a snapshot failure is
// logged and never propagated, so it cannot break the write it guards.

import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import { createLogger } from "../../../../common/logger";
import type { CheckpointFile, CheckpointRevertResult } from "../../../../common/types";
import { writeFileAtomic } from "../persistence/atomic-file";

const log = createLogger("Checkpoint");

/** Keep the newest N turn manifests; older ones are pruned on each new turn. */
const MAX_TURNS = 50;

interface FileSnapshot {
  /** absolute path that was modified; revert restores to exactly this path */
  absPath: string;
  /** workspace-relative path for display in the UI */
  relPath: string;
  /** false when the file did not exist before the turn (revert deletes it) */
  existed: boolean;
  /** pre-image contents, present only when existed is true */
  content: string;
}

interface TurnCheckpoint {
  turnId: string;
  createdAt: string;
  files: FileSnapshot[];
}

/** Per-turn handle threaded into a tool's context. `record` captures a file's
 *  pre-image the first time it is seen in a turn; later calls for the same path
 *  are no-ops so the earliest state is the one a revert restores. */
export interface CheckpointRecorder {
  record(absPath: string, relPath: string): Promise<void>;
}

/** Turn ids come from the renderer; constrain to a safe filename. */
function safeId(turnId: string): string {
  return turnId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "turn";
}

export class CheckpointStore {
  private cache = new Map<string, TurnCheckpoint>();

  /** baseDir override exists for tests; production uses Electron userData. */
  constructor(private readonly baseDir?: string) {}

  private dir(): string {
    return join(this.baseDir ?? userDataDir(), "checkpoints");
  }

  private file(turnId: string): string {
    return join(this.dir(), `${safeId(turnId)}.json`);
  }

  private async loadTurn(turnId: string): Promise<TurnCheckpoint | null> {
    const cached = this.cache.get(turnId);
    if (cached) return cached;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(turnId), "utf8"));
      if (!isTurnCheckpoint(parsed)) return null;
      this.cache.set(turnId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  private async saveTurn(turn: TurnCheckpoint): Promise<void> {
    await writeFileAtomic(this.file(turn.turnId), `${JSON.stringify(turn, null, 2)}\n`);
  }

  /** A recorder bound to one turn. Pre-images are captured at most once per path. */
  recorder(turnId: string): CheckpointRecorder {
    return {
      record: async (absPath: string, relPath: string): Promise<void> => {
        try {
          let turn = this.cache.get(turnId) ?? (await this.loadTurn(turnId));
          if (!turn) {
            turn = { turnId, createdAt: new Date().toISOString(), files: [] };
            this.cache.set(turnId, turn);
          }
          if (turn.files.some((f) => f.absPath === absPath)) return; // earliest state wins
          let snapshot: FileSnapshot;
          try {
            const content = await readFile(absPath, "utf8");
            snapshot = { absPath, relPath, existed: true, content };
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              snapshot = { absPath, relPath, existed: false, content: "" };
            } else {
              throw err;
            }
          }
          turn.files.push(snapshot);
          await this.saveTurn(turn);
        } catch (err) {
          // Best-effort: a checkpoint failure must never break the guarded write.
          log.error("failed to record checkpoint", err);
        }
      },
    };
  }

  /** Files a turn changed, for the renderer's "N files changed" affordance. */
  async list(turnId: string): Promise<CheckpointFile[]> {
    const turn = await this.loadTurn(turnId);
    if (!turn) return [];
    return turn.files.map((f) => ({ path: f.relPath, existed: f.existed }));
  }

  /** Restore every recorded pre-image, then discard the manifest so a turn
   *  cannot be reverted twice. Per-file failures are collected, not thrown. */
  async revert(turnId: string): Promise<CheckpointRevertResult> {
    const turn = await this.loadTurn(turnId);
    if (!turn || turn.files.length === 0) return { reverted: 0, errors: [] };
    let reverted = 0;
    const errors: string[] = [];
    for (const f of turn.files) {
      try {
        if (f.existed) {
          await mkdir(dirname(f.absPath), { recursive: true });
          await writeFile(f.absPath, f.content, "utf8");
        } else {
          await unlink(f.absPath).catch((err) => {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          });
        }
        reverted++;
      } catch (err) {
        errors.push(`${f.relPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.cache.delete(turnId);
    await rm(this.file(turnId), { force: true }).catch(() => undefined);
    return { reverted, errors };
  }

  /** Keep the newest MAX_TURNS manifests; delete older ones. Synchronous and
   *  swallow-on-error so it can run opportunistically at turn start. */
  prune(keep = MAX_TURNS): void {
    try {
      const dir = this.dir();
      mkdirSync(dir, { recursive: true });
      const files = readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const { n } of files.slice(keep)) {
        rmSync(join(dir, n), { force: true });
      }
    } catch {
      // Pruning is opportunistic; a failure here is not worth surfacing.
    }
  }
}

function isTurnCheckpoint(x: unknown): x is TurnCheckpoint {
  if (typeof x !== "object" || x === null) return false;
  const t = x as Record<string, unknown>;
  return typeof t.turnId === "string" && typeof t.createdAt === "string" && Array.isArray(t.files);
}

/** Singleton used by the IPC layer and the turn loop. */
export const checkpointStore = new CheckpointStore();

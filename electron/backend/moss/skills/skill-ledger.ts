// electron/backend/moss/skills/skill-ledger.ts
//
// Skills earn their place. Every skill version is tracked with its verified
// outcomes: a skill the agent wrote (or rewrote) starts as a candidate and is
// promoted to trusted only after several verified successes on that version;
// a skill that keeps failing is demoted and leaves the prompt's skill index
// until the user restores it. Human-authored skills start trusted but can still
// be demoted by evidence. Earlier versions are kept so a regression can be
// rolled back. "Verified" means host-owned evidence -- passing verification or
// a completed task -- never the model's own claim.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import type { Skill, SkillTrust, SkillTrustStatus } from "../../../../common/types";
import { writeFileAtomicSync } from "../persistence/atomic-file";

export const PROMOTE_AFTER = 3;
export const DEMOTE_AFTER_CONSECUTIVE = 2;
export const STALE_AFTER_DAYS = 90;
const MAX_HISTORY = 5;
const RECENT_WINDOW = 5;

export type SkillOutcome = "success" | "failure" | "used";

interface SkillVersionSnapshot {
  version: number;
  hash: string;
  savedAt: string;
  description: string;
  instructions: string;
}

interface LedgerEntry {
  id: string;
  version: number;
  contentHash: string;
  status: SkillTrustStatus;
  statusReason: string;
  uses: number;
  verifiedSuccesses: number;
  failures: number;
  versionSuccesses: number;
  consecutiveFailures: number;
  recent: Array<"s" | "f">;
  firstSeenAt: string;
  lastUsedAt?: string;
  history: SkillVersionSnapshot[];
}

function contentHash(skill: Pick<Skill, "description" | "instructions">): string {
  return createHash("sha256").update(`${skill.description}\u0000${skill.instructions}`).digest("hex").slice(0, 20);
}

export class SkillLedger {
  private pendingEdits = new Map<string, "agent" | "user">();

  constructor(private readonly baseDir?: string, private readonly now: () => Date = () => new Date()) {}

  private file(): string {
    return join(this.baseDir ?? userDataDir(), "m-skills", "ledger.json");
  }

  private read(): Record<string, LedgerEntry> {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file(), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, LedgerEntry> : {};
    } catch {
      return {};
    }
  }

  private write(entries: Record<string, LedgerEntry>): void {
    try {
      writeFileAtomicSync(this.file(), `${JSON.stringify(entries, null, 2)}\n`);
    } catch {
      // Trust tracking is advisory; a write failure must not break skill use.
    }
  }

  private isStale(entry: LedgerEntry): boolean {
    const reference = Date.parse(entry.lastUsedAt ?? entry.firstSeenAt);
    return Number.isFinite(reference) && this.now().getTime() - reference > STALE_AFTER_DAYS * 86_400_000;
  }

  private toTrust(entry: LedgerEntry): SkillTrust {
    return {
      status: entry.status,
      version: entry.version,
      uses: entry.uses,
      verifiedSuccesses: entry.verifiedSuccesses,
      failures: entry.failures,
      versionSuccesses: entry.versionSuccesses,
      consecutiveFailures: entry.consecutiveFailures,
      ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
      stale: this.isStale(entry),
      statusReason: entry.statusReason,
    };
  }

  /** Reconcile the ledger with the skills on disk: register new skills, open a
   *  new version when content changed, and drop entries for deleted skills.
   *  Returns the skills with their trust attached. */
  sync(skills: readonly Skill[]): Skill[] {
    const entries = this.read();
    let changed = false;
    const now = this.now().toISOString();
    const present = new Set(skills.map((skill) => skill.id));
    for (const id of Object.keys(entries)) {
      if (!present.has(id)) {
        delete entries[id];
        changed = true;
      }
    }
    for (const skill of skills) {
      const hash = contentHash(skill);
      const existing = entries[skill.id];
      if (!existing) {
        const agent = skill.createdBy === "agent";
        entries[skill.id] = {
          id: skill.id,
          version: 1,
          contentHash: hash,
          status: agent ? "candidate" : "trusted",
          statusReason: agent ? "Agent-written; needs verified successes before it is trusted" : "Written or imported by a person",
          uses: 0,
          verifiedSuccesses: 0,
          failures: 0,
          versionSuccesses: 0,
          consecutiveFailures: 0,
          recent: [],
          firstSeenAt: now,
          history: [{ version: 1, hash, savedAt: now, description: skill.description, instructions: skill.instructions }],
        };
        changed = true;
        continue;
      }
      if (existing.contentHash !== hash) {
        const editor = this.pendingEdits.get(skill.id) ?? (skill.createdBy === "agent" ? "agent" : "user");
        this.pendingEdits.delete(skill.id);
        existing.version += 1;
        existing.contentHash = hash;
        existing.versionSuccesses = 0;
        existing.consecutiveFailures = 0;
        existing.history = [...existing.history, { version: existing.version, hash, savedAt: now, description: skill.description, instructions: skill.instructions }].slice(-MAX_HISTORY);
        if (editor === "agent") {
          existing.status = "candidate";
          existing.statusReason = `Version ${existing.version} was rewritten by the agent and must be verified again`;
        } else if (existing.status === "demoted") {
          existing.status = "candidate";
          existing.statusReason = `Version ${existing.version} was edited after demotion and must be verified again`;
        }
        changed = true;
      }
    }
    if (changed) this.write(entries);
    return skills.map((skill) => entries[skill.id] ? { ...skill, trust: this.toTrust(entries[skill.id]) } : skill);
  }

  /** Attribute the next content change of this skill to its editor. */
  noteEdit(id: string, editor: "agent" | "user"): void {
    this.pendingEdits.set(id, editor);
  }

  recordOutcome(ids: readonly string[], outcome: SkillOutcome): void {
    if (ids.length === 0) return;
    const entries = this.read();
    const now = this.now().toISOString();
    let changed = false;
    for (const id of new Set(ids)) {
      const entry = entries[id];
      if (!entry) continue;
      const stale = this.isStale(entry);
      entry.uses += 1;
      entry.lastUsedAt = now;
      if (outcome === "success") {
        entry.verifiedSuccesses += 1;
        entry.versionSuccesses += 1;
        entry.consecutiveFailures = 0;
        entry.recent = [...entry.recent, "s" as const].slice(-RECENT_WINDOW);
        if (entry.status === "candidate" && entry.versionSuccesses >= PROMOTE_AFTER) {
          entry.status = "trusted";
          entry.statusReason = `Promoted after ${PROMOTE_AFTER} verified successes on version ${entry.version}`;
        }
      } else if (outcome === "failure") {
        entry.failures += 1;
        entry.consecutiveFailures += 1;
        entry.recent = [...entry.recent, "f" as const].slice(-RECENT_WINDOW);
        const recentFailures = entry.recent.filter((item) => item === "f").length;
        if (entry.status !== "demoted" && (entry.consecutiveFailures >= DEMOTE_AFTER_CONSECUTIVE || recentFailures >= 3 || stale)) {
          entry.status = "demoted";
          entry.statusReason = stale
            ? `Demoted: failed on first use after ${STALE_AFTER_DAYS} days unused`
            : entry.consecutiveFailures >= DEMOTE_AFTER_CONSECUTIVE
              ? `Demoted after ${entry.consecutiveFailures} consecutive failures`
              : `Demoted after ${recentFailures} failures in the last ${entry.recent.length} uses`;
        }
      }
      changed = true;
    }
    if (changed) this.write(entries);
  }

  setStatus(id: string, status: SkillTrustStatus): SkillTrust | null {
    const entries = this.read();
    const entry = entries[id];
    if (!entry) return null;
    entry.status = status;
    entry.consecutiveFailures = 0;
    entry.statusReason = status === "trusted" ? "Trusted by the user" : status === "candidate" ? "Restored by the user; needs verified successes" : "Demoted by the user";
    this.write(entries);
    return this.toTrust(entry);
  }

  /** Earlier versions, newest first, for rollback. */
  history(id: string): SkillVersionSnapshot[] {
    return [...(this.read()[id]?.history ?? [])].reverse();
  }
}

export const skillLedger = new SkillLedger();

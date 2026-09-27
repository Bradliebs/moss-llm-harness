// electron/backend/moss/governed/progress-supervisor.ts
//
// Detects a turn that keeps acting without making progress. A round counts as
// progress only when it produces a new successful observation or a file change
// Moss has not seen before. Repeating an identical call, failing, or writing a
// file back to an earlier version does not count. After a few stalled rounds
// the model is warned; after more, the turn stops and asks the user, instead of
// spending more budget on the same dead end.

import { createHash } from "node:crypto";

export const DEFAULT_STALL_WARN = 3;
export const DEFAULT_STALL_LIMIT = 5;

export interface RoundObservation {
  name: string;
  arguments: string;
  ok: boolean;
  content: string;
}

export interface SupervisorVerdict {
  action: "continue" | "warn" | "stop";
  stalledRounds: number;
  reason?: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function canonical(raw: string): string {
  try {
    const sort = (value: unknown): unknown => Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])]))
        : value;
    return JSON.stringify(sort(JSON.parse(raw || "{}")));
  } catch {
    return raw;
  }
}

function parse(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export class ProgressSupervisor {
  private readonly seen = new Set<string>();
  private readonly fileVersions = new Map<string, string[]>();
  private stalled = 0;
  private warned = false;
  private lastReason = "";

  constructor(private readonly warnAfter = DEFAULT_STALL_WARN, private readonly stopAfter = DEFAULT_STALL_LIMIT) {}

  get stalledRounds(): number {
    return this.stalled;
  }

  /** Judge one completed tool round. */
  observeRound(observations: readonly RoundObservation[]): SupervisorVerdict {
    let progressed = false;
    const reasons: string[] = [];
    for (const observation of observations) {
      if (!observation.ok) {
        reasons.push(`${observation.name} failed`);
        continue;
      }
      const revert = this.fileChange(observation);
      if (revert === "revert") {
        reasons.push(`${observation.name} restored an earlier version of a file`);
        continue;
      }
      if (revert === "new") {
        progressed = true;
        continue;
      }
      if (revert === "same") {
        reasons.push(`${observation.name} rewrote a file with identical content`);
        continue;
      }
      const key = hash(`${observation.name}\u0000${canonical(observation.arguments)}\u0000${hash(observation.content)}`);
      if (this.seen.has(key)) reasons.push(`${observation.name} repeated a result already seen`);
      else {
        this.seen.add(key);
        progressed = true;
      }
    }
    if (progressed || observations.length === 0) {
      this.stalled = 0;
      this.warned = false;
      return { action: "continue", stalledRounds: 0 };
    }
    this.stalled += 1;
    this.lastReason = [...new Set(reasons)].slice(0, 3).join("; ") || "no new results";
    if (this.stopAfter > 0 && this.stalled >= this.stopAfter) {
      return { action: "stop", stalledRounds: this.stalled, reason: this.lastReason };
    }
    if (this.stalled >= this.warnAfter && !this.warned) {
      this.warned = true;
      return { action: "warn", stalledRounds: this.stalled, reason: this.lastReason };
    }
    return { action: "continue", stalledRounds: this.stalled, reason: this.lastReason };
  }

  /** "new" for a first-seen file state, "revert" for a return to an earlier
   *  non-latest state (edit/revert oscillation), "same" for a no-op rewrite,
   *  or undefined when the call does not change a file. */
  private fileChange(observation: RoundObservation): "new" | "revert" | "same" | undefined {
    const args = parse(observation.arguments);
    let path: string | undefined;
    let state: string | undefined;
    if (observation.name === "write_file" && typeof args.path === "string") {
      path = args.path;
      state = hash(String(args.content ?? ""));
    } else if (observation.name === "edit_file" && typeof args.path === "string") {
      path = args.path;
      // An edit that swaps newText back to oldText undoes an earlier edit.
      const forward = hash(`${String(args.oldText ?? "")}\u0000${String(args.newText ?? "")}`);
      const inverse = hash(`${String(args.newText ?? "")}\u0000${String(args.oldText ?? "")}`);
      const history = this.fileVersions.get(path) ?? [];
      if (history.includes(`edit:${inverse}`)) {
        this.fileVersions.set(path, [...history, `edit:${forward}`]);
        return "revert";
      }
      state = `edit:${forward}`;
      if (history.includes(state)) return "same";
      this.fileVersions.set(path, [...history, state]);
      return "new";
    }
    if (!path || state === undefined) return undefined;
    const history = this.fileVersions.get(path) ?? [];
    const latest = history.at(-1);
    this.fileVersions.set(path, [...history, state]);
    if (latest === state) return "same";
    return history.includes(state) ? "revert" : "new";
  }
}

export function supervisorWarning(verdict: SupervisorVerdict): string {
  return `Moss supervisor: the last ${verdict.stalledRounds} tool rounds made no progress (${verdict.reason}). Change your approach, use what you already know, or stop and ask the user for guidance. Continuing the same way will end the turn.`;
}

export function supervisorStopMessage(verdict: SupervisorVerdict): string {
  return `I stopped because the last ${verdict.stalledRounds} tool rounds made no progress (${verdict.reason}). Rather than keep repeating the same approach, I need your guidance: tell me what to try differently, what information I am missing, or whether to stop here.`;
}

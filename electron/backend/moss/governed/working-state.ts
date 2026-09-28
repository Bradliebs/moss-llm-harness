// electron/backend/moss/governed/working-state.ts
//
// Governed working state. Invariants, protected paths, decisions, facts, and
// open questions live in typed state that is kept apart from the transcript and
// rendered into the system message every round, so context compaction can never
// summarize them away. A budget allocator sizes the rendering to the model's
// context, and protected paths are enforced by the host rather than trusted to
// the model.

import { randomUUID } from "node:crypto";
import { isAbsolute, posix, relative, resolve } from "node:path";

import type { AgentMessage, WorkingState, WorkingStateEntry, WorkingStateKind } from "../../../../common/types";
import { classifyCommand } from "../permission";
import type { Tool } from "../tools/types";

export const WORKING_STATE_TAG = "working_state";
const MAX_ENTRIES = 200;
const MAX_TEXT = 500;
const KIND_ORDER: readonly WorkingStateKind[] = ["invariant", "protected", "decision", "question", "fact"];
const KIND_LABEL: Record<WorkingStateKind, string> = {
  invariant: "Invariants (never violate)",
  protected: "Protected paths (never create, modify, move, or delete)",
  decision: "Decisions",
  question: "Open questions",
  fact: "Facts",
};
const KIND_PREFIX: Record<WorkingStateKind, string> = { invariant: "i", protected: "p", decision: "d", question: "q", fact: "f" };

export function emptyWorkingState(): WorkingState {
  return { schemaVersion: 1, entries: [] };
}

function isEntry(value: unknown): value is WorkingStateEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<WorkingStateEntry>;
  return typeof entry.id === "string" && typeof entry.text === "string" && KIND_ORDER.includes(entry.kind as WorkingStateKind)
    && (entry.source === "user" || entry.source === "model");
}

/** Accept only well-formed entries from the renderer. */
export function normalizeWorkingState(value: unknown): WorkingState {
  const entries = value && typeof value === "object" && Array.isArray((value as WorkingState).entries)
    ? (value as WorkingState).entries.filter(isEntry).map((entry) => ({ ...entry, text: entry.text.slice(0, MAX_TEXT) }))
    : [];
  return { schemaVersion: 1, entries: entries.slice(-MAX_ENTRIES) };
}

export class WorkingStateStore {
  private state: WorkingState;
  private revision = 0;

  constructor(initial?: WorkingState) {
    this.state = normalizeWorkingState(initial ?? emptyWorkingState());
  }

  get version(): number {
    return this.revision;
  }

  snapshot(): WorkingState {
    return structuredClone(this.state);
  }

  add(kind: WorkingStateKind, text: string, source: "user" | "model", rationale?: string): WorkingStateEntry {
    const clean = text.trim().slice(0, MAX_TEXT);
    if (!clean) throw new Error("Working state entries need text");
    const duplicate = this.state.entries.find((entry) => entry.kind === kind && entry.text.toLowerCase() === clean.toLowerCase());
    if (duplicate) return duplicate;
    const count = this.state.entries.filter((entry) => entry.kind === kind).length + 1;
    const entry: WorkingStateEntry = {
      id: `${KIND_PREFIX[kind]}${count}-${randomUUID().slice(0, 4)}`,
      kind,
      text: clean,
      ...(rationale?.trim() ? { rationale: rationale.trim().slice(0, MAX_TEXT) } : {}),
      source,
      createdAt: new Date().toISOString(),
    };
    this.state.entries = [...this.state.entries, entry].slice(-MAX_ENTRIES);
    this.revision += 1;
    return entry;
  }

  /** The model may retire its own facts and questions. Invariants, protected
   *  paths, decisions, and anything the user wrote stay until the user removes them. */
  removeByModel(id: string): { ok: boolean; reason?: string } {
    const entry = this.state.entries.find((item) => item.id === id);
    if (!entry) return { ok: false, reason: `No working state entry '${id}'` };
    if (entry.source === "user") return { ok: false, reason: "Entries written by the user can only be removed by the user" };
    if (entry.kind !== "fact" && entry.kind !== "question") {
      return { ok: false, reason: `${KIND_LABEL[entry.kind].split(" (")[0]} can only be removed by the user` };
    }
    this.state.entries = this.state.entries.filter((item) => item.id !== id);
    this.revision += 1;
    return { ok: true };
  }

  protectedPatterns(): string[] {
    return this.state.entries.filter((entry) => entry.kind === "protected").map((entry) => entry.text);
  }
}

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Working-state budget: 15% of the known context window, clamped to a band
 *  that keeps it useful on small models without crowding larger ones. */
export function workingStateBudget(contextLimit?: number): number {
  if (!contextLimit || contextLimit <= 0) return 1_500;
  return Math.min(2_000, Math.max(300, Math.floor(contextLimit * 0.15)));
}

/** Render within a token budget. Invariants and protected paths are always
 *  kept; the remaining kinds fill the budget newest first. */
export function renderWorkingState(state: WorkingState, budgetTokens = 1_500): string {
  if (state.entries.length === 0) return "";
  const header = `<${WORKING_STATE_TAG}>\nAuthoritative state for this conversation, maintained by Moss. It is not part of the transcript and survives context compaction. Keep it current with the working_state tool; never contradict an invariant or touch a protected path.`;
  const footer = `</${WORKING_STATE_TAG}>`;
  let used = estimateTokens(header) + estimateTokens(footer);
  const sections: string[] = [];
  const omitted: string[] = [];
  for (const kind of KIND_ORDER) {
    const entries = state.entries.filter((entry) => entry.kind === kind).reverse();
    if (entries.length === 0) continue;
    const lines: string[] = [];
    let skipped = 0;
    for (const entry of entries) {
      const line = `- [${entry.id}] ${entry.text}${entry.rationale ? ` (because ${entry.rationale})` : ""}${entry.source === "user" ? " [user]" : ""}`;
      const cost = estimateTokens(line) + 1;
      const mandatory = kind === "invariant" || kind === "protected";
      if (!mandatory && used + cost > budgetTokens) {
        skipped += 1;
        continue;
      }
      used += cost;
      lines.push(line);
    }
    if (lines.length > 0) sections.push(`${KIND_LABEL[kind]}:\n${lines.reverse().join("\n")}`);
    if (skipped > 0) omitted.push(`${skipped} ${kind === "fact" ? "older facts" : kind === "question" ? "older questions" : "older decisions"}`);
  }
  if (omitted.length > 0) sections.push(`(${omitted.join(", ")} omitted to fit the context budget; use working_state with action "view" to read them.)`);
  return [header, ...sections, footer].join("\n\n");
}

/** Put the rendered block into the system message, replacing any earlier block. */
export function withWorkingState(messages: readonly AgentMessage[], rendered: string): AgentMessage[] {
  const pattern = new RegExp(`\\n*<${WORKING_STATE_TAG}>[\\s\\S]*?</${WORKING_STATE_TAG}>`, "g");
  const next = [...messages];
  const systemIndex = next.findIndex((message) => message.role === "system");
  if (systemIndex < 0) {
    if (rendered) next.unshift({ role: "system", content: rendered });
    return next;
  }
  const base = next[systemIndex].content.replace(pattern, "");
  next[systemIndex] = { ...next[systemIndex], content: rendered ? `${base}\n\n${rendered}` : base };
  return next;
}

// --- Protected paths ---

function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** Workspace-relative form with `.` and `..` collapsed, so `src/../secret.txt`
 *  is matched as `secret.txt`, exactly as the path guard resolves it. */
function toRelative(path: string, workspaceRoot: string): string {
  if (workspaceRoot) return relative(resolve(workspaceRoot), resolve(workspaceRoot, path));
  return isAbsolute(path) ? path : posix.normalize(path.replace(/\\/g, "/"));
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** True when `path` equals a protected entry, lies inside a protected folder,
 *  or matches a protected glob. */
export function matchesProtected(path: string, patterns: readonly string[], workspaceRoot = ""): string | undefined {
  const target = normalizePath(toRelative(path, workspaceRoot));
  if (!target) return undefined;
  for (const raw of patterns) {
    const pattern = normalizePath(toRelative(raw.trim(), workspaceRoot));
    if (!pattern) continue;
    if (/[*?]/.test(pattern) ? globToRegExp(pattern).test(target) : target === pattern || target.startsWith(`${pattern}/`)) return raw;
  }
  return undefined;
}

const PATH_ARGUMENTS: Record<string, readonly string[]> = {
  write_file: ["path"],
  edit_file: ["path"],
  move_file: ["from", "to"],
};

/** Host enforcement: refuse a mutation that targets a protected path. Commands
 *  are refused when they are not read-only and mention a protected path. */
export function protectedPathViolation(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  patterns: readonly string[],
  workspaceRoot: string,
): string | undefined {
  if (patterns.length === 0) return undefined;
  for (const key of PATH_ARGUMENTS[toolName] ?? []) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const match = matchesProtected(value, patterns, workspaceRoot);
    if (match) return `Protected path: '${value}' is protected by this conversation's working state (${match}). Ask the user to remove the protection before changing it.`;
  }
  if (toolName === "run_command" && typeof args.command === "string" && classifyCommand(args.command) !== "readonly") {
    const command = normalizePath(args.command);
    const mentioned = patterns.find((pattern) => {
      const literal = normalizePath(pattern).replace(/\/?\*.*$/, "");
      return literal.length >= 3 && command.includes(literal);
    });
    if (mentioned) return `Protected path: this command could change '${mentioned}', which is protected by this conversation's working state. Ask the user to remove the protection first.`;
  }
  return undefined;
}

// --- Model-facing tool ---

const ACTIONS = ["view", "record_fact", "record_decision", "add_question", "add_invariant", "protect_path", "remove"] as const;
type Action = (typeof ACTIONS)[number];
const ACTION_KIND: Partial<Record<Action, WorkingStateKind>> = {
  record_fact: "fact",
  record_decision: "decision",
  add_question: "question",
  add_invariant: "invariant",
  protect_path: "protected",
};

export const workingStateTool: Tool = {
  name: "working_state",
  description:
    "Maintain this conversation's durable working state: facts you have established, decisions and why, open questions, invariants, and protected paths. It survives context compaction. Use 'remove' to retire your own facts or answered questions; invariants, protected paths, and decisions can only be removed by the user.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      text: { type: "string", description: "Entry text, or a workspace-relative path or glob for protect_path." },
      rationale: { type: "string", description: "Why, for record_decision." },
      id: { type: "string", description: "Entry id, for remove." },
    },
    required: ["action"],
  },
  async execute(args, ctx) {
    const store = ctx.workingState;
    if (!store) return { ok: false, content: "Working state is not available in this turn." };
    const action = String(args.action ?? "") as Action;
    if (!ACTIONS.includes(action)) return { ok: false, content: `Unknown action '${action}'. Use one of: ${ACTIONS.join(", ")}.` };
    if (action === "view") {
      return { ok: true, content: renderWorkingState(store.snapshot(), Number.MAX_SAFE_INTEGER) || "Working state is empty." };
    }
    if (action === "remove") {
      const result = store.removeByModel(String(args.id ?? ""));
      return result.ok ? { ok: true, content: `Removed ${String(args.id)}.` } : { ok: false, content: result.reason ?? "Could not remove entry" };
    }
    const text = String(args.text ?? "").trim();
    if (!text) return { ok: false, content: `'${action}' needs text.` };
    const entry = store.add(ACTION_KIND[action]!, text, "model", typeof args.rationale === "string" ? args.rationale : undefined);
    return { ok: true, content: `Recorded ${entry.id}: ${entry.text}` };
  },
};

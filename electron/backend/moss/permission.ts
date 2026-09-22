// electron/backend/moss/permission.ts
//
// Minimal permission policy. Read-only tools auto-run; anything that mutates the
// filesystem or executes commands requires explicit user approval. The path
// guard (path-guard.ts) is a separate, always-on sandbox enforced at execution.

import type { TaskExecutionGrant, ToolRisk } from "../../../common/types";

export type Permission = "allow" | "ask" | "deny";

const AUTO_ALLOW = new Set<string>([
  // plan only mutates in-memory checklist state, never the filesystem.
  "plan",
  "read_file",
  "list_dir",
  "search_files",
  "glob_files",
  "search_codebase",
  "read_tool_output",
  // delegate spawns a read-only subagent; it cannot reach a mutating tool.
  "delegate",
  // view_image only reads a file inside the workspace sandbox.
  "view_image",
  // git_status and git_diff only read repository state; they cannot mutate it.
  "git_status",
  "git_diff",
  "browser_inspect",
  "browser_assert_url",
  "browser_assert_text",
  "desktop_inspect",
  "desktop_assert_control",
  // Self-management tools operate on local app data, not user files, and are
  // low-risk; requiring approval on every memory/skill access would be noise.
  "m_remember",
  "m_recall",
  "m_forget",
  "m_list_memories",
  "m_list_skills",
  "m_get_skill",
  "m_get_skill_resource",
  "m_list_capabilities",
  "m_capability_status",
]);

export function classifyTool(name: string): Permission {
  if (AUTO_ALLOW.has(name)) return "allow";
  // write_file, edit_file, move_file, run_command, and any unknown tool require approval.
  return "ask";
}

// --- Shell command content classification ---------------------------------
//
// run_command is the highest-risk tool. Name-based gating alone is too coarse:
// `ls` and `rm -rf /` both arrive as run_command. classifyCommand inspects the
// command text so read-only commands can run without a prompt while destructive
// commands always prompt -- even when auto-approve is on.

export type CommandRisk = "readonly" | "mutating" | "destructive";

// A destructive token anywhere in the command (including inside a chain or
// command substitution) forces a prompt. Patterns are matched case-insensitively
// against the whole command string, so `echo hi && rm -rf x` is destructive.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(?:-\S*\s+)*-\S*[rf]/i, // rm with -r / -f / -rf (any flag order)
  /\brm\s+--(?:recursive|force)\b/i, // rm --recursive / --force
  /\brmdir\b/i,
  /\bdd\b[^|;&\n]*\bof=/i, // dd of=...
  /\bmkfs\b/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\bfdisk\b/i,
  /\bchmod\s+-R\b/i,
  />\s*\/dev\/(?:sd|hd|nvme|disk)/i, // writing to a block device
  /:\s*\(\s*\)\s*\{/, // :(){ fork bomb
  /\bgit\s+push\b[^|;&\n]*(?:--force\b|\s-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-\S*f/i,
  /\bdel\b\s+\/[a-z]/i, // Windows: del /s /q
  /\brd\b\s+\/s/i, // Windows: rd /s
  /\bformat\b\s+[a-z]:/i, // Windows: format C:
  /\bRemove-Item\b[^|;&\n]*-(?:Recurse|Force)\b/i,
  /\bFormat-Volume\b/i,
  /\bClear-Disk\b/i,
];

// Leading commands considered pure inspection. A command is read-only only when
// every pipe/chain segment starts with one of these (git is handled separately)
// and it contains no redirection or command substitution that could hide a
// mutation. Anything not provably read-only is treated as "mutating".
const READONLY_COMMANDS = new Set<string>([
  "ls",
  "dir",
  "cat",
  "type",
  "pwd",
  "cd",
  "echo",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "which",
  "where",
  "whoami",
  "hostname",
  "uname",
  "date",
  "env",
  "printenv",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "ps",
]);

// git subcommands with no common mutating form.
const GIT_READONLY_SUBCOMMANDS = new Set<string>([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "cat-file",
]);

function isReadonlySegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  const head = tokens[0]?.toLowerCase();
  if (!head) return false;
  if (head === "git") {
    const sub = tokens[1]?.toLowerCase();
    return sub !== undefined && GIT_READONLY_SUBCOMMANDS.has(sub);
  }
  return READONLY_COMMANDS.has(head);
}

export function classifyCommand(command: string): CommandRisk {
  const cmd = command.trim();
  if (!cmd) return "mutating";

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) return "destructive";
  }

  // Redirection or command substitution can hide a mutation behind an otherwise
  // read-only-looking command; refuse to auto-run those.
  if (/[>]|\$\(|`/.test(cmd)) return "mutating";

  const segments = cmd.split(/\s*(?:\|\||&&|\||;|\n)\s*/).filter(Boolean);
  if (segments.length === 0) return "mutating";
  return segments.every(isReadonlySegment) ? "readonly" : "mutating";
}

// --- Permission resolution -------------------------------------------------

export type PolicyAction = "run" | "prompt" | "deny";

export interface PolicyDecision {
  action: PolicyAction;
  /** true only when a mutating tool runs without a prompt because auto-approve
   *  was on -- the one case where the user never saw the call. */
  autoApproved: boolean;
  /** content risk tier so the approval UI can show why a call needs review. Set
   *  for run_command (readonly/mutating/destructive) and for file-mutating or
   *  unknown tools, which always carry the "mutating" tier. */
  risk?: CommandRisk;
}

export interface PolicyInput {
  name: string;
  /** the shell command string, when name === "run_command" */
  command?: string;
  args?: Readonly<Record<string, unknown>>;
  autoApprove: boolean;
  executionGrant?: TaskExecutionGrant;
  stepCapabilities?: readonly string[];
}

const IRREVERSIBLE_ACTION_PATTERN = /\b(delete|destroy|remove|submit|publish|pay|send|confirm|purchase)\b/i;
const ALWAYS_PROMPT_TOOLS = new Set(["send_email"]);

/** Resolve whether a tool call runs, prompts, or is denied. Centralizes the
 *  whole policy so the agent runner stays thin and the rules stay testable. */
export function resolvePermission(input: PolicyInput): PolicyDecision {
  if (input.executionGrant && (
    !input.executionGrant.allowedCapabilities.includes(input.name)
    || !(input.stepCapabilities?.includes(input.name) ?? false)
  )) {
    return { action: "deny", autoApproved: false };
  }
  const base = classifyTool(input.name);
  if (base === "deny") return { action: "deny", autoApproved: false };
  if (base === "allow") return { action: "run", autoApproved: false };

  if (input.name === "jev_evaluate") return { action: "prompt", autoApproved: false, risk: "mutating" };

  if (ALWAYS_PROMPT_TOOLS.has(input.name)) {
    return { action: "prompt", autoApproved: false, risk: "destructive" };
  }

  if (
    (input.name === "browser_click" || input.name === "desktop_invoke")
    && typeof input.args?.name === "string"
    && IRREVERSIBLE_ACTION_PATTERN.test(input.args.name)
  ) {
    return { action: "prompt", autoApproved: false, risk: "destructive" };
  }

  // base === "ask": mutating or elevated tools.
  if (input.name === "run_command") {
    const risk = classifyCommand(input.command ?? "");
    // Read-only commands are safe to run without a prompt.
    if (risk === "readonly") return { action: "run", autoApproved: false, risk };
    // Destructive commands always prompt, even when auto-approve is on.
    if (risk === "destructive") return { action: "prompt", autoApproved: false, risk };
    // Mutating commands: a mission grant replaces the legacy chat-wide switch.
    return mayAutoApprove(input, risk)
      ? { action: "run", autoApproved: true, risk }
      : { action: "prompt", autoApproved: false, risk };
  }

  return mayAutoApprove(input, "mutating")
    ? { action: "run", autoApproved: true, risk: "mutating" }
    : { action: "prompt", autoApproved: false, risk: "mutating" };
}

function mayAutoApprove(input: PolicyInput, risk: Exclude<ToolRisk, "destructive">): boolean {
  const grant = input.executionGrant;
  if (!grant) return input.autoApprove;
  if (grant.schemaVersion !== 1 || grant.authority !== "policy-scoped") return false;
  if (grant.maxAutoApprovedRisk === "readonly" && risk !== "readonly") return false;
  return grant.allowedCapabilities.includes(input.name)
    && (input.stepCapabilities?.includes(input.name) ?? false);
}

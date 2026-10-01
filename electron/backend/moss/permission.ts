// electron/backend/moss/permission.ts
//
// Minimal permission policy. Read-only tools auto-run; anything that mutates the
// filesystem or executes commands requires explicit user approval. The path
// guard (path-guard.ts) is a separate, always-on sandbox enforced at execution.

import type { TaskExecutionGrant, ToolRisk } from "../../../common/types";
import type { UntrustedDerivation } from "./safety/provenance";

import { labelsNameIrreversibleAction, namesIrreversibleAction } from "./safety/irreversible";

export type Permission = "allow" | "ask" | "deny";

const AUTO_ALLOW = new Set<string>([
  // plan only mutates in-memory checklist state, never the filesystem.
  "plan",
  // working_state edits conversation state; protected paths are enforced by the host.
  "working_state",
  // find_tool only changes which tools are offered this turn.
  "find_tool",
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
  /\brm\b[^|;&\n]*\s-[a-z]*[rf]/i, // rm with -r / -f / -rf anywhere in its arguments
  /\brm\b[^|;&\n]*\s--(?:recursive|force)\b/i, // rm --recursive / --force
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

/** An argument that points outside the workspace: an absolute or home path, a
 *  UNC share, or a parent directory. Short Windows switches such as /s stay allowed. */
function pathLeaves(arg: string): boolean {
  if (/^[a-z]:/i.test(arg) || arg.startsWith("\\") || arg.startsWith("~")) return true;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(arg)) return true;
  return arg.startsWith("/") && (arg.length > 4 || /^\/[^/]*\//.test(arg) || arg === "/");
}

function leavesWorkspace(token: string): boolean {
  // Quotes, carets, and backticks only splice text together in a shell.
  const arg = token.replace(/["'^`]/g, "");
  // A path can also hide after an option: --file=/etc/passwd or -f/etc/passwd.
  const candidates = [arg, ...arg.split("=").slice(1), /^-[a-z]./i.test(arg) && !arg.startsWith("--") ? arg.slice(2) : ""];
  return candidates.some((candidate) => candidate !== "" && pathLeaves(candidate));
}

/** Options that make an otherwise read-only command write files or run programs. */
const WRITING_OPTIONS = /^--(?:output|ext-diff|pre|exec|textconv)\b/i;

function isReadonlySegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  const head = tokens[0]?.toLowerCase();
  if (!head) return false;
  // Reading outside the workspace sends that content to the model unasked.
  if (tokens.slice(1).some(leavesWorkspace)) return false;
  if (tokens.slice(1).some((token) => WRITING_OPTIONS.test(token))) return false;
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

  // Redirection, command substitution, or variable expansion (which can print
  // secrets such as API keys) hide effects behind a read-only-looking command.
  if (/[<>]|\$|`|%[a-z_][a-z0-9_]*%/i.test(cmd)) return "mutating";

  // A single & separates commands in cmd.exe and backgrounds one in POSIX shells.
  const segments = cmd.split(/\s*(?:\|\||&&|&|\||;|\r?\n|\r)\s*/).filter(Boolean);
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
  /** true when auto-approval was withheld because untrusted content entered
   *  the turn; the approval prompt explains why */
  provenanceGate?: boolean;
  /** which rule decided, in plain language, for the approval prompt */
  rule?: string;
}

export interface PolicyInput {
  name: string;
  /** the shell command string, when name === "run_command" */
  command?: string;
  args?: Readonly<Record<string, unknown>>;
  autoApprove: boolean;
  executionGrant?: TaskExecutionGrant;
  stepCapabilities?: readonly string[];
  /** untrusted content (web, MCP, browser, desktop) has entered this turn */
  untrusted?: boolean;
  /** how the arguments relate to that content; absent is treated as derived */
  untrustedDerivation?: UntrustedDerivation;
  /** the tool is declared read-only by a source the user trusts */
  readOnly?: boolean;
  /** the tool is declared destructive by its source */
  destructive?: boolean;
  /** Moss's own reason, shown instead of the server's declaration */
  destructiveReason?: string;
  /** prompt when the arguments name an irreversible action */
  checkIrreversible?: boolean;
  /** the tool only reads from the network, such as opening a page */
  networkRead?: boolean;
}

/** Tools that only read from the network. After untrusted content they keep
 *  auto-approval unless their arguments derive from that content. */
const NETWORK_READ_TOOLS = new Set(["web_search", "fetch_url", "browser_navigate"]);

const GATE_RULE = "Changes after untrusted content always need approval.";

/** An http(s) URL whose host is not this machine or a private network. File,
 *  script, and data URLs, and local addresses, can read things a web page cannot. */
export function isPublicWebUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // A trailing dot names the same host ("localhost." is localhost).
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  // A single-label name ("intranet", "router") resolves on the local network.
  if (!host.includes(".") && !host.includes(":")) return false;
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (host.includes(":")) return !(host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89a-f]/.test(host) || host.startsWith("::ffff:"));
  return true;
}

function derivedReason(input: PolicyInput): string | undefined {
  const derivation = input.untrustedDerivation;
  if (!derivation) return "Its arguments may derive from untrusted content.";
  return derivation.kind === "derived" ? derivation.reason : undefined;
}

/** Allow-listed tools that still write durable state and so must not be
 *  triggered by untrusted content without a human in the loop. */
const DURABLE_STATE_TOOLS = new Set(["m_remember", "m_forget"]);

/** Working-state entries that act as standing instructions. Facts and questions
 *  are marked as untrusted instead of prompting. */
const AUTHORITATIVE_STATE_ACTIONS = new Set(["add_invariant", "record_decision", "protect_path"]);


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
  if (input.destructive) {
    return { action: "prompt", autoApproved: false, risk: "destructive", rule: input.destructiveReason ?? "The tool's server declares it destructive." };
  }
  if (input.networkRead && typeof input.args?.url === "string" && !isPublicWebUrl(input.args.url)) {
    return { action: "prompt", autoApproved: false, risk: "mutating", rule: "It opens a local file, a script, or an address on this computer or network, not a public web page." };
  }
  if (input.checkIrreversible && labelsNameIrreversibleAction(input.args)) {
    return { action: "prompt", autoApproved: false, risk: "destructive", rule: "It acts on a control named for an irreversible action, such as buy, pay, send, submit, or delete." };
  }
  if (input.readOnly) {
    const reason = input.untrusted ? derivedReason(input) : undefined;
    return reason
      ? { action: "prompt", autoApproved: false, risk: "readonly", provenanceGate: true, rule: reason }
      : { action: "run", autoApproved: false, risk: "readonly" };
  }
  const base = classifyTool(input.name);
  if (base === "deny") return { action: "deny", autoApproved: false };
  if (base === "allow") {
    if (input.untrusted && DURABLE_STATE_TOOLS.has(input.name)) {
      return { action: "prompt", autoApproved: false, risk: "mutating", provenanceGate: true, rule: "Saving memory after untrusted content always needs approval." };
    }
    if (input.untrusted && input.name === "working_state" && AUTHORITATIVE_STATE_ACTIONS.has(String(input.args?.action ?? ""))) {
      return { action: "prompt", autoApproved: false, risk: "mutating", provenanceGate: true, rule: "An invariant, decision, or protected path recorded after untrusted content steers every later round, so it needs approval." };
    }
    return { action: "run", autoApproved: false };
  }

  if (input.name === "jev_evaluate") return { action: "prompt", autoApproved: false, risk: "mutating" };

  if (ALWAYS_PROMPT_TOOLS.has(input.name)) {
    return { action: "prompt", autoApproved: false, risk: "destructive" };
  }

  if (
    (input.name === "browser_click" || input.name === "desktop_invoke")
    && typeof input.args?.name === "string"
    && namesIrreversibleAction(input.args.name)
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
    return autoOrPrompt(input, risk);
  }

  return autoOrPrompt(input, "mutating");
}

/** Untrusted content may inform a decision but never authorize a side effect:
 *  whatever auto-approval would otherwise apply is withheld once it is present. */
function autoOrPrompt(input: PolicyInput, risk: Exclude<ToolRisk, "destructive">): PolicyDecision {
  if (!mayAutoApprove(input, risk)) return { action: "prompt", autoApproved: false, risk };
  if (input.untrusted) {
    if (NETWORK_READ_TOOLS.has(input.name) || input.networkRead) {
      const reason = derivedReason(input);
      if (!reason) return { action: "run", autoApproved: true, risk };
      return { action: "prompt", autoApproved: false, risk, provenanceGate: true, rule: reason };
    }
    return { action: "prompt", autoApproved: false, risk, provenanceGate: true, rule: GATE_RULE };
  }
  return { action: "run", autoApproved: true, risk };
}

function mayAutoApprove(input: PolicyInput, risk: Exclude<ToolRisk, "destructive">): boolean {
  const grant = input.executionGrant;
  if (!grant) return input.autoApprove;
  if (grant.schemaVersion !== 1 || grant.authority !== "policy-scoped") return false;
  if (grant.maxAutoApprovedRisk === "readonly" && risk !== "readonly") return false;
  return grant.allowedCapabilities.includes(input.name)
    && (input.stepCapabilities?.includes(input.name) ?? false);
}

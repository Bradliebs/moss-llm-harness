// electron/backend/moss/models/tool-deferral.ts
//
// Deferred tool loading. An MCP server can add thousands of tokens of tool
// definitions to every request (Playwright: 24 tools, about 4,300 tokens), most
// of them unused in a given conversation. A large server's tools are held back
// until the conversation needs them: when the request names the server or
// clearly describes its work, when an earlier turn already used them, or when
// the model asks through find_tool, which then enables the whole server rather
// than a few tools.

import type { AgentMessage, ToolDefinition } from "../../../../common/types";

/** Servers whose definitions cost less than this are always offered. */
export const DEFER_THRESHOLD_TOKENS = 1_200;

export interface DeferredGroup {
  /** MCP server id */
  id: string;
  tools: string[];
  /** one line for find_tool's description */
  summary: string;
}

const estimate = (tool: ToolDefinition): number => Math.ceil(JSON.stringify(tool).length / 4);
/** Server id of an MCP tool, named mcp__<server>__<tool>. */
const serverOf = (name: string): string | undefined => (name.startsWith("mcp__") ? name.split("__")[1] || undefined : undefined);
const shortName = (name: string): string => name.split("__").slice(2).join("__") || name;

/** Name parts too common in ordinary requests to signal a tool set. */
const GENERIC_PARTS = new Set(["close", "press", "select", "option", "handle", "messages", "requests", "install", "resize", "list", "file", "files", "read", "write", "search", "create", "update", "delete", "remove", "get", "set", "run", "code", "type", "fill", "form", "wait", "tabs", "text"]);

/** Everyday words for web pages, counted as hints for a browser tool set. */
const PAGE_WORDS = ["website", "webpage", "web page", "homepage", "site", "page", "login", "log in", "sign in", "url"];
/** A browsing verb directly followed by a web address: a URL, www., localhost,
 *  an IPv4 address, or a bare domain. Bare domains need a suffix that is rarely
 *  a code name (.net, .io, .dev, and .app are, as in System.Net or socket.io). */
const BROWSE_ADDRESS = new RegExp(
  String.raw`\b(open|visit|go to|navigate to|browse to|load|log ?in to|sign in to|screenshot of|snapshot of)\s+(the\s+)?` +
    String.raw`(https?:\/\/\S+|www\.\S+|localhost\b|\d{1,3}(\.\d{1,3}){3}\b|[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|org|gov|edu|uk|de|fr|nl|es|ca|au|ch|se|nz|ie|in|jp)\b)`,
);
/** Signs that a request is about code, where words such as page, click, login,
 *  or navigate usually name code rather than ask for a browser. */
const CODE_MARKERS = /`|\b[\w-]+\.(tsx?|jsx?|mjs|cjs|py|rs|go|java|cs|rb|php|css|scss|html|vue|svelte|json|ya?ml|md)\b|\b[\w-]+\/[\w./-]+|(^|\s)\/[\w-]+|\b(component|handler|route|router|function|class|method|module|spec|test|redux|reducer|hook|config|codebase|variable)s?\b/;

const wordIn = (text: string, word: string): boolean => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text);

/** Why the request asks for this server, or undefined. Small models rarely ask
 *  find_tool on their own, so the host enables a set when the request already
 *  says what it needs. A strong signal is the server id, the word "browser" for
 *  a browser set, or a browsing verb followed by a web address ("open
 *  example.com"). Otherwise it takes two distinct hints, distinctive words of
 *  the tool names (Playwright: navigate, screenshot, console) plus everyday
 *  page words for a browser set, in a request with no signs of code. One hint
 *  alone ("console.log", "snapshot test") is not enough, nor are hints in a
 *  coding request ("the login component", "a click handler"). */
export function requestSignal(id: string, tools: readonly ToolDefinition[], request: string): string | undefined {
  const text = request.toLowerCase();
  const parts = new Set<string>();
  for (const tool of tools) {
    for (const part of shortName(tool.name).toLowerCase().split(/[_-]+/)) if (part.length >= 5 && !GENERIC_PARTS.has(part)) parts.add(part);
  }
  const browser = parts.has("browser") || parts.has("navigate");
  if (wordIn(text, id.toLowerCase())) return `the request names ${id}`;
  if (browser && wordIn(text, "browser")) return "the request mentions a browser";
  if (browser && BROWSE_ADDRESS.test(text)) return "the request asks to open a web address";
  if (CODE_MARKERS.test(request)) return undefined;
  const hints = [...parts, ...(browser ? PAGE_WORDS : [])].filter((word) => wordIn(text, word));
  return hints.length >= 2 ? `the request mentions ${hints.slice(0, 3).join(", ")}` : undefined;
}

export function planToolDeferral(
  tools: readonly ToolDefinition[],
  history: readonly AgentMessage[],
  request: string,
  thresholdTokens = DEFER_THRESHOLD_TOKENS,
): { offered: ToolDefinition[]; deferred: DeferredGroup[]; enabled: { id: string; reason: string }[] } {
  const groups = new Map<string, ToolDefinition[]>();
  for (const tool of tools) {
    const server = serverOf(tool.name);
    if (server) groups.set(server, [...(groups.get(server) ?? []), tool]);
  }
  const used = new Set(history.flatMap((message) => message.toolCalls ?? []).map((call) => serverOf(call.name)).filter(Boolean));
  const deferred: DeferredGroup[] = [];
  const enabled: { id: string; reason: string }[] = [];
  for (const [id, members] of groups) {
    const cost = members.reduce((sum, tool) => sum + estimate(tool), 0);
    if (cost < thresholdTokens) continue;
    if (used.has(id)) {
      enabled.push({ id, reason: "an earlier turn used it" });
      continue;
    }
    const signal = requestSignal(id, members, request);
    if (signal) {
      enabled.push({ id, reason: signal });
      continue;
    }
    const names = members.map((tool) => shortName(tool.name));
    deferred.push({ id, tools: members.map((tool) => tool.name), summary: `${id}: ${members.length} tools (${names.slice(0, 8).join(", ")}${names.length > 8 ? ", ..." : ""})` });
  }
  const held = new Set(deferred.flatMap((group) => group.tools));
  return { offered: tools.filter((tool) => !held.has(tool.name)), deferred, enabled };
}

/** find_tool's definition, listing what can be enabled. */
export function findToolDefinition(base: ToolDefinition, deferred: readonly DeferredGroup[]): ToolDefinition {
  if (deferred.length === 0) return base;
  return {
    ...base,
    description: `${base.description} Tool sets available on request (asking enables the whole set): ${deferred.map((group) => group.summary).join("; ")}.`,
  };
}

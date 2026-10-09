// electron/backend/moss/models/tool-repair.ts
//
// Repairs tool calls before they run. Small models often write a call as text
// instead of using the native channel, use argument names outside the schema,
// or echo the schema back instead of filling in values. Each repair is
// deterministic and reported; a call that still fails validation returns a
// precise schema error to the model instead of running.

import { randomUUID } from "node:crypto";

import type { ToolCall, ToolDefinition } from "../../../../common/types";

export const INVALID_ARGUMENTS_PREFIX = "Invalid arguments for";

interface Schema {
  properties?: Record<string, { type?: string | string[]; enum?: unknown[] }>;
  required?: string[];
}

const ALIASES: Record<string, string[]> = {
  path: ["file", "file_path", "filepath", "filename", "file_name", "target", "location_path"],
  command: ["cmd", "shell", "script", "command_line"],
  pattern: ["glob", "query_pattern"],
  query: ["q", "search", "search_query", "text"],
  content: ["contents", "text", "data", "body"],
  url: ["link", "href", "uri", "address"],
};

function schemaOf(tool: ToolDefinition | undefined): Schema {
  return (tool?.parameters ?? {}) as Schema;
}

function normalize(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function parseObject(raw: string): Record<string, unknown> | null {
  const attempts = [raw, raw.replace(/^```(?:json)?\s*|\s*```$/g, ""), raw.replace(/,\s*([}\]])/g, "$1")];
  for (const attempt of attempts) {
    try {
      const value: unknown = JSON.parse(attempt.trim() || "{}");
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Try the next, more lenient form.
    }
  }
  return null;
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function candidateObjects(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) out.push(match[1]);
  const mistral = text.match(/\[TOOL_CALLS\]\s*(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (mistral) out.push(mistral[1]);
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(match[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) out.push(trimmed);
  return out;
}

/** Extract tool calls a model wrote as text. Only names of offered tools are
 *  accepted, so ordinary prose or code samples are not misread as calls. */
export function parseTextToolCalls(text: string, tools: readonly ToolDefinition[]): ToolCall[] {
  const names = new Set(tools.map((tool) => tool.name));
  const visible = stripThinking(text);
  if (!visible || names.size === 0) return [];
  const calls: ToolCall[] = [];
  const accept = (name: unknown, args: unknown): void => {
    if (typeof name !== "string" || !names.has(name)) return;
    const value = typeof args === "string" ? parseObject(args) ?? {} : args && typeof args === "object" ? args : {};
    calls.push({ id: `repaired-${randomUUID()}`, name, arguments: JSON.stringify(value) });
  };
  for (const candidate of candidateObjects(visible)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : undefined;
      accept(record.name ?? record.tool ?? fn?.name, record.arguments ?? record.parameters ?? record.args ?? fn?.arguments);
    }
    if (calls.length > 0) return calls;
  }
  const fnCall = visible.match(/^\s*([a-z_][a-z0-9_]*)\s*\(\s*(\{[\s\S]*\})\s*\)\s*$/i);
  if (fnCall) accept(fnCall[1], fnCall[2]);
  return calls;
}

export interface RepairResult {
  call: ToolCall;
  repairs: string[];
  /** set when the call cannot run; the message is returned to the model */
  error?: string;
}

function unwrapEchoedSchema(value: unknown): { value: unknown; unwrapped: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, unwrapped: false };
  const record = value as Record<string, unknown>;
  if ("value" in record && ("type" in record || "description" in record)) return { value: record.value, unwrapped: true };
  return { value, unwrapped: false };
}

function matchProperty(key: string, properties: string[], used: Set<string>): string | undefined {
  const free = properties.filter((property) => !used.has(property));
  const normalized = normalize(key);
  const exact = free.find((property) => normalize(property) === normalized);
  if (exact) return exact;
  const alias = free.find((property) => ALIASES[property]?.some((name) => normalize(name) === normalized));
  if (alias) return alias;
  const contained = free.filter((property) => normalize(property).length >= 3 && (normalized.includes(normalize(property)) || normalize(property).includes(normalized)));
  if (contained.length === 1) return contained[0];
  const close = free.filter((property) => editDistance(normalize(property), normalized) <= Math.max(1, Math.floor(normalize(property).length / 4)));
  return close.length === 1 ? close[0] : undefined;
}

function resolveToolName(name: string, tools: readonly ToolDefinition[]): string | undefined {
  if (tools.some((tool) => tool.name === name)) return name;
  const normalized = normalize(name);
  const matches = tools.filter((tool) => normalize(tool.name) === normalized || normalize(tool.name.replace(/^mcp__[^_]+__/, "")) === normalized);
  return matches.length === 1 ? matches[0].name : undefined;
}

/** Repair and validate one call against the offered tools. Unknown tools are
 *  left for the runner, which reports them. */
export function repairToolCall(call: ToolCall, tools: readonly ToolDefinition[]): RepairResult {
  const repairs: string[] = [];
  const resolvedName = resolveToolName(call.name, tools);
  if (!resolvedName) return { call, repairs };
  if (resolvedName !== call.name) repairs.push(`renamed tool ${call.name} to ${resolvedName}`);
  const tool = tools.find((item) => item.name === resolvedName);
  const schema = schemaOf(tool);
  const properties = Object.keys(schema.properties ?? {});
  let args = parseObject(call.arguments);
  if (!args) {
    return {
      call: { ...call, name: resolvedName },
      repairs,
      error: `Invalid JSON arguments for ${resolvedName}: ${call.arguments.slice(0, 200)}${call.arguments.length > 200 ? "..." : ""}. Send a JSON object with properties: ${properties.join(", ") || "none"}.${call.arguments.length > 2_000 ? " The arguments were long and may have been cut off: write large content in smaller pieces, for example create the file with its first part, then add the rest with edit_file." : ""}`,
    };
  }
  if (properties.length > 0) {
    const fixed: Record<string, unknown> = {};
    const used = new Set<string>(Object.keys(args).filter((key) => properties.includes(key)));
    for (const [key, raw] of Object.entries(args)) {
      const target = properties.includes(key) ? key : matchProperty(key, properties, used);
      // An object argument shaped like {type, value} is legitimate when the
      // property itself takes an object, so only scalar properties are unwrapped.
      const declared = target ? schema.properties![target]?.type : undefined;
      // An unknown key is not valid as sent, so an echoed schema there is unwrapped.
      const scalar = !target
        || (typeof declared === "string" ? !["object", "array"].includes(declared) : Array.isArray(declared) && !declared.some((type) => type === "object" || type === "array"));
      const { value, unwrapped } = scalar ? unwrapEchoedSchema(raw) : { value: raw, unwrapped: false };
      if (unwrapped) repairs.push(`unwrapped echoed schema for ${key}`);
      if (target === key) {
        fixed[key] = value;
      } else if (target) {
        used.add(target);
        fixed[target] = value;
        repairs.push(`renamed argument ${key} to ${target}`);
      } else {
        fixed[key] = value;
      }
    }
    // A lone unknown key and a lone missing required key are the same argument.
    const unknown = Object.keys(fixed).filter((key) => !properties.includes(key));
    const missing = (schema.required ?? []).filter((key) => !(key in fixed));
    if (unknown.length === 1 && missing.length === 1) {
      fixed[missing[0]] = fixed[unknown[0]];
      delete fixed[unknown[0]];
      repairs.push(`renamed argument ${unknown[0]} to ${missing[0]}`);
    }
    args = fixed;
  }
  for (const key of properties) {
    const spec = schema.properties![key];
    const value = args[key];
    if (typeof value === "number" && spec?.type === "string") {
      args[key] = String(value);
      repairs.push(`converted ${key} to a string`);
    } else if (typeof value === "string" && (spec?.type === "number" || spec?.type === "integer") && value.trim() !== "" && Number.isFinite(Number(value))) {
      args[key] = Number(value);
      repairs.push(`converted ${key} to a number`);
    }
  }
  const repairedCall = { ...call, name: resolvedName, arguments: repairs.length > 0 ? JSON.stringify(args) : call.arguments };
  const missing = (schema.required ?? []).filter((key) => args![key] === undefined || args![key] === null);
  if (missing.length > 0) {
    return {
      call: repairedCall,
      repairs,
      error: `${INVALID_ARGUMENTS_PREFIX} ${resolvedName}: missing required ${missing.map((key) => `'${key}'`).join(", ")}. Expected properties: ${properties.join(", ")}.`,
    };
  }
  return { call: repairedCall, repairs };
}

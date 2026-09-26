// electron/backend/moss/safety/provenance.ts
//
// Provenance-based authority. Content that came from outside the user's own
// request -- web pages, fetched URLs, MCP servers, browser and desktop
// inspection, transcriptions -- may inform the model's reasoning, but it can
// never authorize a side effect by itself. Once such content enters a turn,
// every later side effect needs an explicit human approval, even under
// auto-approve or a policy-scoped mission grant, and the approval prompt names
// the untrusted sources and flags arguments copied from them.

import { isExternalContentTool } from "./untrusted-wrap";

const SHINGLE_WORDS = 8;
const MAX_TRACKED_CHARS = 400_000;
const MIN_TOKEN_LENGTH = 24;

/** Tools whose results carry content controlled by a third party. */
export function isUntrustedSource(toolName: string): boolean {
  return isExternalContentTool(toolName)
    || toolName.startsWith("browser_")
    || toolName === "desktop_inspect";
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9@._/:-]+/).filter(Boolean);
}

function shingles(text: string): string[] {
  const list = words(text);
  const out: string[] = [];
  for (let index = 0; index + SHINGLE_WORDS <= list.length; index++) out.push(list.slice(index, index + SHINGLE_WORDS).join(" "));
  return out;
}

function distinctiveTokens(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
  const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
  const long = text.split(/\s+/).filter((token) => token.length >= MIN_TOKEN_LENGTH);
  return [...urls, ...emails, ...long].map((token) => token.replace(/[.,;:!?]+$/, "").toLowerCase());
}

function argumentText(raw: string): string {
  try {
    const collect = (value: unknown): string[] => typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(collect)
        : value && typeof value === "object"
          ? Object.values(value as Record<string, unknown>).flatMap(collect)
          : [];
    return collect(JSON.parse(raw || "{}")).join("\n");
  } catch {
    return raw;
  }
}

export class ProvenanceTracker {
  private readonly sources = new Set<string>();
  private readonly shingleSet = new Set<string>();
  private readonly tokenSet = new Set<string>();
  private trackedChars = 0;

  get tainted(): boolean {
    return this.sources.size > 0;
  }

  get untrustedSources(): string[] {
    return [...this.sources];
  }

  /** Record a tool result; only untrusted sources taint the turn. */
  observe(toolName: string, content: string): void {
    if (!isUntrustedSource(toolName)) return;
    this.sources.add(toolName.startsWith("mcp__") ? toolName.split("__").slice(0, 2).join("__") : toolName);
    const remaining = MAX_TRACKED_CHARS - this.trackedChars;
    if (remaining <= 0) return;
    const text = content.slice(0, remaining);
    this.trackedChars += text.length;
    for (const shingle of shingles(text)) this.shingleSet.add(shingle);
    for (const token of distinctiveTokens(text)) this.tokenSet.add(token);
  }

  /** True when the arguments reuse a URL, address, long token, or eight-word
   *  run from untrusted content. */
  copiedInto(rawArguments: string): boolean {
    if (!this.tainted) return false;
    const text = argumentText(rawArguments);
    if (distinctiveTokens(text).some((token) => this.tokenSet.has(token))) return true;
    return shingles(text).some((shingle) => this.shingleSet.has(shingle));
  }
}

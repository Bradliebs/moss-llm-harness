// electron/backend/moss/safety/provenance.ts
//
// Provenance-based authority. Content that came from outside the user's own
// request -- web pages, fetched URLs, MCP servers, browser and desktop
// inspection, transcriptions -- may inform the model's reasoning, but it can
// never authorize a side effect by itself. Once such content enters a turn,
// later side effects need an explicit human approval, even under auto-approve
// or a policy-scoped mission grant, and the approval prompt names the
// untrusted sources and flags arguments copied from them.
//
// Reads are tracked at the data level so research does not drown in prompts:
// following a link copied verbatim from untrusted content, or a search that
// does not reuse it, keeps its auto-approval. Any other URL still needs
// approval, because its host and path can carry data to wherever the content
// pointed, and so does a read that reuses untrusted text.

import type { AgentMessage } from "../../../../common/types";
import { isExternalContentTool } from "./untrusted-wrap";

const SHINGLE_WORDS = 8;
const MAX_TRACKED_CHARS = 400_000;
const MIN_TOKEN_LENGTH = 24;
const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/gi;

/** How a call's arguments relate to untrusted content in the turn. */
export type UntrustedDerivation =
  | { kind: "none" }
  /** only follows links that appeared verbatim in untrusted content */
  | { kind: "link" }
  | { kind: "derived"; reason: string };

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
  const urls = text.match(URL_PATTERN) ?? [];
  const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
  const long = text.split(/\s+/).filter((token) => token.length >= MIN_TOKEN_LENGTH);
  return [...urls, ...emails, ...long].map((token) => token.replace(/[.,;:!?]+$/, "").toLowerCase());
}

function normalizeToken(token: string): string {
  return token.replace(/[.,;:!?]+$/, "").toLowerCase();
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
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

/** Tool results from earlier turns that came from untrusted sources. Their text
 *  is still in the conversation, so it still cannot authorize a side effect. */
export function priorUntrustedResults(messages: readonly AgentMessage[], trustedPrefix = 0): Array<{ name: string; content: string; sources: string[] }> {
  const names = new Map<string, string>();
  const results: Array<{ name: string; content: string; sources: string[] }> = [];
  messages.forEach((message, index) => {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    // The user reviewed everything before this point and vouched for it.
    if (index < trustedPrefix || message.role !== "tool" || !message.toolCallId) return;
    const name = names.get(message.toolCallId) ?? "tool";
    const sources = [...(isUntrustedSource(name) ? [name] : []), ...(message.untrustedSources ?? [])];
    if (sources.length === 0 && /^<external_content source="/.test(message.content.trimStart())) sources.push("external_content");
    if (sources.length > 0) results.push({ name, content: message.content, sources });
  });
  return results;
}

export class ProvenanceTracker {
  private readonly sources = new Set<string>();
  private readonly shingleSet = new Set<string>();
  private readonly tokenSet = new Set<string>();
  private readonly hostSet = new Set<string>();
  private trackedChars = 0;

  get tainted(): boolean {
    return this.sources.size > 0;
  }

  get untrustedSources(): string[] {
    return [...this.sources];
  }

  /** Record a tool result; only untrusted sources taint the turn. A result can
   *  name the sources it carries when its tool name does not reveal them. */
  observe(toolName: string, content: string, carriedSources: readonly string[] = []): void {
    const sources = [...(isUntrustedSource(toolName) ? [toolName] : []), ...carriedSources];
    if (sources.length === 0) return;
    for (const source of sources) this.sources.add(source.startsWith("mcp__") ? source.split("__").slice(0, 2).join("__") : source);
    const remaining = MAX_TRACKED_CHARS - this.trackedChars;
    if (remaining <= 0) return;
    const text = content.slice(0, remaining);
    this.trackedChars += text.length;
    for (const shingle of shingles(text)) this.shingleSet.add(shingle);
    for (const token of distinctiveTokens(text)) this.tokenSet.add(token);
    for (const url of text.match(URL_PATTERN) ?? []) {
      const host = hostOf(normalizeToken(url));
      if (host) this.hostSet.add(host);
    }
  }

  /** Whether the arguments derive from untrusted content. Links copied
   *  verbatim are reported separately because following one discloses nothing
   *  the page did not already contain. */
  derivation(rawArguments: string): UntrustedDerivation {
    if (!this.tainted) return { kind: "none" };
    const text = argumentText(rawArguments);
    let link = false;
    for (const raw of text.match(URL_PATTERN) ?? []) {
      const url = normalizeToken(raw);
      if (this.tokenSet.has(url)) {
        link = true;
        continue;
      }
      // Only a verbatim link is known to disclose nothing new: a subdomain or
      // path can carry data as easily as a query string.
      const host = hostOf(url);
      if (host && [...this.hostSet].some((named) => host === named || host.endsWith(`.${named}`) || named.endsWith(`.${host}`))) {
        return { kind: "derived", reason: `It changes a link on ${host}, a host named by untrusted content.` };
      }
      return { kind: "derived", reason: `It opens ${host ?? "a URL"}, which did not appear in the untrusted content; a URL can carry data in its host or path.` };
    }
    const rest = text.replace(URL_PATTERN, " ");
    if (distinctiveTokens(rest).some((token) => this.tokenSet.has(token)) || shingles(rest).some((shingle) => this.shingleSet.has(shingle))) {
      return { kind: "derived", reason: "Its arguments reuse text from untrusted content." };
    }
    return link ? { kind: "link" } : { kind: "none" };
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

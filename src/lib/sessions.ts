// src/lib/sessions.ts
//
// Conversation sessions, persisted to localStorage (renderer-only; no backend
// session store yet). Each session holds its own message history so the left
// nav can switch between conversations and they survive a reload.

import type { AgentMessage, TokenUsage, ToolRisk } from "@common/types";

import type { ModelRate } from "./pricing";
import { estimateCost, formatUsd } from "./pricing";
import { createPersistentStore } from "./persistentStore";

export interface Session {
  id: string;
  title: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
  /** per-chat personality override; undefined inherits the global default */
  personalityId?: string;
  taskId?: string;
}

interface SessionsState {
  sessions: Session[];
  currentId: string | null;
}

const sessionsState = createPersistentStore<SessionsState>("moss.sessions", {
  sessions: [],
  currentId: null,
});

const UNTITLED = "New chat";

function titleFromText(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean || UNTITLED;
}

function titleFrom(messages: AgentMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return UNTITLED;
  return titleFromText(firstUser.content);
}

// Sessions persisted before titles were derived on send can still show the
// placeholder despite having a user message. Re-derive their titles once on
// load so the left nav reads accurately; empty sessions keep the placeholder.
sessionsState.update((prev) => ({
  ...prev,
  sessions: prev.sessions.map((s) => (s.title === UNTITLED ? { ...s, title: titleFrom(s.messages) } : s)),
}));

export function useSessions(): SessionsState {
  return sessionsState.use();
}

export function currentSession(state: SessionsState): Session | null {
  return state.sessions.find((s) => s.id === state.currentId) ?? null;
}

/** Read a session's messages outside of render (used by the send path so the
 *  turn always commits onto the session's real history, not stale render state). */
export function getSessionMessages(id: string): AgentMessage[] {
  return sessionsState.get().sessions.find((s) => s.id === id)?.messages ?? [];
}

/** Read a session's personality override outside of render (used by the send path
 *  so the turn uses the per-chat choice). Undefined means inherit the global
 *  default from settings. */
export function getSessionPersonality(id: string): string | undefined {
  return sessionsState.get().sessions.find((s) => s.id === id)?.personalityId;
}

/** Read a session's current title outside of render. */
export function getSessionTitle(id: string): string | undefined {
  return sessionsState.get().sessions.find((s) => s.id === id)?.title;
}

/** Set a session's personality override, or clear it (undefined) to inherit the
 *  global default. */
export function setSessionPersonality(id: string, personalityId: string | undefined): void {
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === id ? { ...s, personalityId } : s)),
  }));
}

/** Create an empty session and make it current. Returns the new id. */
export function setSessionTaskId(id: string, taskId: string): void {
  if (sessionsState.get().sessions.find((session) => session.id === id)?.taskId === taskId) return;
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((session) => session.id === id ? { ...session, taskId } : session),
  }));
}

export function createSession(): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  sessionsState.update((prev) => ({
    sessions: [{ id, title: UNTITLED, messages: [], createdAt: now, updatedAt: now }, ...prev.sessions],
    currentId: id,
  }));
  return id;
}

/** Ensure a current session exists, creating one if the store is empty. Returns its id. */
export function ensureCurrentSession(): string {
  const state = sessionsState.get();
  const current = currentSession(state);
  if (current) return current.id;
  if (state.sessions.length > 0) {
    sessionsState.update((prev) => ({ ...prev, currentId: prev.sessions[0].id }));
    return state.sessions[0].id;
  }
  return createSession();
}

export function selectSession(id: string): void {
  sessionsState.update((prev) => ({ ...prev, currentId: id }));
}

export function deleteSession(id: string): void {
  sessionsState.update((prev) => {
    const sessions = prev.sessions.filter((s) => s.id !== id);
    const currentId = prev.currentId === id ? (sessions[0]?.id ?? null) : prev.currentId;
    return { sessions, currentId };
  });
}

/** Empty a conversation in place: drop its messages and reset the title to the
 *  placeholder, keeping the session selected so the user stays put. Unlike
 *  deleteSession, the conversation entry remains in the left nav. */
export function clearSession(id: string): void {
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) =>
      s.id === id ? { ...s, messages: [], title: UNTITLED, updatedAt: new Date().toISOString() } : s,
    ),
  }));
}

/** Title a session from the first user message the moment it is sent, so the
 *  sidebar reflects the conversation immediately instead of waiting for the turn
 *  to complete. Only overwrites the placeholder, never a title already derived. */
export function setSessionTitle(id: string, firstUserText: string): void {
  const title = titleFromText(firstUserText);
  if (title === UNTITLED) return;
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) =>
      s.id === id && s.title === UNTITLED ? { ...s, title } : s,
    ),
  }));
}

/** Explicitly rename a session to a user-supplied title. Unlike setSessionTitle,
 *  this overwrites any existing title. An empty/whitespace title is ignored so a
 *  conversation can never lose its name to a blank rename. */
export function renameSession(id: string, title: string): void {
  const clean = title.trim();
  if (!clean) return;
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === id ? { ...s, title: clean } : s)),
  }));
}

// --- Continue in a new chat -------------------------------------------------
//
// When a conversation has grown past what is comfortable to keep re-sending, the
// user can fork it into a fresh chat seeded with a summary of the old one. The
// summary is normally written by the model (see the chat.summarize IPC); the
// locally-built digest below is the fallback for when that call cannot be made
// or fails, so the button always does something.

/** Budgets for the locally-built fallback digest. Bounded on purpose — a handoff
 *  exists to make the new chat small, so an unbounded transcript would recreate
 *  the problem it is meant to solve. */
const HANDOFF_RECENT_TURNS = 2;
const HANDOFF_RECENT_CHARS = 1500;
const HANDOFF_REQUEST_CHARS = 160;
const HANDOFF_MAX_REQUESTS = 20;

/** The reply seeded alongside the summary. The new conversation must start with a
 *  user turn followed by an assistant turn: two user messages back to back are
 *  rejected by strict providers (Anthropic), and the next thing the user types
 *  would be exactly that. */
const HANDOFF_REPLY = "I've read the carried-over context from our previous chat. Ready to continue — what next?";

function collapse(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}\n…[truncated]` : clean;
}

/** Wrap a summary body in the framing the receiving model needs: where this came
 *  from, and that the rest of the history is genuinely gone. */
function wrapHandoff(title: string, body: string): string {
  return [
    `# Carried-over context from "${title}"`,
    "",
    "This chat continues an earlier conversation. The earlier messages are not in this context window — the summary below is everything that carried over. If you need a detail that is not here, say so rather than guessing.",
    "",
    body.trim(),
  ].join("\n");
}

/** Build the fallback digest locally, with no model call. Used when the model
 *  cannot write the summary. Lossier than a written summary: it preserves what
 *  was asked and what ran, but not what was concluded. */
export function buildHandoffDigest(session: Session): string {
  const messages = session.messages;
  const userIdxs = messages.reduce<number[]>((acc, m, i) => (m.role === "user" ? [...acc, i] : acc), []);
  // Everything from this index on is carried verbatim; everything before it is
  // reduced to the list of requests that were made.
  const recentStart =
    userIdxs.length > HANDOFF_RECENT_TURNS ? userIdxs[userIdxs.length - HANDOFF_RECENT_TURNS] : (userIdxs[0] ?? 0);

  const lines: string[] = [];

  const earlierRequests = userIdxs
    .filter((i) => i < recentStart)
    .map((i) => collapse(messages[i].content, HANDOFF_REQUEST_CHARS))
    .filter(Boolean)
    .slice(-HANDOFF_MAX_REQUESTS);
  if (earlierRequests.length > 0) {
    lines.push("## Earlier requests (oldest first)", "");
    for (const r of earlierRequests) lines.push(`- ${r}`);
    lines.push("");
  }

  const audit = sessionToolAudit(messages);
  if (audit.length > 0) {
    const counts = new Map<string, { risk: ToolRisk; count: number }>();
    for (const e of audit) {
      const prev = counts.get(e.name);
      if (prev) prev.count += 1;
      else counts.set(e.name, { risk: e.risk, count: 1 });
    }
    lines.push("## Tools already run in the earlier chat", "");
    for (const [name, { risk, count }] of counts) lines.push(`- ${name} (${risk}) ×${count}`);
    lines.push("");
  }

  const recent = messages.slice(recentStart).filter((m) => m.role === "user" || m.role === "assistant");
  if (recent.length > 0) {
    lines.push("## Most recent exchange (verbatim)", "");
    for (const m of recent) {
      const body = clip(m.content, HANDOFF_RECENT_CHARS);
      if (!body) continue;
      lines.push(m.role === "user" ? "### User" : "### Assistant", "", body, "");
    }
  }

  return wrapHandoff(session.title, lines.join("\n")).trimEnd();
}

/** Derive the continuation's title, numbering repeat handoffs so a conversation
 *  forked more than once stays distinguishable in the left nav. */
function continuedTitle(title: string): string {
  const match = /^(.*) \(continued(?: (\d+))?\)$/.exec(title);
  if (!match) return `${title} (continued)`;
  return `${match[1]} (continued ${match[2] ? Number(match[2]) + 1 : 2})`;
}

/** Fork a conversation into a fresh chat seeded with a summary of it, and make
 *  the new chat current. The source conversation is left untouched. Pass the
 *  model-written summary when one is available; omit it to fall back to the
 *  locally-built digest. Returns the new session id, or null when the source is
 *  missing or empty. */
export function continueInNewSession(id: string, modelSummary?: string): string | null {
  const source = sessionsState.get().sessions.find((s) => s.id === id);
  if (!source || source.messages.length === 0) return null;

  const content = modelSummary?.trim()
    ? wrapHandoff(source.title, modelSummary)
    : buildHandoffDigest(source);
  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  const seed: AgentMessage[] = [
    { role: "user", content, handoff: true },
    { role: "assistant", content: HANDOFF_REPLY, handoff: true },
  ];
  sessionsState.update((prev) => ({
    sessions: [
      {
        id: newId,
        title: continuedTitle(source.title),
        messages: seed,
        createdAt: now,
        updatedAt: now,
        ...(source.personalityId ? { personalityId: source.personalityId } : {}),
      },
      ...prev.sessions,
    ],
    currentId: newId,
  }));
  return newId;
}

/** Serialize a conversation to a Markdown transcript for export. Only the
 *  human-readable user and assistant turns are included; system and tool-result
 *  messages are omitted so the export reads as a clean conversation. */
export interface MarkdownExportOptions {
  /** when true, render each tool call's arguments and each tool result, and
   *  append a token-usage (and, when priceable, cost) summary footer */
  includeTools?: boolean;
  /** model id used to price the summary footer; omit to skip the cost line */
  model?: string;
  /** user pricing overrides forwarded to estimateCost */
  modelRates?: Record<string, ModelRate>;
}

export function sessionToMarkdown(session: Session, options: MarkdownExportOptions = {}): string {
  const lines: string[] = [`# ${session.title}`, ""];
  for (const m of session.messages) {
    if (m.role === "user" || m.role === "assistant") {
      if (m.content.trim()) {
        lines.push(m.role === "user" ? "## User" : "## Assistant", "", m.content, "");
      }
      if (options.includeTools && m.toolCalls?.length) {
        for (const call of m.toolCalls) {
          lines.push(`### Tool call: ${call.name}`, "", "```json", call.arguments, "```", "");
        }
      }
    } else if (m.role === "tool" && options.includeTools && m.toolCallId) {
      lines.push(m.autoApproved ? "### Tool result (auto-approved)" : "### Tool result", "", "```", m.content, "```", "");
    }
  }
  if (options.includeTools) {
    const usage = sessionTokenUsage(session.messages);
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (total > 0) {
      lines.push("---", "", "## Summary", "");
      lines.push(`- Tokens: ${total} (input ${usage.inputTokens ?? 0}, output ${usage.outputTokens ?? 0})`);
      const cost = options.model ? estimateCost(usage, options.model, options.modelRates) : null;
      if (cost !== null) lines.push(`- Estimated cost: ${formatUsd(cost)}`);
      lines.push("");
    }
    const audit = sessionToolAudit(session.messages);
    if (audit.length) {
      lines.push("## Tool activity", "");
      lines.push("| Tool | Risk | Auto-approved | Duration |", "| --- | --- | --- | --- |");
      for (const e of audit)
        lines.push(`| ${e.name} | ${e.risk} | ${e.autoApproved ? "yes" : "no"} | ${e.durationMs != null ? `${e.durationMs}ms` : ""} |`);
      lines.push("");
    }
  }
  return lines.join("\n");
}


/** Derive a session's total token usage by summing the per-message usage. Usage
 *  lives on the assistant messages that incurred it, so the total is always an
 *  accurate recomputation with no separate counter to drift or reset. */
export function sessionTokenUsage(messages: AgentMessage[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const m of messages) {
    inputTokens += m.usage?.inputTokens ?? 0;
    outputTokens += m.usage?.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

export interface ToolUsageSummary {
  /** executed tool calls in the conversation (one per tool-result message) */
  total: number;
  /** how many of those ran without a prompt because auto-approve was on */
  autoApproved: number;
}

/** Summarize tool activity in a conversation so the UI can show, at a glance,
 *  how many tools ran and how many ran unattended under auto-approve. */
export function sessionToolUsage(messages: AgentMessage[]): ToolUsageSummary {
  let total = 0;
  let autoApproved = 0;
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) {
      total += 1;
      if (m.autoApproved) autoApproved += 1;
    }
  }
  return { total, autoApproved };
}

/** Tools that only read; mirrors the read-only set the backend auto-allows.
 *  Used as a fallback risk tier when a tool message has no persisted risk
 *  (older history, or readonly allow-listed tools the policy runs without
 *  recording a tier). Everything else falls back to mutating. */
const READONLY_TOOLS = new Set<string>([
  "read_file",
  "list_dir",
  "search_files",
  "glob_files",
  "m_recall",
  "m_list_memories",
  "m_list_skills",
  "m_get_skill",
]);

export type ToolRiskTier = "readonly" | "mutating";

export function toolRiskTier(name: string): ToolRiskTier {
  return READONLY_TOOLS.has(name) ? "readonly" : "mutating";
}

export interface ToolAuditEntry {
  callId: string;
  /** the tool's name, resolved from the assistant call that triggered it */
  name: string;
  risk: ToolRisk;
  autoApproved: boolean;
  /** wall-clock milliseconds the call took, when recorded at execution time */
  durationMs?: number;
}

/** Build a per-conversation audit of every executed tool call, pairing each
 *  result with the name of the call that triggered it, the real risk tier the
 *  permission policy recorded at execution time (falling back to a name-derived
 *  tier for messages without one), and whether it ran without a prompt. Order
 *  matches execution order. */
export function sessionToolAudit(messages: AgentMessage[]): ToolAuditEntry[] {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.toolCalls) for (const c of m.toolCalls) names.set(c.id, c.name);
  }
  const entries: ToolAuditEntry[] = [];
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) {
      const name = names.get(m.toolCallId) ?? "unknown";
      entries.push({
        callId: m.toolCallId,
        name,
        risk: m.risk ?? toolRiskTier(name),
        autoApproved: Boolean(m.autoApproved),
        ...(typeof m.durationMs === "number" ? { durationMs: m.durationMs } : {}),
      });
    }
  }
  return entries;
}

/** The token usage occupying the model's context window: the most recent reply's
 *  usage (its input already counts the whole prior exchange, plus its own output).
 *  Returned split so callers can show the input/output breakdown. Zeros until a
 *  reply with usage has landed. */
export function contextWindowUsage(messages: AgentMessage[]): TokenUsage {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.usage) {
      return { inputTokens: m.usage.inputTokens ?? 0, outputTokens: m.usage.outputTokens ?? 0 };
    }
  }
  return { inputTokens: 0, outputTokens: 0 };
}

/** Approximate the tokens currently occupying the model's context window: the
 *  most recent reply's input (which already counts the whole prior exchange)
 *  plus its own output. Returns 0 until a reply with usage has landed. Summing
 *  every message would double-count, since each turn's input already includes
 *  the entire prior history. */
export function contextWindowTokens(messages: AgentMessage[]): number {
  const usage = contextWindowUsage(messages);
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Replace a session's full message history (called on turn completion). The
 *  title is derived from the first user message once one exists. */
export function setSessionMessages(id: string, messages: AgentMessage[]): void {
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            messages,
            title: s.title === UNTITLED ? titleFrom(messages) : s.title,
            updatedAt: new Date().toISOString(),
          }
        : s,
    ),
  }));
}

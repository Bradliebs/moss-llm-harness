// src/components/ChatPanel.tsx

import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileText, Menu, PanelRightOpen, RefreshCw, X } from "lucide-react";

import type { AgentMessage, ChatEventPayload, ConfidenceMode, DocumentAttachment, MissionCapabilityDescriptor, MissionLaunchPolicy, Skill, TaskBudget, TaskHistoryEntry, TaskSnapshot, TaskSpec, TokenUsage } from "@common/types";
import { PERSONALITY_PRESETS } from "@common/personalities";
import { parseClarification } from "@common/clarification";

import { useDictation } from "../lib/dictation";
import { DOCX_MEDIA_TYPE, extractDocxText, extractPdfText, imageAttachmentError, imageMediaType, isDocxFile, isLikelyVisionModel, isPdfFile, MAX_DOCX_BYTES, MAX_PDF_BYTES, textAttachmentError, textLanguageForFile } from "../lib/attachments";
import { markdownToHtml } from "../lib/markdown";
import { estimateCost, formatUsd } from "../lib/pricing";
import {
  clearSession,
  contextWindowTokens,
  contextWindowUsage,
  continueInNewSession,
  currentSession,
  ensureCurrentSession,
  getSessionMessages,
  getSessionPersonality,
  sessionTokenUsage,
  sessionToolUsage,
  sessionToolAudit,
  setSessionMessages,
  setSessionPersonality,
  setSessionTaskId,
  setSessionTitle,
  useSessions,
} from "../lib/sessions";
import { modelsStore, toEmbedConfig, toProviderConfig, updateSettings, useSettings } from "../lib/settings";
import { type ToolStatus, toolStatusColor } from "../lib/toolStatus";
import { MossFace } from "./MossFace";
import { ArtifactWorkspace } from "./ArtifactWorkspace";
import { ClarificationForm } from "./ClarificationForm";
import { RichResponse } from "./RichResponse";
import { WelcomeScreen } from "./WelcomeScreen";

const loadStoredArtifact = (taskId: string, artifactId: string) => window.moss.task.artifact(taskId, artifactId);
async function copyArtifact(content: string): Promise<void> {
  if (!await window.moss.clipboard.write(content)) throw new Error("Copy failed");
}

/** Short chip labels and colors for the opt-in shadow confidence indicator. */
const CONFIDENCE_LABEL: Record<ConfidenceMode, string> = {
  settled: "Settled",
  reasoned: "Tool-backed",
  "web-fresh": "Web-fresh",
  "needs-review": "Needs review",
};
const CONFIDENCE_CLASS: Record<ConfidenceMode, string> = {
  settled: "bg-neutral-300 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-200",
  reasoned: "bg-emerald-200 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  "web-fresh": "bg-sky-200 text-sky-900 dark:bg-sky-900 dark:text-sky-100",
  "needs-review": "bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
};

interface ToolView {
  kind: "tool";
  callId: string;
  name: string;
  args: string;
  status: ToolStatus;
  result?: string;
  autoApproved?: boolean;
  /** content risk tier for run_command, surfaced on the approval prompt */
  risk?: "readonly" | "mutating" | "destructive";
}

interface MessageView {
  kind: "message";
  role: "user" | "assistant";
  content: string;
  images?: string[];
  documents?: DocumentAttachment[];
  interrupted?: boolean;
  hasToolCalls?: boolean;
  usage?: TokenUsage;
  turnUsage?: TokenUsage;
  historyIndex?: number;
  /** id of the turn that produced this reply; present on a turn's final
   *  assistant message so the revert affordance can look up its file changes */
  turnId?: string;
  sourceUserIndex?: number;
  /** carried-over context seeded by "Continue in new chat"; rendered collapsed */
  handoff?: boolean;
}

type ViewItem = MessageView | ToolView;

interface MissionLaunch {
  spec: TaskSpec;
  policy: MissionLaunchPolicy;
}

function positiveNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function ToolCard({ tool, onApprove }: { tool: ToolView; onApprove: (callId: string, approved: boolean, comment?: string) => void }): React.ReactElement {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [approvalComment, setApprovalComment] = useState("");
  const active = tool.status === "running" || tool.status === "approval";

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = active;
  }, [active]);

  return (
    <details
      ref={detailsRef}
      open={active}
      className="group mr-auto w-full max-w-2xl animate-fade-in overflow-hidden rounded-lg border border-neutral-300/60 bg-white/80 text-sm shadow-sm dark:border-neutral-700/60 dark:bg-neutral-900/80"
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 marker:hidden"
        title={`${tool.name}(${tool.args})`}
      >
        <span className="font-mono text-xs text-emerald-700 dark:text-emerald-300">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
          {tool.args}
        </span>
        {tool.autoApproved ? (
          <span
            className="rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-700 dark:text-amber-300"
            title="Ran automatically without asking because auto-approve was on."
          >
            auto
          </span>
        ) : null}
        <span className={`text-xs ${toolStatusColor(tool.status)}`}>{tool.status}</span>
        <span className="text-[10px] text-neutral-400 transition-transform group-open:rotate-180" aria-hidden="true">▼</span>
      </summary>

      <div className="border-t border-neutral-200/70 px-3 py-2 dark:border-neutral-700/70">
        <div className="text-[10px] font-medium uppercase text-neutral-500 dark:text-neutral-400">Arguments</div>
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-2 text-xs text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">
          {tool.args}
        </pre>
        {tool.status === "approval" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-amber-700 dark:text-amber-300">Approval required.</span>
            {tool.risk === "destructive" ? (
              <span
                className="rounded-full border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300"
                title="This command can delete data or change your system, so it always asks for approval even when auto-approve is on."
              >
                destructive
              </span>
            ) : tool.risk === "mutating" ? (
              <span
                className="rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                title="This command can change files or state, so it asks for approval unless auto-approve is on."
              >
                mutating
              </span>
            ) : null}
            <input
              aria-label="Approval reason"
              className="min-w-48 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
              maxLength={500}
              placeholder="Optional reason"
              value={approvalComment}
              onChange={(event) => setApprovalComment(event.target.value)}
            />
            <button
              type="button"
              className="rounded-md bg-emerald-600 px-2.5 py-0.5 font-medium text-white transition hover:bg-emerald-500"
              onClick={() => onApprove(tool.callId, true, approvalComment)}
            >
              Approve
            </button>
            <button
              type="button"
              className="rounded-md bg-red-700 px-2.5 py-0.5 font-medium text-white transition hover:bg-red-600"
              onClick={() => onApprove(tool.callId, false, approvalComment)}
            >
              Deny
            </button>
          </div>
        ) : tool.result ? (
          <>
            <div className="mt-2 text-[10px] font-medium uppercase text-neutral-500 dark:text-neutral-400">Output</div>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-2 text-xs text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">
              {tool.result}
            </pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

/** Render a token count with thousands separators so large conversation totals
 *  stay scannable (e.g. 12530 -> "12,530"). */
function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function ResponseActions({ content, onRegenerate }: { content: string; onRegenerate?: () => void }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className="response-actions" aria-label="Response actions">
      <button
        type="button"
        aria-label={copied ? "Response copied" : "Copy response"}
        title={copied ? "Copied" : "Copy response"}
        onClick={() => {
        copyToClipboard(content, markdownToHtml(content));
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      }}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      {onRegenerate ? (
        <button type="button" aria-label="Regenerate response" title="Regenerate response" onClick={onRegenerate}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** Shows how many files a completed turn changed and lets the user undo them.
 *  Lazily queries the checkpoint store on mount (and after the turn id changes);
 *  renders nothing when the turn changed no files or the bridge is unavailable.
 *  After a revert it reports the outcome and disables the button, since a turn's
 *  checkpoint is consumed by reverting it. */
function TurnRevert({ turnId }: { turnId: string }): React.ReactElement | null {
  const [count, setCount] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "reverting" | "reverted" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const bridge = window.moss?.checkpoint;
    if (!bridge) {
      setCount(0);
      return;
    }
    void bridge
      .list(turnId)
      .then((files) => {
        if (!cancelled) setCount(files.length);
      })
      .catch(() => {
        if (!cancelled) setCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [turnId]);

  if (!count || state === "reverted") {
    return state === "reverted" ? (
      <div className="mt-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">{message}</div>
    ) : null;
  }

  const label = `${count} file${count === 1 ? "" : "s"} changed`;
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
      <span title="Files this turn created or modified in the workspace.">{label}</span>
      <button
        className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 transition hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-300"
        disabled={state === "reverting"}
        title="Undo this turn's file changes, restoring each file to its state before the turn."
        onClick={() => {
          const bridge = window.moss?.checkpoint;
          if (!bridge) return;
          setState("reverting");
          void bridge
            .revert(turnId)
            .then((res) => {
              const undone = `Reverted ${res.reverted} file${res.reverted === 1 ? "" : "s"}`;
              if (res.errors.length > 0) {
                setState("error");
                setMessage(`${undone}; ${res.errors.length} failed`);
              } else {
                setState("reverted");
                setMessage(undone);
              }
            })
            .catch((err: unknown) => {
              setState("error");
              setMessage(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }}
      >
        {state === "reverting" ? "Reverting…" : "Revert"}
      </button>
      {state === "error" ? <span className="text-red-500 dark:text-red-400">{message}</span> : null}
    </div>
  );
}

/** Copy text to the clipboard, with rich HTML when provided so pastes keep
 *  their formatting. Prefers the Electron bridge (works without a secure
 *  context), then the async Clipboard API, then a textarea/execCommand
 *  fallback so it never silently no-ops. */
function copyToClipboard(text: string, html?: string): void {
  if (window.moss?.clipboard) {
    void window.moss.clipboard
      .write(text, html)
      .catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

/** Best-effort clipboard write outside the Electron bridge: async Clipboard API
 *  first, then a textarea/execCommand fallback so it never silently no-ops. */
function fallbackCopy(text: string): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
    return;
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  } catch {
    /* clipboard unavailable */
  }
}

/** Flag the last assistant message so reloaded history shows it was cut off by
 *  an error mid-stream rather than a complete reply. */
function markLastAssistantInterrupted(messages: AgentMessage[]): AgentMessage[] {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistant < 0) return messages;
  return messages.map((m, i) => (i === lastAssistant ? { ...m, interrupted: true } : m));
}

function messagesToItems(messages: AgentMessage[]): ViewItem[] {
  const items: ViewItem[] = [];
  const toolResults = new Map<string, { content: string; autoApproved?: boolean }>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) {
      toolResults.set(m.toolCallId, { content: m.content, autoApproved: m.autoApproved });
    }
  }
  // A turn spans a user message and the assistant/tool messages that answer it.
  // Accumulate the turn's usage across rounds; when a turn took more than one
  // provider round, stamp the total onto its final reply so the cost of the
  // whole exchange is visible, not just the last round.
  let turnInput = 0;
  let turnOutput = 0;
  let turnRounds = 0;
  let turnId: string | undefined;
  let sourceUserIndex: number | undefined;
  let lastTurnReply: MessageView | null = null;
  function closeTurn(): void {
    if (lastTurnReply && turnRounds > 1 && (turnInput || turnOutput)) {
      lastTurnReply.turnUsage = { inputTokens: turnInput, outputTokens: turnOutput };
    }
    if (lastTurnReply && turnId) {
      lastTurnReply.turnId = turnId;
    }
    turnInput = 0;
    turnOutput = 0;
    turnRounds = 0;
    turnId = undefined;
    lastTurnReply = null;
  }
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role === "user") {
      closeTurn();
      sourceUserIndex = mi;
      items.push({ kind: "message", role: "user", content: m.content, images: m.images, documents: m.documents, historyIndex: mi, handoff: m.handoff });
    } else if (m.role === "assistant") {
      if (m.turnId) turnId = m.turnId;
      if (m.usage) {
        turnInput += m.usage.inputTokens ?? 0;
        turnOutput += m.usage.outputTokens ?? 0;
        turnRounds += 1;
      }
      if (m.content) {
        const reply: MessageView = {
          kind: "message",
          role: "assistant",
          content: m.content,
          interrupted: m.interrupted,
          hasToolCalls: !!m.toolCalls?.length,
          usage: m.usage,
          sourceUserIndex,
          handoff: m.handoff,
        };
        items.push(reply);
        lastTurnReply = reply;
      }
      for (const tc of m.toolCalls ?? []) {
        const tr = toolResults.get(tc.id);
        items.push({
          kind: "tool",
          callId: tc.id,
          name: tc.name,
          args: tc.arguments,
          status: "done",
          result: tr?.content,
          autoApproved: tr?.autoApproved,
        });
      }
    }
  }
  closeTurn();
  return items;
}

interface ChatPanelProps {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onOpenChats: () => void;
  onOpenSettings: () => void;
}

export function ChatPanel({ busy, setBusy, onOpenChats, onOpenSettings }: ChatPanelProps): React.ReactElement {
  const settings = useSettings();
  const sessions = useSessions();
  const models = modelsStore.use();
  const current = currentSession(sessions);
  const history = current?.messages ?? [];
  const usage = sessionTokenUsage(history);
  const cost = estimateCost(usage, settings.model, settings.modelRates);
  const tools = sessionToolUsage(history);
  const toolAudit = sessionToolAudit(history);
  const contextUsed = contextWindowTokens(history);
  const contextDetail = contextWindowUsage(history);

  const [pendingUser, setPendingUser] = useState<AgentMessage | null>(null);
  const [activity, setActivity] = useState<ViewItem[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [pendingAttachmentReads, setPendingAttachmentReads] = useState(0);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("");
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [taskHistory, setTaskHistory] = useState<TaskHistoryEntry[]>([]);
  const [artifactSelection, setArtifactSelection] = useState<{ sessionId: string; taskId: string; id: string } | null>(null);
  const [composerMode, setComposerMode] = useState<"chat" | "mission">("chat");
  const [missionAuthority, setMissionAuthority] = useState<MissionLaunchPolicy["authority"]>("supervised");
  const [missionCapabilities, setMissionCapabilities] = useState<MissionCapabilityDescriptor[]>([]);
  const [selectedMissionCapabilities, setSelectedMissionCapabilities] = useState<string[]>([]);
  const [missionCapabilitiesLoading, setMissionCapabilitiesLoading] = useState(false);
  const [missionBudget, setMissionBudget] = useState({ minutes: "15", tokens: "50000", actions: "24", cost: "5" });
  const [confidence, setConfidence] = useState<{ mode: ConfidenceMode; note: string } | null>(null);
  const [mcpToolCount, setMcpToolCount] = useState(0);
  const [mcpDownCount, setMcpDownCount] = useState(0);
  const [showToolAudit, setShowToolAudit] = useState(false);
  const [auditHideReadonly, setAuditHideReadonly] = useState(false);
  const [auditSortByRisk, setAuditSortByRisk] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [interruptQueued, setInterruptQueued] = useState(false);
  const dictation = useDictation((text) =>
    setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text)),
  );

  // The audit popover view: optionally drop readonly rows and order by risk
  // (destructive first) so a long tool history stays scannable. The sort copy
  // is stable, so calls of equal risk keep their execution order.
  const riskRank = (r: string) => (r === "destructive" ? 0 : r === "mutating" ? 1 : 2);
  const visibleToolAudit = (auditHideReadonly ? toolAudit.filter((e) => e.risk !== "readonly") : toolAudit.slice()).sort(
    (a, b) => (auditSortByRisk ? riskRank(a.risk) - riskRank(b.risk) : 0),
  );

  const turnIdRef = useRef<string | null>(null);
  const taskTurnIdRef = useRef<string | null>(null);
  const taskSessionRef = useRef<string | null>(null);
  const turnSessionRef = useRef<string | null>(null);
  const turnBaseRef = useRef<AgentMessage[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const currentSessionIdRef = useRef(current?.id);
  currentSessionIdRef.current = current?.id;
  // The event feed is subscribed once, so its handler closes over first-render
  // state. Hold the pending user message in a ref (like the base) so the commit
  // paths read the current value instead of a stale null.
  const turnPendingUserRef = useRef<AgentMessage | null>(null);
  const queuedInterruptionRef = useRef<{ sessionId: string; message: AgentMessage } | null>(null);
  const runTurnRef = useRef<(
    sessionId: string,
    base: AgentMessage[],
    userMsg: AgentMessage,
    durableTask?: TaskSnapshot,
  ) => void>(() => undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Depth counter so the drop overlay does not flicker as the drag crosses
  // nested children (each child fires its own dragenter/dragleave pair).
  const dragDepth = useRef(0);

  const slashMatch = input.match(/^\/([^\s]*)$/);
  const skillQuery = slashMatch?.[1].toLowerCase() ?? "";
  const matchingSkills = slashMatch
    ? skills.filter(
        (skill) =>
          skill.enabled &&
          (skill.name.toLowerCase().includes(skillQuery) || skill.description.toLowerCase().includes(skillQuery)),
      )
    : [];
  const skillMenuOpen = !skillMenuDismissed && slashMatch !== null && matchingSkills.length > 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history, activity, pendingUser]);

  useEffect(() => {
    setStatus("");
  }, [current?.id]);

  useEffect(() => {
    let cancelled = false;
    setTask((previous) => previous?.id === current?.taskId ? previous : null);
    if (current?.taskId) {
      void window.moss.task.get(current.taskId).then((snapshot) => {
        if (cancelled) return;
        setTask((previous) => previous && snapshot && previous.id === snapshot.id && previous.revision > snapshot.revision ? previous : snapshot);
      }).catch((error: unknown) => {
        if (!cancelled) setStatus(`Could not restore task: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return () => { cancelled = true; };
  }, [current?.id, current?.taskId]);

  useEffect(() => {
    if (!slashMatch || !window.moss.skills?.list) return;
    let cancelled = false;
    void window.moss.skills
      .list()
      .then((availableSkills) => {
        if (!cancelled) setSkills(availableSkills);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slashMatch !== null]);

  useEffect(() => {
    const off = window.moss.chat.onEvent((payload: ChatEventPayload) => {
      if (payload.turnId !== turnIdRef.current && payload.turnId !== taskTurnIdRef.current) return;
      handleEvent(payload);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (composerMode !== "mission" || !settings.enableTools || !window.moss.mission?.capabilities) return;
    let cancelled = false;
    setMissionCapabilitiesLoading(true);
    const automation = {
      browserEnabled: settings.browserEnabled === true,
      browserAllowedDomains: (settings.browserAllowedDomains ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      browserHeadless: settings.browserHeadless !== false,
      desktopEnabled: settings.desktopEnabled === true,
      desktopAllowedProcesses: (settings.desktopAllowedProcesses ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      desktopAllowedWindows: (settings.desktopAllowedWindows ?? "").split("\n").map((value) => value.trim()).filter(Boolean),
    };
    void window.moss.mission.capabilities({
      automation,
      stt: {
        baseUrl: (settings.sttBaseUrl || settings.baseUrl || "").trim(),
        apiKey: settings.apiKey || undefined,
        model: settings.sttModel || "whisper-1",
      },
      email: { apiKey: settings.emailApiKey || "", from: settings.emailFrom || "" },
      embed: toEmbedConfig(settings),
    }).then((capabilities) => {
      if (cancelled) return;
      setMissionCapabilities(capabilities);
      setSelectedMissionCapabilities((selected) => {
        const live = new Set(capabilities.map((capability) => capability.id));
        const retained = selected.filter((id) => live.has(id));
        return retained.length > 0
          ? retained
          : capabilities.filter((capability) => capability.risk === "readonly").map((capability) => capability.id);
      });
    }).catch(() => {
      if (!cancelled) setMissionCapabilities([]);
    }).finally(() => {
      if (!cancelled) setMissionCapabilitiesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [composerMode, settings.enableTools]);

  useEffect(() => {
    if (!task) {
      setTaskHistory([]);
      return;
    }
    let cancelled = false;
    void window.moss.task.history(task.id)
      .then((entries) => {
        if (!cancelled) setTaskHistory(entries);
      })
      .catch(() => {
        if (!cancelled) setTaskHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.revision]);

  // Surface how many tools the connected MCP servers contribute, mirroring the
  // settings panel count so it is visible without opening settings. Guarded so
  // renderers without the mcp bridge (some tests) simply show no badge.
  useEffect(() => {
    let cancelled = false;
    const pending = window.moss.mcp?.status();
    if (pending) {
      pending
        .then((servers) => {
          if (cancelled) return;
          setMcpToolCount(servers.filter((s) => s.connected).reduce((n, s) => n + s.toolCount, 0));
          setMcpDownCount(servers.filter((s) => s.enabled && !s.connected).length);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  function handleEvent(payload: ChatEventPayload): void {
    const ev = payload.event;
    if (ev.type === "task-state") {
      const sessionId = taskSessionRef.current;
      if (sessionId) setSessionTaskId(sessionId, ev.task.id);
      if (sessionId === currentSessionIdRef.current) setTask(ev.task);
      if (["completed", "failed", "cancelled"].includes(ev.task.state)) taskTurnIdRef.current = null;
    } else if (ev.type === "text-delta") {
      setActivity((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.kind === "message" && last.role === "assistant") {
          next[next.length - 1] = { ...last, content: last.content + ev.text };
        } else {
          next.push({ kind: "message", role: "assistant", content: ev.text });
        }
        return next;
      });
    } else if (ev.type === "tool-call") {
      setActivity((prev) => [
        ...prev,
        { kind: "tool", callId: ev.callId, name: ev.name, args: ev.arguments, status: "running" },
      ]);
    } else if (ev.type === "tool-approval-request") {
      setActivity((prev) =>
        prev.map((it) =>
          it.kind === "tool" && it.callId === ev.callId ? { ...it, status: "approval", risk: ev.risk } : it,
        ),
      );
    } else if (ev.type === "tool-result") {
      setActivity((prev) =>
        prev.map((it) =>
          it.kind === "tool" && it.callId === ev.callId
            ? { ...it, status: ev.ok ? "done" : "error", result: ev.content, autoApproved: ev.autoApproved }
            : it,
        ),
      );
    } else if (ev.type === "token-usage") {
      // Usage is persisted per-message via the runner's committed messages and
      // shown once the turn lands; nothing to accumulate live here.
    } else if (ev.type === "notice") {
      // Transient turn-progress note (e.g. a stream retry); shown on the status
      // line and cleared when the turn lands, like Aborted/Error.
      setStatus(ev.message);
    } else if (ev.type === "confidence") {
      // Shadow label for the finished turn; shown as an opt-in chip until the
      // next turn launches.
      setConfidence({ mode: ev.mode, note: ev.note });
    } else if (ev.type === "turn-complete" || ev.type === "turn-aborted" || ev.type === "turn-error") {
      const sessionId = turnSessionRef.current;
      let committed: AgentMessage[] | null = null;
      if (sessionId) {
        const base = turnBaseRef.current;
        const user = turnPendingUserRef.current;
        const msgs =
          ev.type === "turn-error" ? markLastAssistantInterrupted(ev.messages) : ev.messages;
        committed = user ? [...base, user, ...msgs] : [...base, ...msgs];
        setSessionMessages(sessionId, committed);
      }
      turnPendingUserRef.current = null;
      setPendingUser(null);
      setActivity([]);
      setBusy(false);
      turnIdRef.current = null;
      turnSessionRef.current = null;
      setStatus(
        ev.type === "turn-aborted"
          ? "Aborted"
          : ev.type === "turn-error"
            ? `Error: ${ev.message}`
            : "",
      );

      const queued = queuedInterruptionRef.current;
      if (queued && committed && queued.sessionId === sessionId) {
        queuedInterruptionRef.current = null;
        setInterruptQueued(false);
        runTurnRef.current(queued.sessionId, committed, queued.message);
      }
    }
  }

  /** Launch a turn: wire the turn refs, mark busy, and stream the request.
   *  Shared by the composer (send), regenerate, and edit/resend so the commit
   *  path in handleEvent rebuilds the session from the same base + user message. */
  function runTurn(
    sessionId: string,
    base: AgentMessage[],
    userMsg: AgentMessage,
    durableTask?: TaskSnapshot,
    missionLaunch?: MissionLaunch,
  ): void {
    const activeSettings = settingsRef.current;
    const turnId = crypto.randomUUID();
    turnIdRef.current = turnId;
    taskTurnIdRef.current = turnId;
    taskSessionRef.current = sessionId;
    turnSessionRef.current = sessionId;
    turnBaseRef.current = base;
    turnPendingUserRef.current = userMsg;
    setPendingUser(userMsg);
    setActivity([]);
    setBusy(true);
    setStatus("");
    setConfidence(null);
    window.moss.chat.send({
      turnId,
      ...(durableTask ? { taskId: durableTask.id } : {}),
      config: toProviderConfig(activeSettings),
      messages: [...base, userMsg],
      workspaceRoot: activeSettings.workspaceRoot ?? undefined,
      enableTools: activeSettings.enableTools,
      jevEnabled: activeSettings.jevEnabled === true,
      maxToolRounds: activeSettings.maxToolRounds ?? 8,
      autoApproveTools: activeSettings.autoApproveTools,
      automation: {
        browserEnabled: activeSettings.browserEnabled === true,
        browserAllowedDomains: (activeSettings.browserAllowedDomains ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
        browserHeadless: activeSettings.browserHeadless !== false,
        desktopEnabled: activeSettings.desktopEnabled === true,
        desktopAllowedProcesses: (activeSettings.desktopAllowedProcesses ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
        desktopAllowedWindows: (activeSettings.desktopAllowedWindows ?? "").split("\n").map((value) => value.trim()).filter(Boolean),
      },
      customInstructions: activeSettings.customInstructions,
      personalityId: getSessionPersonality(sessionId) ?? activeSettings.personalityId,
      adaptiveTone: activeSettings.adaptiveTone,
      stt: {
        baseUrl: (activeSettings.sttBaseUrl || activeSettings.baseUrl || "").trim(),
        apiKey: activeSettings.apiKey || undefined,
        model: activeSettings.sttModel || "whisper-1",
      },
      email: { apiKey: activeSettings.emailApiKey || "", from: activeSettings.emailFrom || "" },
      verify: {
        enabled: activeSettings.verifyEnabled,
        commands: (activeSettings.verifyCommands || "")
          .split("\n")
          .map((c) => c.trim())
          .filter(Boolean),
      },
      embed: toEmbedConfig(activeSettings),
      ...(durableTask ? { taskSpec: durableTask.spec } : missionLaunch ? { taskSpec: missionLaunch.spec, mission: missionLaunch.policy } : {}),
      dailyBudgetUsd: activeSettings.dailyBudgetUsd || 0,
      modelRates: activeSettings.modelRates,
      gatedMemory: activeSettings.gatedMemory,
      showConfidence: activeSettings.showConfidence,
      injectionMode: activeSettings.injectionMode,
      contextLimit: activeSettings.contextLimit,
    });
  }

  runTurnRef.current = runTurn;

  function currentMissionBudget(): TaskBudget | null {
    const minutes = positiveNumber(missionBudget.minutes);
    const tokens = positiveNumber(missionBudget.tokens);
    const actions = positiveNumber(missionBudget.actions);
    const cost = positiveNumber(missionBudget.cost);
    if (minutes === null || tokens === null || actions === null || cost === null) return null;
    return {
      maxDurationMs: Math.round(minutes * 60_000),
      maxTokens: Math.round(tokens),
      maxActions: Math.round(actions),
      maxCostUsd: cost,
    };
  }

  async function launchMission(text: string, userMsg: AgentMessage): Promise<void> {
    const budget = currentMissionBudget();
    if (!budget || selectedMissionCapabilities.length === 0) {
      setStatus(!budget ? "Mission budgets must all be positive numbers." : "Select at least one mission capability.");
      return;
    }
    const activeSettings = settingsRef.current;
    const automation = {
      browserEnabled: activeSettings.browserEnabled === true,
      browserAllowedDomains: (activeSettings.browserAllowedDomains ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      browserHeadless: activeSettings.browserHeadless !== false,
      desktopEnabled: activeSettings.desktopEnabled === true,
      desktopAllowedProcesses: (activeSettings.desktopAllowedProcesses ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      desktopAllowedWindows: (activeSettings.desktopAllowedWindows ?? "").split("\n").map((value) => value.trim()).filter(Boolean),
    };
    const policyWithoutToken: Omit<MissionLaunchPolicy, "authorizationToken"> = {
      authority: missionAuthority,
      requestedCapabilities: selectedMissionCapabilities,
      maxAutoApprovedRisk: missionAuthority === "supervised" ? "readonly" : "mutating",
      budget,
    };
    let policy: MissionLaunchPolicy = policyWithoutToken;
    if (missionAuthority === "policy-scoped") {
      setStatus("Awaiting native mission authorization...");
      const authorization = await window.moss.mission.authorize({
        objective: text,
        workspaceRoot: activeSettings.workspaceRoot ?? undefined,
        policy: policyWithoutToken,
        automation,
      });
      if (!authorization) {
        setStatus("Mission launch cancelled.");
        return;
      }
      policy = { ...policyWithoutToken, authorizationToken: authorization.token };
    }
    const spec: TaskSpec = {
      objective: text,
      acceptanceCriteria: [{
        id: "requested-outcome",
        description: "The requested outcome is complete and verified with available evidence.",
        mandatory: true,
      }],
      constraints: [],
      assumptions: [],
      workspaceRoot: activeSettings.workspaceRoot ?? undefined,
      budget,
    };
    const sessionId = ensureCurrentSession();
    setSessionTitle(sessionId, text);
    setInput("");
    setAttachments([]);
    setDocuments([]);
    runTurn(sessionId, getSessionMessages(sessionId), userMsg, undefined, { spec, policy });
  }

  function send(textArg?: string): void {
    const text = (textArg ?? input).trim();
    if ((!text && attachments.length === 0 && documents.length === 0) || pendingAttachmentReads > 0 || !settings.model) return;
    if (busy && queuedInterruptionRef.current) return;

    const sessionId = busy ? turnSessionRef.current : ensureCurrentSession();
    if (!sessionId) return;
    const userMsg: AgentMessage = { role: "user", content: text };
    if (attachments.length > 0) userMsg.images = attachments;
    if (documents.length > 0) userMsg.documents = documents;
    if (composerMode === "mission" && !busy) {
      void launchMission(text, userMsg).catch((error) => {
        setStatus(`Could not launch mission: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    setInput("");
    setAttachments([]);
    setDocuments([]);

    if (busy) {
      queuedInterruptionRef.current = { sessionId, message: userMsg };
      setInterruptQueued(true);
      setStatus("Interrupting current response…");
      if (turnIdRef.current) window.moss.chat.abort(turnIdRef.current);
      return;
    }

    setSessionTitle(sessionId, text || documents[0]?.name || "");
    const base = getSessionMessages(sessionId);
    runTurn(sessionId, base, userMsg);
  }

  async function resumeTask(): Promise<void> {
    if (!task) return;
    try {
      const sessionId = ensureCurrentSession();
      const resumed = await window.moss.task.resume(task.id);
      setTask(resumed);
      runTurn(sessionId, getSessionMessages(sessionId), { role: "user", content: resumed.spec.objective }, resumed);
    } catch (error) {
      setStatus(`Could not resume task: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function cancelTask(): Promise<void> {
    if (!task) return;
    try {
      setTask(await window.moss.task.cancel(task.id));
    } catch (error) {
      setStatus(`Could not cancel task: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Fork this conversation into a fresh chat carrying a model-written summary.
   *  The summary is a one-shot, tool-free call that never touches this session's
   *  transcript. If it cannot be made — no model configured, provider error — we
   *  still fork, using the locally-built digest, and say why. */
  async function handleContinueInNewChat(sessionId: string): Promise<void> {
    if (history.length === 0) return;
    setSummarizing(true);
    setStatus("");
    let summary: string | undefined;
    try {
      if (settings.model) {
        const result = await window.moss.chat.summarize({
          config: toProviderConfig(settings),
          messages: history,
          title: current?.title ?? "Untitled chat",
        });
        if (result.ok) summary = result.summary;
        else setStatus(`Carried over a basic digest instead of a written summary: ${result.error ?? "unknown error"}`);
      }
    } catch (error) {
      setStatus(
        `Carried over a basic digest instead of a written summary: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSummarizing(false);
    }
    continueInNewSession(sessionId, summary);
  }

  /** Re-run the user turn at the given history index, dropping that turn's
   *  reply (and any tool messages) so the model answers the same prompt again. */
  function regenerateAt(userIndex: number): void {
    if (busy || !settings.model) return;
    const sessionId = current?.id;
    if (!sessionId) return;
    if (userIndex < 0 || history[userIndex]?.role !== "user") return;
    runTurn(sessionId, history.slice(0, userIndex), history[userIndex]);
  }

  /** Pull the user turn at the given history index back into the composer
   *  (text + images) and truncate history before it, so the user can edit the
   *  prompt and send it again. */
  function editUserAt(index: number): void {
    if (busy) return;
    const sessionId = current?.id;
    if (!sessionId) return;
    const userMsg = history[index];
    if (!userMsg || userMsg.role !== "user") return;
    setInput(userMsg.content);
    setAttachments(userMsg.images ?? []);
    setDocuments(userMsg.documents ?? []);
    setSessionMessages(sessionId, history.slice(0, index));
  }

  function abort(): void {
    queuedInterruptionRef.current = null;
    setInterruptQueued(false);
    if (turnIdRef.current) window.moss.chat.abort(turnIdRef.current);
  }

  function selectSkill(skill: Skill): void {
    setInput(`/${skill.name} `);
    setSelectedSkillIndex(0);
    setSkillMenuDismissed(true);
  }

  /** Read picked files into structured message attachments. Provider adapters
   *  expand document text only when building the model request, keeping the
   *  composer and visible transcript compact. */
  function addFiles(fileList: FileList | null): void {
    if (!fileList) return;
    for (const file of Array.from(fileList)) {
      const imageType = imageMediaType(file);
      const isPdf = isPdfFile(file);
      const isDocx = isDocxFile(file);
      const lang = textLanguageForFile(file);
      if (imageType) {
        const error = imageAttachmentError(file);
        if (error) {
          setStatus(error);
          continue;
        }
        const reader = new FileReader();
        setPendingAttachmentReads((count) => count + 1);
        reader.onload = () => {
          if (typeof reader.result === "string") {
            setAttachments((prev) => [...prev, reader.result as string]);
          }
        };
        reader.onerror = () => setStatus(`${file.name}: could not read file`);
        reader.onloadend = () => setPendingAttachmentReads((count) => Math.max(0, count - 1));
        reader.readAsDataURL(file.slice(0, file.size, imageType));
      } else if (isPdf || isDocx) {
        const format = isPdf ? "PDF" : "Word document";
        if (file.size > (isPdf ? MAX_PDF_BYTES : MAX_DOCX_BYTES)) {
          setStatus(`${file.name}: ${format} is larger than 10 MB`);
          continue;
        }
        setPendingAttachmentReads((count) => count + 1);
        file.arrayBuffer()
          .then(isPdf ? extractPdfText : extractDocxText)
          .then((text) => {
            if (!text.trim()) throw new Error("no readable text found");
            const error = textAttachmentError({ name: file.name, size: new TextEncoder().encode(text).byteLength });
            if (error) throw new Error("extracted text is larger than 256 KB");
            setDocuments((prev) => [
              ...prev,
              { name: file.name, mediaType: isPdf ? "application/pdf" : DOCX_MEDIA_TYPE, text },
            ]);
          })
          .catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : "could not read file";
            setStatus(`${file.name}: ${reason}`);
          })
          .finally(() => setPendingAttachmentReads((count) => Math.max(0, count - 1)));
      } else if (file.name.toLowerCase().endsWith(".doc") || file.type === "application/msword") {
        setStatus(`${file.name}: legacy .doc files are not supported; save as .docx and attach again`);
      } else if (lang !== null) {
        const error = textAttachmentError(file);
        if (error) {
          setStatus(error);
          continue;
        }
        const reader = new FileReader();
        setPendingAttachmentReads((count) => count + 1);
        reader.onload = () => {
          if (typeof reader.result === "string") {
            setDocuments((prev) => [
              ...prev,
              { name: file.name, mediaType: file.type || "text/plain", text: reader.result as string },
            ]);
          }
        };
        reader.onerror = () => setStatus(`${file.name}: could not read file`);
        reader.onloadend = () => setPendingAttachmentReads((count) => Math.max(0, count - 1));
        reader.readAsText(file);
      } else {
        setStatus(`${file.name}: unsupported file type`);
      }
    }
  }

  function approve(callId: string, approved: boolean, comment?: string): void {
    if (!turnIdRef.current) return;
    const normalizedComment = comment?.trim();
    window.moss.tool.approve({
      turnId: turnIdRef.current,
      callId,
      approved,
      ...(normalizedComment ? { comment: normalizedComment } : {}),
    });
    setActivity((prev) =>
      prev.map((it) =>
        it.kind === "tool" && it.callId === callId
          ? { ...it, status: approved ? "running" : "denied" }
          : it,
      ),
    );
  }

  const items: ViewItem[] = [
    ...messagesToItems(history),
    ...(pendingUser ? [{ kind: "message", role: "user", content: pendingUser.content, images: pendingUser.images, documents: pendingUser.documents } as MessageView] : []),
    ...activity,
  ];

  const showWelcome = items.length === 0;
  const taskActionCount = task?.attempts.reduce((total, attempt) => total + attempt.actionCount, 0) ?? 0;
  const taskTokenCount = task?.attempts.reduce(
    (total, attempt) => total + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0),
    0,
  ) ?? 0;
  const taskCost = task?.attempts.reduce((total, attempt) => total + attempt.estimatedCostUsd, 0) ?? 0;
  const taskElapsedMs = task
    ? Math.max(0, new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime())
    : 0;
  const runningTaskStep = task?.steps.find((step) => step.state === "running");
  const currentExclusiveStep = task?.steps.find(
    (step) => step.state === "running" && step.mission?.executionLane === "exclusive",
  );
  const selectedArtifact = artifactSelection?.sessionId === current?.id && artifactSelection?.taskId === task?.id
    ? task?.artifacts?.find((artifact) => artifact.id === artifactSelection?.id)
    : undefined;
  function openArtifact(id: string): void {
    if (current && task) setArtifactSelection({ sessionId: current.id, taskId: task.id, id });
  }

  return (
    <div className="relative flex h-screen min-w-0 flex-1 bg-transparent text-neutral-900 dark:text-neutral-100">
    <div className={`${selectedArtifact ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/60 px-4 py-2 text-sm backdrop-blur-sm">
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white md:hidden"
          onClick={onOpenChats}
          title="Open conversations"
          aria-label="Open conversations"
        >
          <Menu size={18} aria-hidden="true" />
        </button>
        <MossFace className="h-8 w-8" label="Moss portrait" />
        <span className="font-semibold tracking-tight text-neutral-800 dark:text-neutral-200">Moss</span>
        {models.length > 0 ? (
          <select
            className="w-56 rounded-md border border-neutral-300/60 dark:border-neutral-700/60 bg-neutral-200 dark:bg-neutral-800 px-2 py-1 transition focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            aria-label="Model"
            value={settings.model}
            onChange={(e) => updateSettings({ model: e.target.value })}
          >
            <option value="">Select model…</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <button
            className="rounded-md bg-neutral-300 dark:bg-neutral-700 px-2 py-1 transition hover:bg-neutral-400 dark:hover:bg-neutral-600"
            onClick={onOpenSettings}
          >
            Set up provider…
          </button>
        )}
        {settings.model ? <span className="text-xs text-neutral-500 dark:text-neutral-400">{settings.model}</span> : null}
        {current ? (
          <select
            className="w-40 rounded-md border border-neutral-300/60 dark:border-neutral-700/60 bg-neutral-200 dark:bg-neutral-800 px-2 py-1 transition focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            value={current.personalityId ?? ""}
            onChange={(e) => setSessionPersonality(current.id, e.target.value || undefined)}
            disabled={busy}
            title="Personality for this chat. Inherit uses the global default from Settings."
          >
            <option value="">
              Inherit ({PERSONALITY_PRESETS.find((p) => p.id === settings.personalityId)?.name ?? "Default"})
            </option>
            {PERSONALITY_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        {usage.inputTokens || usage.outputTokens ? (
          <span
            className="text-xs text-neutral-400 dark:text-neutral-600"
            title="Total token usage for this conversation (input / output), summed across messages."
          >
            {formatTokens(usage.inputTokens ?? 0)} in / {formatTokens(usage.outputTokens ?? 0)} out
          </span>
        ) : null}
        {cost !== null && (usage.inputTokens || usage.outputTokens) ? (
          <span
            className="text-xs text-neutral-400 dark:text-neutral-600"
            title={`Estimated cost for this conversation using built-in rates for ${settings.model}. Approximate; provider pricing may differ.`}
          >
            ~{formatUsd(cost)}
          </span>
        ) : null}
        {tools.total > 0 ? (
          <span className="relative">
            <button
              type="button"
              className={tools.autoApproved > 0 ? "text-xs text-amber-400/80 hover:underline" : "text-xs text-neutral-400 dark:text-neutral-600 hover:underline"}
              title={`${tools.total} tool call(s) ran in this conversation; ${tools.autoApproved} ran without asking because auto-approve was on. Click to review.`}
              onClick={() => setShowToolAudit((v) => !v)}
            >
              {tools.total} tool{tools.total === 1 ? "" : "s"}
              {tools.autoApproved > 0 ? ` (${tools.autoApproved} auto)` : ""}
            </button>
            {showToolAudit ? (
              <div className="absolute left-0 top-5 z-20 max-h-64 w-72 overflow-y-auto rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-2 shadow-lg">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Tool activity</p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setAuditHideReadonly((v) => !v)}
                      className={
                        auditHideReadonly
                          ? "rounded bg-neutral-300 dark:bg-neutral-700 px-1 text-[10px] uppercase text-neutral-800 dark:text-neutral-200"
                          : "rounded bg-neutral-200 dark:bg-neutral-800 px-1 text-[10px] uppercase text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                      }
                    >
                      Hide readonly
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuditSortByRisk((v) => !v)}
                      className={
                        auditSortByRisk
                          ? "rounded bg-neutral-300 dark:bg-neutral-700 px-1 text-[10px] uppercase text-neutral-800 dark:text-neutral-200"
                          : "rounded bg-neutral-200 dark:bg-neutral-800 px-1 text-[10px] uppercase text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                      }
                    >
                      By risk
                    </button>
                  </div>
                </div>
                <ul className="space-y-1">
                  {visibleToolAudit.map((e, i) => (
                    <li key={`${e.callId}-${i}`} className="flex items-center gap-2 text-xs">
                      <span className="flex-1 truncate font-mono text-neutral-800 dark:text-neutral-200">{e.name}</span>
                      <span
                        className={
                          e.risk === "destructive"
                            ? "rounded bg-red-900/60 px-1 text-[10px] uppercase text-red-300"
                            : e.risk === "mutating"
                              ? "rounded bg-amber-900/60 px-1 text-[10px] uppercase text-amber-300"
                              : "rounded bg-neutral-200 dark:bg-neutral-800 px-1 text-[10px] uppercase text-neutral-600 dark:text-neutral-400"
                        }
                      >
                        {e.risk}
                      </span>
                      {e.autoApproved ? (
                        <span className="rounded bg-amber-900/40 px-1 text-[10px] uppercase text-amber-300">auto</span>
                      ) : null}
                      {e.durationMs != null ? (
                        <span className="font-mono text-[10px] tabular-nums text-neutral-500 dark:text-neutral-400">{e.durationMs}ms</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </span>
        ) : null}
        {settings.contextLimit > 0 && contextUsed > 0 ? (
          <span
            className="inline-flex flex-col gap-0.5"
            title={`Approximate context-window usage: the latest reply used ${formatTokens(contextDetail.inputTokens ?? 0)} input + ${formatTokens(contextDetail.outputTokens ?? 0)} output tokens, against the limit you set in Settings.`}
          >
            <span
              className={
                contextUsed >= settings.contextLimit
                  ? "text-xs font-medium text-amber-600 dark:text-amber-400"
                  : "text-xs text-neutral-400 dark:text-neutral-600"
              }
            >
              ctx {formatTokens(contextUsed)}/{formatTokens(settings.contextLimit)}
            </span>
            <progress
              className={`h-1 w-full overflow-hidden rounded-full ${
                contextUsed >= settings.contextLimit ? "accent-amber-400" : "accent-emerald-500"
              }`}
              max={settings.contextLimit}
              value={Math.min(contextUsed, settings.contextLimit)}
              aria-label="Context window usage"
            />
          </span>
        ) : null}
        {settings.enableTools && mcpToolCount > 0 ? (
          <span
            className="rounded-full border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-300"
            title="Tools available from connected MCP servers."
          >
            {mcpToolCount} MCP {mcpToolCount === 1 ? "tool" : "tools"}
          </span>
        ) : null}
        {settings.enableTools && mcpDownCount > 0 ? (
          <span
            className="rounded-full border border-rose-500/30 bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-300"
            title="Configured MCP servers that are enabled but failed to connect. Retry them in Settings."
          >
            {mcpDownCount} MCP {mcpDownCount === 1 ? "server" : "servers"} down
          </span>
        ) : null}
        {settings.enableTools && settings.autoApproveTools ? (
          <span
            className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300"
            title="Tools that write files or run commands run automatically without asking."
          >
            Auto-approving tools
          </span>
        ) : null}
        <span className="ml-auto truncate text-xs text-neutral-500 dark:text-neutral-400">
          {settings.workspaceRoot ?? "no workspace"}
        </span>
        {current && history.length > 0 ? (
          <button
            className="rounded-md bg-neutral-300 dark:bg-neutral-700 px-2 py-1 transition hover:bg-neutral-400 dark:hover:bg-neutral-600 disabled:opacity-50"
            onClick={() => void handleContinueInNewChat(current.id)}
            disabled={busy || summarizing}
            title="Start a fresh chat that carries a summary of this conversation. Resets the context window without losing the thread; this conversation is kept."
          >
            {summarizing ? "Summarizing…" : "Continue in new chat"}
          </button>
        ) : null}
        {current && history.length > 0 ? (
          <button
            className="rounded-md bg-neutral-300 dark:bg-neutral-700 px-2 py-1 transition hover:bg-neutral-400 dark:hover:bg-neutral-600 disabled:opacity-50"
            onClick={() => clearSession(current.id)}
            disabled={busy}
            title="Clear this conversation: removes its messages but keeps it in the list."
          >
            Clear
          </button>
        ) : null}
        <button className="rounded-md bg-neutral-300 dark:bg-neutral-700 px-2 py-1 transition hover:bg-neutral-400 dark:hover:bg-neutral-600" onClick={onOpenSettings}>
          Settings
        </button>
        {task?.artifacts?.length ? <button type="button" className="response-icon-button" title={`Open artifacts (${task.artifacts.length})`} aria-label="Open artifacts" aria-expanded={!!selectedArtifact} onClick={() => selectedArtifact ? setArtifactSelection(null) : openArtifact(task.artifacts![0].id)}><PanelRightOpen size={18} /></button> : null}
      </header>

      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
        {showWelcome ? (
          <WelcomeScreen onPick={(text) => send(text)} needsSetup={!settings.model} onOpenSettings={onOpenSettings} />
        ) : (
          items.map((it, i) => {
          const clarification = it.kind === "message" && it.role === "assistant" && !it.interrupted && !it.hasToolCalls && !(busy && i === items.length - 1)
            ? parseClarification(it.content) : null;
          return (
          it.kind === "message" && it.handoff && it.role === "user" ? (
            <details
              key={i}
              className="group mx-auto w-full max-w-[52rem] animate-fade-in overflow-hidden rounded-lg border border-neutral-300/60 bg-white/70 shadow-sm dark:border-neutral-700/60 dark:bg-neutral-900/70"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 marker:hidden">
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Carried-over context</span>
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
                  Summary of the previous chat, sent as the first message
                </span>
                <span className="text-[10px] text-neutral-400 transition-transform group-open:rotate-180" aria-hidden="true">▼</span>
              </summary>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-neutral-200/70 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700/70 dark:text-neutral-300">
                {it.content}
              </pre>
            </details>
          ) : it.kind === "message" ? (
            <div
              key={i}
              className={
                it.role === "user"
                  ? "group ml-auto max-w-2xl animate-fade-in whitespace-pre-wrap rounded-2xl border border-emerald-500/20 bg-emerald-600/15 px-4 py-2.5 shadow-sm"
                  : "assistant-response group relative mx-auto w-full max-w-[52rem] animate-fade-in pl-11"
              }
            >
              {it.role === "assistant" ? (
                <MossFace className="absolute left-0 top-0 h-8 w-8" label="Moss response" />
              ) : null}
              {it.role === "assistant" ? (
                clarification ? <ClarificationForm
                  key={`${current?.id}:${i}:${it.content}`}
                  request={clarification}
                  disabled={busy || i !== items.length - 1 || !settings.model}
                  onSubmit={(answer) => {
                    if (busy || turnIdRef.current || !current || current.id !== currentSessionIdRef.current || i !== items.length - 1 || !settings.model) return false;
                    runTurn(current.id, getSessionMessages(current.id), { role: "user", content: answer });
                    return true;
                  }}
                /> : <RichResponse
                  key={`${current?.id}:${i}`}
                  content={it.content}
                  streaming={busy && i === items.length - 1}
                  onCopy={(text) => copyToClipboard(text)}
                />
              ) : it.content}
              {it.role === "user" && it.images && it.images.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {it.images.map((src, ii) => (
                    <img
                      key={ii}
                      src={src}
                      alt="attachment"
                      className="max-h-32 rounded-lg border border-emerald-500/20"
                    />
                  ))}
                </div>
              ) : null}
              {it.role === "user" && it.documents && it.documents.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {it.documents.map((document, documentIndex) => (
                    <span
                      key={`${document.name}-${documentIndex}`}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-emerald-500/20 bg-white/50 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-900/40 dark:text-neutral-200"
                      title={document.name}
                    >
                      <FileText size={14} className="shrink-0" aria-hidden="true" />
                      <span className="truncate">{document.name}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {it.role === "assistant" && it.interrupted ? (
                <span className="ml-1 text-xs italic text-neutral-500 dark:text-neutral-400">(interrupted)</span>
              ) : null}
              {it.role === "user" && it.historyIndex !== undefined && !busy ? (
                <div className="mt-1 flex gap-2 text-[10px] text-emerald-200/50 opacity-0 transition group-hover:opacity-100">
                  <button
                    className="hover:text-emerald-100"
                    onClick={() => editUserAt(it.historyIndex!)}
                    title="Edit this message: pulls it into the composer and removes everything after it."
                  >
                    Edit
                  </button>
                  <button
                    className="hover:text-emerald-100"
                    onClick={() => regenerateAt(it.historyIndex!)}
                    title="Re-run this prompt to get a fresh reply, dropping everything after it."
                  >
                    Regenerate
                  </button>
                </div>
              ) : null}
              {it.role === "assistant" && it.content ? (
                <div className="response-footer">
                  <ResponseActions
                    content={it.content}
                    onRegenerate={it.sourceUserIndex !== undefined && !busy ? () => regenerateAt(it.sourceUserIndex!) : undefined}
                  />
                  <div className="response-usage">
                    {it.usage && (it.usage.inputTokens || it.usage.outputTokens) ? (
                      <span title="Token usage for this reply (input / output).">
                        {formatTokens(it.usage.inputTokens ?? 0)}/{formatTokens(it.usage.outputTokens ?? 0)} tok
                      </span>
                    ) : null}
                    {it.turnUsage ? (
                      <span title="Total token usage for this exchange across all tool rounds (input / output).">
                        turn {formatTokens(it.turnUsage.inputTokens ?? 0)}/{formatTokens(it.turnUsage.outputTokens ?? 0)} tok
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {it.role === "assistant" && it.turnId ? <TurnRevert turnId={it.turnId} /> : null}
            </div>
          ) : <ToolCard key={i} tool={it} onApprove={approve} />
          );
        }))}
      </div>

      {task ? (
        <section className="border-t border-neutral-200 dark:border-neutral-800 bg-white/70 dark:bg-neutral-900/70 px-4 py-2 text-xs" aria-label="Task status">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold text-neutral-900 dark:text-neutral-100">Task</span>
            <span className={
              task.state === "completed"
                ? "text-emerald-600 dark:text-emerald-400"
                : task.state === "blocked" || task.state === "failed"
                  ? "text-red-600 dark:text-red-400"
                  : task.state === "paused" || task.state === "waiting_for_approval"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-sky-600 dark:text-sky-400"
            }>{task.state.replaceAll("_", " ")}</span>
            <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">
              {runningTaskStep?.description ?? task.spec.objective}
            </span>
            {task.missionPlan ? (
              <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
                Plan r{task.missionPlan.revision} · {task.steps.filter((step) => step.state === "completed").length}/{task.steps.length} steps
              </span>
            ) : null}
            {runningTaskStep?.mission ? (
              <span className="text-neutral-500 dark:text-neutral-400">
                {runningTaskStep.mission.workerRole} · {runningTaskStep.mission.executionLane}
              </span>
            ) : null}
            <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
              {task.attempts.length} {task.attempts.length === 1 ? "attempt" : "attempts"} · {task.evidence.filter((item) => item.passed).length}/{task.spec.acceptanceCriteria.filter((item) => item.mandatory).length} evidence
            </span>
            {task.spec.budget?.maxActions ? (
              <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
                {taskActionCount}/{task.spec.budget.maxActions} actions
              </span>
            ) : null}
            {task.approval ? (
              <span className="font-mono text-neutral-500 dark:text-neutral-400">
                {task.approval.toolName} {task.approval.status}
              </span>
            ) : null}
            {(task.state === "paused" || task.state === "blocked") ? (
              <button className="rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-0.5 hover:bg-neutral-300 dark:hover:bg-neutral-700" onClick={() => void resumeTask()}>
                Resume
              </button>
            ) : null}
            {!(["completed", "failed", "cancelled"].includes(task.state)) ? (
              <button className="text-red-600 dark:text-red-400 hover:text-red-500" onClick={() => void cancelTask()}>
                Cancel
              </button>
            ) : null}
          </div>
          {task.spec.budget ? (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-neutral-500 dark:text-neutral-400" aria-label="Remaining mission budget">
              {task.spec.budget.maxActions ? <span>{Math.max(0, task.spec.budget.maxActions - taskActionCount)} actions left</span> : null}
              {task.spec.budget.maxTokens ? <span>{formatTokens(Math.max(0, task.spec.budget.maxTokens - taskTokenCount))} tokens left</span> : null}
              {task.spec.budget.maxCostUsd ? <span>{formatUsd(Math.max(0, task.spec.budget.maxCostUsd - taskCost))} left</span> : null}
              {task.spec.budget.maxDurationMs ? <span title="Remaining at the latest durable checkpoint">{formatDuration(task.spec.budget.maxDurationMs - taskElapsedMs)} left</span> : null}
              {currentExclusiveStep ? <span className="font-medium text-amber-700 dark:text-amber-300">Exclusive: {currentExclusiveStep.description}</span> : null}
            </div>
          ) : null}
          {task.blocker ? <p className="mt-1 whitespace-pre-wrap text-amber-700 dark:text-amber-300">{task.blocker.summary}</p> : null}
          {(task.missionPlan || task.evidence.length > 0 || (task.artifacts?.length ?? 0) > 0) ? (
            <details className="mt-1 border-t border-neutral-200 pt-1 dark:border-neutral-800">
              <summary className="w-fit cursor-pointer select-none text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
                Mission details
              </summary>
              {task.missionPlan ? (
                <ol className="mt-1 grid gap-1 sm:grid-cols-2">
                  {task.steps.map((step) => (
                    <li key={step.id} className="flex min-w-0 gap-2 text-neutral-600 dark:text-neutral-300">
                      <span className="w-16 shrink-0 text-neutral-400">{step.state}</span>
                      <span className="min-w-0 truncate">{step.description}</span>
                      {step.mission ? <span className="ml-auto shrink-0 text-neutral-400">{step.mission.workerRole}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {task.spec.acceptanceCriteria.map((criterion) => {
                  const criterionEvidence = task.evidence.filter((item) => item.criterionId === criterion.id);
                  return (
                    <div key={criterion.id} className="min-w-0 border-l-2 border-neutral-300 pl-2 dark:border-neutral-700">
                      <div className="flex gap-2 text-neutral-700 dark:text-neutral-200">
                        <span className="min-w-0 flex-1 truncate">{criterion.description}</span>
                        <span className="shrink-0 tabular-nums text-neutral-400">{criterionEvidence.filter((item) => item.passed).length}/{criterionEvidence.length}</span>
                      </div>
                      {criterionEvidence.map((item) => <p key={item.id} className={item.passed ? "truncate text-emerald-600 dark:text-emerald-400" : "truncate text-red-600 dark:text-red-400"}>{item.summary}</p>)}
                    </div>
                  );
                })}
              </div>
              {task.artifacts && task.artifacts.length > 0 ? (
                <ul className="mt-2 space-y-1" aria-label="Mission artifacts">
                  {task.artifacts.map((artifact) => (
                    <li key={artifact.id} className="flex gap-2 text-neutral-600 dark:text-neutral-300">
                      <button type="button" className="min-w-0 break-words text-left font-mono underline decoration-neutral-400 underline-offset-2 hover:text-emerald-600" title={`Open ${artifact.name}`} onClick={() => openArtifact(artifact.id)}>{artifact.name}</button>
                      <span className="min-w-0 truncate text-neutral-400">{artifact.summary}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          ) : null}
          {taskHistory.length > 0 ? (
            <details className="mt-1 border-t border-neutral-200 pt-1 dark:border-neutral-800">
              <summary className="w-fit cursor-pointer select-none text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
                Timeline ({taskHistory.length})
              </summary>
              <ol className="mt-1 max-h-40 space-y-1 overflow-y-auto border-l border-neutral-300 pl-3 dark:border-neutral-700">
                {taskHistory.map((entry) => (
                  <li key={entry.id} className="flex gap-2 text-neutral-600 dark:text-neutral-300">
                    <time className="shrink-0 tabular-nums text-neutral-400 dark:text-neutral-500" dateTime={entry.occurredAt}>
                      {new Date(entry.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </time>
                    <span>{entry.summary}</span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </section>
      ) : null}

      <footer
        className="relative border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/60 px-4 py-3 backdrop-blur-sm"
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {dragging ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-emerald-500/60 bg-neutral-50/80 dark:bg-neutral-950/80 text-sm text-emerald-300">
            Drop files to attach
          </div>
        ) : null}
        {status ? <div className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">{status}</div> : null}
        {confidence ? (
          <div className="mb-2" title={confidence.note}>
            <span className={`rounded px-1.5 py-0.5 text-xs ${CONFIDENCE_CLASS[confidence.mode]}`}>
              {CONFIDENCE_LABEL[confidence.mode]}
            </span>
          </div>
        ) : null}
        {dictation.error ? <div className="mb-2 text-xs text-red-600 dark:text-red-400">{dictation.error}</div> : null}
        {pendingAttachmentReads > 0 ? (
          <div className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">
            Attaching {pendingAttachmentReads} {pendingAttachmentReads === 1 ? "file" : "files"}...
          </div>
        ) : null}
        {attachments.length > 0 && settings.model && !isLikelyVisionModel(settings.model) ? (
          <div className="mb-2 text-xs text-amber-600 dark:text-amber-400">The selected model may not support images.</div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((src, i) => (
              <div key={i} className="relative">
                <img
                  src={src}
                  alt="attachment"
                  className="h-14 w-14 rounded-lg border border-neutral-300/60 dark:border-neutral-700/60 object-cover"
                />
                <button
                  className="absolute -right-1 -top-1 rounded-full bg-white dark:bg-neutral-900 px-1 text-[10px] text-neutral-700 dark:text-neutral-300 hover:text-white"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  title="Remove this attachment"
                >
                  x
                </button>
              </div>
            ))}
            <button
              className="self-center rounded-lg px-2 py-1 text-[10px] text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
              onClick={() => setAttachments([])}
              title="Remove all attachments"
            >
              Clear all
            </button>
          </div>
        ) : null}
        {documents.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {documents.map((document, documentIndex) => (
              <span
                key={`${document.name}-${documentIndex}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-neutral-300/60 bg-neutral-100 px-2 py-1 text-xs text-neutral-700 dark:border-neutral-700/60 dark:bg-neutral-800 dark:text-neutral-200"
                title={document.name}
              >
                <FileText size={14} className="shrink-0" aria-hidden="true" />
                <span className="max-w-52 truncate">{document.name}</span>
                <button
                  type="button"
                  className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
                  onClick={() => setDocuments((prev) => prev.filter((_, index) => index !== documentIndex))}
                  title={`Remove ${document.name}`}
                  aria-label={`Remove ${document.name}`}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {skillMenuOpen ? (
          <div
            className="mb-2 max-h-56 overflow-y-auto rounded-md border border-neutral-300/70 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            role="listbox"
            aria-label="Skills"
          >
            {matchingSkills.map((skill, index) => (
              <button
                key={skill.id}
                type="button"
                role="option"
                aria-selected={index === selectedSkillIndex}
                className={`flex w-full items-start gap-3 rounded px-2 py-2 text-left ${
                  index === selectedSkillIndex
                    ? "bg-emerald-100 text-neutral-900 dark:bg-emerald-900/40 dark:text-neutral-100"
                    : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectSkill(skill)}
              >
                <span className="shrink-0 font-mono text-sm text-emerald-700 dark:text-emerald-400">/{skill.name}</span>
                <span className="min-w-0 truncate text-xs text-neutral-500 dark:text-neutral-400">{skill.description}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-md border border-neutral-300/70 bg-neutral-100 p-0.5 dark:border-neutral-700 dark:bg-neutral-900"
            aria-label="Composer mode"
          >
            {(["chat", "mission"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={composerMode === mode}
                className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
                  composerMode === mode
                    ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white"
                    : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
                }`}
                onClick={() => setComposerMode(mode)}
                disabled={busy}
              >
                {mode === "chat" ? "Chat" : "Mission"}
              </button>
            ))}
          </div>
          {composerMode === "mission" ? (
            <details className="relative">
              <summary className="cursor-pointer select-none rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800">
                Review mission
              </summary>
              <div
                className="absolute bottom-8 left-0 z-20 w-[min(36rem,calc(100vw-2rem))] rounded-md border border-neutral-300 bg-white p-3 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
                aria-label="Mission review"
              >
                <div className="mb-3 flex gap-1" aria-label="Mission authority">
                  <button
                    type="button"
                    aria-pressed={missionAuthority === "supervised"}
                    className={`rounded px-2 py-1 text-xs ${missionAuthority === "supervised" ? "bg-emerald-600 text-white" : "bg-neutral-200 dark:bg-neutral-800"}`}
                    onClick={() => setMissionAuthority("supervised")}
                  >
                    Supervised
                  </button>
                  <button
                    type="button"
                    aria-pressed={missionAuthority === "policy-scoped"}
                    className={`rounded px-2 py-1 text-xs ${missionAuthority === "policy-scoped" ? "bg-amber-600 text-white" : "bg-neutral-200 dark:bg-neutral-800"}`}
                    onClick={() => setMissionAuthority("policy-scoped")}
                  >
                    Policy-scoped
                  </button>
                </div>
                <fieldset className="mb-3">
                  <legend className="mb-1 text-xs font-semibold text-neutral-700 dark:text-neutral-200">Capabilities</legend>
                  {missionCapabilitiesLoading ? <span className="text-xs text-neutral-500">Loading capabilities...</span> : (
                    <div className="max-h-32 columns-2 overflow-y-auto">
                      {missionCapabilities.map((capability) => (
                        <label key={capability.id} className="flex break-inside-avoid items-center gap-1.5 py-0.5 text-xs">
                          <input
                            type="checkbox"
                            checked={selectedMissionCapabilities.includes(capability.id)}
                            onChange={(event) => setSelectedMissionCapabilities((selected) => event.target.checked
                              ? [...selected, capability.id]
                              : selected.filter((id) => id !== capability.id))}
                          />
                          <span className="truncate font-mono">{capability.id}</span>
                          <span className="text-neutral-400">{capability.risk}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
                <fieldset>
                  <legend className="mb-1 text-xs font-semibold text-neutral-700 dark:text-neutral-200">Budgets</legend>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {([
                      ["minutes", "Minutes", "240"],
                      ["tokens", "Tokens", "1000000"],
                      ["actions", "Actions", "256"],
                      ["cost", "Cost USD", "100"],
                    ] as const).map(([key, label, max]) => (
                      <label key={key} className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        {label}
                        <input
                          aria-label={`Mission ${label}`}
                          type="number"
                          min="0.01"
                          max={max}
                          step={key === "cost" ? "0.01" : "1"}
                          value={missionBudget[key]}
                          onChange={(event) => setMissionBudget((currentBudget) => ({ ...currentBudget, [key]: event.target.value }))}
                          className="mt-0.5 w-full rounded border border-neutral-300 bg-neutral-100 px-1.5 py-1 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                        />
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </details>
          ) : null}
          {composerMode === "mission" ? (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {missionAuthority === "supervised" ? "Prompts before mutations" : "Native approval for bounded mutations"}
            </span>
          ) : null}
        </div>
        <div className="flex gap-2">
          <textarea
            className="flex-1 resize-none rounded-xl border border-neutral-300/60 dark:border-neutral-700/60 bg-neutral-200 dark:bg-neutral-800 px-3 py-2 transition focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            rows={2}
            placeholder="Message…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSelectedSkillIndex(0);
              setSkillMenuDismissed(false);
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length > 0) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (skillMenuOpen && e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedSkillIndex((index) => (index + 1) % matchingSkills.length);
                return;
              }
              if (skillMenuOpen && e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedSkillIndex((index) => (index - 1 + matchingSkills.length) % matchingSkills.length);
                return;
              }
              if (skillMenuOpen && e.key === "Escape") {
                e.preventDefault();
                setSkillMenuDismissed(true);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (skillMenuOpen) {
                  selectSkill(matchingSkills[selectedSkillIndex] ?? matchingSkills[0]);
                  return;
                }
                send();
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            aria-label="Attach files"
            accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.avif,.docx,.pdf,.txt,.md,.json,.csv,.tsv,.log,.xml,.yml,.yaml,.toml,.ini,.html,.css,.ts,.tsx,.js,.jsx,.py,.sh,.sql,.rs,.go,.java,.c,.cpp,.rb"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="rounded-xl bg-neutral-300 dark:bg-neutral-700 px-3 py-2 transition hover:bg-neutral-400 dark:hover:bg-neutral-600"
            onClick={() => fileInputRef.current?.click()}
            title="Attach an image, Word (.docx), PDF, or text file"
          >
            Attach{attachments.length + documents.length > 0 ? ` (${attachments.length + documents.length})` : ""}
          </button>
          <button
            className={`rounded-xl px-3 py-2 transition disabled:opacity-50 ${
              dictation.state === "recording"
                ? "bg-red-700 hover:bg-red-600"
                : "bg-neutral-300 dark:bg-neutral-700 hover:bg-neutral-400 dark:hover:bg-neutral-600"
            }`}
            onClick={dictation.toggle}
            disabled={dictation.state === "transcribing"}
            title="Dictate with Whisper"
          >
            {dictation.state === "recording"
              ? "Recording"
              : dictation.state === "transcribing"
                ? "…"
                : "Mic"}
          </button>
          {busy ? (
            <>
              <button
                className="rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white shadow transition hover:bg-emerald-500 disabled:opacity-50"
                onClick={() => send()}
                disabled={
                  interruptQueued ||
                  !settings.model ||
                  pendingAttachmentReads > 0 ||
                  (!input.trim() && attachments.length === 0 && documents.length === 0)
                }
                title="Stop the current response and send this message"
              >
                {interruptQueued ? "Queued" : "Interrupt"}
              </button>
              <button className="rounded-xl bg-red-700 px-4 py-2 font-medium text-white transition hover:bg-red-600" onClick={abort}>
                Stop
              </button>
            </>
          ) : (
            <button
              className="rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white shadow transition hover:bg-emerald-500 disabled:opacity-50"
              onClick={() => send()}
              disabled={!settings.model || pendingAttachmentReads > 0 || (composerMode === "mission" && (missionCapabilitiesLoading || selectedMissionCapabilities.length === 0))}
            >
              {composerMode === "mission" ? "Launch" : "Send"}
            </button>
          )}
        </div>
      </footer>
    </div>
    {selectedArtifact && task ? (
      <div className="absolute inset-0 z-20 min-w-0 lg:static lg:z-auto lg:w-[40%] lg:max-w-[40rem] lg:shrink-0">
        <ArtifactWorkspace key={`${current?.id}:${task.id}`} artifacts={task.artifacts ?? []} selectedId={selectedArtifact.id} onSelect={openArtifact} onClose={() => setArtifactSelection(null)} loadArtifact={loadStoredArtifact} onCopy={copyArtifact} />
      </div>
    ) : null}
    </div>
  );
}

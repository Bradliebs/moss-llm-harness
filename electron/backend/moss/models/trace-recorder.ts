// electron/backend/moss/models/trace-recorder.ts
//
// Opt-in local traces of every model call in a turn: the exact model-facing
// request and the streamed response. Traces make any past turn replayable
// against another model. They contain conversation and workspace content, so
// they are off by default, stay under Electron user data, and are pruned by
// age and count. Images are replaced with placeholders to bound size.

import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import type { AgentMessage, HarnessDecision, ProviderKind, ToolDefinition, TraceCall, TurnTrace, TurnTraceSummary } from "../../../../common/types";
import { writeFileAtomic } from "../persistence/atomic-file";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { endpointLabel } from "./capability-profile";

export const MAX_TRACES = 200;
export const TRACE_RETENTION_DAYS = 14;

function stripImages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (!message.images?.length) return message;
    const { images, ...rest } = message;
    return { ...rest, content: `${rest.content}\n[${images.length} image${images.length === 1 ? "" : "s"} omitted from trace]` };
  });
}

export class TraceRecorder {
  private readonly trace: TurnTrace;
  private readonly toolsByName = new Map<string, ToolDefinition>();

  constructor(meta: { id?: string; providerKind: ProviderKind; baseUrl: string; model: string; now?: () => Date }) {
    this.trace = {
      schemaVersion: 1,
      id: meta.id ?? randomUUID(),
      createdAt: (meta.now ?? (() => new Date()))().toISOString(),
      providerKind: meta.providerKind,
      endpoint: endpointLabel(meta.baseUrl),
      primaryModel: meta.model,
      tools: [],
      calls: [],
    };
  }

  get id(): string {
    return this.trace.id;
  }

  setOutcomeContext(context: NonNullable<TurnTrace["outcomeContext"]>): void {
    this.trace.outcomeContext = context;
  }

  noteDecision(decision: HarnessDecision): void {
    (this.trace.decisions ??= []).push(decision);
  }

  record(call: Omit<TraceCall, "index">, tools: readonly ToolDefinition[] = []): void {
    for (const tool of tools) if (!this.toolsByName.has(tool.name)) this.toolsByName.set(tool.name, tool);
    this.trace.calls.push({ ...call, index: this.trace.calls.length, request: { ...call.request, messages: stripImages(call.request.messages) } });
  }

  finish(details: Pick<TurnTrace, "outcome" | "escalatedTo" | "verification">): TurnTrace {
    return {
      ...this.trace,
      tools: [...this.toolsByName.values()],
      ...(details.outcome ? { outcome: details.outcome } : {}),
      ...(details.escalatedTo ? { escalatedTo: details.escalatedTo } : {}),
      ...(details.verification ? { verification: details.verification } : {}),
    };
  }
}

/** Records each request and its streamed response without changing either. */
export class RecordingProvider implements ChatProvider {
  readonly kind: string;

  constructor(
    private readonly inner: ChatProvider,
    private readonly recorder: TraceRecorder,
    private readonly now: () => number = Date.now,
    private readonly route?: { providerKind: ProviderKind; endpoint: string; constrained?: boolean },
  ) {
    this.kind = inner.kind;
  }

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const started = this.now();
    const response: TraceCall["response"] = { text: "", toolCalls: [] };
    let error: string | undefined;
    try {
      for await (const event of this.inner.streamChat(req, signal)) {
        if (event.type === "text-delta") response.text += event.text;
        else if (event.type === "tool-call") response.toolCalls.push(event.toolCall);
        else if (event.type === "usage") {
          response.usage = {
            ...response.usage,
            ...(event.usage.inputTokens !== undefined ? { inputTokens: event.usage.inputTokens } : {}),
            ...(event.usage.outputTokens !== undefined ? { outputTokens: event.usage.outputTokens } : {}),
          };
        }
        yield event;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      throw caught;
    } finally {
      this.recorder.record({
        startedAt: new Date(started).toISOString(),
        durationMs: this.now() - started,
        model: req.model,
        ...(this.route ? { providerKind: this.route.providerKind, endpoint: endpointLabel(this.route.endpoint) } : {}),
        ...(this.route?.constrained ? { constrained: true } : {}),
        request: {
          messages: req.messages,
          toolNames: (req.tools ?? []).map((tool) => tool.name),
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        },
        response,
        ...(error ? { error } : {}),
      }, req.tools);
    }
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels();
  }
}

function isTrace(value: unknown): value is TurnTrace {
  if (!value || typeof value !== "object") return false;
  const trace = value as Partial<TurnTrace>;
  return trace.schemaVersion === 1 && typeof trace.id === "string" && Array.isArray(trace.calls) && Array.isArray(trace.tools);
}

export function summarizeTrace(trace: TurnTrace): TurnTraceSummary {
  const firstUser = trace.calls[0]?.request.messages.find((message) => message.role === "user")?.content ?? "";
  const lastUser = [...(trace.calls[0]?.request.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? firstUser;
  return {
    id: trace.id,
    createdAt: trace.createdAt,
    primaryModel: trace.primaryModel,
    ...(trace.escalatedTo ? { escalatedTo: trace.escalatedTo } : {}),
    callCount: trace.calls.length,
    toolCallCount: trace.calls.reduce((sum, call) => sum + call.response.toolCalls.length, 0),
    ...(trace.outcome ? { outcome: trace.outcome } : {}),
    preview: lastUser.replace(/\s+/g, " ").trim().slice(0, 120),
  };
}

export class TraceStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly baseDir?: string, private readonly now: () => number = Date.now) {}

  dir(): string {
    return join(this.baseDir ?? userDataDir(), "turn-traces");
  }

  private file(id: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid trace id");
    return join(this.dir(), `${id}.json`);
  }

  save(trace: TurnTrace): Promise<void> {
    const run = this.queue.then(async () => {
      await writeFileAtomic(this.file(trace.id), JSON.stringify(trace));
      await this.prune();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get(id: string): Promise<TurnTrace | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file(id), "utf8"));
      return isTrace(value) ? value : null;
    } catch {
      return null;
    }
  }

  private async entries(): Promise<Array<{ name: string; mtimeMs: number }>> {
    let names: string[];
    try {
      names = (await readdir(this.dir())).filter((name) => /^[A-Za-z0-9-]+\.json$/.test(name));
    } catch {
      return [];
    }
    const entries = await Promise.all(names.map(async (name) => {
      try {
        return { name, mtimeMs: (await stat(join(this.dir(), name))).mtimeMs };
      } catch {
        return null;
      }
    }));
    return entries.filter((entry): entry is { name: string; mtimeMs: number } => !!entry).sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async list(limit = 50): Promise<TurnTraceSummary[]> {
    const summaries: TurnTraceSummary[] = [];
    for (const entry of (await this.entries()).slice(0, limit)) {
      const trace = await this.get(entry.name.replace(/\.json$/, ""));
      if (trace) summaries.push(summarizeTrace(trace));
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async count(): Promise<number> {
    return (await this.entries()).length;
  }

  async clear(): Promise<void> {
    await this.queue;
    await rm(this.dir(), { recursive: true, force: true });
  }

  private async prune(): Promise<void> {
    const cutoff = this.now() - TRACE_RETENTION_DAYS * 86_400_000;
    const entries = await this.entries();
    await Promise.all(entries
      .filter((entry, index) => index >= MAX_TRACES || entry.mtimeMs < cutoff)
      .map((entry) => rm(join(this.dir(), entry.name), { force: true })));
  }
}

export const traceStore = new TraceStore();

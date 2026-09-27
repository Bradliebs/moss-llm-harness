// electron/backend/moss/tools/types.ts

import type { EmailConfig, EmbedConfig, SttConfig } from "../../../../common/types";
import type { CheckpointRecorder } from "../checkpoint/checkpoint-store";
import type { PlanStore } from "../task/plan-store";
import type { WorkingStateStore } from "../governed/working-state";

export interface ToolContext {
  /** absolute sandbox root; empty string means no workspace selected */
  workspaceRoot: string;
  signal: AbortSignal;
  /** speech-to-text config, when configured, for the transcribe_audio tool */
  stt?: SttConfig;
  /** email config, when configured, for the send_email tool */
  email?: EmailConfig;
  /** embeddings config, when configured, for the search_codebase tool */
  embed?: EmbedConfig;
  /** when present, mutating tools snapshot a file's pre-image before changing
   *  it so the turn's edits can be reverted */
  checkpoint?: CheckpointRecorder;
  /** Trusted runtime state: true only when the user approved this exact tool
   *  call through the approval broker. Never sourced from model arguments. */
  approvalGranted?: boolean;
  /** when true, m_remember queues a proposal for human review instead of
   *  writing straight to durable memory */
  gatedMemory?: boolean;
  /** checklist state for the plan tool; scoped to the turn unless the caller
   *  supplies a longer-lived store */
  plan?: PlanStore;
  /** conversation working state for the working_state tool */
  workingState?: WorkingStateStore;
  /** enables hidden tools that match a need; present only when the turn narrowed its tools */
  findTools?: (need: string, signal: AbortSignal) => Promise<string>;
  /** runs a read-only subagent in its own conversation and resolves its report.
   *  Absent when the host has not wired delegation, or inside a subagent, where
   *  the depth cap withholds it to stop unbounded recursion. */
  delegate?: (task: string, signal: AbortSignal) => Promise<string>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  /** Images the tool wants the model to see, as data URLs
   *  (data:<mime>;base64,...). Provider adapters attach these alongside the
   *  tool result; models without vision simply receive the text. */
  images?: string[];
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object */
  parameters: Record<string, unknown>;
  /** Cooperative execution deadline. Declaring a deadline requires execute()
   *  to observe ctx.signal and settle after cancellation. */
  timeoutMs?: number;
  /** Declared read-only by a source the user trusts (an MCP server whose
   *  annotations they opted into); the permission policy runs it without a prompt. */
  readOnly?: boolean;
  /** Declared destructive; always prompts, even under auto-approve. */
  destructive?: boolean;
  dispose?(): Promise<void>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// electron/backend/moss/providers/types.ts

import type { AgentMessage, ToolDefinition } from "../../../../common/types";

export interface ChatRequest {
  model: string;
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** sampling temperature; omitted means the provider default */
  temperature?: number;
}

/** Low-level provider stream events. The agent runner accumulates these into the
 *  renderer-facing `MossEvent` stream and the tool-execution loop. */
export type ProviderStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCall: { id: string; name: string; arguments: string } }
  | { type: "usage"; usage: { inputTokens?: number; outputTokens?: number } };

export interface ChatProvider {
  readonly kind: string;
  streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  listModels(): Promise<string[]>;
}

/** Thrown by a provider when an HTTP request fails. `status` carries the
 *  response status code when one was received, letting the runner distinguish a
 *  transient failure (network-level, or 5xx/429) from a permanent one (bad auth,
 *  model, or request) so it only retries the former. */
export class ProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

// electron/backend/moss/models/escalation.ts
//
// Model routing with escalation. The turn starts on the selected model; when
// the harness rejects its work repeatedly (failed verification, a refused
// completion, or a failed tool call), later rounds switch to a stronger escalation model on the same
// provider connection. The monitor only reads harness events, so the model
// never decides for itself whether it deserves escalation.

import type { MossEvent } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";

export const DEFAULT_ESCALATE_AFTER = 2;

export class EscalatingProvider implements ChatProvider {
  readonly kind: string;
  private escalated = false;

  constructor(
    private readonly inner: ChatProvider,
    private readonly primaryModel: string,
    private readonly escalationModel: string,
  ) {
    this.kind = inner.kind;
  }

  get isEscalated(): boolean {
    return this.escalated;
  }

  /** Switch subsequent primary-model requests to the escalation model. Returns
   *  false when already escalated. */
  escalate(): boolean {
    if (this.escalated) return false;
    this.escalated = true;
    return true;
  }

  streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const routed = this.escalated && req.model === this.primaryModel ? { ...req, model: this.escalationModel } : req;
    return this.inner.streamChat(routed, signal);
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels();
  }
}

/** Counts harness rejections of the model's work. */
export class EscalationMonitor {
  private rejections = 0;
  private fired = false;

  constructor(private readonly threshold = DEFAULT_ESCALATE_AFTER) {}

  get count(): number {
    return this.rejections;
  }

  /** Returns true exactly once, when the rejection count reaches the threshold. */
  observe(event: MossEvent): boolean {
    // A failed tool call counts too, unless the user or policy refused it: those
    // are decisions about permission, not evidence the model is struggling.
    const rejected = (event.type === "verification" && !event.ok)
      || (event.type === "round-end" && event.finish === "rejected")
      || (event.type === "tool-result" && !event.ok && !/^(?:User denied|Denied by policy|Tool call denied|Protected path:)/.test(event.content));
    if (!rejected || this.fired) return false;
    this.rejections += 1;
    if (this.rejections < Math.max(1, this.threshold)) return false;
    this.fired = true;
    return true;
  }
}

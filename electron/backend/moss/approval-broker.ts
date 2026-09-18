// electron/backend/moss/approval-broker.ts
//
// Bridges the async agent loop (main process) and the user's approve/deny click
// (renderer). The runner awaits `request(callId)`; the IPC handler calls
// `resolve(callId, response)` when the user responds.

import type { ToolApprovalResponse } from "../../../common/types";

export class ApprovalBroker {
  private readonly pending = new Map<string, (response: ToolApprovalResponse) => void>();

  pendingCallId(): string | undefined {
    return this.pending.keys().next().value;
  }

  request(callId: string, signal?: AbortSignal): Promise<ToolApprovalResponse> {
    if (signal?.aborted) return Promise.resolve({ approved: false, comment: "Turn aborted" });
    return new Promise<ToolApprovalResponse>((resolve) => {
      const onAbort = () => this.resolve(callId, { approved: false, comment: "Turn aborted" });
      this.pending.set(callId, (response) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(response);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  resolve(callId: string, response: ToolApprovalResponse): void {
    const fn = this.pending.get(callId);
    if (fn) {
      this.pending.delete(callId);
      fn(response);
    }
  }

  /** Deny everything still waiting (used on abort). */
  denyAll(comment?: string): void {
    const response: ToolApprovalResponse = { approved: false, ...(comment ? { comment } : {}) };
    for (const fn of this.pending.values()) fn(response);
    this.pending.clear();
  }
}

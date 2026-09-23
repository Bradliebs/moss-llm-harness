import type { ChatEventPayload, TaskSnapshot } from "@common/types";
import { useSyncExternalStore } from "react";

let snapshots: TaskSnapshot[] = [];
let started = false;
let stopEvents: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function replace(next: TaskSnapshot[]): void {
  snapshots = [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  emit();
}

function merge(snapshot: TaskSnapshot): void {
  const existing = snapshots.find((candidate) => candidate.id === snapshot.id);
  if (existing && existing.revision > snapshot.revision) return;
  replace([snapshot, ...snapshots.filter((candidate) => candidate.id !== snapshot.id)]);
}

function start(): void {
  if (started || typeof window === "undefined" || !window.moss?.task) return;
  started = true;
  void refreshTaskRuns().catch(() => undefined);
  stopEvents = window.moss.chat?.onEvent?.((payload: ChatEventPayload) => {
    if (payload.event.type === "task-state") merge(payload.event.task);
  }) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopEvents) {
      stopEvents();
      stopEvents = null;
      started = false;
    }
  };
}

export async function refreshTaskRuns(): Promise<void> {
  if (typeof window === "undefined" || !window.moss?.task) return;
  replace(await window.moss.task.list());
}

export function useTaskRuns(): TaskSnapshot[] {
  return useSyncExternalStore(subscribe, () => snapshots, () => snapshots);
}

export function isRunActive(snapshot: TaskSnapshot | undefined): boolean {
  return !!snapshot && !["completed", "failed", "cancelled"].includes(snapshot.state);
}

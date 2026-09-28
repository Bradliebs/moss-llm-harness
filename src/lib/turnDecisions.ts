// src/lib/turnDecisions.ts
//
// Harness decisions per turn (scaffolding, constrained output, voting, repairs,
// routing, escalation, approvals, stalls), kept for the Why timeline on each
// reply. Only the most recent turns are kept.

import type { HarnessDecision } from "@common/types";

import { createPersistentStore } from "./persistentStore";

const MAX_TURNS = 200;
const MAX_PER_TURN = 60;

type DecisionMap = Record<string, HarnessDecision[]>;

export const turnDecisionsStore = createPersistentStore<DecisionMap>("moss.turnDecisions", {});

export function recordTurnDecision(turnId: string, decision: HarnessDecision): void {
  turnDecisionsStore.update((prev) => {
    const list = [...(prev[turnId] ?? []), decision].slice(-MAX_PER_TURN);
    const next: DecisionMap = { ...prev, [turnId]: list };
    const ids = Object.keys(next);
    // Insertion order is chronological, so the oldest turns are dropped first.
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TURNS))) delete next[id];
    return next;
  });
}

export function useTurnDecisions(turnId: string): HarnessDecision[] {
  return turnDecisionsStore.use()[turnId] ?? [];
}

/** Decisions across several turns, such as every attempt of a mission, in order. */
export function useDecisionsFor(turnIds: readonly string[]): HarnessDecision[] {
  const all = turnDecisionsStore.use();
  return [...new Set(turnIds)].flatMap((id) => all[id] ?? []);
}

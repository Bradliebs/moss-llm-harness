// src/components/TurnDecisions.tsx
//
// "Why?" for a finished reply: every decision the harness made during the
// turn, in order, with a link to the setting that controls it.

import type { HarnessDecisionKind } from "@common/types";

import type { SettingsCategoryId } from "../lib/guidance";
import { useDecisionsFor } from "../lib/turnDecisions";

const LABELS: Record<HarnessDecisionKind, string> = {
  scaffold: "Adapted",
  constrain: "Constrained",
  vote: "Voted",
  repair: "Repaired",
  "find-tool": "Tools",
  route: "Routed",
  escalate: "Escalated",
  gate: "Asked you",
  stall: "Stalled",
  budget: "Budget",
  quarantine: "Quarantined",
  procedure: "Procedure",
  "live-score": "Live score",
  context: "Context",
  critic: "Critic",
};

const SETTINGS_LABELS: Partial<Record<SettingsCategoryId, string>> = {
  models: "Models",
  safety: "Safety",
  tools: "Tools",
  knowledge: "Knowledge",
};

function category(value: string | undefined): SettingsCategoryId | undefined {
  return value && value in SETTINGS_LABELS ? value as SettingsCategoryId : undefined;
}

/** Pass one turn id for a reply, or every turn id of a mission run. */
export function TurnDecisions({ turnId, turnIds, onOpenSettings }: { turnId?: string; turnIds?: readonly string[]; onOpenSettings?: (category?: SettingsCategoryId) => void }): React.ReactElement | null {
  const decisions = useDecisionsFor(turnIds ?? (turnId ? [turnId] : []));
  if (decisions.length === 0) return null;
  return (
    <details className="mt-1.5 text-[11px] text-neutral-700 dark:text-neutral-200">
      <summary className="cursor-pointer text-neutral-600 dark:text-neutral-300">
        Why? {decisions.length} harness decision{decisions.length === 1 ? "" : "s"}
      </summary>
      <ol className="mt-1 space-y-0.5 pl-1" aria-label="Harness decisions for this turn">
        {decisions.map((decision, index) => (
          <li key={index} className="flex flex-wrap items-baseline gap-1.5">
            <span className="rounded bg-neutral-200 px-1 font-medium dark:bg-neutral-800">{LABELS[decision.kind] ?? decision.kind}</span>
            <span>{decision.summary}</span>
            {decision.detail ? <span className="text-neutral-600 dark:text-neutral-300">({decision.detail})</span> : null}
            {category(decision.settings) && onOpenSettings ? (
              <button type="button" className="underline" onClick={() => onOpenSettings(category(decision.settings))}>
                {SETTINGS_LABELS[category(decision.settings)!]} settings
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

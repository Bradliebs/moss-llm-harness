// src/components/LiveScoreSummary.tsx
//
// How the selected model has done on your own work: verified outcomes per task
// kind, the resulting success interval, and whether live evidence has moved
// its tier away from the probe tier.

import { useEffect, useState } from "react";

import { liveScore, MIN_GRADED_FOR_TIER, modelKey } from "@common/live-scores";
import type { ModelCapabilityProfile, ModelPerformanceEntry, ModelTaskKind, ProviderKind } from "@common/types";

const KINDS: ReadonlyArray<{ kind: ModelTaskKind; label: string }> = [
  { kind: "coding", label: "Coding" },
  { kind: "research", label: "Research" },
  { kind: "automation", label: "Automation" },
  { kind: "mission", label: "Missions" },
  { kind: "chat", label: "Chat" },
];

function percent(value: number | undefined): string {
  return value === undefined ? "–" : `${Math.round(value * 100)}%`;
}

export function LiveScoreSummary({
  kind,
  baseUrl,
  model,
  profile,
}: {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  profile: ModelCapabilityProfile | null;
}): React.ReactElement | null {
  const [entries, setEntries] = useState<ModelPerformanceEntry[] | null>(null);
  const bridge = window.moss?.model;

  useEffect(() => {
    let cancelled = false;
    void bridge?.performance?.()
      .then((list) => { if (!cancelled) setEntries(list.filter((entry) => modelKey(entry.providerKind, entry.endpoint, entry.model) === modelKey(kind, baseUrl, model))); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [bridge, kind, baseUrl, model]);

  if (!entries || !model) return null;
  const overall = liveScore(entries, "all", profile?.tier);
  const rows = KINDS.map((item) => ({ ...item, score: liveScore(entries, item.kind) })).filter((item) => item.score.runs > 0 || item.score.graded > 0);
  return (
    <div className="space-y-1 rounded border border-neutral-200 p-3 text-xs dark:border-neutral-800" aria-label="Live results on your work">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-neutral-900 dark:text-neutral-100">Live results on your work</span>
        {overall.graded > 0 ? (
          <span className="text-neutral-700 dark:text-neutral-200">
            {percent(overall.successRate)} verified success over {Math.round(overall.graded)} graded runs (likely {percent(overall.lowerBound)}–{percent(overall.upperBound)})
          </span>
        ) : null}
        {entries.length > 0 ? (
          <button
            type="button"
            className="ml-auto underline"
            onClick={() => void bridge?.clearPerformance?.(kind, baseUrl, model).then(() => setEntries([]))}
          >
            Forget results
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="text-neutral-600 dark:text-neutral-300">
          No graded work yet. Moss records verified passes and failures, harness rejections, and stalls from your turns; the
          model&apos;s own claims never count.
        </p>
      ) : (
        <table className="w-full">
          <caption className="sr-only">Live results by task kind</caption>
          <thead>
            <tr className="text-left text-neutral-600 dark:text-neutral-300">
              <th scope="col" className="pr-2 font-medium">Task</th>
              <th scope="col" className="pr-2 font-medium">Turns</th>
              <th scope="col" className="pr-2 font-medium">Graded</th>
              <th scope="col" className="font-medium">Verified success</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.kind} className="text-neutral-800 dark:text-neutral-100">
                <td className="pr-2">{row.label}</td>
                <td className="pr-2 tabular-nums">{row.score.runs}</td>
                <td className="pr-2 tabular-nums">{Math.round(row.score.graded * 10) / 10}</td>
                <td className="tabular-nums">{percent(row.score.successRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {profile && overall.effectiveTier && overall.effectiveTier !== profile.tier ? (
        <p className="text-neutral-800 dark:text-neutral-100">
          Adaptation treats this model as <strong>{overall.effectiveTier}</strong> rather than its probe tier ({profile.tier}),
          based on your results.
        </p>
      ) : profile ? (
        <p className="text-neutral-600 dark:text-neutral-300">
          After {MIN_GRADED_FOR_TIER} graded runs, clear results can move the tier used for adaptation one step from the probe
          tier.
        </p>
      ) : null}
    </div>
  );
}

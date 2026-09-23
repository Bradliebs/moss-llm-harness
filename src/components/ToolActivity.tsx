import { useState } from "react";

import type { ToolAuditEntry } from "../lib/sessions";

interface ToolActivityProps {
  total: number;
  autoApproved: number;
  entries: ToolAuditEntry[];
}

function riskRank(risk: ToolAuditEntry["risk"]): number {
  return risk === "destructive" ? 0 : risk === "mutating" ? 1 : 2;
}

export function ToolActivity({ total, autoApproved, entries }: ToolActivityProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [hideReadonly, setHideReadonly] = useState(false);
  const [sortByRisk, setSortByRisk] = useState(false);
  if (total === 0) return null;

  const visible = (hideReadonly ? entries.filter((entry) => entry.risk !== "readonly") : entries.slice())
    .sort((a, b) => sortByRisk ? riskRank(a.risk) - riskRank(b.risk) : 0);

  return (
    <span className="relative">
      <button
        type="button"
        className={autoApproved > 0 ? "text-xs text-amber-400/80 hover:underline" : "text-xs text-neutral-400 dark:text-neutral-600 hover:underline"}
        title={`${total} tool call(s) ran in this conversation; ${autoApproved} ran without asking because auto-approve was on. Click to review.`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {total} tool{total === 1 ? "" : "s"}
        {autoApproved > 0 ? ` (${autoApproved} auto)` : ""}
      </button>
      {open ? (
        <div className="absolute left-0 top-5 z-20 max-h-64 w-72 overflow-y-auto rounded border border-neutral-300 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Tool activity</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setHideReadonly((value) => !value)}
                className={hideReadonly
                  ? "rounded bg-neutral-300 px-1 text-[10px] uppercase text-neutral-800 dark:bg-neutral-700 dark:text-neutral-200"
                  : "rounded bg-neutral-200 px-1 text-[10px] uppercase text-neutral-600 hover:text-neutral-800 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"}
              >
                Hide readonly
              </button>
              <button
                type="button"
                onClick={() => setSortByRisk((value) => !value)}
                className={sortByRisk
                  ? "rounded bg-neutral-300 px-1 text-[10px] uppercase text-neutral-800 dark:bg-neutral-700 dark:text-neutral-200"
                  : "rounded bg-neutral-200 px-1 text-[10px] uppercase text-neutral-600 hover:text-neutral-800 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"}
              >
                By risk
              </button>
            </div>
          </div>
          <ul className="space-y-1">
            {visible.map((entry, index) => (
              <li key={`${entry.callId}-${index}`} className="flex items-center gap-2 text-xs">
                <span className="flex-1 truncate font-mono text-neutral-800 dark:text-neutral-200">{entry.name}</span>
                <span className={
                  entry.risk === "destructive"
                    ? "rounded bg-red-900/60 px-1 text-[10px] uppercase text-red-300"
                    : entry.risk === "mutating"
                      ? "rounded bg-amber-900/60 px-1 text-[10px] uppercase text-amber-300"
                      : "rounded bg-neutral-200 px-1 text-[10px] uppercase text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                }>
                  {entry.risk}
                </span>
                {entry.autoApproved ? (
                  <span className="rounded bg-amber-900/40 px-1 text-[10px] uppercase text-amber-300">auto</span>
                ) : null}
                {entry.durationMs != null ? (
                  <span className="font-mono text-[10px] tabular-nums text-neutral-500 dark:text-neutral-400">{entry.durationMs}ms</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  );
}

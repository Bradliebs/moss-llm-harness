// src/components/ProceduresSection.tsx
//
// Learned procedures in the Library: what each one runs, where it came from,
// its verified record, and controls to trust, demote, restore, or delete it.

import { useCallback, useEffect, useState } from "react";

import type { Procedure, ProcedureStatus } from "@common/types";

const STATUS_CLASS: Record<ProcedureStatus, string> = {
  trusted: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100",
  candidate: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
  demoted: "bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200",
};

function argText(value: Procedure["steps"][number]["args"][string]): string {
  return "slot" in value ? `<${value.slot}>` : JSON.stringify(value.const).slice(0, 60);
}

export function ProceduresSection(): React.ReactElement | null {
  const bridge = window.moss?.procedures;
  const [procedures, setProcedures] = useState<Procedure[]>([]);

  const refresh = useCallback(async () => {
    if (bridge) setProcedures(await bridge.list());
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!bridge) return null;
  const button = "rounded px-1.5 py-0.5 text-[11px] text-neutral-700 underline dark:text-neutral-200";
  return (
    <section className="flex min-h-0 flex-col" aria-labelledby="procedures-heading">
      <h2 id="procedures-heading" className="mb-1 text-sm font-semibold text-neutral-800 dark:text-neutral-200">Learned procedures</h2>
      <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-300">
        A tool sequence that passed verification in three turns becomes a procedure. The model fills only its slots; each step
        runs with the usual approvals, and a failed step hands control back. Procedures become trusted after three verified
        uses and are demoted after two failures in a row.
      </p>
      {procedures.length === 0 ? (
        <p className="text-xs text-neutral-600 dark:text-neutral-400">None yet. They are learned from repeated, verified work.</p>
      ) : (
        <ul className="space-y-2 overflow-y-auto">
          {procedures.map((procedure) => (
            <li key={procedure.id} className="rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{procedure.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${STATUS_CLASS[procedure.status]}`}>{procedure.status}</span>
                <span className="text-neutral-600 dark:text-neutral-300">
                  {procedure.successCount} verified use{procedure.successCount === 1 ? "" : "s"} · {procedure.failureCount} failed · learned from {procedure.learnedFrom} turns
                </span>
              </div>
              <p className="mt-0.5 text-neutral-700 dark:text-neutral-200">{procedure.description}</p>
              <ol className="mt-1 list-decimal pl-5 font-mono text-[11px] text-neutral-700 dark:text-neutral-200">
                {procedure.steps.map((step, index) => (
                  <li key={index}>{step.tool}({Object.entries(step.args).map(([key, value]) => `${key}=${argText(value)}`).join(", ")})</li>
                ))}
              </ol>
              <div className="mt-1 flex gap-2">
                {procedure.status !== "trusted" ? (
                  <button type="button" className={button} onClick={() => void bridge.setStatus(procedure.id, "trusted").then(setProcedures)}>Trust</button>
                ) : null}
                {procedure.status !== "demoted" ? (
                  <button type="button" className={button} onClick={() => void bridge.setStatus(procedure.id, "demoted").then(setProcedures)}>Demote</button>
                ) : (
                  <button type="button" className={button} onClick={() => void bridge.setStatus(procedure.id, "candidate").then(setProcedures)}>Restore</button>
                )}
                <button type="button" className={`${button} text-red-700 dark:text-red-300`} onClick={() => void bridge.remove(procedure.id).then(setProcedures)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

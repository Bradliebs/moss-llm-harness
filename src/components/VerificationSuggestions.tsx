// src/components/VerificationSuggestions.tsx
//
// Offers verification commands inferred from the workspace's project files.
// Nothing is enabled until the user accepts a suggestion, which adds it to the
// enabled verification commands and binds it to the mission contract.

import { useEffect, useState } from "react";

import type { VerificationSuggestion } from "@common/types";

export function VerificationSuggestions({
  workspaceRoot,
  configuredCommands,
  onAccept,
}: {
  workspaceRoot: string | null | undefined;
  configuredCommands: string[];
  onAccept: (command: string) => void;
}): React.ReactElement | null {
  const [suggestions, setSuggestions] = useState<VerificationSuggestion[]>([]);

  useEffect(() => {
    let cancelled = false;
    const suggest = window.moss?.workspace?.suggestVerification;
    if (!workspaceRoot || !suggest) {
      setSuggestions([]);
      return;
    }
    void suggest(workspaceRoot)
      .then((result) => { if (!cancelled) setSuggestions(result); })
      .catch(() => { if (!cancelled) setSuggestions([]); });
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  const pending = suggestions.filter((suggestion) => !configuredCommands.includes(suggestion.command));
  if (pending.length === 0) return null;
  return (
    <section className="mt-2 rounded border border-sky-300/60 bg-sky-50 p-2 text-[11px] dark:border-sky-900 dark:bg-sky-950/40" aria-label="Suggested verification">
      <p className="font-medium text-sky-900 dark:text-sky-100">Suggested from this workspace (not yet enabled)</p>
      <ul className="mt-1 space-y-1">
        {pending.map((suggestion) => (
          <li key={suggestion.command} className="flex flex-wrap items-center gap-2 text-neutral-700 dark:text-neutral-200">
            <code>{suggestion.command}</code>
            <span className="text-neutral-600 dark:text-neutral-300">from {suggestion.source}</span>
            <button
              type="button"
              className="ml-auto rounded border border-sky-400 px-1.5 py-0.5 text-sky-900 hover:bg-sky-100 dark:border-sky-700 dark:text-sky-100 dark:hover:bg-sky-900"
              onClick={() => onAccept(suggestion.command)}
              aria-label={`Use ${suggestion.command} for verification`}
            >
              Use
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Bind an accepted command to the first mandatory criterion that lacks a
 *  verification method or already uses commands. */
export function bindSuggestedCommand<T extends { mandatory: boolean; verification?: { kind: string; commands?: string[] } }>(
  criteria: T[],
  command: string,
): T[] {
  const index = criteria.findIndex((criterion) => criterion.mandatory && (!criterion.verification || criterion.verification.kind === "commands"));
  if (index < 0) return criteria;
  return criteria.map((criterion, criterionIndex) => {
    if (criterionIndex !== index) return criterion;
    const commands = criterion.verification?.kind === "commands" ? criterion.verification.commands ?? [] : [];
    return { ...criterion, verification: { kind: "commands", commands: commands.includes(command) ? commands : [...commands, command] } };
  });
}

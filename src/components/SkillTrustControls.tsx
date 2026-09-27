// src/components/SkillTrustControls.tsx
//
// Shows a skill's earned trust (candidate, trusted, demoted), its verified
// record, and version history, with user overrides and rollback.

import { useState } from "react";

import type { Skill, SkillTrustStatus } from "@common/types";

const BADGE: Record<SkillTrustStatus, string> = {
  trusted: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100",
  candidate: "bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100",
  demoted: "bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100",
};

export function SkillTrustControls({ skill, onChanged }: { skill: Skill; onChanged: () => void }): React.ReactElement | null {
  const [versions, setVersions] = useState<Array<{ version: number; savedAt: string }> | null>(null);
  const trust = skill.trust;
  if (!trust) return null;

  async function setStatus(status: SkillTrustStatus): Promise<void> {
    await window.moss.skills.setTrust?.(skill.id, status);
    onChanged();
  }

  async function showVersions(): Promise<void> {
    setVersions(versions ? null : (await window.moss.skills.history?.(skill.id)) ?? []);
  }

  async function rollback(version: number): Promise<void> {
    await window.moss.skills.rollback?.(skill.id, version);
    setVersions(null);
    onChanged();
  }

  const action = "text-xs text-neutral-700 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white";
  return (
    <div className="mt-1 pl-6 text-xs text-neutral-700 dark:text-neutral-300" aria-label={`Trust for ${skill.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${BADGE[trust.status]}`}>{trust.status}</span>
        {trust.stale ? <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] uppercase dark:bg-neutral-800">stale</span> : null}
        <span>v{trust.version} · {trust.verifiedSuccesses} verified · {trust.failures} failed · {trust.uses} uses</span>
        <span className="text-neutral-600 dark:text-neutral-400">{trust.statusReason}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-3">
        {trust.status !== "trusted" ? <button type="button" className={action} onClick={() => void setStatus("trusted")}>Trust</button> : null}
        {trust.status === "demoted" ? <button type="button" className={action} onClick={() => void setStatus("candidate")}>Restore as candidate</button> : null}
        {trust.status !== "demoted" ? <button type="button" className={action} onClick={() => void setStatus("demoted")}>Demote</button> : null}
        {trust.version > 1 ? <button type="button" className={action} aria-expanded={versions !== null} onClick={() => void showVersions()}>Versions</button> : null}
      </div>
      {versions ? (
        <ul className="mt-1 space-y-0.5" aria-label={`Versions of ${skill.name}`}>
          {versions.map((item) => (
            <li key={item.version} className="flex items-center gap-2">
              <span>v{item.version} · {new Date(item.savedAt).toLocaleString()}</span>
              {item.version !== trust.version ? (
                <button type="button" className={action} onClick={() => void rollback(item.version)}>Roll back to v{item.version}</button>
              ) : <span className="text-neutral-500 dark:text-neutral-400">current</span>}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

import { checkCriticIndependence, workerModels } from "@common/model-family";
import type { TaskAcceptanceCriterion, TaskCriterionVerification } from "@common/types";

import type { MossSettings } from "../lib/settings";

export interface CriticSetup {
  model?: string;
  workers: string[];
}

/** The configured critic and the models it must be independent of. */
export function criticSetup(settings: Pick<MossSettings, "model" | "fastModel" | "fastRoute" | "escalationModel" | "escalationRoute" | "criticModel" | "criticRoute">): CriticSetup {
  const model = settings.criticRoute?.model ?? settings.criticModel;
  return { ...(model ? { model } : {}), workers: workerModels(settings) };
}

export interface MissionContract {
  criteria: TaskAcceptanceCriterion[];
  constraints: string;
  assumptions: string;
}

interface MissionReviewProps {
  contract: MissionContract;
  configuredCommands: string[];
  onChange: (contract: MissionContract) => void;
}

function updateVerification(
  criterion: TaskAcceptanceCriterion,
  kind: TaskCriterionVerification["kind"],
  configuredCommands: string[],
): TaskAcceptanceCriterion {
  const verification: TaskCriterionVerification =
    kind === "commands"
      ? { kind, commands: configuredCommands.slice(0, 1) }
      : kind === "file-exists"
        ? { kind, path: "" }
        : kind === "file-contains"
          ? { kind, path: "", substring: "" }
          : kind === "critic"
            ? { kind, rubric: "", paths: [] }
            : { kind, url: "", expectedStatus: 200 };
  return { ...criterion, verification };
}

export function missionContractIssues(
  contract: MissionContract,
  configuredCommands: string[],
  workspaceRoot?: string | null,
  critic?: CriticSetup,
): string[] {
  const issues: string[] = [];
  const mandatory = contract.criteria.filter((criterion) => criterion.mandatory);
  if (mandatory.length === 0) issues.push("Add at least one mandatory acceptance criterion.");
  const ids = new Set<string>();
  for (const [index, criterion] of contract.criteria.entries()) {
    const label = `Criterion ${index + 1}`;
    if (!criterion.id.trim() || ids.has(criterion.id)) issues.push(`${label} needs a unique identifier.`);
    ids.add(criterion.id);
    if (!criterion.description.trim()) issues.push(`${label} needs a measurable outcome.`);
    const verification = criterion.verification;
    if (!verification) {
      if (criterion.mandatory) issues.push(`${label} needs a verification method.`);
      continue;
    }
    if ((verification.kind === "commands" || verification.kind.startsWith("file-")) && !workspaceRoot) {
      issues.push(`${label} needs a selected workspace for ${verification.kind === "commands" ? "command" : "file"} verification.`);
    }
    if (verification.kind === "commands") {
      const commands = verification.commands.map((command) => command.trim()).filter(Boolean);
      if (commands.length === 0) issues.push(`${label} needs at least one enabled verification command.`);
      if (commands.some((command) => !configuredCommands.includes(command))) {
        issues.push(`${label} uses a command that is not enabled in Settings.`);
      }
    } else if (verification.kind === "file-exists" && !verification.path.trim()) {
      issues.push(`${label} needs a workspace-relative path.`);
    } else if (verification.kind === "file-contains" && (!verification.path.trim() || !verification.substring.trim())) {
      issues.push(`${label} needs a path and expected text.`);
    } else if (verification.kind === "critic") {
      const independence = checkCriticIndependence(critic?.model, critic?.workers ?? []);
      if (!independence.ok) issues.push(`${label}: ${independence.reason}`);
      if ((verification.paths ?? []).some((path) => path.trim()) && !workspaceRoot) issues.push(`${label} needs a selected workspace for the files the critic reviews.`);
      if ((verification.paths ?? []).filter((path) => path.trim()).length > 5) issues.push(`${label} can name at most five files for the critic.`);
    } else if (verification.kind === "http") {
      try {
        const url = new URL(verification.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported");
      } catch {
        issues.push(`${label} needs a valid HTTP or HTTPS URL.`);
      }
      if (
        verification.expectedStatus !== undefined
        && (!Number.isInteger(verification.expectedStatus)
          || verification.expectedStatus < 100
          || verification.expectedStatus > 599)
      ) {
        issues.push(`${label} needs an HTTP status between 100 and 599.`);
      }
    }
  }
  return [...new Set(issues)];
}

export function MissionContractEditor({
  contract,
  configuredCommands,
  onChange,
}: MissionReviewProps): React.ReactElement {
  function updateCriterion(index: number, update: (criterion: TaskAcceptanceCriterion) => TaskAcceptanceCriterion): void {
    onChange({
      ...contract,
      criteria: contract.criteria.map((criterion, criterionIndex) =>
        criterionIndex === index ? update(criterion) : criterion),
    });
  }

  return (
    <section className="space-y-3" aria-labelledby="mission-contract-heading">
      <div>
        <h3 id="mission-contract-heading" className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
          Outcome contract
        </h3>
        <p className="mt-0.5 text-[11px] text-neutral-600 dark:text-neutral-400">
          Every mandatory outcome needs a host-run verification method, or an independent critic, before launch.
        </p>
      </div>
      <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
        {contract.criteria.map((criterion, index) => {
          const verification = criterion.verification;
          return (
            <fieldset key={criterion.id} className="space-y-2 rounded border border-neutral-200 p-2 dark:border-neutral-700">
              <legend className="px-1 text-[11px] font-medium text-neutral-600 dark:text-neutral-300">Criterion {index + 1}</legend>
              <label className="block text-[11px] text-neutral-600 dark:text-neutral-300">
                Measurable outcome
                <input
                  aria-label={`Acceptance criterion ${index + 1}`}
                  className="mt-0.5 w-full rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                  value={criterion.description}
                  onChange={(event) => updateCriterion(index, (current) => ({ ...current, description: event.target.value }))}
                  placeholder="For example: The requested report exists and contains the final recommendation"
                />
              </label>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <label className="text-[11px] text-neutral-600 dark:text-neutral-300">
                  Verification method
                  <select
                    aria-label={`Verification method ${index + 1}`}
                    className="mt-0.5 w-full rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                    value={verification?.kind ?? ""}
                    onChange={(event) => updateCriterion(
                      index,
                      (current) => updateVerification(
                        current,
                        event.target.value as TaskCriterionVerification["kind"],
                        configuredCommands,
                      ),
                    )}
                  >
                    <option value="">Select verification...</option>
                    <option value="commands">Configured commands</option>
                    <option value="file-exists">File or folder exists</option>
                    <option value="file-contains">File contains text</option>
                    <option value="http">HTTP response</option>
                    <option value="critic">Independent critic review</option>
                  </select>
                </label>
                {contract.criteria.length > 1 ? (
                  <button
                    type="button"
                    className="self-end rounded px-2 py-1 text-xs text-red-700 hover:bg-red-500/10 dark:text-red-400"
                    onClick={() => onChange({
                      ...contract,
                      criteria: contract.criteria.filter((_, criterionIndex) => criterionIndex !== index),
                    })}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {verification?.kind === "commands" ? (
                configuredCommands.length > 0 ? (
                  <div className="space-y-1" aria-label={`Verification commands ${index + 1}`}>
                    {configuredCommands.map((command) => (
                      <label key={command} className="flex items-start gap-2 text-[11px] text-neutral-600 dark:text-neutral-300">
                        <input
                          type="checkbox"
                          checked={verification.commands.includes(command)}
                          onChange={(event) => updateCriterion(index, (current) => {
                            if (current.verification?.kind !== "commands") return current;
                            const commands = event.target.checked
                              ? [...current.verification.commands, command]
                              : current.verification.commands.filter((value) => value !== command);
                            return { ...current, verification: { kind: "commands", commands } };
                          })}
                        />
                        <code className="break-all">{command}</code>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p role="alert" className="text-[11px] text-amber-700 dark:text-amber-300">
                    Enable verification commands in Settings or choose a file or HTTP check.
                  </p>
                )
              ) : verification?.kind === "file-exists" ? (
                <label className="block text-[11px] text-neutral-600 dark:text-neutral-300">
                  Workspace-relative path
                  <input
                    aria-label={`Verification path ${index + 1}`}
                    className="mt-0.5 w-full rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                    value={verification.path}
                    onChange={(event) => updateCriterion(index, (current) => ({
                      ...current,
                      verification: { kind: "file-exists", path: event.target.value },
                    }))}
                    placeholder="dist/report.json"
                  />
                </label>
              ) : verification?.kind === "file-contains" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-[11px] text-neutral-600 dark:text-neutral-300">
                    Workspace-relative path
                    <input
                      aria-label={`Verification path ${index + 1}`}
                      className="mt-0.5 w-full rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                      value={verification.path}
                      onChange={(event) => updateCriterion(index, (current) => ({
                        ...current,
                        verification: {
                          kind: "file-contains",
                          path: event.target.value,
                          substring: current.verification?.kind === "file-contains" ? current.verification.substring : "",
                        },
                      }))}
                    />
                  </label>
                  <label className="text-[11px] text-neutral-600 dark:text-neutral-300">
                    Expected text
                    <input
                      aria-label={`Expected text ${index + 1}`}
                      className="mt-0.5 w-full rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                      value={verification.substring}
                      onChange={(event) => updateCriterion(index, (current) => ({
                        ...current,
                        verification: {
                          kind: "file-contains",
                          path: current.verification?.kind === "file-contains" ? current.verification.path : "",
                          substring: event.target.value,
                        },
                      }))}
                    />
                  </label>
                </div>
              ) : verification?.kind === "critic" ? (
                <div className="space-y-1.5">
                  <label className="block text-[11px] text-neutral-600 dark:text-neutral-300">
                    How the critic should judge it (optional)
                    <textarea
                      aria-label={`Critic rubric ${index + 1}`}
                      className="mt-0.5 h-12 w-full resize-y rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                      value={verification.rubric ?? ""}
                      onChange={(event) => updateCriterion(index, (current) => ({
                        ...current,
                        verification: { kind: "critic", rubric: event.target.value, paths: current.verification?.kind === "critic" ? current.verification.paths ?? [] : [] },
                      }))}
                      placeholder="For example: names at least three vendors with prices and a source for each"
                    />
                  </label>
                  <label className="block text-[11px] text-neutral-600 dark:text-neutral-300">
                    Workspace files to review, comma-separated (optional)
                    <input
                      aria-label={`Critic files ${index + 1}`}
                      className="mt-0.5 w-full rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                      value={(verification.paths ?? []).join(",")}
                      onChange={(event) => updateCriterion(index, (current) => ({
                        ...current,
                        verification: {
                          kind: "critic",
                          rubric: current.verification?.kind === "critic" ? current.verification.rubric ?? "" : "",
                          // Untrimmed so typing a space inside a name survives; the verifier trims.
                          paths: event.target.value.split(","),
                        },
                      }))}
                      placeholder="reports/vendors.md"
                    />
                  </label>
                  <p className="text-[11px] text-neutral-600 dark:text-neutral-400">
                    A model from a different family than the ones doing the work reads the step&apos;s artifacts and these files, with no
                    tools, and must quote them to pass. This is a judgement, not a deterministic check.
                  </p>
                </div>
              ) : verification?.kind === "http" ? (
                <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
                  <label className="text-[11px] text-neutral-600 dark:text-neutral-300">
                    URL
                    <input
                      aria-label={`Verification URL ${index + 1}`}
                      className="mt-0.5 w-full rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                      value={verification.url}
                      onChange={(event) => updateCriterion(index, (current) => ({
                        ...current,
                        verification: {
                          kind: "http",
                          url: event.target.value,
                          expectedStatus: current.verification?.kind === "http" ? current.verification.expectedStatus : 200,
                        },
                      }))}
                      placeholder="http://127.0.0.1:3000/health"
                    />
                  </label>
                  <label className="text-[11px] text-neutral-600 dark:text-neutral-300">
                    Status
                    <input
                      aria-label={`Expected HTTP status ${index + 1}`}
                      type="number"
                      min={100}
                      max={599}
                      className="mt-0.5 w-full rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                      value={verification.expectedStatus ?? 200}
                      onChange={(event) => updateCriterion(index, (current) => ({
                        ...current,
                        verification: {
                          kind: "http",
                          url: current.verification?.kind === "http" ? current.verification.url : "",
                          expectedStatus: Number(event.target.value) || 200,
                        },
                      }))}
                    />
                  </label>
                </div>
              ) : null}
            </fieldset>
          );
        })}
      </div>
      <button
        type="button"
        className="rounded bg-neutral-200 px-2 py-1 text-xs hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700"
        onClick={() => onChange({
          ...contract,
          criteria: [
            ...contract.criteria,
            {
              id: `criterion-${crypto.randomUUID()}`,
              description: "",
              mandatory: true,
            },
          ],
        })}
      >
        Add criterion
      </button>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-neutral-600 dark:text-neutral-300">
          Constraints, one per line
          <textarea
            aria-label="Mission constraints"
            className="mt-0.5 h-16 w-full resize-y rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            value={contract.constraints}
            onChange={(event) => onChange({ ...contract, constraints: event.target.value })}
          />
        </label>
        <label className="text-[11px] text-neutral-600 dark:text-neutral-300">
          Assumptions, one per line
          <textarea
            aria-label="Mission assumptions"
            className="mt-0.5 h-16 w-full resize-y rounded border border-neutral-300 bg-neutral-100 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            value={contract.assumptions}
            onChange={(event) => onChange({ ...contract, assumptions: event.target.value })}
          />
        </label>
      </div>
    </section>
  );
}

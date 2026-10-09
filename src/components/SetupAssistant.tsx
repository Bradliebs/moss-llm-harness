// src/components/SetupAssistant.tsx
//
// "Set up for this PC": detects local models, the GPU, and saved cloud keys,
// proposes a complete setup, and applies only the lines the user keeps ticked.

import { CircleCheck, CircleDashed, CircleX, LoaderCircle } from "lucide-react";
import { useState } from "react";

import type { SetupDetectionRequest } from "@common/types";

import { buildSetupProposal, patchForProvider, type SetupAction, type SetupProposal } from "../lib/setupProposal";
import { applyPreset, PROVIDER_PRESETS, settingsStore, updateSettings, useSettings, type MossSettings } from "../lib/settings";
import { LiveStatus } from "./LiveStatus";

const OLLAMA_INDEX = PROVIDER_PRESETS.findIndex((preset) => preset.id === "ollama");

function presetBaseUrl(settings: MossSettings, id: string): string {
  return (settings.providerProfiles?.[id]?.baseUrl ?? PROVIDER_PRESETS.find((preset) => preset.id === id)?.baseUrl ?? "").trim();
}

type StepState = { label: string; state: "pending" | "running" | "done" | "failed"; note?: string };

export function SetupAssistant({ className }: { className: string }): React.ReactElement | null {
  const settings = useSettings();
  const [proposal, setProposal] = useState<SetupProposal | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"detect" | "apply" | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [status, setStatus] = useState("");
  const bridge = window.moss;
  if (!bridge?.setup) return null;
  const ollamaBaseUrl = presetBaseUrl(settings, "ollama");

  async function detect(): Promise<void> {
    setBusy("detect");
    setStatus("");
    setSteps([]);
    try {
      const request: SetupDetectionRequest = {
        ollamaBaseUrl,
        cloud: PROVIDER_PRESETS.filter((preset) => preset.id !== "ollama" && preset.id !== "custom")
          .map((preset) => ({ presetId: preset.id, kind: preset.kind, baseUrl: presetBaseUrl(settings, preset.id) }))
          .filter((preset) => preset.baseUrl),
      };
      const [detection, profiles, performance] = await Promise.all([
        bridge.setup!.detect(request),
        bridge.model?.profiles().catch(() => []) ?? Promise.resolve([]),
        bridge.model?.performance?.().catch(() => []) ?? Promise.resolve([]),
      ]);
      const next = buildSetupProposal({ detection, profiles, performance, settings, ollamaBaseUrl, currentPresetId: PROVIDER_PRESETS[settings.presetIndex]?.id });
      setProposal(next);
      setChecked(new Set(next.items.filter((item) => item.recommended).map((item) => item.id)));
    } catch (error) {
      setStatus(`Could not check this PC: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }

  function actionLabel(action: SetupAction): string {
    return action.type === "pull" ? `Download ${action.model}` : action.type === "probe" ? `Profile ${action.model}` : `Check ${action.model}'s context window`;
  }

  async function runAction(action: SetupAction): Promise<string | undefined> {
    if (action.type === "pull") {
      await bridge.setup!.pull(ollamaBaseUrl, action.model);
      return undefined;
    }
    if (action.type === "probe") {
      const profile = await bridge.model!.probe({ config: { kind: "openai-compatible", baseUrl: ollamaBaseUrl, model: action.model }, options: { maxContextTokens: 8_192 } });
      return `${profile.tier}, ${Math.round(profile.overall * 100)}%`;
    }
    const report = await bridge.model!.inspectContext!(ollamaBaseUrl, action.model);
    if ((report.status === "too-small" || report.status === "too-large") && report.recommendedContext && report.variant) {
      const variant = await bridge.model!.createContextVariant!(ollamaBaseUrl, action.model, report.recommendedContext);
      if (settingsStore.get().model === action.model) updateSettings({ model: variant });
      return `created ${variant}`;
    }
    return report.reason;
  }

  async function apply(): Promise<void> {
    if (!proposal) return;
    const selected = proposal.items.filter((item) => checked.has(item.id));
    setBusy("apply");
    try {
      if (selected.some((item) => item.useOllamaPreset) && PROVIDER_PRESETS[settingsStore.get().presetIndex]?.id !== "ollama" && OLLAMA_INDEX >= 0) {
        await applyPreset(OLLAMA_INDEX);
      }
      const chatOnOllama = PROVIDER_PRESETS[settingsStore.get().presetIndex]?.id === "ollama";
      const patch = patchForProvider(Object.assign({}, ...selected.map((item) => item.patch ?? {})) as Partial<MossSettings>, chatOnOllama, ollamaBaseUrl);
      if (Object.keys(patch).length > 0) updateSettings(patch);
      const actions = selected.flatMap((item) => item.actions ?? []);
      const queue: StepState[] = actions.map((action) => ({ label: actionLabel(action), state: "pending" }));
      setSteps(queue);
      for (const [index, action] of actions.entries()) {
        queue[index] = { ...queue[index], state: "running" };
        setSteps([...queue]);
        try {
          const note = await runAction(action);
          queue[index] = { ...queue[index], state: "done", ...(note ? { note } : {}) };
        } catch (error) {
          queue[index] = { ...queue[index], state: "failed", note: error instanceof Error ? error.message : String(error) };
        }
        setSteps([...queue]);
      }
      const failed = queue.filter((step) => step.state === "failed").length;
      setStatus(`Applied ${selected.length} setup item${selected.length === 1 ? "" : "s"}${failed ? `; ${failed} step${failed === 1 ? "" : "s"} failed` : ""}. Approval settings were not changed.`);
      setProposal(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={className} aria-labelledby="setup-heading">
      <h3 id="setup-heading" className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Set up for this PC</h3>
      <p className="text-xs text-neutral-600 dark:text-neutral-300">
        Checks your local Ollama models, GPU, and saved cloud keys, then proposes a complete setup: chat and fast models,
        escalation, ranking by meaning, profiling, and the context window. Nothing changes until you apply it, and approval
        settings are never touched.
      </p>
      <button
        type="button"
        className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        disabled={busy !== null}
        onClick={() => void detect()}
      >
        {busy === "detect" ? "Checking this PC…" : proposal ? "Check again" : "Set up for this PC"}
      </button>
      {proposal ? (
        <div className="space-y-2 rounded border border-neutral-200 p-3 text-xs dark:border-neutral-800" aria-label="Setup proposal">
          <p className="text-neutral-700 dark:text-neutral-200">{proposal.summary}</p>
          {proposal.items.length > 0 ? (
            <>
              <ul className="space-y-1.5">
                {proposal.items.map((item) => (
                  <li key={item.id}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-emerald-600"
                        checked={checked.has(item.id)}
                        onChange={(event) => setChecked((prev) => {
                          const next = new Set(prev);
                          if (event.target.checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        })}
                      />
                      <span>
                        <span className="font-medium text-neutral-900 dark:text-neutral-100">{item.title}</span>
                        <span className="block text-neutral-600 dark:text-neutral-300">{item.detail}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="rounded border border-emerald-600 px-2 py-0.5 text-emerald-800 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-200 dark:hover:bg-emerald-950"
                disabled={busy !== null || checked.size === 0}
                onClick={() => void apply()}
              >
                Apply {checked.size} item{checked.size === 1 ? "" : "s"}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <ol className="space-y-0.5 text-xs" aria-label="Setup progress">
          {steps.map((step, index) => (
            <li key={index} className={`flex items-start gap-1.5 ${step.state === "failed" ? "text-red-700 dark:text-red-300" : "text-neutral-700 dark:text-neutral-200"}`}>
              {step.state === "done" ? <CircleCheck size={14} className="mt-px shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                : step.state === "failed" ? <CircleX size={14} className="mt-px shrink-0" aria-hidden="true" />
                : step.state === "running" ? <LoaderCircle size={14} className="mt-px shrink-0 animate-spin" aria-hidden="true" />
                : <CircleDashed size={14} className="mt-px shrink-0 text-neutral-400" aria-hidden="true" />}
              <span>
                <span className="sr-only">{step.state === "done" ? "Done: " : step.state === "failed" ? "Failed: " : step.state === "running" ? "Running: " : "Waiting: "}</span>
                {step.label}
                {step.note ? ` — ${step.note}` : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <LiveStatus message={status} className="text-xs text-neutral-700 dark:text-neutral-200" />
    </section>
  );
}

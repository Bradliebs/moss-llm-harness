// src/components/ContextFitSettings.tsx
//
// Checks the selected Ollama model's served context window against its
// training and GPU memory, and creates a correctly sized variant on request.

import { useState } from "react";

import type { OllamaContextReport } from "@common/types";

import { updateSettings, useSettings } from "../lib/settings";
import { LiveStatus } from "./LiveStatus";

function tokens(value: number | undefined): string {
  return value === undefined ? "unknown" : `${value.toLocaleString("en-US")} tokens`;
}

export function isOllamaEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.port === "11434";
  } catch {
    return false;
  }
}

export function ContextFitSettings(): React.ReactElement | null {
  const settings = useSettings();
  const bridge = window.moss?.model;
  const [report, setReport] = useState<OllamaContextReport | null>(null);
  const [busy, setBusy] = useState<"check" | "create" | null>(null);
  const [status, setStatus] = useState("");

  if (!bridge?.inspectContext || settings.kind !== "openai-compatible" || !settings.model || !isOllamaEndpoint(settings.baseUrl)) return null;

  async function check(): Promise<void> {
    setBusy("check");
    setStatus("");
    try {
      setReport(await bridge!.inspectContext!(settings.baseUrl, settings.model));
    } catch (error) {
      setStatus(`Could not check the context window: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function create(target: OllamaContextReport): Promise<void> {
    if (!target.recommendedContext || !bridge?.createContextVariant) return;
    setBusy("create");
    try {
      const name = await bridge.createContextVariant(settings.baseUrl, target.model, target.recommendedContext);
      updateSettings({
        model: name,
        ...(settings.contextLimit > target.recommendedContext || settings.contextLimit === 0 ? { contextLimit: target.recommendedContext } : {}),
      });
      setReport(null);
      setStatus(`Created ${name} and switched to it. Its capability profile was copied; re-run the probe to measure the new context.`);
    } catch (error) {
      setStatus(`Could not create the variant: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }

  const fixable = report && (report.status === "too-small" || report.status === "too-large") && report.recommendedContext && report.variant;
  return (
    <div className="space-y-1 rounded border border-neutral-200 p-3 text-xs dark:border-neutral-800" aria-label="Context window fit">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-neutral-900 dark:text-neutral-100">Context window</span>
        <span className="text-neutral-600 dark:text-neutral-300">Loads the model and compares the context Ollama serves with its training and your GPU.</span>
        <button
          type="button"
          className="ml-auto rounded bg-neutral-200 px-2 py-0.5 hover:bg-neutral-300 disabled:opacity-50 dark:bg-neutral-800 dark:hover:bg-neutral-700"
          disabled={busy !== null}
          onClick={() => void check()}
        >
          {busy === "check" ? "Checking…" : "Check context window"}
        </button>
      </div>
      {report ? (
        <div className="space-y-1" aria-label="Context window report">
          <p className={report.status === "ok" ? "text-emerald-800 dark:text-emerald-200" : "text-amber-800 dark:text-amber-200"}>{report.reason}</p>
          {report.status !== "not-applicable" ? (
            <p className="text-neutral-700 dark:text-neutral-200">
              Served {tokens(report.servedContext)} · trained {tokens(report.trainedContext)}
              {report.usableContext ? ` · probe recalled up to ${tokens(report.usableContext)}` : ""}
              {report.fitsInVram !== undefined ? ` · fits in GPU ${tokens(report.fitsInVram)}` : ""}
              {report.gpu ? ` · ${report.gpu.name ?? "GPU"} ${(report.gpu.freeMiB / 1024).toFixed(1)} of ${(report.gpu.totalMiB / 1024).toFixed(1)} GB free` : " · no NVIDIA GPU detected"}
            </p>
          ) : null}
          {fixable ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-900">{report.variant}</code>
              <span className="text-neutral-600 dark:text-neutral-300">num_ctx {report.recommendedContext!.toLocaleString("en-US")}; your existing model is unchanged.</span>
              <button
                type="button"
                className="rounded border border-emerald-600 px-2 py-0.5 text-emerald-800 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-200 dark:hover:bg-emerald-950"
                disabled={busy !== null}
                onClick={() => void create(report)}
              >
                {busy === "create" ? "Creating…" : "Create variant and switch"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <LiveStatus message={status} className="text-neutral-700 dark:text-neutral-200" />
    </div>
  );
}

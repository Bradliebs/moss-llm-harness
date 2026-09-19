import type {
  HarnessCellDiff,
  HarnessDiagnosticReference,
  HarnessMatrixCellResult,
  HarnessMatrixReport,
  HarnessTraceEnvelopeEvent,
} from "../../../../common/evals";
import { HarnessDiagnosticArtifactStore, type HarnessDiagnosticArtifact } from "./diagnostic-artifact-store";

export interface HarnessInspectionDiagnostics {
  store: HarnessDiagnosticArtifactStore;
  corrections?: HarnessDiagnosticReference[];
}

export interface HarnessTrialSelector {
  caseId?: string;
  targetId?: string;
  variantId?: string;
  repetition?: number;
}

export interface HarnessTrialInspection {
  schemaVersion: 1;
  reportGeneratedAt: string;
  identity: {
    caseId: string;
    targetId: string;
    variantId: string;
    repetition: number;
    runId: string;
  };
  outcome: {
    success: boolean;
    state: HarnessMatrixCellResult["result"]["observation"]["outcome"];
    score: number;
    failureAttribution?: HarnessMatrixCellResult["result"]["failureAttribution"];
  };
  timeline: HarnessTraceEnvelopeEvent[];
  criteria: HarnessMatrixCellResult["result"]["criteria"];
  protectedInputs: {
    intact: boolean;
    checkedPaths: string[];
    changedPaths: string[];
  };
  resources: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
    actions: number;
  };
  harnessScore?: HarnessMatrixCellResult["harnessScore"];
  rubricAssessment?: HarnessMatrixCellResult["result"]["rubricAssessment"];
  baselineDelta?: HarnessCellDiff;
  diagnostics?: HarnessDiagnosticArtifact;
  corrections?: HarnessDiagnosticArtifact[];
  reviewSignals?: string[];
}

export function inspectHarnessTrial(
  report: HarnessMatrixReport,
  selector: HarnessTrialSelector = {},
  baseline?: HarnessMatrixReport,
  diagnosticOptions?: HarnessInspectionDiagnostics,
): HarnessTrialInspection {
  const cell = selectCell(report, selector);
  const baselineCell = baseline ? selectCell(baseline, exactSelector(cell)) : undefined;
  const usage = cell.result.observation.usage;
  if (diagnosticOptions && !cell.diagnostics) throw new Error("Selected trial has no diagnostic artifact");
  const diagnostics = diagnosticOptions && cell.diagnostics ? diagnosticOptions.store.read(cell.diagnostics) : undefined;
  const corrections = diagnosticOptions?.corrections?.map((reference) => {
    const artifact = diagnosticOptions.store.read(reference);
    const event = artifact.events[0];
    const payload = event && artifact.payloads[event.payload] as { original?: HarnessDiagnosticReference } | undefined;
    if (artifact.events.length !== 1 || event?.kind !== "human-correction"
      || payload?.original?.sha256 !== cell.diagnostics?.sha256) throw new Error("Correction does not belong to selected trial");
    return artifact;
  });
  const reviewSignals: string[] = [];
  if (diagnostics?.truncated) reviewSignals.push("Diagnostic capture is truncated; omitted content is not evidence of absence.");
  if (diagnostics && !diagnostics.events.some((event) => event.kind === "provider-request")) {
    reviewSignals.push("No provider requests captured; this artifact does not establish a complete model trajectory.");
  }
  if (cell.trace?.events?.some((event) => event.type === "scenario-disturbance" && event.status === "undelivered")) {
    reviewSignals.push("Undelivered disturbance: review harness attribution before judging agent behavior.");
  }
  if (!cell.result.success && cell.result.observation.outcome === "completed") {
    reviewSignals.push("Claimed completion differs from evaluator outcome: inspect grader evidence; this alone does not prove grader error.");
  }
  const checkedPaths = [...new Set([
    ...Object.keys(cell.protectedInputHashesBefore),
    ...Object.keys(cell.protectedInputHashesAfter),
  ])].sort();

  return {
    schemaVersion: 1,
    reportGeneratedAt: report.generatedAt,
    identity: {
      caseId: cell.caseId,
      targetId: cell.targetId,
      variantId: cell.variantId,
      repetition: cell.repetition,
      runId: cell.result.observation.runId,
    },
    outcome: {
      success: cell.result.success,
      state: cell.result.observation.outcome,
      score: cell.result.score,
      ...(cell.result.failureAttribution ? { failureAttribution: structuredClone(cell.result.failureAttribution) } : {}),
    },
    timeline: structuredClone(cell.trace?.events ?? []),
    criteria: structuredClone(cell.result.criteria),
    protectedInputs: {
      intact: cell.protectedInputsIntact,
      checkedPaths,
      changedPaths: checkedPaths.filter((path) =>
        cell.protectedInputHashesBefore[path] !== cell.protectedInputHashesAfter[path]),
    },
    resources: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      estimatedCostUsd: cell.result.observation.estimatedCostUsd,
      durationMs: cell.result.durationMs,
      actions: cell.trace?.toolCalls.length ?? 0,
    },
    ...(cell.harnessScore ? { harnessScore: structuredClone(cell.harnessScore) } : {}),
    ...(cell.result.rubricAssessment ? { rubricAssessment: structuredClone(cell.result.rubricAssessment) } : {}),
    ...(baselineCell ? { baselineDelta: buildCellDelta(baselineCell, cell) } : {}),
    ...(diagnostics ? { diagnostics, corrections: corrections ?? [], reviewSignals } : {}),
  };
}

export function renderTrialInspectionHtml(inspection: HarnessTrialInspection): string {
  const title = `${inspection.identity.caseId} / ${inspection.identity.targetId} / ${inspection.identity.variantId}`;
  const serialized = escapeHtml(JSON.stringify(inspection, null, 2));
  const trajectory = inspection.diagnostics ? inspection.diagnostics.events.map((event) => ({
    sequence: event.sequence, kind: event.kind, payload: inspection.diagnostics!.payloads[event.payload],
  })) : undefined;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Moss eval inspection</title>
  <style>
    :root { color-scheme: light; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    body { margin: 0; background: #f4f5f2; color: #18201c; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 56px; }
    h1 { margin: 0 0 8px; font: 700 24px Georgia, serif; overflow-wrap: anywhere; }
    p { margin: 0 0 24px; color: #526059; }
    pre { overflow: auto; margin: 0; padding: 20px; border: 1px solid #ccd2cd; background: #fff; line-height: 1.5; }
    .evidence { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin-bottom: 24px; }
    .evidence section { min-width: 0; }
    h2 { font-size: 18px; }
    @media (max-width: 720px) { .evidence { grid-template-columns: minmax(0, 1fr); } }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>Sanitized trial inspection, schema version ${inspection.schemaVersion}</p>
    ${trajectory ? `<div class="evidence"><section><h2>Outcome Checks</h2><pre>${escapeHtml(JSON.stringify({ outcome: inspection.outcome, criteria: inspection.criteria, reviewSignals: inspection.reviewSignals, corrections: inspection.corrections }, null, 2))}</pre></section><section><h2>Redacted Trajectory</h2><pre>${escapeHtml(JSON.stringify(trajectory, null, 2))}</pre></section></div>` : ""}
    <pre>${serialized}</pre>
  </main>
</body>
</html>
`;
}

function selectCell(report: HarnessMatrixReport, selector: HarnessTrialSelector): HarnessMatrixCellResult {
  const matches = report.cells.filter((cell) =>
    (selector.caseId === undefined || cell.caseId === selector.caseId)
    && (selector.targetId === undefined || cell.targetId === selector.targetId)
    && (selector.variantId === undefined || cell.variantId === selector.variantId)
    && (selector.repetition === undefined || cell.repetition === selector.repetition));
  if (matches.length === 0) throw new Error("No harness trial matches the selector");
  if (matches.length > 1) throw new Error(`Harness trial selector is ambiguous (${matches.length} matches)`);
  return matches[0];
}

function exactSelector(cell: HarnessMatrixCellResult): HarnessTrialSelector {
  return {
    caseId: cell.caseId,
    targetId: cell.targetId,
    variantId: cell.variantId,
    repetition: cell.repetition,
  };
}

function buildCellDelta(baseline: HarnessMatrixCellResult, candidate: HarnessMatrixCellResult): HarnessCellDiff {
  const baselineUsage = baseline.result.observation.usage;
  const candidateUsage = candidate.result.observation.usage;
  return {
    caseId: candidate.caseId,
    targetId: candidate.targetId,
    variantId: candidate.variantId,
    repetition: candidate.repetition,
    promptChanged: baseline.promptProvenance?.seededMessagesHash !== candidate.promptProvenance?.seededMessagesHash,
    completionChanged: baseline.result.success !== candidate.result.success,
    securityChanged: baseline.harnessScore?.securityPassed !== candidate.harnessScore?.securityPassed,
    robustnessDelta: (candidate.harnessScore?.process.robustness ?? 0) - (baseline.harnessScore?.process.robustness ?? 0),
    toolUseDelta: (candidate.harnessScore?.process.toolUse ?? 0) - (baseline.harnessScore?.process.toolUse ?? 0),
    consistencyDelta: (candidate.harnessScore?.process.consistency ?? 0) - (baseline.harnessScore?.process.consistency ?? 0),
    tokensDelta: ((candidateUsage.inputTokens ?? 0) + (candidateUsage.outputTokens ?? 0))
      - ((baselineUsage.inputTokens ?? 0) + (baselineUsage.outputTokens ?? 0)),
    costDeltaUsd: candidate.result.observation.estimatedCostUsd - baseline.result.observation.estimatedCostUsd,
    durationDeltaMs: candidate.result.durationMs - baseline.result.durationMs,
    actionsDelta: (candidate.trace?.toolCalls.length ?? 0) - (baseline.trace?.toolCalls.length ?? 0),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}
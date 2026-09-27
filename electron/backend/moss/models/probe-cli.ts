// electron/backend/moss/models/probe-cli.ts
//
// Standalone capability probe runner. Profiles one or more models on the same
// endpoint and prints a side-by-side comparison, so "should I switch models?"
// becomes a command instead of a guess.
//
//   npm run probe -- --model llama3.1:8b --model qwen2.5:7b
//   npm run probe -- --kind anthropic --base-url https://api.anthropic.com \
//     --api-key-env ANTHROPIC_API_KEY --model claude-sonnet-4-5 --output profiles.json

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CapabilityDimension, ModelCapabilityProfile, ProviderConfig, ProviderKind } from "../../../../common/types";
import { createProvider } from "../providers";
import type { ChatProvider } from "../providers/types";
import { ALL_DIMENSIONS, CONTEXT_LEVELS, DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_TIMEOUT_SECONDS, DIMENSION_LABELS, ProbeUnavailableError, runCapabilityProbes } from "./capability-probes";
import { buildCapabilityProfile } from "./capability-profile";

export interface ProbeCliOptions {
  kind: ProviderKind;
  baseUrl: string;
  models: string[];
  apiKey?: string;
  maxContextTokens: number;
  timeoutSeconds: number;
  dimensions?: CapabilityDimension[];
  output?: string;
}

export interface ProbeCliDependencies {
  createProvider?: (config: ProviderConfig) => ChatProvider;
  env?: NodeJS.ProcessEnv;
  io?: { stdout: (message: string) => void; stderr: (message: string) => void };
  now?: () => number;
  writeOutput?: (path: string, text: string) => void;
}

export const PROBE_USAGE = "Usage: probe --model NAME [--model NAME ...] [--base-url URL] [--kind openai-compatible|anthropic] [--api-key-env VAR] [--max-context TOKENS] [--timeout SECONDS] [--only DIMENSION,...] [--output FILE]";

export function parseProbeArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ProbeCliOptions {
  const options: ProbeCliOptions = {
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    models: [],
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
  let apiKeyEnv = "MOSS_PROBE_API_KEY";
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    const need = (): string => {
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      index += 1;
      return value;
    };
    if (flag === "--model") options.models.push(need());
    else if (flag === "--base-url") options.baseUrl = need();
    else if (flag === "--kind") {
      const kind = need();
      if (kind !== "openai-compatible" && kind !== "anthropic") throw new Error(`Unsupported provider kind: ${kind}`);
      options.kind = kind;
    } else if (flag === "--api-key-env") apiKeyEnv = need();
    else if (flag === "--max-context") {
      const tokens = Number(need());
      if (!Number.isInteger(tokens) || tokens < CONTEXT_LEVELS[0]) throw new Error(`--max-context must be an integer of at least ${CONTEXT_LEVELS[0]}`);
      options.maxContextTokens = tokens;
    } else if (flag === "--timeout") {
      const seconds = Number(need());
      if (!Number.isFinite(seconds) || seconds < 5) throw new Error("--timeout must be at least 5 seconds");
      options.timeoutSeconds = seconds;
    } else if (flag === "--only") {
      const dimensions = need().split(",").map((item) => item.trim()).filter(Boolean);
      const unknown = dimensions.filter((item) => !ALL_DIMENSIONS.includes(item as CapabilityDimension));
      if (unknown.length) throw new Error(`Unknown dimension: ${unknown.join(", ")}`);
      options.dimensions = dimensions as CapabilityDimension[];
    } else if (flag === "--output") options.output = need();
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.models.length === 0) throw new Error("At least one --model is required");
  const apiKey = env[apiKeyEnv]?.trim();
  if (apiKey) options.apiKey = apiKey;
  return options;
}

function percent(value: number | undefined): string {
  return value === undefined ? "-" : `${Math.round(value * 100)}%`;
}

export function formatComparison(profiles: readonly ModelCapabilityProfile[]): string {
  if (profiles.length === 0) return "";
  const dimensions = ALL_DIMENSIONS.filter((dimension) => profiles.some((profile) => profile.results.some((result) => result.dimension === dimension)));
  const rows: string[][] = [
    ["", ...profiles.map((profile) => profile.model)],
    ...dimensions.map((dimension) => [
      DIMENSION_LABELS[dimension],
      ...profiles.map((profile) => percent(profile.results.find((result) => result.dimension === dimension)?.score)),
    ]),
    ["Overall", ...profiles.map((profile) => percent(profile.overall))],
    ["Tier", ...profiles.map((profile) => profile.tier)],
    ["Usable context", ...profiles.map((profile) => profile.recommendation.usableContextTokens?.toLocaleString("en-US") ?? "-")],
    ["Coherent tool calls", ...profiles.map((profile) => String(profile.recommendation.maxCoherentSteps ?? "-"))],
    ["Median latency", ...profiles.map((profile) => profile.latency ? `${(profile.latency.medianMs / 1000).toFixed(1)}s` : "-")],
    ["Failed requests", ...profiles.map((profile) => String(profile.failedRequests))],
    ["Duration", ...profiles.map((profile) => `${Math.round(profile.durationMs / 1000)}s`)],
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n");
}

export async function runProbeCli(args: readonly string[], dependencies: ProbeCliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? { stdout: console.log, stderr: console.error };
  let options: ProbeCliOptions;
  try {
    options = parseProbeArgs(args, dependencies.env);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(PROBE_USAGE);
    return 2;
  }
  const now = dependencies.now ?? Date.now;
  const factory = dependencies.createProvider ?? createProvider;
  const controller = new AbortController();
  const profiles: ModelCapabilityProfile[] = [];
  let unavailable = 0;
  for (const model of options.models) {
    io.stderr(`Probing ${model} at ${options.baseUrl}`);
    const provider = factory({ kind: options.kind, baseUrl: options.baseUrl, model, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
    const startedAt = now();
    let run: Awaited<ReturnType<typeof runCapabilityProbes>>;
    try {
      run = await runCapabilityProbes({ provider, model, signal: controller.signal, now, timeoutMs: options.timeoutSeconds * 1_000 }, {
        maxContextTokens: options.maxContextTokens,
        dimensions: options.dimensions,
        onProgress: (progress) => io.stderr(`  [${progress.completedDimensions + 1}/${progress.totalDimensions}] ${progress.message}`),
      });
    } catch (error) {
      if (!(error instanceof ProbeUnavailableError)) throw error;
      io.stderr(`  skipped: ${error.message}`);
      unavailable += 1;
      continue;
    }
    const { results, warmupMs } = run;
    const profile = buildCapabilityProfile({
      providerKind: options.kind,
      baseUrl: options.baseUrl,
      model,
      results,
      startedAt,
      finishedAt: now(),
      maxContextTested: Math.max(...CONTEXT_LEVELS.filter((level) => level <= options.maxContextTokens)),
      warmupMs,
    });
    profiles.push(profile);
    for (const note of profile.recommendation.notes) io.stderr(`  note: ${note}`);
  }
  io.stdout(formatComparison(profiles));
  if (options.output) {
    const output = resolve(options.output);
    const text = `${JSON.stringify({ schemaVersion: 1, profiles }, null, 2)}\n`;
    if (dependencies.writeOutput) dependencies.writeOutput(output, text);
    else {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, text, "utf8");
    }
    io.stderr(`Wrote ${profiles.length} profile${profiles.length === 1 ? "" : "s"} to ${output}`);
  }
  return unavailable > 0 ? 1 : 0;
}

if (require.main === module) {
  void runProbeCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

// electron/backend/moss/models/replay-cli.ts
//
// Replays recorded turn traces against one or more candidate models and prints
// how often each made the same decision as the original model.
//
//   npm run replay -- --trace %APPDATA%\moss\turn-traces\<id>.json --model qwen2.5:7b
//   npm run replay -- --dir %APPDATA%\moss\turn-traces --last 5 --model a --model b

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ProviderConfig, ProviderKind, ReplayReport, TurnTrace } from "../../../../common/types";
import { createProvider } from "../providers";
import type { ChatProvider } from "../providers/types";
import { DEFAULT_TIMEOUT_SECONDS } from "./capability-probes";
import { createReplayJudge } from "./replay-judge";
import { replayTrace } from "./trace-replay";

export const REPLAY_USAGE = "Usage: replay (--trace FILE ... | --dir DIR [--last N]) --model NAME [--model NAME ...] [--base-url URL] [--kind openai-compatible|anthropic] [--api-key-env VAR] [--timeout SECONDS] [--judge NAME [--judge-base-url URL] [--judge-kind KIND] [--judge-api-key-env VAR]] [--output FILE]";

export interface ReplayCliOptions {
  traces: string[];
  dir?: string;
  last: number;
  models: string[];
  kind?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  timeoutSeconds: number;
  output?: string;
  judge?: { model: string; kind?: ProviderKind; baseUrl?: string; apiKey?: string };
}

export function parseReplayArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ReplayCliOptions {
  const options: ReplayCliOptions = { traces: [], last: 5, models: [], timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
  let apiKeyEnv = "MOSS_PROBE_API_KEY";
  let judgeKeyEnv: string | undefined;
  let judgeKind: ProviderKind | undefined;
  let judgeBaseUrl: string | undefined;
  let judgeModel: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    const need = (): string => {
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      index += 1;
      return value;
    };
    if (flag === "--trace") options.traces.push(need());
    else if (flag === "--dir") options.dir = need();
    else if (flag === "--last") {
      const count = Number(need());
      if (!Number.isInteger(count) || count < 1) throw new Error("--last must be a positive integer");
      options.last = count;
    } else if (flag === "--model") options.models.push(need());
    else if (flag === "--base-url") options.baseUrl = need();
    else if (flag === "--kind") {
      const kind = need();
      if (kind !== "openai-compatible" && kind !== "anthropic") throw new Error(`Unsupported provider kind: ${kind}`);
      options.kind = kind;
    } else if (flag === "--api-key-env") apiKeyEnv = need();
    else if (flag === "--timeout") {
      const seconds = Number(need());
      if (!Number.isFinite(seconds) || seconds < 5) throw new Error("--timeout must be at least 5 seconds");
      options.timeoutSeconds = seconds;
    } else if (flag === "--output") options.output = need();
    else if (flag === "--judge") judgeModel = need();
    else if (flag === "--judge-base-url") judgeBaseUrl = need();
    else if (flag === "--judge-api-key-env") judgeKeyEnv = need();
    else if (flag === "--judge-kind") {
      const kind = need();
      if (kind !== "openai-compatible" && kind !== "anthropic") throw new Error(`Unsupported provider kind: ${kind}`);
      judgeKind = kind;
    }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.traces.length === 0 && !options.dir) throw new Error("Provide --trace FILE or --dir DIR");
  if (options.models.length === 0) throw new Error("At least one --model is required");
  const apiKey = env[apiKeyEnv]?.trim();
  if (apiKey) options.apiKey = apiKey;
  if (judgeModel) {
    const judgeKey = judgeKeyEnv ? env[judgeKeyEnv]?.trim() : apiKey;
    options.judge = { model: judgeModel, ...(judgeKind ? { kind: judgeKind } : {}), ...(judgeBaseUrl ? { baseUrl: judgeBaseUrl } : {}), ...(judgeKey ? { apiKey: judgeKey } : {}) };
  } else if (judgeKind || judgeBaseUrl || judgeKeyEnv) throw new Error("--judge-kind, --judge-base-url, and --judge-api-key-env need --judge");
  return options;
}

export interface ReplayCliDependencies {
  createProvider?: (config: ProviderConfig) => ChatProvider;
  readTrace?: (path: string) => TurnTrace;
  listDir?: (dir: string) => string[];
  env?: NodeJS.ProcessEnv;
  io?: { stdout: (message: string) => void; stderr: (message: string) => void };
  writeOutput?: (path: string, text: string) => void;
}

function readTraceFile(path: string): TurnTrace {
  const value = JSON.parse(readFileSync(path, "utf8")) as TurnTrace;
  if (value?.schemaVersion !== 1 || !Array.isArray(value.calls)) throw new Error(`Not a Moss turn trace: ${path}`);
  return value;
}

function newestTraceFiles(dir: string, last: number): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, last);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatReplayTable(reports: readonly ReplayReport[]): string {
  if (reports.length === 0) return "";
  const rows = [
    ["Trace", "Baseline", "Candidate", "Calls", "Same action", "Reasonable", "Valid args", "Errors", "Median latency"],
    ...reports.map((report) => [
      report.traceId.slice(0, 8),
      report.baselineModel,
      report.candidateModel,
      String(report.summary.calls),
      `${report.summary.sameAction} (${percent(report.summary.agreementRate)})`,
      report.summary.acceptable !== undefined ? `${report.summary.acceptable} (${percent(report.summary.acceptableRate ?? 0)})` : "-",
      percent(report.summary.validArgumentRate),
      String(report.summary.errors),
      report.summary.medianLatencyMs !== undefined ? `${(report.summary.medianLatencyMs / 1000).toFixed(1)}s` : "-",
    ]),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n");
}

export async function runReplayCli(args: readonly string[], dependencies: ReplayCliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? { stdout: console.log, stderr: console.error };
  let options: ReplayCliOptions;
  try {
    options = parseReplayArgs(args, dependencies.env);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(REPLAY_USAGE);
    return 2;
  }
  const readTrace = dependencies.readTrace ?? readTraceFile;
  const paths = [
    ...options.traces.map((path) => resolve(path)),
    ...(options.dir ? (dependencies.listDir ?? ((dir) => newestTraceFiles(dir, options.last)))(resolve(options.dir)) : []),
  ];
  if (paths.length === 0) {
    io.stderr("No traces found. Turn on trace recording in Settings > Models > Routing and adaptation.");
    return 1;
  }
  const factory = dependencies.createProvider ?? createProvider;
  const controller = new AbortController();
  const reports: ReplayReport[] = [];
  for (const path of paths) {
    const trace = readTrace(path);
    for (const model of options.models) {
      io.stderr(`Replaying ${trace.calls.length} call${trace.calls.length === 1 ? "" : "s"} from ${trace.id.slice(0, 8)} against ${model}`);
      const provider = factory({
        kind: options.kind ?? trace.providerKind,
        baseUrl: options.baseUrl ?? trace.endpoint,
        model,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      });
      const judge = options.judge
        ? {
            model: options.judge.model,
            judge: createReplayJudge({
              provider: factory({
                kind: options.judge.kind ?? options.kind ?? trace.providerKind,
                baseUrl: options.judge.baseUrl ?? options.baseUrl ?? trace.endpoint,
                model: options.judge.model,
                ...(options.judge.apiKey ? { apiKey: options.judge.apiKey } : {}),
              }),
              model: options.judge.model,
              judgeModel: options.judge.model,
            }),
          }
        : undefined;
      const report = await replayTrace(trace, provider, model, { signal: controller.signal, timeoutMs: options.timeoutSeconds * 1_000, ...(judge ? { judge } : {}) });
      if (report.judgeSkipped) io.stderr(`Not judged: ${report.judgeSkipped}`);
      reports.push(report);
    }
  }
  io.stdout(formatReplayTable(reports));
  if (options.output) {
    const text = `${JSON.stringify({ schemaVersion: 1, reports }, null, 2)}\n`;
    if (dependencies.writeOutput) dependencies.writeOutput(resolve(options.output), text);
    else writeFileSync(resolve(options.output), text, "utf8");
  }
  return 0;
}

if (require.main === module) {
  void runReplayCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

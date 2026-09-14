import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvalConfig } from "./eval-cli";
import type { ProviderStreamEvent } from "../providers/types";
import * as pilotCases from "./pilot-cases";
import * as representativeCorpus from "./representative-corpus";
import * as graderHealth from "./grader-health";
import * as turnExecutor from "./turn-eval-executor";
import * as sandboxBackend from "./sandbox-backend";
import * as sandboxTools from "./sandbox-tools";
import * as executionSelection from "./execution-selection";
import * as splitPolicy from "./split-policy";
import * as trustedScenarioTools from "./trusted-scenario-tools";

const streamChat = vi.fn(async function* (): AsyncIterable<ProviderStreamEvent> { yield { type: "text-delta", text: "done" }; });
const hostCommand = vi.fn(async () => ({ ok: true, content: "unexpected host execution" }));
const providerConstructed = vi.fn();
const modules: Record<string, unknown> = {
  "pilot-cases.js": pilotCases,
  "representative-corpus.js": representativeCorpus,
  "grader-health.js": graderHealth,
  "turn-eval-executor.js": turnExecutor,
  "sandbox-backend.js": sandboxBackend,
  "sandbox-tools.js": sandboxTools,
  "execution-selection.js": executionSelection,
  "split-policy.js": splitPolicy,
  "trusted-scenario-tools.js": trustedScenarioTools,
  "openai-compatible.js": { OpenAiCompatibleProvider: class {
    constructor(baseUrl: string, apiKey?: string, options?: { reasoningEffort?: "none" }) {
      providerConstructed(baseUrl, apiKey, options);
    }
    kind = "deterministic";
    listModels = async () => [];
    streamChat = streamChat;
  } },
  "index.js": { TOOL_REGISTRY: new Map([["run_command", { name: "run_command", description: "fixture", parameters: {}, execute: hostCommand }]]) },
};

function loadConfig(env: Record<string, string> = {}): HarnessEvalConfig {
  const module = { exports: {} };
  runInNewContext(readFileSync("scripts/eval-pilots.cjs", "utf8"), {
    module, process: { env, cwd: () => process.cwd() },
    require: (path: string) => {
      const dependency = modules[basename(path)];
      if (!dependency) throw new Error(`Unexpected config dependency: ${path}`);
      return dependency;
    },
  });
  return module.exports as HarnessEvalConfig;
}

afterEach(() => vi.restoreAllMocks());

describe("pilot configuration execution selection", () => {
  it("compares runtime variants through explicit approval without changing the approval experiment", () => {
    const config = loadConfig({ MOSS_EVAL_EXPERIMENT: "phase5-runtime" });
    expect(config.variants.map((variant) => variant.id)).toEqual(["phase5-baseline-gated", "phase5-candidate-gated"]);
    expect(config.variants.every((variant) => variant.autoApprove === false)).toBe(true);
    expect(loadConfig().variants.map((variant) => variant.autoApprove)).toEqual([true, false]);
  });

  it("records opt-in inference settings in the target and configures the provider from that target", () => {
    const defaults = loadConfig();
    expect(defaults.targets[0].generation).toBeUndefined();
    const candidate = loadConfig({ MOSS_EVAL_REASONING_EFFORT: "none" });
    expect(candidate.targets[0].id).not.toBe(defaults.targets[0].id);
    expect(candidate.targets[0].generation).toEqual({ reasoningEffort: "none" });
    candidate.createExecutor(candidate.targets[0], candidate.variants[0], "");
    expect(providerConstructed).toHaveBeenLastCalledWith("http://localhost:11434/v1", undefined, { reasoningEffort: "none" });
    candidate.createExecutor(defaults.targets[0], candidate.variants[0], "");
    expect(providerConstructed).toHaveBeenLastCalledWith("http://localhost:11434/v1", undefined, { reasoningEffort: undefined });
    expect(() => loadConfig({ MOSS_EVAL_REASONING_EFFORT: "low" })).toThrow("must be none or unset");
  });

  it("fingerprints the compiled runtime and executor configuration in addition to graders", () => {
    const config = loadConfig();
    expect(config.evaluatorArtifacts).toEqual(expect.arrayContaining([
      `${process.cwd()}/dist-electron`, `${process.cwd()}/scripts/eval-pilots.cjs`,
      `${process.cwd()}/package-lock.json`,
    ]));
  });

  it.each([["pilot", 4, 1], ["representative", 30, 6]])("defaults %s to Docker-free cases while retaining corpus health", (corpus, total, excluded) => {
    const config = loadConfig({ MOSS_EVAL_CORPUS: String(corpus) });
    expect(() => config.validateExecution?.()).not.toThrow();
    const splitExcluded = config.healthCases!.filter((testCase) => testCase.split !== "development").length;
    expect(config.cases).toHaveLength(Number(total) - Number(excluded) - splitExcluded);
    expect(config.healthCases).toHaveLength(Number(total));
    expect(config.cases.every((testCase) => !executionSelection.requiresEvalSandbox(testCase))).toBe(true);
    expect(config.executionCoverage?.selection).toBe("local");
    expect(config.executionCoverage?.excluded).toHaveLength(Number(excluded) + splitExcluded);
    expect(config.executionCoverage?.excluded.filter((entry) => entry.reason === "requires-container")).toHaveLength(Number(excluded));
    expect(config.cases.every((testCase) => testCase.split === "development")).toBe(true);
  });

  it("selects validation for promotion and retains the full corpus for named releases", () => {
    const promotion = loadConfig({ MOSS_EVAL_CORPUS: "representative", MOSS_EVAL_PURPOSE: "promotion" });
    expect(promotion.cases.length).toBeGreaterThan(0);
    expect(promotion.cases.every((testCase) => testCase.split === "validation")).toBe(true);
    expect(() => loadConfig({ MOSS_EVAL_PURPOSE: "release" })).toThrow("named measurement");
    const release = loadConfig({ MOSS_EVAL_CORPUS: "representative", MOSS_EVAL_EXECUTION: "full", MOSS_EVAL_PURPOSE: "release", MOSS_EVAL_MEASUREMENT: "release-1" });
    expect(release.cases).toHaveLength(30);
    expect(release.executionCoverage?.excluded).toEqual([]);
  });

  it.each(["container", "full"])("requires a pinned image for %s without dropping command capabilities", (selection) => {
    const env = { MOSS_EVAL_EXECUTION: selection };
    const config = loadConfig(env);
    expect(() => config.validateExecution?.()).toThrow("pinned");
    expect(config.cases.some((testCase) => testCase.allowedCapabilities.includes("run_command"))).toBe(true);
    expect(config.cases).toHaveLength(selection === "container" ? 1 : 4);
    expect(() => loadConfig({ ...env, MOSS_EVAL_SANDBOX_IMAGE: "node:22" })).toThrow("digest");
    expect(() => loadConfig({ ...env, MOSS_EVAL_SANDBOX_IMAGE: `node@sha256:${"a".repeat(64)}` }).validateExecution?.()).not.toThrow();
  });

  it("records suite exclusions even when execution selection is full", () => {
    const config = loadConfig({ MOSS_EVAL_EXECUTION: "full", MOSS_EVAL_CORPUS: "representative", MOSS_EVAL_SUITES: "regression" });
    expect(config.executionCoverage?.excluded.length).toBeGreaterThan(0);
    expect(config.executionCoverage?.excluded.every((entry) => entry.reason === "suite-filter")).toBe(true);
    expect(config.healthCases).toHaveLength(30);
  });

  it("rejects unknown selections", () => {
    expect(() => loadConfig({ MOSS_EVAL_EXECUTION: "host-shell" })).toThrow("Execution selection");
  });

  it("runs the default production loop without a Docker backend or host commands", async () => {
    const dockerRun = vi.spyOn(sandboxBackend.DockerEvalSandboxBackend.prototype, "run");
    const root = mkdtempSync(join(tmpdir(), "moss-local-config-"));
    try {
      const config = loadConfig();
      config.validateExecution?.();
      const executor = config.createExecutor(config.targets[0], config.variants[0], root);
      for (const testCase of config.cases) await executor(testCase, 0);
      expect(streamChat).toHaveBeenCalled();
      expect(dockerRun).not.toHaveBeenCalled();
      expect(hostCommand).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
import { describe, expect, it } from "vitest";

import { idealReply, scriptedProvider } from "./__fixtures__/probe-fakes";
import { formatComparison, parseProbeArgs, runProbeCli } from "./probe-cli";

describe("parseProbeArgs", () => {
  it("defaults to local Ollama and reads the API key from the environment", () => {
    expect(parseProbeArgs(["--model", "a", "--model", "b"], { MOSS_PROBE_API_KEY: " key " })).toEqual({
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      models: ["a", "b"],
      maxContextTokens: 32_768,
      timeoutSeconds: 90,
      apiKey: "key",
    });
    expect(parseProbeArgs(["--kind", "anthropic", "--model", "c", "--api-key-env", "X", "--max-context", "8192", "--only", "tool-calling,plan-coherence"], { X: "k" }))
      .toMatchObject({ kind: "anthropic", apiKey: "k", maxContextTokens: 8_192, dimensions: ["tool-calling", "plan-coherence"] });
  });

  it("rejects invalid arguments", () => {
    expect(() => parseProbeArgs([])).toThrow(/--model is required/);
    expect(() => parseProbeArgs(["--model"])).toThrow(/Missing value/);
    expect(() => parseProbeArgs(["--model", "a", "--kind", "gemini"])).toThrow(/Unsupported provider kind/);
    expect(() => parseProbeArgs(["--model", "a", "--max-context", "10"])).toThrow(/at least 1024/);
    expect(() => parseProbeArgs(["--model", "a", "--only", "vibes"])).toThrow(/Unknown dimension/);
    expect(() => parseProbeArgs(["--model", "a", "--bogus"])).toThrow(/Unknown argument/);
    expect(() => parseProbeArgs(["--model", "a", "--timeout", "1"])).toThrow(/at least 5 seconds/);
    expect(parseProbeArgs(["--model", "a", "--timeout", "240"]).timeoutSeconds).toBe(240);
  });
});

describe("runProbeCli", () => {
  it("profiles each model and prints a comparison table", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const written: Array<{ path: string; text: string }> = [];
    const code = await runProbeCli(["--model", "ideal", "--model", "weak", "--max-context", "2048", "--output", "profiles.json"], {
      env: {},
      createProvider: (config) => scriptedProvider(config.model === "ideal" ? idealReply : () => ({ text: "no" })),
      io: { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) },
      writeOutput: (path, text) => written.push({ path, text }),
    });
    expect(code).toBe(0);
    const table = stdout.join("\n");
    expect(table).toMatch(/Tool calling\s+100%\s+0%/);
    expect(table).toMatch(/Tier\s+strong\s+unreliable/);
    expect(stderr.some((line) => line.includes("note:"))).toBe(true);
    expect(JSON.parse(written[0].text).profiles).toHaveLength(2);
    expect(formatComparison([])).toBe("");
  });

  it("skips an unavailable model and exits 1", async () => {
    const stderr: string[] = [];
    const code = await runProbeCli(["--model", "missing", "--only", "tool-calling"], {
      env: {},
      createProvider: () => scriptedProvider(() => new Error("HTTP 404")),
      io: { stdout: () => undefined, stderr: (message) => stderr.push(message) },
    });
    expect(code).toBe(1);
    expect(stderr.some((line) => /skipped: missing did not respond to a warm-up request: HTTP 404/.test(line))).toBe(true);
  });

  it("prints usage and exits 2 for bad arguments", async () => {
    const stderr: string[] = [];
    expect(await runProbeCli([], { io: { stdout: () => undefined, stderr: (message) => stderr.push(message) } })).toBe(2);
    expect(stderr.at(-1)).toMatch(/^Usage: probe/);
  });
});

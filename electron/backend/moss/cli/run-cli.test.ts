import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelCapabilityProfile } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { setUserDataDir } from "../runtime/user-data";
import type { VerifyResult } from "../verify/verifier";
import { defaultDataDir, parseRunArgs, runMossCli, type RunCliDependencies } from "./run-cli";

function scripted(rounds: ProviderStreamEvent[][], requests: ChatRequest[] = []): ChatProvider {
  let round = 0;
  return {
    kind: "test",
    async *streamChat(request) {
      requests.push(request);
      const events = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      for (const event of events) yield event;
    },
    async listModels() {
      return [];
    },
  };
}

const text = (value: string): ProviderStreamEvent => ({ type: "text-delta", text: value });
const call = (id: string, name: string, args: unknown): ProviderStreamEvent => ({ type: "tool-call", toolCall: { id, name, arguments: JSON.stringify(args) } });

let workspace: string;
let dataDir: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "moss-run-ws-"));
  dataDir = mkdtempSync(join(tmpdir(), "moss-run-data-"));
});

afterEach(() => {
  setUserDataDir(undefined);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

async function runCli(args: string[], provider: ChatProvider, extra: Partial<RunCliDependencies> = {}) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runMossCli(["--model", "test-model", "--workspace", workspace, "--data-dir", dataDir, ...args], {
    createProvider: () => provider,
    io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } },
    loadProfile: async () => null,
    signal: new AbortController().signal,
    ...extra,
  });
  const events = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { exitCode, stdout, stderr, events };
}

describe("parseRunArgs", () => {
  it("defaults to a local endpoint, denied approvals and automatic constrained output", () => {
    const options = parseRunArgs(["--model", "llama3.1:8b", "--prompt", "hi"], { MOSS_USER_DATA: "/data" }, "/work");
    expect(options).toMatchObject({ kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.1:8b", approve: "deny", constrained: "auto", workspace: "/work", dataDir: "/data", tools: true });
  });

  it("offers no approval mode that runs gated calls unseen", () => {
    expect(() => parseRunArgs(["--model", "m", "--approve", "all"])).toThrow(/deny, safe or ask/);
    expect(() => parseRunArgs(["--prompt", "hi"])).toThrow(/--model is required/);
  });

  it("reads the API key from the named environment variable", () => {
    expect(parseRunArgs(["--model", "m", "--api-key-env", "KEY"], { KEY: " secret " }).apiKey).toBe("secret");
  });

  it("uses the desktop app's data folder by default", () => {
    expect(defaultDataDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toBe(join("C:\\Users\\a\\AppData\\Roaming", "moss"));
    expect(defaultDataDir({ XDG_CONFIG_HOME: "/home/a/.config" }, "linux")).toBe(join("/home/a/.config", "moss"));
  });
});

describe("runMossCli", () => {
  it("runs a read-only turn with real tools and exits 0", async () => {
    writeFileSync(join(workspace, "notes.txt"), "The code word is HERON.");
    const requests: ChatRequest[] = [];
    const provider = scripted([[call("c1", "read_file", { path: "notes.txt" })], [text("HERON")]], requests);
    const result = await runCli(["--prompt", "What is the code word?", "--json"], provider);
    expect(result.exitCode).toBe(0);
    const summary = result.events.at(-1);
    expect(summary).toMatchObject({ type: "run-summary", ok: true, exitCode: 0, finalText: "HERON" });
    expect(result.events.some((event) => event.type === "tool-result" && event.ok === true)).toBe(true);
    expect(requests[0].messages[0].content).toContain("running headless");
  });

  it("refuses a gated call in deny mode and tells the model why", async () => {
    const requests: ChatRequest[] = [];
    const provider = scripted([[call("c1", "write_file", { path: "out.txt", content: "x" })], [text("I could not write the file.")]], requests);
    const result = await runCli(["--prompt", "Write out.txt", "--json"], provider);
    expect(existsSync(join(workspace, "out.txt"))).toBe(false);
    expect(result.events).toContainEqual({ type: "approval-decision", callId: "c1", approved: false });
    expect(JSON.stringify(requests[1].messages)).toContain("--approve deny");
    expect(result.exitCode).toBe(0);
  });

  it("runs mutating tools in safe mode", async () => {
    const provider = scripted([[call("c1", "write_file", { path: "out.txt", content: "done" })], [text("Wrote it.")]]);
    const result = await runCli(["--prompt", "Write out.txt", "--approve", "safe"], provider);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(workspace, "out.txt"), "utf8")).toBe("done");
    expect(result.stderr).toContain("approvals: safe");
  });

  it("asks on the terminal in ask mode", async () => {
    const questions: string[] = [];
    const provider = scripted([[call("c1", "write_file", { path: "out.txt", content: "yes" })], [text("Done.")]]);
    await runCli(["--prompt", "Write out.txt", "--approve", "ask"], provider, { ask: async (question) => { questions.push(question); return "y"; } });
    expect(questions[0]).toMatch(/^Approve write_file/);
    expect(readFileSync(join(workspace, "out.txt"), "utf8")).toBe("yes");
  });

  it("does not finish until verification passes, even when nothing changed", async () => {
    const requests: ChatRequest[] = [];
    const outcomes: VerifyResult[] = [
      { ok: false, results: [{ command: "npm test", ok: false, output: "1 failing" }] },
      { ok: true, results: [{ command: "npm test", ok: true, output: "" }] },
    ];
    const provider = scripted([[text("All good.")], [text("Now it passes.")]], requests);
    const result = await runCli(["--prompt", "Fix the tests", "--verify", "npm test", "--json"], provider, { runVerify: async () => outcomes.shift()! });
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain("1 failing");
    expect(result.events.at(-1)).toMatchObject({ ok: true, verified: true });
  });

  it("fails the run when verification never passes", async () => {
    const provider = scripted([[text("Done, trust me.")]]);
    const failing: VerifyResult = { ok: false, results: [{ command: "npm test", ok: false, output: "still failing" }] };
    const result = await runCli(["--prompt", "Fix the tests", "--verify", "npm test"], provider, { runVerify: async () => failing });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not done");
  });

  it("applies the measured scaffolding for a weak model", async () => {
    const requests: ChatRequest[] = [];
    const profile = {
      model: "test-model",
      providerKind: "openai-compatible",
      tier: "limited",
      results: [],
      recommendation: { scaffolding: "heavy", toolUse: "careful", notes: [] },
    } as unknown as ModelCapabilityProfile;
    const provider = scripted([[text("Nothing to do.")]], requests);
    const result = await runCli(["--prompt", "Why is CI red?", "--constrained", "never", "--json"], provider, { loadProfile: async () => profile });
    const scaffolding = result.events.find((event) => event.type === "scaffolding") as { level: string; tools: string[] };
    expect(scaffolding.level).toBe("heavy");
    expect(scaffolding.tools).toContain("find_tool");
    expect(scaffolding.tools.length).toBeLessThanOrEqual(9);
    expect(requests[0].tools?.map((tool) => tool.name)).toEqual(scaffolding.tools);
    expect(requests[0].messages[0].content).toContain("Execute exactly one step per response");
  });

  it("re-runs stale checks after a change the runner did not verify", async () => {
    let verifications = 0;
    // The runner verifies the first three writes, then stops at its cycle cap;
    // the fourth write breaks the checks unseen, so the guard must re-run them.
    const writes = [1, 2, 3, 4].map((n) => [call(`c${n}`, "write_file", { path: `f${n}.txt`, content: "x" })]);
    const provider = scripted([...writes, [text("Done.")]]);
    const result = await runCli(["--prompt", "Change it", "--approve", "safe", "--verify", "check", "--json"], provider, {
      runVerify: async () => {
        verifications += 1;
        return verifications <= 3
          ? { ok: true, results: [{ command: "check", ok: true, output: "" }] }
          : { ok: false, results: [{ command: "check", ok: false, output: "broken" }] };
      },
    });
    expect(verifications).toBeGreaterThan(3);
    expect(result.exitCode).toBe(1);
    expect(result.events.at(-1)).toMatchObject({ ok: false, verified: false });
  });

  it("keeps a passing result when nothing changed after it", async () => {
    let verifications = 0;
    const provider = scripted([[call("c1", "write_file", { path: "a.txt", content: "x" })], [call("c2", "read_file", { path: "a.txt" })], [text("Done.")]]);
    const result = await runCli(["--prompt", "Change it", "--approve", "safe", "--verify", "check"], provider, {
      runVerify: async () => {
        verifications += 1;
        return { ok: true, results: [{ command: "check", ok: true, output: "" }] };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(verifications).toBe(1);
  });

  it("runs no tool at all with --no-tools, even one the model calls anyway", async () => {
    const provider = scripted([[call("c1", "write_file", { path: "made.txt", content: "x" })], [text("Done.")]]);
    await runCli(["--prompt", "Write made.txt", "--approve", "safe", "--no-tools"], provider);
    expect(existsSync(join(workspace, "made.txt"))).toBe(false);
  });

  it("rejects bad arguments with the usage line", async () => {
    const result = await runCli(["--approve", "everything"], scripted([[text("x")]]));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Usage: moss");
  });
});

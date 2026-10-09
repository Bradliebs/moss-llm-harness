import { describe, expect, it } from "vitest";

import type { ModelCapabilityProfile, MossEvent, ToolDefinition } from "../../../../common/types";
import { DEFAULT_ESCALATE_AFTER, EscalationMonitor } from "./escalation";
import { INVALID_ARGUMENTS_PREFIX } from "./tool-repair";
import { applyScaffoldingMessages, planScaffolding, selectRelevantTools } from "./scaffolding";

function toolDef(name: string, description = ""): ToolDefinition {
  return { name, description, parameters: { type: "object", properties: {} } };
}

const TOOLS = [
  "read_file", "list_dir", "write_file", "edit_file", "search_files", "glob_files", "move_file", "run_command",
  "git_status", "git_diff", "web_search", "fetch_url", "browser_navigate", "browser_click", "m_remember", "m_recall",
  "plan", "delegate", "send_email", "view_image",
].map((name) => toolDef(name, name === "web_search" ? "Search the web for current information" : ""));

function profile(scaffolding: "light" | "moderate" | "heavy", overrides: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
  return {
    schemaVersion: 1,
    suiteVersion: "1",
    providerKind: "openai-compatible",
    endpoint: "http://localhost:11434/v1",
    model: "small",
    probedAt: "2026-09-26T00:00:00.000Z",
    durationMs: 1,
    maxContextTested: 8_192,
    results: [],
    overall: 0.5,
    tier: scaffolding === "light" ? "strong" : scaffolding === "moderate" ? "capable" : "limited",
    usage: {},
    failedRequests: 0,
    recommendation: { scaffolding, toolUse: "supervised", structuredOutput: "direct", settings: {}, notes: [] },
    ...overrides,
  };
}

describe("selectRelevantTools", () => {
  it("keeps request-relevant and core tools within the limit, in registry order", () => {
    const selected = selectRelevantTools(TOOLS, "Search the web for the latest Node.js release and open it in the browser", 8).map((tool) => tool.name);
    expect(selected).toHaveLength(8);
    expect(selected).toEqual(expect.arrayContaining(["web_search", "browser_navigate", "browser_click"]));
    expect(selected).not.toContain("m_remember");
    expect(selected.indexOf("read_file")).toBeLessThan(selected.indexOf("web_search"));
    expect(selectRelevantTools(TOOLS.slice(0, 3), "anything", 8)).toHaveLength(3);
  });

  it("ranks housekeeping tools last unless the request names them", () => {
    const selected = selectRelevantTools(TOOLS, "hello there", 12).map((tool) => tool.name);
    expect(selected).not.toContain("m_remember");
    expect(selected).not.toContain("delegate");
    expect(selectRelevantTools(TOOLS, "remember that I prefer tabs", 8).map((tool) => tool.name)).toContain("m_remember");
  });

  it("always keeps a tool named in the request", () => {
    expect(selectRelevantTools(TOOLS, "please call git_diff", 3).map((tool) => tool.name)).toContain("git_diff");
  });
});

describe("planScaffolding", () => {
  it("changes nothing without a profile or for a strong model", () => {
    expect(planScaffolding(null, TOOLS, "hi")).toEqual({ level: "none", tools: TOOLS });
    const light = planScaffolding(profile("light"), TOOLS, "hi");
    expect(light).toMatchObject({ level: "light", tools: TOOLS });
    expect(light.notice).toBeUndefined();
  });

  it("narrows tools and adds one-call-per-round guidance for a limited model", () => {
    const heavy = planScaffolding(profile("heavy"), TOOLS, "edit the config file and run the tests");
    expect(heavy.level).toBe("heavy");
    expect(heavy.tools).toHaveLength(8);
    expect(heavy.maxToolCallsPerRound).toBe(1);
    expect(heavy.systemGuidance).toMatch(/exactly one step per response/);
    expect(heavy.notice).toBe("Adapted to small's measured profile (limited): step-by-step guidance, one tool call per round, 8 of 20 tools offered.");
  });

  it("keeps more tools for a capable model and repeats constraints when system prompts are ignored", () => {
    const moderate = planScaffolding(profile("moderate", {
      results: [{ dimension: "instruction-following", score: 0.5, passed: 1, total: 2, summary: "", durationMs: 1, trials: [{ id: "system-suffix", passed: false, score: 0, durationMs: 1 }] }],
    }), TOOLS, "hello");
    expect(moderate.tools).toHaveLength(20);
    expect(moderate.maxToolCallsPerRound).toBeUndefined();
    expect(moderate.userReminder).toMatch(/exact tool argument names/);
  });

  it("warns when measured tool calling is unreliable and skips guidance for tool-less turns", () => {
    const avoid = profile("heavy", { tier: "unreliable", recommendation: { scaffolding: "heavy", toolUse: "avoid", structuredOutput: "repair", settings: {}, notes: [] } });
    // OpenAI-compatible endpoints carry weak tool callers with constrained output instead.
    expect(planScaffolding(avoid, TOOLS, "x").notice).not.toMatch(/consider Chat only/);
    expect(planScaffolding({ ...avoid, providerKind: "anthropic" }, TOOLS, "x").notice).toMatch(/consider Chat only/);
    expect(planScaffolding(avoid, [], "x")).toEqual({ level: "none", tools: [] });
  });
});

describe("pinned coding tools", () => {
  const registry = ["plan", "working_state", "read_file", "list_dir", "search_files", "glob_files", "write_file", "edit_file", "move_file", "run_command", "git_diff", "send_email", "search_codebase"]
    .map((name) => ({ name, description: name === "send_email" ? "Send an email message" : name === "working_state" ? "Record a build decision" : name, parameters: {} }));

  it("keeps read, edit, and run tools in an 8-tool list whatever the request says", () => {
    for (const query of ["why does the build fail? run the tests and fix it", "summarize the email handling code and refactor it"]) {
      const names = selectRelevantTools(registry, query, 8).map((tool) => tool.name);
      expect(names).toHaveLength(8);
      for (const pinned of ["read_file", "edit_file", "run_command"]) expect(names, query).toContain(pinned);
    }
  });

  it("does not pin tools into a short find_tool ranking", () => {
    expect(selectRelevantTools(registry, "send an email", 3).map((tool) => tool.name)).toContain("send_email");
  });
});

describe("applyScaffoldingMessages", () => {
  it("extends copies of the system and latest user messages only", () => {
    const messages = [
      { role: "system" as const, content: "base" },
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "second" },
    ];
    const next = applyScaffoldingMessages(messages, { level: "heavy", tools: [], systemGuidance: "GUIDE", userReminder: "REMIND" });
    expect(next[0].content).toBe("base\n\nGUIDE");
    expect(next[1].content).toBe("first");
    expect(next[3].content).toBe("second\n\n(REMIND)");
    expect(messages[0].content).toBe("base");
    expect(applyScaffoldingMessages([{ role: "user", content: "u" }], { level: "heavy", tools: [], systemGuidance: "G" })[0]).toEqual({ role: "system", content: "G" });
  });
});

describe("escalation", () => {
  it("fires once when harness rejections reach the threshold", () => {
    const monitor = new EscalationMonitor();
    const rejected: MossEvent = { type: "round-end", round: 0, toolCallCount: 0, finish: "rejected" };
    const failed: MossEvent = { type: "verification", ok: false, checkCount: 1 };
    expect(DEFAULT_ESCALATE_AFTER).toBe(2);
    expect(monitor.observe({ type: "verification", ok: true, checkCount: 1 })).toBe(false);
    expect(monitor.observe(rejected)).toBe(false);
    expect(monitor.observe(failed)).toBe(true);
    expect(monitor.observe(failed)).toBe(false);
    expect(monitor.count).toBe(2);
    expect(new EscalationMonitor(0).observe(rejected)).toBe(true);
  });

  it("counts failed tool calls but not permission refusals", () => {
    const monitor = new EscalationMonitor(1);
    const result = (ok: boolean, content: string): MossEvent => ({ type: "tool-result", callId: "c", name: "read_file", ok, content, autoApproved: false });
    expect(monitor.observe(result(false, "User denied: write_file"))).toBe(false);
    expect(monitor.observe(result(false, "Denied by policy: run_command"))).toBe(false);
    expect(monitor.observe(result(true, "fine"))).toBe(false);
    expect(monitor.observe(result(false, "File not found: a.txt"))).toBe(true);
  });

  it("forgives the first schema error per tool and tools the harness withheld", () => {
    const monitor = new EscalationMonitor(1);
    const result = (name: string, content: string): MossEvent => ({ type: "tool-result", callId: "c", name, ok: false, content, autoApproved: false });
    expect(monitor.observe(result("write_file", "Unknown tool: run_command"))).toBe(false);
    expect(monitor.observe(result("write_file", `${INVALID_ARGUMENTS_PREFIX} write_file: missing required 'content'.`))).toBe(false);
    expect(monitor.observe(result("read_file", `${INVALID_ARGUMENTS_PREFIX} read_file: missing required 'path'.`))).toBe(false);
    expect(monitor.count).toBe(0);
    // The same mistake twice is the model struggling.
    expect(monitor.observe(result("write_file", `${INVALID_ARGUMENTS_PREFIX} write_file: missing required 'content'.`))).toBe(true);
  });
});

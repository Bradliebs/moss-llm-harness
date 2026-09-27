import { describe, expect, it } from "vitest";

import type { WorkingState } from "../../../../common/types";
import {
  emptyWorkingState,
  matchesProtected,
  normalizeWorkingState,
  protectedPathViolation,
  renderWorkingState,
  withWorkingState,
  workingStateBudget,
  WorkingStateStore,
  workingStateTool,
} from "./working-state";
import { DEFAULT_STALL_LIMIT, ProgressSupervisor, supervisorStopMessage, supervisorWarning } from "./progress-supervisor";

const ctx = (store?: WorkingStateStore) => ({ workspaceRoot: "", signal: new AbortController().signal, ...(store ? { workingState: store } : {}) });

describe("WorkingStateStore", () => {
  it("adds typed entries, deduplicates, and limits what the model may remove", () => {
    const store = new WorkingStateStore({ schemaVersion: 1, entries: [{ id: "i1-user", kind: "invariant", text: "Keep the API stable", source: "user", createdAt: "x" }] });
    const fact = store.add("fact", "Tests use vitest", "model");
    expect(store.add("fact", "tests use VITEST", "model").id).toBe(fact.id);
    const decision = store.add("decision", "Use SQLite", "model", "it is already bundled");
    expect(store.version).toBe(2);
    expect(store.removeByModel(fact.id)).toEqual({ ok: true });
    expect(store.removeByModel(decision.id).ok).toBe(false);
    expect(store.removeByModel("i1-user").reason).toMatch(/user/);
    expect(store.removeByModel("missing").ok).toBe(false);
    expect(() => store.add("fact", "   ", "model")).toThrow();
    store.add("protected", "config/**", "model");
    expect(store.protectedPatterns()).toEqual(["config/**"]);
  });

  it("normalizes untrusted renderer input", () => {
    expect(normalizeWorkingState(null)).toEqual(emptyWorkingState());
    expect(normalizeWorkingState({ entries: [{ id: "x", kind: "bogus", text: "t", source: "user" }, { id: "y", kind: "fact", text: "ok", source: "model" }] }).entries.map((entry) => entry.id)).toEqual(["y"]);
  });
});

describe("rendering and budget", () => {
  const state: WorkingState = {
    schemaVersion: 1,
    entries: [
      { id: "i1", kind: "invariant", text: "Never change the public API", source: "user", createdAt: "x" },
      { id: "p1", kind: "protected", text: "secrets.json", source: "user", createdAt: "x" },
      { id: "d1", kind: "decision", text: "Use SQLite", rationale: "already bundled", source: "model", createdAt: "x" },
      ...Array.from({ length: 40 }, (_, index) => ({ id: `f${index}`, kind: "fact" as const, text: `Fact number ${index} ${"detail ".repeat(10)}`, source: "model" as const, createdAt: "x" })),
    ],
  };

  it("always keeps invariants and protected paths and drops old facts first", () => {
    const rendered = renderWorkingState(state, 300);
    expect(rendered).toContain("Never change the public API");
    expect(rendered).toContain("secrets.json");
    expect(rendered).toContain("because already bundled");
    expect(rendered).toContain("f39");
    expect(rendered).not.toContain("[f0]");
    expect(rendered).toMatch(/older facts omitted/);
    expect(renderWorkingState(emptyWorkingState())).toBe("");
    expect(workingStateBudget()).toBe(1_500);
    expect(workingStateBudget(2_048)).toBe(307);
    expect(workingStateBudget(200_000)).toBe(2_000);
  });

  it("replaces an earlier block in the system message", () => {
    const first = withWorkingState([{ role: "system", content: "base" }, { role: "user", content: "hi" }], "<working_state>\nA\n</working_state>");
    const second = withWorkingState(first, "<working_state>\nB\n</working_state>");
    expect(second[0].content).toBe("base\n\n<working_state>\nB\n</working_state>");
    expect(withWorkingState(second, "")[0].content).toBe("base");
    expect(withWorkingState([{ role: "user", content: "hi" }], "S")[0]).toEqual({ role: "system", content: "S" });
  });
});

describe("protected paths", () => {
  it("matches exact files, folders, and globs across separators and absolute paths", () => {
    expect(matchesProtected("config/secrets.json", ["config/secrets.json"])).toBe("config/secrets.json");
    expect(matchesProtected("src\\db\\schema.sql", ["src/db"])).toBe("src/db");
    expect(matchesProtected("migrations/2026/01.sql", ["migrations/**"])).toBe("migrations/**");
    expect(matchesProtected("a/b.lock", ["*.lock"])).toBeUndefined();
    expect(matchesProtected("pnpm.lock", ["*.lock"])).toBe("*.lock");
    expect(matchesProtected("/ws/keep.txt", ["keep.txt"], "/ws")).toBe("keep.txt");
    expect(matchesProtected("src/dbx/file", ["src/db"])).toBeUndefined();
  });

  it("collapses . and .. before matching, as the path guard does", () => {
    expect(matchesProtected("src/../node_modules/pkg/index.js", ["node_modules/**"], "C:\\ws")).toBe("node_modules/**");
    expect(matchesProtected("./x/../config/secrets.json", ["config/secrets.json"], "C:\\ws")).toBe("config/secrets.json");
    expect(matchesProtected("src/../config/secrets.json", ["config/secrets.json"])).toBe("config/secrets.json");
    expect(matchesProtected("C:\\ws\\a\\..\\keep.txt", ["keep.txt"], "C:\\ws")).toBe("keep.txt");
    expect(matchesProtected("src/./db/../app.ts", ["src/db"], "C:\\ws")).toBeUndefined();
  });

  it("refuses writes, edits, moves, and mutating commands that touch a protected path", () => {
    const patterns = ["config/secrets.json"];
    expect(protectedPathViolation("write_file", { path: "config/secrets.json" }, patterns, "")).toMatch(/^Protected path:/);
    expect(protectedPathViolation("move_file", { from: "a.txt", to: "config/secrets.json" }, patterns, "")).toMatch(/^Protected path:/);
    expect(protectedPathViolation("edit_file", { path: "other.txt" }, patterns, "")).toBeUndefined();
    expect(protectedPathViolation("run_command", { command: "rm config/secrets.json" }, patterns, "")).toMatch(/could change/);
    expect(protectedPathViolation("run_command", { command: "cat config/secrets.json" }, patterns, "")).toBeUndefined();
    expect(protectedPathViolation("write_file", { path: "config/secrets.json" }, [], "")).toBeUndefined();
  });
});

describe("working_state tool", () => {
  it("records, views, and removes entries through the store", async () => {
    const store = new WorkingStateStore();
    expect((await workingStateTool.execute({ action: "record_decision", text: "Use REST", rationale: "simpler" }, ctx(store))).content).toMatch(/^Recorded d1/);
    await workingStateTool.execute({ action: "add_question", text: "Which port?" }, ctx(store));
    const view = await workingStateTool.execute({ action: "view" }, ctx(store));
    expect(view.content).toContain("Use REST (because simpler)");
    const question = store.snapshot().entries.find((entry) => entry.kind === "question")!;
    expect((await workingStateTool.execute({ action: "remove", id: question.id }, ctx(store))).ok).toBe(true);
    expect((await workingStateTool.execute({ action: "record_fact" }, ctx(store))).ok).toBe(false);
    expect((await workingStateTool.execute({ action: "explode" }, ctx(store))).ok).toBe(false);
    expect((await workingStateTool.execute({ action: "view" }, ctx())).ok).toBe(false);
    expect((await workingStateTool.execute({ action: "view" }, ctx(new WorkingStateStore()))).content).toBe("Working state is empty.");
  });
});

describe("ProgressSupervisor", () => {
  const read = (content: string, args = "{\"path\":\"a\"}") => ({ name: "read_file", arguments: args, ok: true, content });

  it("resets on progress, warns once after three stalled rounds, and stops at the limit", () => {
    const supervisor = new ProgressSupervisor();
    expect(supervisor.observeRound([read("one")]).action).toBe("continue");
    const verdicts = [1, 2, 3, 4, 5].map(() => supervisor.observeRound([read("one")]).action);
    expect(verdicts).toEqual(["continue", "continue", "warn", "continue", "stop"]);
    expect(DEFAULT_STALL_LIMIT).toBe(5);
    expect(supervisor.stalledRounds).toBe(5);
  });

  it("treats failures as stalls and new results as progress", () => {
    const supervisor = new ProgressSupervisor(2, 3);
    supervisor.observeRound([{ name: "run_command", arguments: "{}", ok: false, content: "boom" }]);
    expect(supervisor.observeRound([{ name: "run_command", arguments: "{}", ok: false, content: "boom" }])).toMatchObject({ action: "warn", reason: "run_command failed" });
    expect(supervisor.observeRound([read("fresh")]).action).toBe("continue");
    expect(supervisor.stalledRounds).toBe(0);
    expect(new ProgressSupervisor(1, 0).observeRound([{ name: "x", arguments: "{}", ok: false, content: "" }]).action).toBe("warn");
  });

  it("detects edit and revert oscillation", () => {
    const supervisor = new ProgressSupervisor(2, 4);
    const edit = (oldText: string, newText: string) => ({ name: "edit_file", arguments: JSON.stringify({ path: "a.ts", oldText, newText }), ok: true, content: "Replaced 1 occurrence" });
    const write = (content: string) => ({ name: "write_file", arguments: JSON.stringify({ path: "b.ts", content }), ok: true, content: "Wrote" });
    expect(supervisor.observeRound([edit("A", "B")]).action).toBe("continue");
    expect(supervisor.observeRound([edit("B", "A")])).toMatchObject({ stalledRounds: 1, reason: "edit_file restored an earlier version of a file" });
    expect(supervisor.observeRound([write("v1")]).action).toBe("continue");
    supervisor.observeRound([write("v2")]);
    expect(supervisor.observeRound([write("v1")]).reason).toMatch(/restored an earlier version/);
    expect(supervisor.observeRound([write("v1")]).reason).toMatch(/identical content/);
  });

  it("formats warning and stop messages", () => {
    const verdict = { action: "stop" as const, stalledRounds: 5, reason: "read_file repeated a result already seen" };
    expect(supervisorWarning(verdict)).toMatch(/last 5 tool rounds made no progress/);
    expect(supervisorStopMessage(verdict)).toMatch(/I need your guidance/);
  });
});

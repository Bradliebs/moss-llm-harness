import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Procedure } from "../../../../common/types";
import { describeStep, expandProcedure, minePattern, ProcedureStore, procedureToolDefinition, RUN_PROCEDURE } from "./procedure-store";

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) });
const runTests = (file: string) => [
  call("read_file", { path: file }),
  call("edit_file", { path: file, old_string: `bug in ${file}`, new_string: `fix in ${file}` }),
  call("run_command", { command: "npm test" }),
];

describe("minePattern", () => {
  it("keeps unchanged values fixed and turns varying ones into shared slots", () => {
    const examples = ["a.ts", "b.ts", "c.ts"].map((file) => ({
      request: `fix ${file}`,
      steps: runTests(file).map((item) => Object.fromEntries(Object.entries(JSON.parse(item.arguments)).map(([key, value]) => [key, JSON.stringify(value)]))),
    }));
    const mined = minePattern(examples, ["read_file", "edit_file", "run_command"])!;
    expect(mined.steps).toEqual([
      { tool: "read_file", args: { path: { slot: "path" } } },
      { tool: "edit_file", args: { path: { slot: "path" }, old_string: { slot: "old_string" }, new_string: { slot: "new_string" } } },
      { tool: "run_command", args: { command: { const: "npm test" } } },
    ]);
    expect(mined.slots.map((slot) => slot.name)).toEqual(["path", "old_string", "new_string"]);
    expect(describeStep(mined.steps[2])).toBe("run_command(command=\"npm test\")");
    expect(minePattern(examples.slice(0, 2), ["read_file", "edit_file", "run_command"])).toBeUndefined();
  });
});

describe("ProcedureStore", () => {
  let dir = "";
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "moss-procedures-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("learns a candidate after three verified examples, then trusts or demotes it on evidence", async () => {
    const store = new ProcedureStore(dir, () => new Date("2026-09-27T00:00:00.000Z"));
    expect(await store.observe("fix a", runTests("a.ts"))).toBeUndefined();
    expect(await store.observe("fix b", runTests("b.ts"))).toBeUndefined();
    const learned = (await store.observe("fix c", runTests("c.ts")))!;
    expect(learned).toMatchObject({ name: "read_file → edit_file → run_command", status: "candidate", learnedFrom: 3 });
    expect(learned.description).toContain('"fix a"');
    // The same sequence is not learned twice.
    expect(await store.observe("fix d", runTests("d.ts"))).toBeUndefined();
    expect(await store.offered()).toHaveLength(1);

    for (let index = 0; index < 3; index++) await store.recordOutcome([learned.id], "success");
    expect((await store.list())[0].status).toBe("trusted");
    await store.recordOutcome([learned.id], "failure");
    await store.recordOutcome([learned.id], "failure");
    expect((await new ProcedureStore(dir).list())[0]).toMatchObject({ status: "demoted", failureCount: 2 });
    expect(await store.offered()).toEqual([]);
    await store.setStatus(learned.id, "candidate");
    expect(await store.offered()).toHaveLength(1);
    await store.remove(learned.id);
    expect(await store.list()).toEqual([]);
  });

  it("ignores single calls, housekeeping tools, and unparseable arguments", async () => {
    const store = new ProcedureStore(dir);
    for (let index = 0; index < 3; index++) {
      expect(await store.observe("x", [call("read_file", { path: "a" })])).toBeUndefined();
      expect(await store.observe("x", [call("plan", {}), call("read_file", { path: "a" })])).toBeUndefined();
      expect(await store.observe("x", [{ name: "read_file", arguments: "{bad" }, call("list_dir", {})])).toBeUndefined();
    }
    expect(await store.list()).toEqual([]);
  });
});

describe("expandProcedure", () => {
  const procedure = {
    id: "p-1", name: "read → test", description: "d", status: "trusted", learnedFrom: 3, successCount: 0, failureCount: 0, consecutiveFailures: 0, createdAt: "x", updatedAt: "x",
    steps: [{ tool: "read_file", args: { path: { slot: "path" } } }, { tool: "run_command", args: { command: { const: "npm test" } } }],
    slots: [{ name: "path", example: "a.ts" }],
  } as Procedure;

  it("fills slots into ordinary tool calls and reports missing slots", () => {
    const expanded = expandProcedure(procedure, { path: "src/x.ts" });
    expect("calls" in expanded && expanded.calls.map((item) => [item.name, item.arguments])).toEqual([["read_file", "{\"path\":\"src/x.ts\"}"], ["run_command", "{\"command\":\"npm test\"}"]]);
    expect(expandProcedure(procedure, {})).toEqual({ error: "run_procedure p-1 needs slots: path. Expected: path." });
  });

  it("describes procedures to the model with their steps and slots", () => {
    const definition = procedureToolDefinition([{ ...procedure, status: "candidate" }]);
    expect(definition.name).toBe(RUN_PROCEDURE);
    expect(definition.description).toContain("- p-1 (unproven): d Steps: read_file(path=<path>) -> run_command(command=\"npm test\"). Slots: path (e.g. a.ts).");
    expect((definition.parameters as { properties: { procedure: { enum: string[] } } }).properties.procedure.enum).toEqual(["p-1"]);
  });
});

import { describe, expect, it } from "vitest";
import type { EvalCase, HarnessVariant } from "../../../../common/evals";
import { selectExecutionCases } from "./execution-selection";

const local: EvalCase = { schemaVersion: 1, id: "local", profile: "coding", difficulty: "smoke",
  allowedCapabilities: ["read_file"], task: { objective: "read", acceptanceCriteria: [], constraints: [], assumptions: [] }, checks: [] };
const command: EvalCase = { ...local, id: "command", allowedCapabilities: ["run_command"] };

describe("execution selection", () => {
  it("partitions whole cases without changing capabilities", () => {
    const cases = [local, command];
    expect(selectExecutionCases(cases, [], "local")).toEqual({ cases: [local], excluded: [{ caseId: "command", reason: "requires-container" }] });
    expect(selectExecutionCases(cases, [], "container")).toEqual({ cases: [command], excluded: [{ caseId: "local", reason: "local-case" }] });
    expect(selectExecutionCases(cases, [], "full")).toEqual({ cases, excluded: [] });
    expect(command.allowedCapabilities).toEqual(["run_command"]);
  });

  it("requires containment for file-only cases when any variant enables verification", () => {
    const variant: HarnessVariant = { schemaVersion: 1, id: "verify", verify: { enabled: true, commands: ["echo verified"] } };
    expect(selectExecutionCases([local], [variant], "local").cases).toEqual([]);
    expect(selectExecutionCases([local], [variant], "container").cases).toEqual([local]);
  });

  it("rejects unsupported capabilities even when filtering", () => {
    expect(() => selectExecutionCases([{ ...local, allowedCapabilities: ["delegate"] }], [], "local")).toThrow("no sandbox adapter");
  });
});
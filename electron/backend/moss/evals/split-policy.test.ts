import { describe, expect, it } from "vitest";
import { createInitialLineage } from "./dataset-lineage";
import { createOfflinePilotCases } from "./pilot-cases";
import { validateSplitExecution } from "./split-policy";

describe("execution split policy", () => {
  it("defaults to development and reserves validation for promotion or named release", () => {
    const testCase = createOfflinePilotCases()[0];
    expect(() => validateSplitExecution([testCase])).not.toThrow();
    testCase.split = "validation";
    expect(() => validateSplitExecution([testCase])).toThrow("cannot execute");
    expect(() => validateSplitExecution([testCase], { purpose: "promotion" })).not.toThrow();
    expect(() => validateSplitExecution([testCase], { purpose: "release" })).toThrow("named measurement");
  });

  it("requires lineage and a named release for holdout execution", () => {
    const testCase = createOfflinePilotCases()[0];
    testCase.split = "holdout";
    expect(() => validateSplitExecution([testCase], { purpose: "promotion" })).toThrow("cannot execute");
    expect(() => validateSplitExecution([testCase], { purpose: "release", measurementName: "release-1" })).toThrow("lineage");
    testCase.lineage = createInitialLineage(testCase);
    expect(() => validateSplitExecution([testCase], { purpose: "release", measurementName: "release-1" })).not.toThrow();
  });

  it("checks excluded holdout cases for near duplicates and family leakage", () => {
    const development = createOfflinePilotCases()[0];
    const holdout = structuredClone(development);
    holdout.id = "hidden-case";
    holdout.family = "different-family";
    holdout.split = "holdout";
    holdout.lineage = createInitialLineage(holdout);
    expect(() => validateSplitExecution([development], undefined, [development, holdout])).toThrow("Near-duplicate");
    holdout.family = development.family;
    holdout.task.objective = "An unrelated task";
    holdout.lineage = createInitialLineage(holdout);
    expect(() => validateSplitExecution([development], undefined, [development, holdout])).toThrow("holdout boundary");
  });

  it("catches canonical-root leakage even when a development source has no lineage", () => {
    const development = createOfflinePilotCases()[0];
    const holdout = createOfflinePilotCases()[1];
    holdout.split = "holdout";
    holdout.lineage = { ...createInitialLineage(holdout), familyRootId: development.id };
    expect(() => validateSplitExecution([development], undefined, [development, holdout])).toThrow("holdout boundary");
  });
});
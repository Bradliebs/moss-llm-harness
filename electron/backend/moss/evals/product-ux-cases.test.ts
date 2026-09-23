import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PRODUCT_UX_EVAL_CASES } from "./product-ux-cases";

describe("product UX evaluation corpus", () => {
  it("covers setup, recovery, intervention, and background mission behavior", () => {
    expect(new Set(PRODUCT_UX_EVAL_CASES.map((testCase) => testCase.area))).toEqual(
      new Set(["setup", "recovery", "intervention", "background"]),
    );
    expect(PRODUCT_UX_EVAL_CASES.map((testCase) => testCase.id)).toEqual(expect.arrayContaining([
      "provider-setup-failure-recovery",
      "unverifiable-mission-criteria",
      "unknown-model-pricing",
      "unavailable-capability",
      "approval-denial-revised-plan",
      "post-compaction-continuation",
      "reload-during-approval",
      "configuration-change-recovery",
      "background-mission-inspection",
    ]));
  });

  it("defines observable recovery actions and prohibited false-success behavior", () => {
    for (const testCase of PRODUCT_UX_EVAL_CASES) {
      expect(testCase.expectedActions.length).toBeGreaterThan(0);
      expect(testCase.forbiddenOutcomes.length).toBeGreaterThan(0);
      expect(testCase.measuredBy.length).toBeGreaterThan(0);
    }
  });

  it("binds every scenario to an executable regression test", async () => {
    for (const testCase of PRODUCT_UX_EVAL_CASES) {
      const evidence = await readFile(resolve(testCase.executableEvidence.path), "utf8");
      expect(evidence, testCase.id).toContain(testCase.executableEvidence.testName);
    }
  });
});

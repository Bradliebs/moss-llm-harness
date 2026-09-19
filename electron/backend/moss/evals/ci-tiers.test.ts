import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, { "runs-on": string | string[]; env?: Record<string, string>; steps: Array<{ run?: string; uses?: string; with?: { path?: string } }> }>;
}
function workflow(name: string): Workflow {
  return parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as Workflow;
}
describe("evaluation CI tiers", () => {
  it("runs on master pushes and pull requests", () => {
    expect(workflow("ci").on).toEqual({ pull_request: null, push: { branches: ["master"] } });
  });
  it("keeps PR checks scripted, nightly repeated, and release gated without diagnostics uploads", () => {
    const checks = workflow("ci").jobs.deterministic.steps.map((step) => step.run ?? "").join("\n");
    expect(checks).toContain("representative-corpus.e2e.test.ts");
    expect(checks).toContain("sandbox-tools.test.ts");
    expect(workflow("eval-provider-smoke").jobs.smoke.env?.MOSS_EVAL_REPETITIONS).toBe("3");
    const nightly = workflow("eval-provider-smoke").jobs.smoke;
    expect(nightly["runs-on"]).toBe("ubuntu-latest");
    expect(nightly.env?.MOSS_EVAL_SANDBOX_IMAGE).toBeUndefined();
    expect(nightly.env?.MOSS_EVAL_EXECUTION).toBe("local");
    expect(nightly.steps.map((step) => step.run).join("\n")).not.toMatch(/docker|test:sandbox/);
    const providerRun = nightly.steps.findIndex((step) => step.run?.includes("reports/provider-smoke.json"));
    expect(providerRun).toBeGreaterThan(-1);
    const release = workflow("eval-release").jobs["release-eval"];
    expect(release.env?.MOSS_EVAL_EXECUTION).toBe("full");
    expect(release.env?.MOSS_EVAL_PURPOSE).toBe("release");
    expect(release.env?.MOSS_EVAL_MEASUREMENT).toContain("github.run_id");
    expect(release.env?.MOSS_EVAL_CORPUS).toBe("representative");
    expect(release.env?.MOSS_EVAL_SANDBOX_IMAGE).toBeDefined();
    expect(JSON.parse(readFileSync("reports/pilot-thresholds.json", "utf8")).requireFullCoverage).toBe(true);
    expect(release["runs-on"]).toContain("moss-eval-sandbox");
    expect(release.steps.findIndex((step) => step.run === "npm run test:sandbox"))
      .toBeLessThan(release.steps.findIndex((step) => step.run?.includes("--resume")));
    expect(release.steps.map((step) => step.run).join("\n")).toContain("preflight");
    expect(release.steps.map((step) => step.run).join("\n")).not.toContain("--diagnostics-dir");
    expect(release.steps.find((step) => step.uses?.startsWith("actions/upload-artifact"))?.with?.path?.trim().split(/\r?\n/))
      .toEqual(["reports/release-candidate.json", "reports/release-candidate.progress.json", "reports/release-diff.json"]);
  });
  it("requires explicit dispatch and a Windows Linux-engine runner for live containment", () => {
    const live = workflow("eval-sandbox");
    expect(Object.keys(live.on)).toEqual(["workflow_dispatch"]);
    expect(live.jobs.containment["runs-on"]).toContain("moss-eval-sandbox");
    expect(live.jobs.containment.steps.some((step) => step.run === "npm run test:sandbox")).toBe(true);
  });
});
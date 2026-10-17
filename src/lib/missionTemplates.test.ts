import { describe, expect, it } from "vitest";

import { buildMissionTemplate } from "./missionTemplates";

const capabilities = [
  { id: "read_file", risk: "readonly" as const },
  { id: "write_file", risk: "mutating" as const },
  { id: "browser_navigate", risk: "readonly" as const },
];

describe("buildMissionTemplate", () => {
  it("seeds coding verification from the configured command without bypassing preflight", () => {
    const template = buildMissionTemplate("coding", ["npm test"], capabilities, true);
    expect(template.contract.criteria[0].verification).toEqual({ kind: "commands", commands: ["npm test"] });
    expect(template.capabilityIds).toEqual(expect.arrayContaining(["read_file", "write_file"]));
    expect(template.missingPrerequisites).toEqual([]);
  });

  it("keeps missing prerequisites explicit", () => {
    const coding = buildMissionTemplate("coding", [], [], false);
    expect(coding.missingPrerequisites).toEqual(expect.arrayContaining([
      "Select a workspace.",
      "Enable at least one verification command.",
      "Enable workspace tools.",
    ]));
    expect(coding.contract.criteria[0].verification).toEqual({ kind: "commands", commands: [] });
  });

  it("provides distinct research and automation outcome contracts", () => {
    expect(buildMissionTemplate("research", [], capabilities, true).contract.criteria[0].verification)
      .toEqual({ kind: "file-exists", path: "research-report.md" });
    expect(buildMissionTemplate("automation", [], capabilities, false).contract.criteria[0].verification)
      .toEqual({ kind: "http", url: "http://localhost:3000", expectedStatus: 200 });
  });

  it("grants research what its own criterion needs: writing the report and reading sources", () => {
    const research = buildMissionTemplate("research", [], [
      ...capabilities,
      { id: "web_search", risk: "readonly" as const },
      { id: "fetch_url", risk: "readonly" as const },
      { id: "run_command", risk: "mutating" as const },
    ], true);
    // A file-exists criterion that the grant could never satisfy blocked every research mission.
    expect(research.capabilityIds).toEqual(expect.arrayContaining(["read_file", "write_file", "web_search", "fetch_url", "browser_navigate"]));
    expect(research.capabilityIds).not.toContain("run_command");
  });
});

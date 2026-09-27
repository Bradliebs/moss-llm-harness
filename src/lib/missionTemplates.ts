import type { MissionCapabilityDescriptor } from "@common/types";

import type { MissionContract } from "../components/MissionReview";

export type MissionTemplateId = "coding" | "research" | "automation";

export interface MissionTemplate {
  id: MissionTemplateId;
  label: string;
  objective: string;
  contract: MissionContract;
  capabilityIds: string[];
  budget: { minutes: string; tokens: string; actions: string; cost: string };
  missingPrerequisites: string[];
}

function matchingCapabilities(
  capabilities: MissionCapabilityDescriptor[],
  names: readonly string[],
  prefixes: readonly string[] = [],
): string[] {
  return capabilities
    .filter((capability) =>
      names.includes(capability.id) || prefixes.some((prefix) => capability.id.startsWith(prefix)),
    )
    .map((capability) => capability.id);
}

export function buildMissionTemplate(
  id: MissionTemplateId,
  configuredCommands: string[],
  capabilities: MissionCapabilityDescriptor[],
  workspaceSelected: boolean,
): MissionTemplate {
  if (id === "coding") {
    const capabilityIds = matchingCapabilities(
      capabilities,
      ["read_file", "write_file", "apply_patch", "run_command"],
    );
    return {
      id,
      label: "Coding",
      objective: "Implement the requested code change and verify it.",
      contract: {
        criteria: [{
          id: "verified-change",
          description: "The requested change is implemented and its configured verification passes.",
          mandatory: true,
          verification: { kind: "commands", commands: configuredCommands.slice(0, 1) },
        }],
        constraints: "Preserve existing behavior outside the requested change.\nDo not expose credentials or protected data.",
        assumptions: "The selected workspace contains the project and its existing verification tooling.",
      },
      capabilityIds,
      budget: { minutes: "30", tokens: "100000", actions: "48", cost: "10" },
      missingPrerequisites: [
        ...(!workspaceSelected ? ["Select a workspace."] : []),
        ...(configuredCommands.length === 0 ? ["Enable at least one verification command."] : []),
        ...(capabilityIds.length === 0 ? ["Enable workspace tools."] : []),
      ],
    };
  }
  if (id === "research") {
    const capabilityIds = matchingCapabilities(capabilities, ["read_file"], ["browser_", "web_"]);
    return {
      id,
      label: "Research",
      objective: "Research the requested topic and produce a sourced report.",
      contract: {
        criteria: [{
          id: "research-report",
          description: "A sourced research report is saved in the workspace.",
          mandatory: true,
          verification: { kind: "file-exists", path: "research-report.md" },
        }],
        constraints: "Distinguish sourced facts from analysis.\nDo not include secrets, private content, or unsupported claims.",
        assumptions: "The requested sources are accessible and may be cited in the final report.",
      },
      capabilityIds,
      budget: { minutes: "30", tokens: "80000", actions: "40", cost: "8" },
      missingPrerequisites: [
        ...(!workspaceSelected ? ["Select a workspace for the report."] : []),
        ...(!capabilityIds.some((capability) => capability.startsWith("browser_") || capability.startsWith("web_"))
          ? ["Enable browser or research tools."]
          : []),
      ],
    };
  }
  const capabilityIds = matchingCapabilities(capabilities, [], ["browser_", "desktop_"]);
  return {
    id,
    label: "Automation",
    objective: "Run the requested bounded automation and verify the target is healthy.",
    contract: {
      criteria: [{
        id: "target-health",
        description: "The automation target responds with the expected status.",
        mandatory: true,
        verification: { kind: "http", url: "http://localhost:3000", expectedStatus: 200 },
      }],
      constraints: "Stay within configured browser domains and desktop process/window allowlists.\nStop on unexpected destructive actions.",
      assumptions: "The target application is available and the configured allowlists cover the requested workflow.",
    },
    capabilityIds,
    budget: { minutes: "20", tokens: "60000", actions: "32", cost: "6" },
    missingPrerequisites: capabilityIds.length === 0 ? ["Enable and scope browser or desktop automation."] : [],
  };
}

import { resolve } from "node:path";
import type { EvalCase } from "../../../../common/evals";

export function createMcpCases(repositoryRoot = process.cwd()): EvalCase[] {
  const root = resolve(repositoryRoot, "electron/backend/moss/evals/corpus");
  return [false, true].map((swapped): EvalCase => {
    const member = swapped ? "perturbed" : "canonical";
    const owner = swapped ? "south" : "north";
    return {
      schemaVersion: 1, id: `mcp-routing-${member}`, profile: "platform", difficulty: "standard",
      suite: "capability", split: "development", family: "mcp-routing", domain: "mcp",
      familyRole: swapped ? "negative" : "positive",
      provenance: {
        source: "test", sourceId: "mcp-routing", owner: "moss", referenceSolutionVerified: true,
        sourceEvidence: "electron/backend/moss/evals/mcp-cases.test.ts",
      },
      perturbation: { class: swapped ? "layout" : "canonical", expectedDecision: swapped ? "changed" : "same", canonicalCaseId: "mcp-routing-canonical" },
      task: {
        objective: "Close ticket T42 for project orchard using its owning MCP server. Both servers have a T42 ticket; use the tool descriptions to identify ownership. Leave the other project's ticket unchanged.",
        acceptanceCriteria: [{ id: "mcp-state", description: "Exactly one update closes orchard's ticket, and the other server remains unchanged", mandatory: true }],
        constraints: ["Only update the owning server", "Do not update the other project"], assumptions: [],
        budget: { maxActions: 4, maxTokens: 20_000, maxDurationMs: 120_000 },
      },
      fixture: {
        workspaceTemplate: resolve(root, `fixtures/mcp-behavior-${member}`),
        referenceSolution: resolve(root, `references/mcp-behavior-${member}`),
        state: { kind: "mcp-behavior", schemaVersion: 1 },
      },
      allowedCapabilities: ["mcp__north__set_status", "mcp__south__set_status"],
      checks: [{ id: "mcp-state", criterionId: "mcp-state", kind: "command", command: `"${process.execPath}" "${resolve(root, "validators/mcp-behavior-state.cjs")}" ${member}` }],
      benchmark: { expectedCapabilities: [`mcp__${owner}__set_status`] },
      tags: ["mcp", "behavioral", "ownership-swap", "namespaced-routing", "stateful-fake"],
    };
  });
}
import type { EvalCase } from "../../../../common/evals";
import { adaptMcpTool } from "../mcp/mcp-manager";
import type { Tool } from "../tools";
import { createBrowserCases } from "./browser-cases";
import { createBrowserEvalTools } from "./browser-eval-tools";
import { createDesktopCases } from "./desktop-cases";
import { createDesktopEvalTools } from "./desktop-eval-tools";
import { createMcpCases } from "./mcp-cases";
import { createMcpEvalTools } from "./mcp-eval-tools";
import { validateTurnEvalCapabilities } from "./sandbox-tools";

const reviewedCases = new Map([...createBrowserCases(), ...createDesktopCases(), ...createMcpCases()].map((testCase) => [testCase.id, testCase]));

export function validateEvalCaseCapabilities(testCase: EvalCase): string[] {
  const reviewed = reviewedCases.get(testCase.id);
  if (!reviewed) {
    validateTurnEvalCapabilities(testCase.allowedCapabilities);
    return [];
  }
  if (testCase.allowedCapabilities.some((name) => !reviewed.allowedCapabilities.includes(name))) {
    throw new Error("Trusted scenario cases may expose only their reviewed local adapter capabilities");
  }
  return reviewed.allowedCapabilities;
}

export async function createTrustedScenarioTools(testCase: EvalCase, workspaceRoot: string): Promise<Tool[] | undefined> {
  validateEvalCaseCapabilities(testCase);
  const reviewed = reviewedCases.get(testCase.id);
  if (!reviewed) return undefined;
  if (reviewed.domain === "browser") return createBrowserEvalTools(workspaceRoot);
  if (reviewed.domain === "desktop") {
    const mode = testCase.fixture?.state?.desktopMode;
    if (mode !== "available" && mode !== "stale") throw new Error("Desktop scenario requires a reviewed mode");
    return createDesktopEvalTools(workspaceRoot, mode);
  }
  return createMcpEvalTools(workspaceRoot, adaptMcpTool);
}
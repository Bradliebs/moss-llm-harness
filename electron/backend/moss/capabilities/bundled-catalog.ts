import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { appRootDir, isPackagedApp } from "../runtime/user-data";

import { CapabilityCatalog } from "./capability-catalog";
import { CapabilityInstaller } from "./capability-installer";
import { createCapabilityCatalogTools } from "./capability-tools";

const WORKSPACE_SUMMARY_SHA256 = "47f69ab8b0bf97ef51911999c8ea41bef017491738975bda4ace8b533f5932be";

export function createBundledCapabilityTools() {
  const artifactPath = isPackagedApp()
    ? join(process.resourcesPath, "catalog-artifacts", "workspace-summary.mjs")
    : join(appRootDir(), "electron", "backend", "moss", "capabilities", "catalog-artifacts", "workspace-summary.mjs");
  const catalog = new CapabilityCatalog({
    schemaVersion: 1,
    entries: [
      {
        id: "workspace-summary",
        version: "1.0.0",
        sourceUrl: pathToFileURL(artifactPath).toString(),
        sha256: WORKSPACE_SUMMARY_SHA256,
        platforms: ["any"],
        runtime: "node",
        entry: { command: "node", args: ["artifact.raw", "${workspaceRoot}"] },
        permissions: ["workspace-read"],
        toolIds: ["workspace_summary"],
      },
    ],
  });
  return createCapabilityCatalogTools(catalog, new CapabilityInstaller(catalog));
}
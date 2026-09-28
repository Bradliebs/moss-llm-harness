import type { ChatStartRequest } from "../../../../common/types";
import type { Tool } from "../tools/types";
import { CapabilityRegistry, type CapabilitySource } from "./capability-registry";
import { CapabilityRouter } from "./capability-router";

export interface LiveCapabilityGroup {
  source: CapabilitySource;
  tools: Tool[];
}

export interface LiveCapabilityRoute {
  tools: Tool[];
  unmet: string[];
}

export function routeLiveCapabilities(
  groups: LiveCapabilityGroup[],
  request: Pick<ChatStartRequest, "email" | "stt" | "embed">,
  platform: NodeJS.Platform = process.platform,
  histories: ReadonlyMap<string, { successCount: number; failureCount: number }> = new Map(),
): LiveCapabilityRoute {
  const registry = new CapabilityRegistry();
  for (const group of groups) {
    for (const tool of group.tools) {
      registry.register({
        tool,
        source: group.source,
        supportedPlatforms: group.source === "desktop" ? ["win32"] : ["any"],
        requiredCredentials: requiredCredentials(tool.name),
        tags: capabilityTags(tool.name, group.source),
        history: histories.get(tool.name) ?? { successCount: 0, failureCount: 0 },
      });
    }
  }

  const all = registry.list();
  const result = new CapabilityRouter(registry).route({
    capabilityNames: all.map((capability) => capability.toolName),
    availableCredentials: availableCredentials(request),
    platform,
  });
  return {
    tools: result.selected.map((capability) => capability.tool),
    unmet: result.unmet.flatMap((item) => item.reasons.map((reason) => `${item.requirement}: ${reason}`)),
  };
}

function requiredCredentials(toolName: string): string[] {
  if (toolName === "send_email") return ["email"];
  if (toolName === "transcribe_audio") return ["stt"];
  if (toolName === "search_codebase") return ["embeddings"];
  return [];
}

function availableCredentials(request: Pick<ChatStartRequest, "email" | "stt" | "embed">): string[] {
  const credentials: string[] = [];
  if (hasEmailCredentials(request.email)) credentials.push("email");
  if (request.stt?.baseUrl.trim() && request.stt.model.trim()) credentials.push("stt");
  if (request.embed?.baseUrl.trim() && request.embed.model.trim()) credentials.push("embeddings");
  return credentials;
}

function hasEmailCredentials(email: ChatStartRequest["email"]): boolean {
  if (!email) return false;
  if (email.provider === "smtp") {
    return Boolean(email.smtp?.host?.trim() && email.smtp.user?.trim() && email.smtp.pass?.trim());
  }
  return Boolean(email.apiKey?.trim() && email.from?.trim());
}

function capabilityTags(toolName: string, source: CapabilitySource): string[] {
  return [source, ...toolName.split("_").filter(Boolean)];
}
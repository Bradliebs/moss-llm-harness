// electron/backend/moss/providers/index.ts

import type { ProviderConfig } from "../../../../common/types";
import { AnthropicProvider } from "./anthropic";
import { CopilotProvider } from "./copilot";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import type { ChatProvider } from "./types";

export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.kind) {
    case "anthropic":
      return new AnthropicProvider(config.baseUrl || "https://api.anthropic.com", config.apiKey);
    case "openai-compatible":
      return new OpenAiCompatibleProvider(config.baseUrl, config.apiKey);
    case "github-copilot":
      // The key is an optional GitHub token; without one the GitHub CLI sign-in is used.
      return new CopilotProvider(config.apiKey ? { apiKey: config.apiKey } : {});
    default: {
      const exhaustive: never = config.kind;
      throw new Error(`Unknown provider kind: ${String(exhaustive)}`);
    }
  }
}

export type { ChatProvider } from "./types";

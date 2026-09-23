// src/lib/guidance.ts
//
// Plain-language explanations for tool denials and provider failures. Each
// match names the rule that applied and, where a setting controls it, the
// Settings category the user can open to change it.

export type SettingsCategoryId = "readiness" | "diagnostics" | "general" | "models" | "tools" | "automation" | "knowledge" | "services" | "safety";

export interface ToolFailureExplanation {
  rule: string;
  detail: string;
  settingsCategory?: SettingsCategoryId;
}

export function explainToolFailure(content: string | undefined): ToolFailureExplanation | null {
  if (!content) return null;
  const domain = content.match(/Domain is not allow-listed: (\S+)/);
  if (domain) {
    return {
      rule: "Browser domain allow-list",
      detail: `${domain[1]} is not in Allowed domains. Add it in Settings if the agent should visit it.`,
      settingsCategory: "automation",
    };
  }
  const process = content.match(/Process is not allow-listed: (.+)/);
  if (process) {
    return {
      rule: "Desktop process allow-list",
      detail: `${process[1].trim()} is not in Allowed process names.`,
      settingsCategory: "automation",
    };
  }
  const window = content.match(/Window is not allow-listed: (.+)/);
  if (window) {
    return {
      rule: "Desktop window allow-list",
      detail: `"${window[1].trim()}" must be listed exactly in Allowed window titles.`,
      settingsCategory: "automation",
    };
  }
  if (/Path escapes the workspace sandbox/.test(content)) {
    return {
      rule: "Workspace sandbox",
      detail: "File tools can only reach files inside the selected workspace folder. Choose a different workspace to work elsewhere.",
      settingsCategory: "tools",
    };
  }
  if (/No workspace folder selected/.test(content)) {
    return { rule: "Workspace required", detail: "Choose a workspace folder before using file or command tools.", settingsCategory: "tools" };
  }
  if (/^User denied/.test(content)) {
    return { rule: "Your approval decision", detail: "You denied this call, so it did not run. The agent was told and can try another approach." };
  }
  if (/Denied by policy|denied by host policy/i.test(content)) {
    return {
      rule: "Mission authority",
      detail: "The mission's granted capabilities or risk ceiling do not include this tool. Revise the mission to grant it.",
    };
  }
  if (/URLs with embedded credentials are not allowed/.test(content)) {
    return { rule: "Outbound request safety", detail: "Requests with a username or password in the URL are always blocked." };
  }
  if (/timed out after/i.test(content)) {
    return {
      rule: "Tool time limit",
      detail: "Commands stop after 60 seconds. Long-running servers and watchers are not supported by run_command.",
    };
  }
  return null;
}

export interface ProviderErrorGuidance {
  hint: string;
  action?: { kind: "settings"; category: SettingsCategoryId; label: string } | { kind: "new-chat"; label: string } | { kind: "retry"; label: string };
}

/** Map a turn error message to an actionable next step. */
export function providerErrorGuidance(message: string): ProviderErrorGuidance | null {
  const text = message.toLowerCase();
  const openModels = { kind: "settings" as const, category: "models" as const, label: "Open model settings" };
  if (/\b(401|403)\b|unauthori[sz]ed|invalid (api )?key|incorrect api key|authentication/.test(text)) {
    return { hint: "The provider rejected the API key. Check that it is current and belongs to this provider.", action: openModels };
  }
  if (/model .*not found|not found.*model|no such model|model_not_found|pull the model|try pulling/.test(text)) {
    return {
      hint: "The selected model is unavailable. For Ollama, run `ollama pull <model>`; otherwise choose a model from the refreshed list.",
      action: openModels,
    };
  }
  if (/econnrefused|fetch failed|failed to fetch|enotfound|network error|connect etimedout|socket hang up/.test(text)) {
    return { hint: "Moss could not reach the provider. Confirm it is running and the base URL is correct.", action: openModels };
  }
  if (/\b429\b|rate limit|too many requests|quota/.test(text)) {
    return { hint: "The provider is rate limiting requests or the quota is exhausted. Wait briefly, then retry.", action: { kind: "retry", label: "Retry" } };
  }
  if (/context (length|window)|maximum context|too many tokens|prompt is too long|context_length_exceeded/.test(text)) {
    return {
      hint: "The conversation no longer fits the model's context window. Continue in a new chat to carry a summary forward.",
      action: { kind: "new-chat", label: "Continue in new chat" },
    };
  }
  if (/daily budget|budget exceeded|spend cap/.test(text)) {
    return { hint: "The daily spending cap was reached. Raise or clear it in Settings to continue.", action: openModels };
  }
  if (/\b(500|502|503|504)\b|overloaded|service unavailable|bad gateway|internal server error/.test(text)) {
    return { hint: "The provider reported a temporary server error. Retry in a moment.", action: { kind: "retry", label: "Retry" } };
  }
  if (/timed? ?out|etimedout|deadline/.test(text)) {
    return { hint: "The provider took too long to respond. Retry, or pick a faster model.", action: { kind: "retry", label: "Retry" } };
  }
  return null;
}

import type { AgentMessage } from "../../../common/types";

const RUNTIME_CONTEXT_PATTERN = /<runtime_context source="host-system-clock">[\s\S]*?<\/runtime_context>/;

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildRuntimeContext(now: () => Date = () => new Date()): string {
  return `<runtime_context source="host-system-clock">\nThe current local date is ${formatLocalDate(now())}. Treat this as authoritative when interpreting relative dates such as today, tomorrow, and yesterday.\n</runtime_context>`;
}

export function withRuntimeContext(messages: AgentMessage[], now?: () => Date): AgentMessage[] {
  const context = buildRuntimeContext(now);
  const existingContextIndex = messages.findIndex((message) =>
    message.role === "system" && RUNTIME_CONTEXT_PATTERN.test(message.content));
  const systemIndex = existingContextIndex >= 0
    ? existingContextIndex
    : messages.findIndex((message) => message.role === "system");
  if (systemIndex < 0) return [{ role: "system", content: context }, ...messages];

  return messages.map((message, index) => {
    if (index !== systemIndex) return message;
    const content = RUNTIME_CONTEXT_PATTERN.test(message.content)
      ? message.content.replace(RUNTIME_CONTEXT_PATTERN, context)
      : `${message.content}\n\n${context}`;
    return { ...message, content };
  });
}
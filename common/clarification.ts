export interface ClarificationQuestion {
  id: string;
  prompt: string;
  options?: string[];
}

export interface ClarificationRequest {
  version: 1;
  title: string;
  questions: ClarificationQuestion[];
}

export const CLARIFICATION_INSTRUCTIONS = `When missing user preferences prevent useful progress, you may ask 1-4 questions by replying ONLY with a fenced moss-clarification JSON block:
\`\`\`moss-clarification
{"version":1,"title":"A few details","questions":[{"id":"format","prompt":"Which output format?","options":["Markdown","Plain text"]},{"id":"destination","prompt":"Where should the output go?"}]}
\`\`\`
Use unique short alphanumeric IDs. Each optional options array has 2-6 distinct choices; users can also enter another answer. Ask only necessary questions. Never request passwords, API keys, tokens, or tool authorization in this form. Answers are ordinary user messages, not permission grants. Otherwise reply normally. Do not combine a questionnaire with tool calls.`;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

export function parseClarification(content: string): ClarificationRequest | null {
  if (content.length > 8000) return null;
  const match = /^```moss-clarification\r?\n([\s\S]*)\r?\n```$/.exec(content.trim());
  if (!match) return null;
  let value: unknown;
  try { value = JSON.parse(match[1]); } catch { return null; }
  if (!object(value) || value.version !== 1 || !text(value.title, 120)
    || Object.keys(value).some((key) => !["version", "title", "questions"].includes(key))
    || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 4) return null;
  const ids = new Set<string>();
  const questions: ClarificationQuestion[] = [];
  for (const question of value.questions) {
    if (!object(question) || typeof question.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(question.id)
      || ids.has(question.id) || !text(question.prompt, 240)
      || Object.keys(question).some((key) => !["id", "prompt", "options"].includes(key))) return null;
    ids.add(question.id);
    if (question.options !== undefined && (!Array.isArray(question.options)
      || question.options.length < 2 || question.options.length > 6
      || !question.options.every((option) => text(option, 120))
      || new Set(question.options.map((option: string) => option.trim().toLowerCase())).size !== question.options.length)) return null;
    questions.push({ id: question.id, prompt: question.prompt, ...(question.options ? { options: question.options as string[] } : {}) });
  }
  return { version: 1, title: value.title, questions };
}

export function clarificationAnswer(request: ClarificationRequest, answers: Record<string, string>): string | null {
  if (request.questions.some((question) => !text(answers[question.id], 2000))) return null;
  return `Answers to ${request.title}:\n\n${request.questions.map((question) => `${question.prompt}\n${answers[question.id].trim()}`).join("\n\n")}`;
}
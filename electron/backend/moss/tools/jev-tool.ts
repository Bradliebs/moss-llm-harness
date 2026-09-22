import { APIError, APITimeoutError, TypeSafeClient, type Question } from "@typesafe-ai/sdk";

import type { Tool } from "./types";

export function createJevTool(getApiKey: () => string): Tool {
  return {
    name: "jev_evaluate",
    description: "Ask TypeSafe Jev one narrow structured question about supplied text. " +
      "Use noul for a yes/no probability, choice for selecting a label, or score for an ordered rubric. " +
      "Supply all necessary evidence in state; Jev cannot browse or inspect files. " +
      "Results are advisory, not proof or authorization. Sends state to TypeSafe after user approval; billed separately.",
    timeoutMs: 20_000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        state: { type: "string", description: "Evidence to evaluate; do not include secrets.", maxLength: 32_000 },
        question: { type: "string", description: "One specific question.", maxLength: 2_000 },
        type: { type: "string", enum: ["noul", "choice", "score"] },
        criteria: {
          type: "array", items: { type: "string", maxLength: 500 }, minItems: 2, maxItems: 20,
          description: "Required for choice (unique labels) and score (rubric levels from lowest to highest); omit for noul.",
        },
      },
      required: ["state", "question", "type"],
    },
    async execute(args, ctx) {
      if (ctx.signal.aborted) return { ok: false, content: "Jev request cancelled." };
      if (!ctx.approvalGranted) return { ok: false, content: "Jev requires approval before sending data to TypeSafe." };
      if (typeof args.state !== "string" || !args.state.trim() || args.state.length > 32_000
        || typeof args.question !== "string" || !args.question.trim() || args.question.length > 2_000) {
        return { ok: false, content: "Jev requires nonempty state (max 32000 characters) and question (max 2000 characters)." };
      }
      let question: Question;
      if (args.type === "noul") {
        if (args.criteria !== undefined) return { ok: false, content: "Omit criteria for a noul question." };
        question = { type: "noul", instructions: args.question };
      } else if (args.type === "choice" || args.type === "score") {
        const criteria = args.criteria;
        if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 20
          || !criteria.every((value): value is string => typeof value === "string" && !!value.trim() && value.length <= 500)
          || new Set(criteria).size !== criteria.length) {
          return { ok: false, content: "Provide 2-20 distinct, nonempty criteria (max 500 characters each)." };
        }
        question = args.type === "choice"
          ? { type: "choice", instructions: args.question, criteria: Object.fromEntries(criteria.map((label) => [label, null])) }
          : { type: "score", instructions: args.question, criteria: [criteria[0], criteria[1], ...criteria.slice(2)] };
      } else {
        return { ok: false, content: "Jev question type must be noul, choice, or score." };
      }
      let apiKey: string;
      try {
        apiKey = getApiKey().trim();
      } catch {
        return { ok: false, content: "Could not unlock the TypeSafe API key. Check secure credential storage." };
      }
      if (!apiKey) return { ok: false, content: "No TypeSafe API key saved. Add one in Settings." };
      try {
        const client = new TypeSafeClient({
          apiKey,
          baseURL: "https://api.typesafe.ai",
          defaultModel: "jev-latest",
          logLevel: "off",
          timeout: 15_000,
          retry: { maxRetries: 0 },
        });
        const result = await client.systemOne({ state: args.state, questions: { evaluation: question } }, { signal: ctx.signal });
        const answer = result.answers?.evaluation;
        const probability = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
        const valid = answer?.type === question.type && (
          answer.type === "noul" ? probability(answer.noul)
            : probability(answer.confidence) && answer.probabilities && Object.values(answer.probabilities).every(probability)
              && (answer.type === "choice"
                ? question.type === "choice" && Object.hasOwn(question.criteria, answer.choice)
                : question.type === "score" && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= question.criteria.length - 1)
        );
        if (!valid) return { ok: false, content: "TypeSafe returned an invalid evaluation." };
        return { ok: true, content: JSON.stringify({ advisory: true, model: result.model, answer, usage: result.usage }) };
      } catch (error) {
        if (ctx.signal.aborted) return { ok: false, content: "Jev request cancelled." };
        if (error instanceof APITimeoutError) return { ok: false, content: "Jev request timed out." };
        if (error instanceof APIError) return { ok: false, content: `TypeSafe request failed (HTTP ${error.status}). Check the API key, quota, and service status.` };
        return { ok: false, content: "Jev request failed. Check connectivity and TypeSafe service availability." };
      }
    },
  };
}
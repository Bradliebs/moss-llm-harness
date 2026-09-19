import { describe, expect, it } from "vitest";
import { clarificationAnswer, parseClarification } from "@common/clarification";

const request = { version: 1 as const, title: "Output details", questions: [{ id: "format", prompt: "Which format?", options: ["Markdown", "Text"] }] };
const block = (value: unknown) => `\`\`\`moss-clarification\n${JSON.stringify(value)}\n\`\`\``;

describe("clarification response contract", () => {
  it("accepts bounded questions and CRLF blocks", () => {
    expect(parseClarification(block(request))).toEqual(request);
    expect(parseClarification(block(request).replaceAll("\n", "\r\n"))).toEqual(request);
  });

  it.each([
    { ...request, version: 2 },
    { ...request, title: " " },
    { ...request, questions: [] },
    { ...request, questions: Array(5).fill(request.questions[0]) },
    { ...request, questions: [request.questions[0], request.questions[0]] },
    { ...request, questions: [{ id: "__proto__", prompt: "Where?" }] },
    { ...request, questions: [{ id: "path", prompt: "x".repeat(241) }] },
    { ...request, questions: [{ ...request.questions[0], options: ["Text", " text "] }] },
    { ...request, questions: [{ ...request.questions[0], options: ["Text"] }] },
    { ...request, questions: [{ ...request.questions[0], type: "password" }] },
    { ...request, action: "run_command" },
  ])("rejects invalid or unknown schema fields: %j", (value) => {
    expect(parseClarification(block(value))).toBeNull();
  });

  it("does not activate partial output, examples inside other fences, or mixed responses", () => {
    const valid = block(request);
    for (const value of [valid.slice(0, -3), `Example:\n${valid}`, `\`\`\`markdown\n${valid}\n\`\`\``, `${valid}\nMore text`, "x".repeat(8001), "```moss-clarification\ninvalid\n```"])
      expect(parseClarification(value)).toBeNull();
  });

  it("requires bounded nonempty answers and serializes them as plain user text", () => {
    expect(clarificationAnswer(request, {})).toBeNull();
    expect(clarificationAnswer(request, { format: " " })).toBeNull();
    expect(clarificationAnswer(request, { format: "x".repeat(2001) })).toBeNull();
    expect(clarificationAnswer(request, { format: " CSV " })).toBe("Answers to Output details:\n\nWhich format?\nCSV");
  });
});
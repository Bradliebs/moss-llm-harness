import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MossEvent } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { readFileTool, writeFileTool } from "../tools/fs-tools";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("JSON artifact completion in the shared turn loop", () => {
  it.each([true, false])("rejects the enclosing object and bounds correction (repair=%s)", async (repair) => {
    const root = mkdtempSync(join(tmpdir(), "moss-json-turn-"));
    roots.push(root);
    writeFileSync(join(root, "source.json"), '{"data":{"ready":false,"count":0}}');
    const events: MossEvent[] = [];
    const requests: ChatRequest[] = [];
    let round = 0;
    const provider: ChatProvider = {
      kind: "fixture", listModels: async () => [],
      async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
        requests.push({ ...request, messages: [...request.messages] });
        round++;
        if (round === 1) {
          yield { type: "tool-call", toolCall: { id: "read", name: "read_file", arguments: '{"path":"source.json"}' } };
        } else if (round === 2 || (round === 4 && repair)) {
          yield { type: "tool-call", toolCall: { id: `write-${round}`, name: "write_file", arguments: JSON.stringify({ path: "answer.json", content: round === 2 ? '{"data":{"ready":false,"count":0}}' : '{"count":0,"ready":false}' }) } };
        } else yield { type: "text-delta", text: "Done" };
      },
    };
    const tools = [readFileTool, writeFileTool];
    let hostChecks = 0;
    await runTurn({
      provider, model: "fixture", workspaceRoot: root, signal: new AbortController().signal,
      messages: [{ role: "user", content: "Write the data value from source.json to answer.json." }],
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      toolRegistry: new Map(tools.map((tool) => [tool.name, tool])),
      autoApprove: true, requestApproval: async () => ({ approved: true }), maxRounds: 5,
      jsonArtifactRequirements: [{ sourcePath: "source.json", valuePath: ["data"], outputPath: "answer.json" }],
      completionGuard: () => { hostChecks++; return { accept: true }; },
      onEvent: (event) => events.push(event),
    });
    expect(requests[3].messages.some((message) => message.content.includes("JSON artifact requirement 1 failed"))).toBe(true);
    expect(events.some((event) => event.type === "round-end" && event.finish === "rejected")).toBe(true);
    expect(events.some((event) => event.type === "turn-complete")).toBe(repair);
    expect(events.some((event) => event.type === "turn-error")).toBe(!repair);
    expect(hostChecks).toBe(repair ? 1 : 0);
    expect(events.filter((event) => event.type === "tool-call" && event.name === "write_file")).toHaveLength(repair ? 2 : 1);
    if (repair) expect(JSON.parse(readFileSync(join(root, "answer.json"), "utf8"))).toEqual({ ready: false, count: 0 });
  });
});
// Tool-call repair and find_tool inside the turn loop: calls written as text
// are recovered, schema mistakes are fixed or returned as precise errors
// without running, and a narrowed model can bring back a tool it needs.

import { describe, expect, it, vi } from "vitest";

import type { MossEvent, ToolDefinition } from "../../../common/types";
import { runTurn, type RunTurnOptions } from "./agent-runner";
import { findToolTool } from "./models/tool-index";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "./providers/types";
import type { Tool } from "./tools";

function scripted(rounds: ProviderStreamEvent[][], requests: ChatRequest[] = []): ChatProvider {
  let round = 0;
  return {
    kind: "test",
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      requests.push({ ...request, tools: request.tools ? [...request.tools] : undefined });
      const events = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      for (const event of events) yield event;
    },
    listModels: async () => [],
  };
}

function schemaTool(name: string, properties: Record<string, { type: string }>, required: string[], execute = vi.fn(async (args: Record<string, unknown>) => ({ ok: true, content: `${name} ${JSON.stringify(args)}` }))): Tool & { execute: typeof execute } {
  return { name, description: `${name} tool`, parameters: { type: "object", properties, required }, execute };
}

const definition = (tool: Tool): ToolDefinition => ({ name: tool.name, description: tool.description, parameters: tool.parameters });

async function run(provider: ChatProvider, tools: Tool[], extra: Partial<RunTurnOptions> = {}): Promise<MossEvent[]> {
  const events: MossEvent[] = [];
  await runTurn({
    provider,
    model: "m",
    messages: [{ role: "user", content: "go" }],
    tools: tools.map(definition),
    toolRegistry: new Map(tools.map((tool) => [tool.name, tool])),
    workspaceRoot: "/ws",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    requestApproval: async () => ({ approved: true }),
    streamRetryBaseMs: 0,
    ...extra,
  });
  return events;
}

const results = (events: MossEvent[]) => events.filter((event) => event.type === "tool-result") as Array<Extract<MossEvent, { type: "tool-result" }>>;
const notices = (events: MossEvent[]) => events.filter((event) => event.type === "notice").map((event) => (event as { message: string }).message);

describe("tool-call repair in the turn loop", () => {
  it("runs a call the model wrote as text instead of showing it as the answer", async () => {
    const read = schemaTool("read_file", { path: { type: "string" } }, ["path"]);
    const events = await run(scripted([
      [{ type: "text-delta", text: "<tool_call>{\"name\":\"read_file\",\"arguments\":{\"file\":\"a.md\"}}</tool_call>" }],
      [{ type: "text-delta", text: "It says hello." }],
    ]), [read]);
    expect(read.execute).toHaveBeenCalledWith({ path: "a.md" }, expect.anything());
    expect(notices(events)).toEqual(expect.arrayContaining([
      "Recovered 1 tool call the model wrote as text.",
      "Repaired read_file call: renamed argument file to path.",
    ]));
    expect(events.at(-1)).toMatchObject({ type: "turn-complete" });
  });

  it("returns a schema error instead of running an incomplete call", async () => {
    const write = schemaTool("write_file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]);
    const requests: ChatRequest[] = [];
    const events = await run(scripted([
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{\"path\":\"a.txt\"}" } }],
      [{ type: "text-delta", text: "ok" }],
    ], requests), [write]);
    expect(write.execute).not.toHaveBeenCalled();
    expect(results(events)[0]).toMatchObject({ ok: false, content: "Invalid arguments for write_file: missing required 'content'. Expected properties: path, content." });
  });
});

describe("find_tool in the turn loop", () => {
  it("offers a hidden catalog tool after the model asks for it", async () => {
    const read = schemaTool("read_file", { path: { type: "string" } }, ["path"]);
    const shell = schemaTool("run_command", { command: { type: "string" } }, ["command"]);
    const requests: ChatRequest[] = [];
    const events = await run(scripted([
      [{ type: "tool-call", toolCall: { id: "c1", name: "find_tool", arguments: "{\"need\":\"run a shell command\"}" } }],
      [{ type: "tool-call", toolCall: { id: "c2", name: "run_command", arguments: "{\"command\":\"ls\"}" } }],
      [{ type: "text-delta", text: "done" }],
    ], requests), [read, shell, findToolTool], {
      tools: [definition(read), definition(findToolTool)],
      toolCatalog: [definition(read), definition(shell)],
    });
    expect(requests[0].tools?.map((tool) => tool.name)).toEqual(["read_file", "find_tool"]);
    expect(requests[1].tools?.map((tool) => tool.name)).toContain("run_command");
    expect(results(events)[0]).toMatchObject({ ok: true, content: expect.stringContaining("- run_command: run_command tool") });
    expect(shell.execute).toHaveBeenCalledOnce();
    expect(notices(events)).toContain("find_tool enabled run_command.");
  });

  it("brings in a hidden tool the model calls directly", async () => {
    const read = schemaTool("read_file", { path: { type: "string" } }, ["path"]);
    const list = schemaTool("list_dir", { path: { type: "string" } }, []);
    const requests: ChatRequest[] = [];
    await run(scripted([
      [{ type: "tool-call", toolCall: { id: "c1", name: "list_dir", arguments: "{}" } }],
      [{ type: "text-delta", text: "done" }],
    ], requests), [read, list], { tools: [definition(read)], toolCatalog: [definition(read), definition(list)] });
    expect(list.execute).toHaveBeenCalledOnce();
    expect(requests[1].tools?.map((tool) => tool.name)).toEqual(["read_file", "list_dir"]);
  });
});


describe("learned procedures in the turn loop", () => {
  const procedureRun = (slots: Record<string, unknown>) => [{ type: "tool-call" as const, toolCall: { id: "p", name: "run_procedure", arguments: JSON.stringify({ procedure: "p-1", slots }) } }];
  const expander = (raw: string) => {
    const args = JSON.parse(raw) as { slots: Record<string, unknown> };
    if (!args.slots.path) return { error: "run_procedure p-1 needs slots: path." };
    return {
      procedureId: "p-1",
      name: "read_file → write_file",
      calls: [
        { id: "s1", name: "read_file", arguments: JSON.stringify({ path: args.slots.path }) },
        { id: "s2", name: "write_file", arguments: JSON.stringify({ path: args.slots.path, content: "x" }) },
      ],
    };
  };

  it("expands the procedure into ordinary calls that still go through the permission policy", async () => {
    const read = schemaTool("read_file", { path: { type: "string" } }, ["path"]);
    const write = schemaTool("write_file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]);
    const approvals: string[] = [];
    const events = await run(scripted([procedureRun({ path: "a.md" }), [{ type: "text-delta", text: "done" }]]), [read, write, { ...schemaTool("run_procedure", {}, []) }], {
      expandProcedure: expander,
      requestApproval: async (id) => { approvals.push(id); return { approved: true }; },
    });
    expect(read.execute).toHaveBeenCalledWith({ path: "a.md" }, expect.anything());
    expect(write.execute).toHaveBeenCalledOnce();
    // write_file is a change, so it still asked for approval.
    expect(approvals).toEqual(["s2"]);
    expect(events.filter((event) => event.type === "tool-call").map((event) => (event as { name: string }).name)).toEqual(["read_file", "write_file"]);
    expect(events.some((event) => event.type === "harness-decision" && event.decision.kind === "procedure")).toBe(true);
  });

  it("stops at the first failed step and reports missing slots without running anything", async () => {
    const read = schemaTool("read_file", { path: { type: "string" } }, ["path"], vi.fn(async () => ({ ok: false, content: "not found" })));
    const write = schemaTool("write_file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]);
    const events = await run(scripted([procedureRun({ path: "a.md" }), [{ type: "text-delta", text: "done" }]]), [read, write], { expandProcedure: expander, autoApprove: true });
    expect(write.execute).not.toHaveBeenCalled();
    expect(results(events).map((result) => result.content)).toEqual(["not found", "Skipped: an earlier step of procedure read_file → write_file failed. Continue by hand from here."]);

    const missing = await run(scripted([procedureRun({}), [{ type: "text-delta", text: "done" }]]), [read, write], { expandProcedure: expander });
    expect(results(missing)[0]).toMatchObject({ ok: false, content: "run_procedure p-1 needs slots: path." });
    expect(read.execute).toHaveBeenCalledOnce();
  });
});
import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "../../../../common/types";
import { INVALID_ARGUMENTS_PREFIX, parseTextToolCalls, repairToolCall } from "./tool-repair";

const READ: ToolDefinition = {
  name: "read_file",
  description: "Read a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const WRITE: ToolDefinition = {
  name: "write_file",
  description: "Write a file.",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
};
const WEATHER: ToolDefinition = {
  name: "get_weather",
  description: "Weather.",
  parameters: { type: "object", properties: { city: { type: "string" }, days: { type: "integer" } }, required: ["city"] },
};
const TOOLS = [READ, WRITE, WEATHER];

const call = (name: string, args: unknown) => ({ id: "c1", name, arguments: typeof args === "string" ? args : JSON.stringify(args) });

describe("parseTextToolCalls", () => {
  it("reads the common text formats small models use", () => {
    expect(parseTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a.md"}}</tool_call>', TOOLS)[0]).toMatchObject({ name: "read_file", arguments: '{"path":"a.md"}' });
    expect(parseTextToolCalls('[TOOL_CALLS] [{"name":"get_weather","arguments":{"city":"Oslo"}}]', TOOLS)[0]).toMatchObject({ name: "get_weather" });
    expect(parseTextToolCalls('Sure:\n```json\n{"tool":"read_file","parameters":{"path":"b.md"},}\n```', TOOLS)[0]).toMatchObject({ name: "read_file", arguments: '{"path":"b.md"}' });
    expect(parseTextToolCalls('{"function":{"name":"read_file","arguments":"{\\"path\\":\\"c.md\\"}"}}', TOOLS)[0]).toMatchObject({ arguments: '{"path":"c.md"}' });
    expect(parseTextToolCalls('read_file({"path": "d.md"})', TOOLS)[0]).toMatchObject({ name: "read_file", arguments: '{"path":"d.md"}' });
    expect(parseTextToolCalls('<think>maybe {"name":"write_file"}</think><tool_call>{"name":"read_file","arguments":{}}</tool_call>', TOOLS)).toHaveLength(1);
  });

  it("ignores prose, code samples, and tools that were not offered", () => {
    expect(parseTextToolCalls("Here is the answer: 42.", TOOLS)).toEqual([]);
    expect(parseTextToolCalls('```json\n{"name":"Alice","age":3}\n```', TOOLS)).toEqual([]);
    expect(parseTextToolCalls('<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>', TOOLS)).toEqual([]);
    expect(parseTextToolCalls('<tool_call>{"name":"read_file"}</tool_call>', [])).toEqual([]);
  });
});

describe("repairToolCall", () => {
  it("leaves a valid call untouched", () => {
    const original = call("read_file", { path: "a.md" });
    expect(repairToolCall(original, TOOLS)).toEqual({ call: original, repairs: [] });
  });

  it("renames tools and arguments, unwraps echoed schemas, and coerces types", () => {
    const repaired = repairToolCall(call("Get-Weather", { location: { type: "string", value: "Paris" }, days: "3" }), TOOLS);
    expect(repaired.error).toBeUndefined();
    expect(repaired.call.name).toBe("get_weather");
    expect(JSON.parse(repaired.call.arguments)).toEqual({ city: "Paris", days: 3 });
    expect(repaired.repairs).toEqual(expect.arrayContaining([
      "renamed tool Get-Weather to get_weather",
      "unwrapped echoed schema for location",
      "renamed argument location to city",
      "converted days to a number",
    ]));
    expect(JSON.parse(repairToolCall(call("write_file", { file_path: "x", contents: "y" }), TOOLS).call.arguments)).toEqual({ path: "x", content: "y" });
    expect(JSON.parse(repairToolCall(call("write_file", { path: 7, content: "y" }), TOOLS).call.arguments)).toEqual({ path: "7", content: "y" });
  });

  it("keeps object arguments that happen to look like an echoed schema", () => {
    const FORM: ToolDefinition = { name: "fill", description: "", parameters: { type: "object", properties: { field: { type: "object" }, label: { type: "string" } }, required: ["field"] } };
    const kept = repairToolCall(call("fill", { field: { type: "text", value: "hello" } }), [FORM]);
    expect(kept).toEqual({ call: call("fill", { field: { type: "text", value: "hello" } }), repairs: [] });
    expect(JSON.parse(repairToolCall(call("fill", { field: {}, label: { type: "string", value: "Name" } }), [FORM]).call.arguments)).toEqual({ field: {}, label: "Name" });
  });

  it("returns a schema error the model can act on instead of running a broken call", () => {
    const missing = repairToolCall(call("write_file", { path: "a.txt" }), TOOLS);
    expect(missing.error).toBe(`${INVALID_ARGUMENTS_PREFIX} write_file: missing required 'content'. Expected properties: path, content.`);
    expect(repairToolCall(call("read_file", "{ not json"), TOOLS).error).toMatch(/^Invalid JSON arguments for read_file: \{ not json\. Send a JSON object with properties: path\.$/);
    // An empty string is a real value, for example an empty file.
    expect(repairToolCall(call("write_file", { path: "a.txt", content: "" }), TOOLS).error).toBeUndefined();
  });

  it("leaves unknown tools for the runner to report", () => {
    const unknown = call("launch_rockets", {});
    expect(repairToolCall(unknown, TOOLS)).toEqual({ call: unknown, repairs: [] });
  });
});

import { describe, expect, it } from "vitest";

import { compactDiff, describeToolCall, diffStats, lineDiff } from "./toolPreview";

describe("describeToolCall", () => {
  it("shows an email's recipients, subject, and body", () => {
    expect(describeToolCall("send_email", JSON.stringify({ to: "a@b.com, c@d.com", subject: "Hi", body: "Hello", html: "<b>Hello</b>" })))
      .toEqual({ kind: "email", to: ["a@b.com", "c@d.com"], subject: "Hi", body: "Hello", html: "<b>Hello</b>" });
  });

  it("recognizes file writes, edits, moves, and commands", () => {
    expect(describeToolCall("write_file", JSON.stringify({ path: "a.ts", content: "x" }))).toEqual({ kind: "write", path: "a.ts", content: "x" });
    expect(describeToolCall("edit_file", JSON.stringify({ path: "a.ts", oldText: "a", newText: "b", replaceAll: true })))
      .toEqual({ kind: "edit", path: "a.ts", oldText: "a", newText: "b", replaceAll: true });
    expect(describeToolCall("move_file", JSON.stringify({ from: "a", to: "b" }))).toEqual({ kind: "move", from: "a", to: "b" });
    expect(describeToolCall("run_command", JSON.stringify({ command: "npm test" }))).toEqual({ kind: "command", command: "npm test", timeoutSeconds: 60 });
    expect(describeToolCall("run_command", JSON.stringify({ command: "npm test", timeoutSeconds: 300 }))).toMatchObject({ timeoutSeconds: 300 });
    expect(describeToolCall("run_command", JSON.stringify({ command: "npm test", timeoutSeconds: 9_999 }))).toMatchObject({ timeoutSeconds: 600 });
  });

  it("falls back to formatted JSON or raw text", () => {
    expect(describeToolCall("other", "{\"a\":1}")).toEqual({ kind: "generic", formatted: "{\n  \"a\": 1\n}" });
    expect(describeToolCall("write_file", "not json")).toEqual({ kind: "generic", formatted: "not json" });
  });
});

describe("lineDiff", () => {
  it("marks added and removed lines", () => {
    const diff = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")!;
    expect(diff).toEqual([
      { type: "same", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "B" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("returns null for very large inputs", () => {
    expect(lineDiff("x\n".repeat(1000), "y\n".repeat(1000))).toBeNull();
  });

  it("collapses long unchanged runs", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "changed");
    const compact = compactDiff(lineDiff(before, after)!, 1);
    expect(compact[0]).toEqual({ type: "gap", count: 9 });
    expect(compact.at(-1)).toEqual({ type: "gap", count: 8 });
  });
});

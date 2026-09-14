import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonArtifactGuard } from "./json-artifact-guard";

const roots: string[] = [];
const signal = new AbortController().signal;
function setup(valuePath = ["payload"], onReadFailure?: "require-absent") {
  const root = mkdtempSync(join(tmpdir(), "moss-json-guard-"));
  roots.push(root);
  const guard = new JsonArtifactGuard([{ sourcePath: "source.json", valuePath, outputPath: "answer.json", onReadFailure }], root);
  return { root, guard, write: (value: unknown) => writeFileSync(join(root, "answer.json"), JSON.stringify(value)) };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("public JSON artifact guard", () => {
  it.each([null, false, 0, "", [1, 2], { count: 17, unit: "crates" }])("compares actual output against the observed source value: %j", async (value) => {
    const { guard, write } = setup();
    guard.observe("read_file", { path: "./source.json" }, { ok: true, content: JSON.stringify({ payload: value }) });
    write({ payload: value });
    expect((await guard.check(signal)).accept).toBe(false);
    write(value);
    expect((await guard.check(signal)).accept).toBe(true);
  });

  it("supports nested arrays and ignores object key order", async () => {
    const { guard, write } = setup(["items", "0", "value"]);
    guard.observe("read_file", { path: "source.json" }, { ok: true, content: '{"items":[{"value":{"first":1,"second":2}}]}' });
    write({ second: 2, first: 1 });
    expect((await guard.check(signal)).accept).toBe(true);
  });

  it("requires observed reads and rejects missing paths and malformed JSON", async () => {
    const { root, guard, write } = setup();
    writeFileSync(join(root, "source.json"), '{"payload":1}');
    write(1);
    expect((await guard.check(signal)).accept).toBe(false);
    for (const content of ['{"other":1}', "broken"]) {
      guard.observe("read_file", { path: "source.json" }, { ok: true, content });
      expect((await guard.check(signal)).accept).toBe(false);
    }
  });

  it("permits absent output after an explicit failed read but never bypasses that failure", async () => {
    const { root, guard, write } = setup(["payload"], "require-absent");
    writeFileSync(join(root, "source.json"), '{"payload":1}');
    expect((await guard.check(signal)).accept).toBe(false);
    guard.observe("read_file", { path: "source.json" }, { ok: false, content: "unavailable" });
    expect((await guard.check(signal)).accept).toBe(true);
    write(1);
    expect((await guard.check(signal)).accept).toBe(false);
  });

  it("does not let a later failed read erase a successful source observation", async () => {
    const { guard } = setup(["payload"], "require-absent");
    guard.observe("read_file", { path: "source.json" }, { ok: true, content: '{"payload":1}' });
    guard.observe("read_file", { path: "source.json" }, { ok: false, content: "unavailable" });
    expect((await guard.check(signal)).accept).toBe(false);
  });

  it("rejects missing, malformed, oversized, linked output and cancellation", async () => {
    const { root, guard, write } = setup();
    guard.observe("read_file", { path: "source.json" }, { ok: true, content: '{"payload":1}' });
    expect((await guard.check(signal)).accept).toBe(false);
    writeFileSync(join(root, "answer.json"), "invalid");
    expect((await guard.check(signal)).accept).toBe(false);
    write("x".repeat(400_001));
    expect((await guard.check(signal)).accept).toBe(false);
    write(1);
    expect((await guard.check(AbortSignal.abort())).accept).toBe(false);
    linkSync(join(root, "answer.json"), join(root, "alias.json"));
    expect((await guard.check(signal)).accept).toBe(false);
  });

  it("rejects output redirected outside the workspace", async () => {
    const { root } = setup();
    const outside = mkdtempSync(join(tmpdir(), "moss-json-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "answer.json"), "1");
    symlinkSync(outside, join(root, "redirect"), "junction");
    const guard = new JsonArtifactGuard([{ sourcePath: "source.json", outputPath: "redirect/answer.json", valuePath: ["payload"] }], root);
    guard.observe("read_file", { path: "source.json" }, { ok: true, content: '{"payload":1}' });
    expect((await guard.check(signal)).accept).toBe(false);
  });

  it("rejects escaping or identical source and output paths", () => {
    const { root } = setup();
    for (const outputPath of ["../escape.json", "source.json"]) {
      expect(() => new JsonArtifactGuard([{ sourcePath: "source.json", outputPath, valuePath: [] }], root)).toThrow();
    }
  });
});
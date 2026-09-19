import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessDiagnosticArtifactStore, HarnessDiagnosticCapture } from "./diagnostic-artifact-store";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "moss-diagnostics-"));
  roots.push(root);
  return join(root, "private");
}

describe("HarnessDiagnosticArtifactStore", () => {
  it("does not create a directory until capture is explicitly written", () => {
    const root = directory();
    new HarnessDiagnosticArtifactStore(root);
    expect(existsSync(root)).toBe(false);
  });

  it("redacts nested and JSON-encoded secrets before persistence and deduplicates payloads", () => {
    const root = directory();
    const store = new HarnessDiagnosticArtifactStore(root);
    const capture = new HarnessDiagnosticCapture();
    const value = { password: "fixture-password", arguments: '{"apiKey":"fixture-api-key","path":"answer.txt"}' };
    capture.append("tool-call", value);
    capture.append("tool-call", value);
    const reference = store.write(capture);
    expect(store.write(capture)).toEqual(reference);
    const serialized = readFileSync(join(root, `${reference.sha256}.json`), "utf8");
    expect(serialized).not.toContain("fixture-password");
    expect(serialized).not.toContain("fixture-api-key");
    const artifact = store.read(reference);
    expect(artifact.events).toHaveLength(2);
    expect(Object.keys(artifact.payloads)).toHaveLength(1);
    expect(readdirSync(root)).toEqual([`${reference.sha256}.json`]);
  });

  it("rejects tampered artifacts and path-shaped references", () => {
    const root = directory();
    const store = new HarnessDiagnosticArtifactStore(root);
    const reference = store.write(new HarnessDiagnosticCapture());
    writeFileSync(join(root, `${reference.sha256}.json`), "{}");
    expect(() => store.read(reference)).toThrow("digest mismatch");
    expect(() => store.read({ schemaVersion: 1, sha256: "../outside" })).toThrow("Invalid diagnostic reference");
  });

  it("bounds oversized payloads and event counts with an explicit truncation marker", () => {
    const capture = new HarnessDiagnosticCapture();
    capture.append("tool-result", "x".repeat(70_000));
    for (let index = 0; index < 1100; index++) capture.append("event", index);
    const artifact = capture.snapshot();
    expect(artifact.truncated).toBe(true);
    expect(artifact.events).toHaveLength(1024);
    expect(JSON.stringify(artifact)).toContain("payload-size-limit");
    expect(() => new HarnessDiagnosticArtifactStore(directory()).write(capture)).not.toThrow();
  });

  it("marks traversal omissions without mistaking repeated values for cycles", () => {
    const shared = { value: "kept" };
    const capture = new HarnessDiagnosticCapture();
    capture.append("repeated", [shared, shared]);
    expect(capture.snapshot().truncated).toBe(false);
    capture.append("large-array", Array.from({ length: 1025 }, () => 1));
    expect(capture.snapshot().truncated).toBe(true);
  });

  it.each([null, { schemaVersion: 1, events: [null], payloads: {}, truncated: false },
    { schemaVersion: 1, events: [{ sequence: 1, kind: "event", payload: "toString" }], payloads: {}, truncated: false },
  ])("rejects malformed artifacts even with a matching file digest: %j", (artifact) => {
    const root = directory();
    const store = new HarnessDiagnosticArtifactStore(root);
    store.write(new HarnessDiagnosticCapture());
    const serialized = JSON.stringify(artifact);
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    writeFileSync(join(root, `${sha256}.json`), serialized);
    expect(() => store.read({ schemaVersion: 1, sha256 })).toThrow("Invalid diagnostic artifact schema");
  });

  it("records sanitized immutable corrections without changing the original", () => {
    const root = directory();
    const store = new HarnessDiagnosticArtifactStore(root);
    const original = store.write(new HarnessDiagnosticCapture());
    const before = readFileSync(join(root, `${original.sha256}.json`), "utf8");
    const correction = { reviewedBy: "reviewer", reason: "Bearer abcdefghijklmnopqrstuvwxyz", success: true, score: 1 };
    const first = store.recordCorrection(original, correction);
    const second = store.recordCorrection(original, correction);
    expect(first).not.toEqual(second);
    expect(JSON.stringify(store.read(first))).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(readFileSync(join(root, `${original.sha256}.json`), "utf8")).toBe(before);
    expect(() => store.recordCorrection(original, { reviewedBy: "reviewer", reason: "note only" })).toThrow("Invalid diagnostic correction");
    expect(() => store.recordCorrection(original, { ...correction, score: 2 })).toThrow("Invalid diagnostic correction");
  });
});
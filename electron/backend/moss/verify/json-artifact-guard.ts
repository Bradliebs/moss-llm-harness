import { open, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { JsonArtifactRequirement } from "../../../../common/verification";
import { resolveInWorkspace } from "../tools/path-guard";
import type { ToolResult } from "../tools/types";

const MAX_JSON_BYTES = 400_000;
type SourceState = { status: "unread" | "failed" | "invalid" } | { status: "read"; value: unknown };

export class JsonArtifactGuard {
  private readonly sources: SourceState[];

  constructor(private readonly requirements: readonly JsonArtifactRequirement[], private readonly workspaceRoot: string) {
    for (const requirement of requirements) {
      const source = resolveInWorkspace(workspaceRoot, requirement.sourcePath);
      const output = resolveInWorkspace(workspaceRoot, requirement.outputPath);
      if (source === output) throw new Error("JSON artifact source and output must differ");
      if (!Array.isArray(requirement.valuePath) || !requirement.valuePath.every((key) => typeof key === "string")) {
        throw new Error("JSON artifact valuePath must be an array of property names");
      }
    }
    this.sources = requirements.map(() => ({ status: "unread" }));
  }

  observe(name: string, args: Record<string, unknown> | string, result: ToolResult): void {
    if (name !== "read_file") return;
    let path: string;
    try {
      const parsed: unknown = typeof args === "string" ? JSON.parse(args) : args;
      if (!parsed || typeof parsed !== "object" || !("path" in parsed) || typeof parsed.path !== "string") return;
      path = resolveInWorkspace(this.workspaceRoot, parsed.path);
    } catch { return; }
    this.requirements.forEach((requirement, index) => {
      if (path !== resolveInWorkspace(this.workspaceRoot, requirement.sourcePath)) return;
      if (!result.ok) {
        if (this.sources[index].status !== "read") this.sources[index] = { status: "failed" };
        return;
      }
      try {
        let value: unknown = JSON.parse(result.content);
        for (const key of requirement.valuePath) {
          if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)
            || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error("Missing JSON value");
          value = (value as Record<string, unknown>)[key];
        }
        this.sources[index] = { status: "read", value };
      } catch {
        this.sources[index] = { status: "invalid" };
      }
    });
  }

  async check(signal: AbortSignal): Promise<{ accept: boolean; feedback?: string }> {
    for (const [index, requirement] of this.requirements.entries()) {
      if (signal.aborted) return { accept: false, feedback: "JSON artifact verification aborted." };
      const source = this.sources[index];
      const feedback = `JSON artifact requirement ${index + 1} failed: output must equal the declared source value, not its enclosing object. Correct only the required artifact.`;
      if (source.status === "unread" || source.status === "invalid") {
        return { accept: false, feedback: `JSON artifact requirement ${index + 1} needs a successful source read containing the declared value path.` };
      }
      const output = resolveInWorkspace(this.workspaceRoot, requirement.outputPath);
      let resolved: string;
      try {
        resolved = await realpath(output);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && source.status === "failed" && requirement.onReadFailure === "require-absent") continue;
        return { accept: false, feedback };
      }
      if (source.status !== "read") return { accept: false, feedback: "The source read failed; the declared output must remain absent." };
      try {
        resolveInWorkspace(await realpath(this.workspaceRoot), resolved);
        const handle = await open(resolved, "r");
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_JSON_BYTES) return { accept: false, feedback };
          const buffer = Buffer.alloc(MAX_JSON_BYTES + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > MAX_JSON_BYTES || signal.aborted) return { accept: false, feedback };
          const actual: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
          if (!isDeepStrictEqual(actual, source.value)) return { accept: false, feedback };
        } finally {
          await handle.close();
        }
      } catch {
        return { accept: false, feedback };
      }
    }
    return { accept: !signal.aborted };
  }
}
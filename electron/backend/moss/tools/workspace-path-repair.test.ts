import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { repairPathArguments, repairWorkspacePath } from "./workspace-path-repair";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "moss-path-repair-"));
  mkdirSync(join(ws, "src"));
  writeFileSync(join(ws, "src", "a.js"), "x");
  writeFileSync(join(ws, "config.json"), "{}");
  mkdirSync(join(ws, "app", "models"), { recursive: true });
  writeFileSync(join(ws, "app", "models", "user.rb"), "x");
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("repairWorkspacePath", () => {
  it("reads container-style and slash-led paths as the workspace path they mean", () => {
    expect(repairWorkspacePath(ws, "/workspace/src/a.js")).toBe("src/a.js");
    expect(repairWorkspacePath(ws, "\\repo\\src\\a.js")).toBe("src/a.js");
    expect(repairWorkspacePath(ws, "/src/a.js")).toBe("src/a.js");
    // A new file in a folder that exists, or at the root of a container path.
    expect(repairWorkspacePath(ws, "/workspace/src/new.js")).toBe("src/new.js");
    expect(repairWorkspacePath(ws, "/workspace/slugify.js")).toBe("slugify.js");
    // The literal reading wins: a Rails project has its own app/ folder.
    expect(repairWorkspacePath(ws, "/app/models/user.rb")).toBe("app/models/user.rb");
    // A bare container root is the workspace itself.
    expect(repairWorkspacePath(ws, "/workspace")).toBe(".");
    expect(repairWorkspacePath(ws, "/workspace/")).toBe(".");
    expect(repairWorkspacePath(ws, "/tmp")).toBeUndefined();
  });

  it("leaves paths with no clear workspace reading alone", () => {
    expect(repairWorkspacePath(ws, "src/a.js")).toBeUndefined();
    expect(repairWorkspacePath(ws, join(ws, "src", "a.js"))).toBeUndefined();
    expect(repairWorkspacePath(ws, "/tmp/config.json")).toBeUndefined();
    expect(repairWorkspacePath(ws, "/etc/new/file.txt")).toBeUndefined();
    expect(repairWorkspacePath(ws, "/workspace/../outside.txt")).toBeUndefined();
    expect(repairWorkspacePath(ws, "//server/share/src/a.js")).toBeUndefined();
    expect(repairWorkspacePath(ws, "C:\\other\\a.js")).toBeUndefined();
    expect(repairWorkspacePath("", "/workspace/src/a.js")).toBeUndefined();
  });
});

describe("repairPathArguments", () => {
  it("rewrites only the path arguments of file tools, and says what changed", () => {
    const moved = repairPathArguments({ id: "c1", name: "move_file", arguments: JSON.stringify({ from: "/workspace/src/a.js", to: "/workspace/src/b.js" }) }, ws);
    expect(JSON.parse(moved.call.arguments)).toEqual({ from: "src/a.js", to: "src/b.js" });
    expect(moved.repairs).toEqual(["read from /workspace/src/a.js as src/a.js in the workspace", "read to /workspace/src/b.js as src/b.js in the workspace"]);
    const command = { id: "c2", name: "run_command", arguments: JSON.stringify({ command: "cat /workspace/src/a.js" }) };
    expect(repairPathArguments(command, ws)).toEqual({ call: command, repairs: [] });
    const fine = { id: "c3", name: "read_file", arguments: JSON.stringify({ path: "src/a.js" }) };
    expect(repairPathArguments(fine, ws)).toEqual({ call: fine, repairs: [] });
    expect(repairPathArguments({ id: "c4", name: "read_file", arguments: "{not json" }, ws).repairs).toEqual([]);
    const glob = repairPathArguments({ id: "c5", name: "glob_files", arguments: JSON.stringify({ pattern: "/workspace/src/**/*.js" }) }, ws);
    expect(JSON.parse(glob.call.arguments)).toEqual({ pattern: "src/**/*.js" });
    const slashGlob = repairPathArguments({ id: "c6", name: "glob_files", arguments: JSON.stringify({ pattern: "/src/*.js" }) }, ws);
    expect(JSON.parse(slashGlob.call.arguments)).toEqual({ pattern: "src/*.js" });
    const plainGlob = { id: "c7", name: "glob_files", arguments: JSON.stringify({ pattern: "**/*.js" }) };
    expect(repairPathArguments(plainGlob, ws)).toEqual({ call: plainGlob, repairs: [] });
  });
});

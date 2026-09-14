import { cpSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserCases } from "./browser-cases";
import { BROWSER_EVAL_STATE_FILE, createBrowserEvalTools, type BrowserEvalState } from "./browser-eval-tools";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("local production browser eval tools", () => {
  it.each(["Draft", undefined])("rejects wrong ownership and targets, then persists a draft transition with name %s", async (name) => {
    const root = mkdtempSync(join(tmpdir(), "moss-browser-behavior-"));
    roots.push(root);
    const initial: BrowserEvalState = { currentTab: "tab-a", tabs: [
      { sessionId: "tab-a", taskId: "task-1", url: "https://browser.eval.test/draft", draft: "old", saved: "old", open: false, saves: 0 },
      { sessionId: "tab-b", taskId: "task-2", url: "https://browser.eval.test/draft", draft: "private", saved: "private", open: false, saves: 0 },
    ] };
    const path = join(root, BROWSER_EVAL_STATE_FILE);
    writeFileSync(path, JSON.stringify(initial));
    const tools = createBrowserEvalTools(root);
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const execute = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      return tool.execute({ taskId: "task-1", sessionId: "tab-a", ...args }, context);
    };
    expect((await execute("browser_open_session", { sessionId: "tab-b" })).ok).toBe(false);
    expect((await execute("browser_open_session", { taskId: "task-2", sessionId: "tab-b" })).ok).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(initial);
    expect((await execute("browser_type", { role: "textbox", name: "Draft", text: "bad" })).ok).toBe(false);
    expect((await execute("browser_open_session", {})).ok).toBe(true);
    expect((await execute("browser_type", { role: "textbox", name: "Wrong", text: "bad" })).ok).toBe(false);
    expect((await execute("browser_type", { role: "button", text: "bad" })).ok).toBe(false);
    expect((await execute("browser_navigate", { url: "https://example.com" })).ok).toBe(false);
    expect((await execute("browser_screenshot", { path: "../outside.png" })).ok).toBe(false);
    expect((await execute("browser_type", { role: "textbox", name, text: "Ready for review", clear: true })).ok).toBe(true);
    expect((await execute("browser_click", { role: "button", name: "Save draft" })).ok).toBe(true);
    expect((await execute("browser_close_session", {})).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...initial, tabs: [
      { ...initial.tabs[0], draft: "Ready for review", saved: "Ready for review", saves: 1 }, initial.tabs[1],
    ] });
  });

  it("rejects mismatched workspaces, cancelled calls, screenshots, and linked state without outside writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-browser-behavior-scope-"));
    const outside = mkdtempSync(join(tmpdir(), "moss-browser-behavior-outside-"));
    roots.push(root, outside);
    cpSync(createBrowserCases()[0].fixture!.workspaceTemplate!, root, { recursive: true });
    const tools = createBrowserEvalTools(root);
    const open = tools.find((tool) => tool.name === "browser_open_session")!;
    const screenshot = tools.find((tool) => tool.name === "browser_screenshot")!;
    const args = { taskId: "task-1", sessionId: "tab-a" };
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const statePath = join(root, BROWSER_EVAL_STATE_FILE);
    const initial = readFileSync(statePath, "utf8");
    expect((await open.execute(args, { ...context, workspaceRoot: outside })).ok).toBe(false);
    expect((await open.execute(args, { ...context, signal: AbortSignal.abort() })).ok).toBe(false);
    expect(readFileSync(statePath, "utf8")).toBe(initial);
    expect((await open.execute(args, context)).ok).toBe(true);
    for (const path of ["capture.png", join(outside, "capture.png")]) {
      expect((await screenshot.execute({ ...args, path }, context)).ok).toBe(false);
    }
    expect(existsSync(join(root, "capture.png"))).toBe(false);
    expect(existsSync(join(outside, "capture.png"))).toBe(false);
    const linkedState = join(outside, BROWSER_EVAL_STATE_FILE);
    linkSync(statePath, linkedState);
    const before = readFileSync(linkedState, "utf8");
    const type = tools.find((tool) => tool.name === "browser_type")!;
    expect((await type.execute({ ...args, role: "textbox", name: "Draft", text: "escape" }, context)).ok).toBe(false);
    expect(() => createBrowserEvalTools(root)).toThrow("workspace-local regular file");
    expect(readFileSync(linkedState, "utf8")).toBe(before);
  });
});
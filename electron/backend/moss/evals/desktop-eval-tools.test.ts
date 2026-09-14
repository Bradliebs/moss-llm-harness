import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopEvalTools, type DesktopEvalMode } from "./desktop-eval-tools";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup(mode: DesktopEvalMode = "available") {
  const root = mkdtempSync(join(tmpdir(), "moss-desktop-behavior-"));
  roots.push(root);
  const tools = createDesktopEvalTools(root, mode);
  return {
    state: () => JSON.parse(readFileSync(join(root, "desktop-behavior-state.json"), "utf8")) as unknown,
    async call(name: string, args: Record<string, unknown> = {}) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing desktop tool: ${name}`);
      return tool.execute({ taskId: "task", sessionId: "session", ...args }, { workspaceRoot: root, signal: new AbortController().signal });
    },
  };
}

const scope = { processName: "moss-eval-preferences.exe", windowTitle: "Moss Eval Preferences" };

describe("safe desktop evaluation tools", () => {
  it("uses production sessions and selects an actual preference", async () => {
    const service = setup();
    expect((await service.call("desktop_open_session", scope)).ok).toBe(true);
    expect((await service.call("desktop_inspect")).content).toContain('"name":"Theme"');
    expect((await service.call("desktop_select", { automationId: "theme", name: "Theme", option: "Dark" })).ok).toBe(true);
    expect((await service.call("desktop_assert_control", { automationId: "theme", property: "value", expected: "Dark" })).ok).toBe(true);
    expect((await service.call("desktop_close_session")).ok).toBe(true);
    expect(service.state()).toEqual({ theme: "Dark", notifications: "On", openSessions: 0, inspections: 1, selections: 1 });
    expect((await service.call("desktop_inspect")).ok).toBe(false);
  });

  it.each(["available", "stale"] as const)("rejects wrong targets and invalid options in %s mode without mutation", async (mode) => {
    const service = setup(mode);
    await service.call("desktop_open_session", scope);
    const before = service.state();
    for (const selector of [
      { automationId: "old-theme", option: "Dark" },
      { automationId: "notifications", name: "Theme", option: "Dark" },
      { automationId: "notifications", option: "Dark" },
      { automationId: "theme", option: "Off" },
      { controlType: "ComboBox", option: "Dark" },
      { x: 10, y: 20, option: "Dark" },
    ]) expect((await service.call("desktop_select", selector)).ok).toBe(false);
    if (mode === "stale") {
      expect((await service.call("desktop_select", { automationId: "theme", name: "Theme", option: "Dark" })).ok).toBe(false);
      expect((await service.call("desktop_assert_control", { automationId: "theme", property: "exists", expected: false })).ok).toBe(true);
    }
    expect(service.state()).toEqual(before);
  });

  it("rejects real applications and unsupported actions", async () => {
    const service = setup();
    expect((await service.call("desktop_open_session", { ...scope, processName: "notepad.exe" })).ok).toBe(false);
    await service.call("desktop_open_session", scope);
    expect((await service.call("desktop_type", { automationId: "theme", text: "Dark" })).ok).toBe(false);
    expect((await service.call("desktop_invoke", { name: "Save" })).ok).toBe(false);
    expect((await service.call("desktop_screenshot", { path: "capture.png" })).ok).toBe(false);
    expect(service.state()).toEqual({ theme: "Light", notifications: "On", openSessions: 1, inspections: 0, selections: 0 });
  });
});
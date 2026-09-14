import { writeFileSync } from "node:fs";

import { createDesktopTools, type DesktopControlSelector, type DesktopDriver } from "../desktop/desktop-tools";
import { resolveInWorkspace } from "../tools/path-guard";
import type { Tool } from "../tools/types";

export type DesktopEvalMode = "available" | "stale";

export function createDesktopEvalTools(workspaceRoot: string, mode: DesktopEvalMode = "available"): Tool[] {
  if (mode !== "available" && mode !== "stale") throw new Error("Unknown desktop evaluation mode");
  const statePath = resolveInWorkspace(workspaceRoot, "desktop-behavior-state.json");
  const state = { theme: "Light", notifications: "On", openSessions: 0, inspections: 0, selections: 0 };
  const persist = (): void => writeFileSync(statePath, JSON.stringify(state, null, 2));
  const controls = [
    ...(mode === "available" ? [{ automationId: "theme", name: "Theme", controlType: "ComboBox", options: ["Light", "Dark"] }] : []),
    { automationId: "notifications", name: "Notifications", controlType: "ComboBox", options: ["On", "Off"] },
  ];
  const matches = (target: DesktopControlSelector) => controls.filter((control) =>
    Object.entries(target).every(([key, value]) => value === undefined || control[key as keyof DesktopControlSelector] === value));
  const unsupported = async (): Promise<never> => { throw new Error("Unsupported action in the desktop evaluation service"); };
  persist();
  return createDesktopTools({
    platform: "win32",
    allowedProcesses: ["moss-eval-preferences.exe"],
    allowedWindows: ["Moss Eval Preferences"],
    driverFactory: async (): Promise<DesktopDriver> => {
      state.openSessions++;
      persist();
      return {
        async inspect() {
          state.inspections++;
          persist();
          return JSON.stringify(controls.map((control) => ({ ...control, enabled: true, value: control.automationId === "theme" ? state.theme : state.notifications })));
        },
        async select(target, option) {
          const candidates = matches(target);
          if (candidates.length !== 1) throw new Error("Missing, stale, or ambiguous desktop control");
          const control = candidates[0];
          if (!control.options.includes(option)) throw new Error("Option is unavailable for this desktop control");
          if (control.automationId === "theme") state.theme = option;
          else state.notifications = option;
          state.selections++;
          persist();
        },
        async controlState(target) {
          const candidates = matches(target);
          if (candidates.length > 1) throw new Error("Ambiguous desktop control");
          if (candidates.length === 0) return { exists: false };
          return { exists: true, enabled: true, value: candidates[0].automationId === "theme" ? state.theme : state.notifications };
        },
        invoke: unsupported,
        type: unsupported,
        screenshot: unsupported,
        async close() {
          state.openSessions--;
          persist();
        },
      };
    },
  });
}
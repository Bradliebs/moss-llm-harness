import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrowserTools, type BrowserTarget } from "../browser/browser-tools";
import type { Tool } from "../tools/types";

export const BROWSER_EVAL_STATE_FILE = "browser-behavior-state.json";

export interface BrowserEvalTab {
  sessionId: string;
  taskId: string;
  url: string;
  draft: string;
  saved: string;
  open: boolean;
  saves: number;
}

export interface BrowserEvalState {
  currentTab: string;
  tabs: BrowserEvalTab[];
}

function parseState(raw: string): BrowserEvalState {
  const state: unknown = JSON.parse(raw);
  if (!state || typeof state !== "object" || !("currentTab" in state)
    || typeof state.currentTab !== "string" || !("tabs" in state) || !Array.isArray(state.tabs)) {
    throw new Error("Invalid browser eval state");
  }
  const tabs = state.tabs.map((tab: unknown): BrowserEvalTab => {
    if (!tab || typeof tab !== "object"
      || !("sessionId" in tab) || typeof tab.sessionId !== "string"
      || !("taskId" in tab) || typeof tab.taskId !== "string"
      || !("url" in tab) || tab.url !== "https://browser.eval.test/draft"
      || !("draft" in tab) || typeof tab.draft !== "string"
      || !("saved" in tab) || typeof tab.saved !== "string"
      || !("open" in tab) || tab.open !== false
      || !("saves" in tab) || tab.saves !== 0) throw new Error("Invalid browser eval tab");
    return { sessionId: tab.sessionId, taskId: tab.taskId, url: tab.url, draft: tab.draft, saved: tab.saved, open: tab.open, saves: tab.saves };
  });
  if (new Set(tabs.map((tab) => tab.sessionId)).size !== tabs.length
    || !tabs.some((tab) => tab.sessionId === state.currentTab)) throw new Error("Invalid browser eval sessions");
  return { currentTab: state.currentTab, tabs };
}

export function createBrowserEvalTools(workspaceRoot: string): Tool[] {
  const root = realpathSync(workspaceRoot);
  const statePath = join(root, BROWSER_EVAL_STATE_FILE);
  const assertStatePath = (): void => {
    if (realpathSync(workspaceRoot) !== root || lstatSync(statePath).isSymbolicLink()
      || !lstatSync(statePath).isFile() || lstatSync(statePath).nlink !== 1
      || realpathSync(statePath) !== statePath) throw new Error("Browser eval state must remain a workspace-local regular file");
  };
  assertStatePath();
  const state = parseState(readFileSync(statePath, "utf8"));
  const persist = (): void => {
    assertStatePath();
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  };
  const tools = createBrowserTools({
    allowedDomains: ["browser.eval.test"],
    driverFactory: async ({ taskId, sessionId }) => {
      const tab = state.tabs.find((candidate) => candidate.sessionId === sessionId);
      if (taskId !== "task-1" || !tab || tab.taskId !== taskId) throw new Error("Browser tab is not owned by this task");
      const assertTarget = (target: BrowserTarget, role: string, name: string): void => {
        if (target.selector || target.role !== role || (target.name !== undefined && target.name !== name)) throw new Error("No matching browser target");
      };
      tab.open = true;
      persist();
      return {
        navigate: async (url) => {
          if (url !== "https://browser.eval.test/draft") throw new Error("Unknown local browser page");
          tab.url = url;
          persist();
        },
        inspect: async () => `Session ${tab.sessionId}; owner ${tab.taskId}; current tab ${state.currentTab}\ntextbox Draft: ${tab.draft}\nbutton Save draft\nSaved: ${tab.saved}`,
        click: async (target) => {
          assertTarget(target, "button", "Save draft");
          tab.saved = tab.draft;
          tab.saves += 1;
          persist();
        },
        type: async (target, text, clear) => {
          assertTarget(target, "textbox", "Draft");
          tab.draft = clear ? text : tab.draft + text;
          persist();
        },
        screenshot: async () => { throw new Error("Screenshots are unsupported by the local browser eval driver"); },
        currentUrl: async () => tab.url,
        pageText: async () => `Draft: ${tab.draft}\nSaved: ${tab.saved}`,
        close: async () => { tab.open = false; persist(); },
      };
    },
  });
  return tools.map((tool): Tool => ({
    ...tool,
    execute: async (args, context) => {
      try {
        if (context.signal.aborted) throw new Error("Browser eval operation aborted");
        if (realpathSync(context.workspaceRoot) !== root) throw new Error("Browser eval workspace mismatch");
        assertStatePath();
        return await tool.execute(args, context);
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    },
  }));
}
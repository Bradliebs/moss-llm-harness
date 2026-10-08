import { describe, expect, it } from "vitest";

import type { AgentMessage, ToolDefinition } from "../../../../common/types";
import { findToolDefinition, planToolDeferral } from "./tool-deferral";

const tool = (name: string, size = 1_500): ToolDefinition => ({ name, description: "d".repeat(size), parameters: { type: "object", properties: {} } });
const browser = ["browser_navigate", "browser_click", "browser_snapshot", "browser_type", "browser_console_messages", "browser_network_requests"].map((name) => tool(`mcp__playwright__${name}`));
const builtIn = [tool("read_file", 100), tool("fetch_url", 100)];
const small = [tool("mcp__notes__search", 100)];
const all = [...builtIn, ...browser, ...small];

describe("planToolDeferral", () => {
  it("holds back a large MCP server's tools until the conversation needs them", () => {
    const plan = planToolDeferral(all, [], "Summarize notes.md and type a short list");
    expect(plan.offered.map((t) => t.name)).toEqual(["read_file", "fetch_url", "mcp__notes__search"]);
    expect(plan.deferred).toEqual([{ id: "playwright", tools: browser.map((t) => t.name), summary: expect.stringContaining("playwright: 6 tools (browser_navigate, browser_click") }]);
  });

  it("offers the set on a strong signal or two distinct hints, and says why", () => {
    const cases: [string, string][] = [
      ["Use playwright to check the login", "the request names playwright"],
      ["Open the browser and log in", "the request mentions a browser"],
      ["Open https://example.com and read the headline", "the request asks to open a web address"],
      ["visit www.bbc.co.uk", "the request asks to open a web address"],
      ["Take a screenshot of the example.com homepage", "the request asks to open a web address"],
      ["Take a screenshot of localhost:5173", "the request asks to open a web address"],
      ["Open amazon.de and take a screenshot", "the request asks to open a web address"],
      ["Go to 192.168.1.1 and log in", "the request asks to open a web address"],
      ["Take a snapshot of the page", "the request mentions snapshot, page"],
      ["click the login button", "the request mentions click, login"],
      ["Open the website and fill in the login form", "the request mentions website, login"],
    ];
    for (const [request, reason] of cases) {
      const plan = planToolDeferral(all, [], request);
      expect(plan.deferred, request).toEqual([]);
      expect(plan.enabled, request).toEqual([{ id: "playwright", reason }]);
    }
  });

  it("keeps the set held back on one weak hint or a URL to fetch", () => {
    for (const request of ["Why is console.log so noisy here?", "fix the network error", "the snapshot test fails", "Navigate the codebase and find the parser", "What does https://example.com say?", "Update the website copy in README.md", "Open README.md and fix the page title",
      "When the user clicks the link, navigate to /home", "Add a click handler to the upload button", "Why does the page re-render? Look at the login component",
      "Fix the site config and the homepage route", "Open System.Net.Http client class", "Open socket.io connection handling", "Go to the definition of electron.app usage",
      "Open the file notes.dev", "Read the page object in tests/login.spec.ts", "Click through the Redux dev tools and show the network slice and the console logger config"]) {
      expect(planToolDeferral(all, [], request).deferred.map((group) => group.id), request).toEqual(["playwright"]);
    }
  });

  it("keeps a set offered once an earlier turn used it", () => {
    const history: AgentMessage[] = [{ role: "assistant", content: "", toolCalls: [{ id: "c", name: "mcp__playwright__browser_snapshot", arguments: "{}" }] }];
    const plan = planToolDeferral(all, history, "and the next page?");
    expect(plan.deferred).toEqual([]);
    expect(plan.enabled).toEqual([{ id: "playwright", reason: "an earlier turn used it" }]);
  });

  it("lists held-back sets in find_tool's description", () => {
    const base = { name: "find_tool", description: "Find a tool.", parameters: {} };
    expect(findToolDefinition(base, []).description).toBe("Find a tool.");
    expect(findToolDefinition(base, planToolDeferral(all, [], "hi").deferred).description).toContain("Tool sets available on request (asking enables the whole set): playwright: 6 tools");
  });
});

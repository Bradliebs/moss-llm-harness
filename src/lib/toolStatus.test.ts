// src/lib/toolStatus.test.ts
//
// Unit tests for the tool-status accent mapping (node environment).

import { describe, expect, it } from "vitest";

import { toolStatusColor, type ToolStatus } from "./toolStatus";

describe("toolStatusColor", () => {
  it("maps each status to a distinct accent", () => {
    expect(toolStatusColor("done")).toContain("emerald");
    expect(toolStatusColor("running")).toContain("sky");
    expect(toolStatusColor("error")).toContain("red");
    expect(toolStatusColor("denied")).toContain("red");
    expect(toolStatusColor("approval")).toContain("neutral");
  });

  it("ships a light default and a dark: variant for every status", () => {
    const statuses: ToolStatus[] = ["approval", "running", "done", "denied", "error"];
    for (const s of statuses) {
      const cls = toolStatusColor(s);
      expect(cls).toMatch(/^text-\w+-[67]00 dark:text-\w+-400$/);
    }
  });
});

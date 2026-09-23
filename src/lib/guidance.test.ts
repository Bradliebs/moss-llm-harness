import { describe, expect, it } from "vitest";

import { explainToolFailure, providerErrorGuidance } from "./guidance";

describe("explainToolFailure", () => {
  it("names the rule and settings category for scope denials", () => {
    expect(explainToolFailure("Error: Domain is not allow-listed: evil.example")).toMatchObject({
      rule: "Browser domain allow-list",
      settingsCategory: "automation",
    });
    expect(explainToolFailure("Process is not allow-listed: calc.exe")?.detail).toContain("calc.exe");
    expect(explainToolFailure("Window is not allow-listed: Untitled")?.settingsCategory).toBe("automation");
    expect(explainToolFailure("Path escapes the workspace sandbox: ../x")?.settingsCategory).toBe("tools");
    expect(explainToolFailure("No workspace folder selected")?.rule).toBe("Workspace required");
  });

  it("explains approval, policy, and time-limit outcomes", () => {
    expect(explainToolFailure("User denied: write_file")?.rule).toBe("Your approval decision");
    expect(explainToolFailure("Denied by policy: run_command")?.rule).toBe("Mission authority");
    expect(explainToolFailure("Command timed out after 60 seconds")?.rule).toBe("Tool time limit");
    expect(explainToolFailure("Something else")).toBeNull();
    expect(explainToolFailure(undefined)).toBeNull();
  });
});

describe("providerErrorGuidance", () => {
  it.each([
    ["HTTP 401 Unauthorized", "settings"],
    ["model \"llama9\" not found, try pulling it first", "settings"],
    ["fetch failed: ECONNREFUSED 127.0.0.1:11434", "settings"],
    ["429 Too Many Requests", "retry"],
    ["context_length_exceeded: maximum context length is 8192", "new-chat"],
    ["503 Service Unavailable", "retry"],
  ])("maps %s to a %s action", (message, kind) => {
    expect(providerErrorGuidance(message)?.action?.kind).toBe(kind);
  });

  it("returns null for unrecognized errors", () => {
    expect(providerErrorGuidance("The model produced invalid JSON")).toBeNull();
  });
});

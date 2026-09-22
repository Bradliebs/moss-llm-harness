// Tests for the permission policy: name-based classification, shell-command
// content risk tiering, and the centralized resolver the agent runner uses.

import { describe, expect, it } from "vitest";

import { classifyCommand, classifyTool, resolvePermission } from "./permission";

describe("classifyTool", () => {
  it("auto-allows read-only tools", () => {
    expect(classifyTool("read_file")).toBe("allow");
    expect(classifyTool("list_dir")).toBe("allow");
    expect(classifyTool("search_files")).toBe("allow");
    expect(classifyTool("glob_files")).toBe("allow");
  });

  it("asks for mutating and unknown tools", () => {
    expect(classifyTool("write_file")).toBe("ask");
    expect(classifyTool("edit_file")).toBe("ask");
    expect(classifyTool("move_file")).toBe("ask");
    expect(classifyTool("run_command")).toBe("ask");
    expect(classifyTool("totally_unknown")).toBe("ask");
  });
});

describe("classifyCommand", () => {
  it("classifies plain inspection commands as read-only", () => {
    for (const c of ["ls -la", "cat README.md", "pwd", "grep foo src", "git status", "git log --oneline", "cat a | grep b"]) {
      expect(classifyCommand(c)).toBe("readonly");
    }
  });

  it("classifies destructive commands regardless of position", () => {
    for (const c of [
      "rm -rf /",
      "rm -r build",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sdb",
      "shutdown now",
      "echo hi && rm -rf x",
      "echo $(rm -rf x)",
      "git push --force",
      "git reset --hard HEAD~1",
    ]) {
      expect(classifyCommand(c)).toBe("destructive");
    }
  });

  it("classifies other side-effecting commands as mutating", () => {
    for (const c of ["npm install", "git commit -m x", "mkdir foo", "rm note.txt", "node script.js"]) {
      expect(classifyCommand(c)).toBe("mutating");
    }
  });

  it("does not treat redirection or substitution as read-only", () => {
    expect(classifyCommand("cat a > b")).toBe("mutating");
    expect(classifyCommand("echo hi > out.txt")).toBe("mutating");
    expect(classifyCommand("echo `date`")).toBe("mutating");
  });

  it("treats an empty command as mutating", () => {
    expect(classifyCommand("   ")).toBe("mutating");
  });
});

describe("resolvePermission", () => {
  it("runs allow-listed tools without a prompt", () => {
    expect(resolvePermission({ name: "read_file", autoApprove: false })).toEqual({ action: "run", autoApproved: false });
    // read-only self-tools (including m_list_memories) auto-run like the file readers.
    expect(resolvePermission({ name: "m_list_memories", autoApprove: false })).toEqual({
      action: "run",
      autoApproved: false,
    });
  });

  it("prompts mutating tools unless auto-approve is on, tagging the mutating risk tier", () => {
    expect(resolvePermission({ name: "write_file", autoApprove: false })).toEqual({
      action: "prompt",
      autoApproved: false,
      risk: "mutating",
    });
    expect(resolvePermission({ name: "write_file", autoApprove: true })).toEqual({
      action: "run",
      autoApproved: true,
      risk: "mutating",
    });
    expect(resolvePermission({ name: "move_file", autoApprove: false }).risk).toBe("mutating");
  });

  it("runs read-only shell commands without a prompt", () => {
    expect(resolvePermission({ name: "run_command", command: "ls", autoApprove: false })).toEqual({
      action: "run",
      autoApproved: false,
      risk: "readonly",
    });
  });

  it("always prompts destructive shell commands, even under auto-approve", () => {
    expect(resolvePermission({ name: "run_command", command: "rm -rf build", autoApprove: true })).toEqual({
      action: "prompt",
      autoApproved: false,
      risk: "destructive",
    });
  });

  it("always prompts irreversible browser and desktop actions", () => {
    for (const name of ["browser_click", "desktop_invoke"]) {
      expect(resolvePermission({ name, args: { name: "Confirm purchase" }, autoApprove: true })).toEqual({
        action: "prompt",
        autoApproved: false,
        risk: "destructive",
      });
    }
  });

  it("always prompts consequential external actions", () => {
    expect(resolvePermission({ name: "jev_evaluate", autoApprove: true })).toEqual({
      action: "prompt", autoApproved: false, risk: "mutating",
    });
    expect(resolvePermission({ name: "send_email", autoApprove: true })).toEqual({
      action: "prompt",
      autoApproved: false,
      risk: "destructive",
    });
  });

  it("uses policy-scoped grants instead of the legacy auto-approve switch", () => {
    const executionGrant = {
      schemaVersion: 1 as const,
      authority: "policy-scoped" as const,
      allowedCapabilities: ["write_file"],
      maxAutoApprovedRisk: "mutating" as const,
      budget: { maxActions: 3 },
      scopes: {},
    };

    expect(resolvePermission({
      name: "write_file",
      autoApprove: false,
      executionGrant,
      stepCapabilities: ["write_file"],
    }).action).toBe("run");
    expect(resolvePermission({
      name: "write_file",
      autoApprove: true,
      executionGrant,
      stepCapabilities: [],
    }).action).toBe("deny");
    expect(resolvePermission({
      name: "move_file",
      autoApprove: true,
      executionGrant,
      stepCapabilities: ["move_file"],
    }).action).toBe("deny");
  });

  it("denies normally auto-allowed tools outside a mission step grant", () => {
    const executionGrant = {
      schemaVersion: 1 as const,
      authority: "policy-scoped" as const,
      allowedCapabilities: ["read_file"],
      maxAutoApprovedRisk: "readonly" as const,
      budget: {},
      scopes: {},
    };

    expect(resolvePermission({
      name: "list_dir",
      autoApprove: true,
      executionGrant,
      stepCapabilities: ["read_file"],
    })).toEqual({ action: "deny", autoApproved: false });
    expect(resolvePermission({
      name: "read_file",
      autoApprove: true,
      executionGrant,
      stepCapabilities: ["read_file"],
    })).toEqual({ action: "run", autoApproved: false });
  });

  it("does not auto-approve mutations with a supervised or read-only grant", () => {
    const baseGrant = {
      schemaVersion: 1 as const,
      allowedCapabilities: ["run_command"],
      budget: { maxActions: 2 },
      scopes: {},
    };
    expect(resolvePermission({
      name: "run_command",
      command: "npm test",
      autoApprove: true,
      executionGrant: { ...baseGrant, authority: "supervised", maxAutoApprovedRisk: "mutating" },
      stepCapabilities: ["run_command"],
    }).action).toBe("prompt");
    expect(resolvePermission({
      name: "run_command",
      command: "npm test",
      autoApprove: true,
      executionGrant: { ...baseGrant, authority: "policy-scoped", maxAutoApprovedRisk: "readonly" },
      stepCapabilities: ["run_command"],
    }).action).toBe("prompt");
  });

  it("treats other shell commands as mutating", () => {
    expect(resolvePermission({ name: "run_command", command: "npm install", autoApprove: false }).action).toBe("prompt");
    expect(resolvePermission({ name: "run_command", command: "npm install", autoApprove: true })).toEqual({
      action: "run",
      autoApproved: true,
      risk: "mutating",
    });
  });

  it("prompts skill-authoring tools as mutating; they are never auto-allowed", () => {
    for (const name of ["m_create_skill", "m_update_skill", "m_delete_skill"]) {
      expect(resolvePermission({ name, autoApprove: false })).toEqual({
        action: "prompt",
        autoApproved: false,
        risk: "mutating",
      });
    }
  });
});

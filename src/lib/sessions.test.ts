// src/lib/sessions.test.ts
//
// Unit tests for conversation session state. The module holds a singleton store,
// so each test re-imports a fresh module (vi.resetModules) for isolation.
// localStorage is absent in node, so the store starts empty on every import.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "@common/types";

import type { Session } from "./sessions";

type SessionsModule = typeof import("./sessions");

let sessions: SessionsModule;

beforeEach(async () => {
  vi.resetModules();
  sessions = await import("./sessions");
});

function userMsg(content: string): AgentMessage {
  return { role: "user", content };
}

describe("createSession", () => {
  it("creates an empty session and makes it current", () => {
    const id = sessions.createSession();
    expect(typeof id).toBe("string");
    expect(sessions.getSessionMessages(id)).toEqual([]);
    expect(sessions.ensureCurrentSession()).toBe(id);
  });
});

describe("pinning and bulk deletion", () => {
  it("pins conversations and deletes several while keeping a valid selection", () => {
    const first = sessions.createSession();
    const second = sessions.createSession();
    const third = sessions.createSession();
    sessions.setSessionPinned(first, true);
    const list = [
      { id: third, pinned: false },
      { id: second },
      { id: first, pinned: true },
    ] as Session[];
    expect(sessions.sortSessionsForDisplay(list).map((session) => session.id)).toEqual([first, third, second]);
    sessions.deleteSessions([second, third]);
    expect(sessions.ensureCurrentSession()).toBe(first);
  });
});

describe("getSessionMessages / setSessionMessages", () => {
  it("round-trips a session's messages and returns [] for an unknown id", () => {
    const id = sessions.createSession();
    sessions.setSessionMessages(id, [userMsg("hello")]);
    expect(sessions.getSessionMessages(id)).toEqual([userMsg("hello")]);
    expect(sessions.getSessionMessages("nope")).toEqual([]);
  });

  it("preserves image attachments on a user message across the round-trip", () => {
    const id = sessions.createSession();
    const withImages: AgentMessage = {
      role: "user",
      content: "look",
      images: ["data:image/png;base64,AAAA"],
    };
    sessions.setSessionMessages(id, [withImages]);
    expect(sessions.getSessionMessages(id)).toEqual([withImages]);
  });

  it("preserves document attachments on a user message across the round-trip", () => {
    const id = sessions.createSession();
    const withDocument: AgentMessage = {
      role: "user",
      content: "summarize",
      documents: [{ name: "notes.txt", mediaType: "text/plain", text: "file body" }],
    };
    sessions.setSessionMessages(id, [withDocument]);
    expect(sessions.getSessionMessages(id)).toEqual([withDocument]);
  });
});

describe("getSessionPersonality / setSessionPersonality", () => {
  it("defaults to undefined (inherit) and round-trips an override", () => {
    const id = sessions.createSession();
    expect(sessions.getSessionPersonality(id)).toBeUndefined();
    sessions.setSessionPersonality(id, "concise");
    expect(sessions.getSessionPersonality(id)).toBe("concise");
  });

  it("clears the override back to inherit when set to undefined", () => {
    const id = sessions.createSession();
    sessions.setSessionPersonality(id, "mentor");
    sessions.setSessionPersonality(id, undefined);
    expect(sessions.getSessionPersonality(id)).toBeUndefined();
  });

  it("returns undefined for an unknown id", () => {
    expect(sessions.getSessionPersonality("nope")).toBeUndefined();
  });
});

describe("renameSession", () => {
  it("overwrites the title with a trimmed value", () => {
    const id = sessions.createSession();
    sessions.renameSession(id, "  Renamed chat  ");
    expect(sessions.getSessionTitle(id)).toBe("Renamed chat");
  });

  it("ignores a blank rename so a conversation never loses its name", () => {
    const id = sessions.createSession();
    sessions.renameSession(id, "Keep me");
    sessions.renameSession(id, "   ");
    expect(sessions.getSessionTitle(id)).toBe("Keep me");
  });
});

describe("sessionToMarkdown", () => {
  it("renders user and assistant turns with role headings", () => {
    const session = {
      id: "s1",
      title: "Greeting",
      messages: [userMsg("hello"), { role: "assistant", content: "hi there" } as AgentMessage],
      createdAt: "x",
      updatedAt: "x",
    };
    const md = sessions.sessionToMarkdown(session);
    expect(md).toContain("# Greeting");
    expect(md).toContain("## User\n\nhello");
    expect(md).toContain("## Assistant\n\nhi there");
  });

  it("omits system, tool, and empty-content messages", () => {
    const session = {
      id: "s1",
      title: "Mixed",
      messages: [
        { role: "system", content: "you are moss" } as AgentMessage,
        { role: "tool", content: "{\"ok\":true}", toolCallId: "t1" } as AgentMessage,
        { role: "assistant", content: "  " } as AgentMessage,
        userMsg("kept"),
      ],
      createdAt: "x",
      updatedAt: "x",
    };
    const md = sessions.sessionToMarkdown(session);
    expect(md).not.toContain("you are moss");
    expect(md).not.toContain("ok");
    expect(md).toContain("## User\n\nkept");
    expect(md).not.toContain("## Assistant");
  });

  it("includes tool calls, results, and a usage+cost footer when includeTools is set", () => {
    const session = {
      id: "s1",
      title: "Rich",
      messages: [
        userMsg("run it"),
        {
          role: "assistant",
          content: "done",
          toolCalls: [{ id: "c1", name: "run_command", arguments: "{\"cmd\":\"ls\"}" }],
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
        } as AgentMessage,
        { role: "tool", content: "file.txt", toolCallId: "c1", autoApproved: true } as AgentMessage,
      ],
      createdAt: "x",
      updatedAt: "x",
    };
    const md = sessions.sessionToMarkdown(session, { includeTools: true, model: "gpt-4o" });
    expect(md).toContain("### Tool call: run_command");
    expect(md).toContain("{\"cmd\":\"ls\"}");
    expect(md).toContain("### Tool result (auto-approved)");
    expect(md).toContain("file.txt");
    expect(md).toContain("## Summary");
    expect(md).toContain("Tokens: 1000000 (input 1000000, output 0)");
    expect(md).toContain("Estimated cost: $2.50");
  });

  it("appends a Tool activity table mirroring the in-app audit when includeTools is set", () => {
    const session = {
      id: "s1",
      title: "Audit",
      messages: [
        userMsg("go"),
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "read_file", arguments: "{}" },
            { id: "c2", name: "write_file", arguments: "{}" },
          ],
        } as AgentMessage,
        { role: "tool", content: "ok", toolCallId: "c1", autoApproved: true, durationMs: 12 } as AgentMessage,
        { role: "tool", content: "ok", toolCallId: "c2" } as AgentMessage,
      ],
      createdAt: "x",
      updatedAt: "x",
    };
    const md = sessions.sessionToMarkdown(session, { includeTools: true });
    expect(md).toContain("## Tool activity");
    expect(md).toContain("| Tool | Risk | Auto-approved | Duration |");
    expect(md).toContain("| read_file | readonly | yes | 12ms |");
    expect(md).toContain("| write_file | mutating | no |  |");
  });

  it("omits the cost line when the model has no rate", () => {
    const session = {
      id: "s1",
      title: "NoRate",
      messages: [{ role: "assistant", content: "hi", usage: { inputTokens: 10, outputTokens: 0 } } as AgentMessage],
      createdAt: "x",
      updatedAt: "x",
    };
    const md = sessions.sessionToMarkdown(session, { includeTools: true, model: "mystery" });
    expect(md).toContain("## Summary");
    expect(md).not.toContain("Estimated cost");
  });
});

describe("ensureCurrentSession", () => {
  it("creates a session when the store is empty and is then idempotent", () => {
    const id = sessions.ensureCurrentSession();
    expect(typeof id).toBe("string");
    expect(sessions.getSessionMessages(id)).toEqual([]);
    expect(sessions.ensureCurrentSession()).toBe(id);
  });

  it("returns the existing current session", () => {
    const id = sessions.createSession();
    expect(sessions.ensureCurrentSession()).toBe(id);
  });

  it("falls back to the front session when the current id is stale", () => {
    sessions.createSession();
    const newest = sessions.createSession();
    sessions.selectSession("ghost");
    expect(sessions.ensureCurrentSession()).toBe(newest);
  });
});

describe("selectSession", () => {
  it("switches the current session", () => {
    const first = sessions.createSession();
    sessions.createSession();
    sessions.selectSession(first);
    expect(sessions.ensureCurrentSession()).toBe(first);
  });
});

describe("deleteSession", () => {
  it("repoints the current id to a remaining session", () => {
    const first = sessions.createSession();
    const second = sessions.createSession();
    sessions.selectSession(second);
    sessions.deleteSession(second);
    expect(sessions.getSessionMessages(second)).toEqual([]);
    expect(sessions.ensureCurrentSession()).toBe(first);
  });

  it("creates a fresh session when the last one is deleted", () => {
    const id = sessions.createSession();
    sessions.deleteSession(id);
    const fresh = sessions.ensureCurrentSession();
    expect(fresh).not.toBe(id);
    expect(sessions.getSessionMessages(id)).toEqual([]);
  });

  it("leaves the current session alone when deleting a non-current one", () => {
    const first = sessions.createSession();
    const second = sessions.createSession();
    sessions.deleteSession(first);
    expect(sessions.ensureCurrentSession()).toBe(second);
    expect(sessions.getSessionMessages(first)).toEqual([]);
  });
});

describe("clearSession", () => {
  it("empties messages but keeps the session current", () => {
    const id = sessions.createSession();
    sessions.setSessionMessages(id, [userMsg("Refactor the parser")]);
    sessions.clearSession(id);
    expect(sessions.getSessionMessages(id)).toEqual([]);
    expect(sessions.ensureCurrentSession()).toBe(id);
  });
});

describe("sessionTokenUsage", () => {
  it("sums per-message usage and ignores messages without it", () => {
    const total = sessions.sessionTokenUsage([
      { role: "user", content: "hi" },
      { role: "assistant", content: "a", usage: { inputTokens: 5, outputTokens: 7 } },
      { role: "assistant", content: "b", usage: { outputTokens: 3 } },
      { role: "assistant", content: "c" },
    ]);
    expect(total).toEqual({ inputTokens: 5, outputTokens: 10 });
  });

  it("returns zeros for an empty history", () => {
    expect(sessions.sessionTokenUsage([])).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("sessionToolUsage", () => {
  it("counts tool-result messages and how many ran under auto-approve", () => {
    const summary = sessions.sessionToolUsage([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: "{}" }] },
      { role: "tool", content: "ok", toolCallId: "c1", autoApproved: true },
      { role: "tool", content: "ok", toolCallId: "c2" },
    ]);
    expect(summary).toEqual({ total: 2, autoApproved: 1 });
  });

  it("returns zeros when no tools ran", () => {
    expect(sessions.sessionToolUsage([{ role: "user", content: "hi" }])).toEqual({ total: 0, autoApproved: 0 });
  });
});

describe("sessionToolAudit", () => {
  it("pairs each result with its call name, risk tier, and auto-approved flag", () => {
    const audit = sessions.sessionToolAudit([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "read_file", arguments: "{}" },
          { id: "c2", name: "write_file", arguments: "{}" },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "c1", autoApproved: true },
      { role: "tool", content: "ok", toolCallId: "c2" },
    ]);
    expect(audit).toEqual([
      { callId: "c1", name: "read_file", risk: "readonly", autoApproved: true },
      { callId: "c2", name: "write_file", risk: "mutating", autoApproved: false },
    ]);
  });

  it("labels a result whose call cannot be resolved as unknown and mutating", () => {
    const audit = sessions.sessionToolAudit([{ role: "tool", content: "ok", toolCallId: "ghost" }]);
    expect(audit).toEqual([{ callId: "ghost", name: "unknown", risk: "mutating", autoApproved: false }]);
  });

  it("prefers the persisted risk tier over the name-derived one", () => {
    const audit = sessions.sessionToolAudit([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "run_command", arguments: "{}" },
          { id: "c2", name: "read_file", arguments: "{}" },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "c1", risk: "destructive" },
      { role: "tool", content: "ok", toolCallId: "c2" },
    ]);
    expect(audit).toEqual([
      { callId: "c1", name: "run_command", risk: "destructive", autoApproved: false },
      { callId: "c2", name: "read_file", risk: "readonly", autoApproved: false },
    ]);
  });

  it("classifies tool names with toolRiskTier", () => {
    expect(sessions.toolRiskTier("list_dir")).toBe("readonly");
    expect(sessions.toolRiskTier("run_command")).toBe("mutating");
  });
});

describe("contextWindowTokens", () => {
  it("uses the most recent reply's input + output, not a sum of all turns", () => {
    const used = sessions.contextWindowTokens([
      { role: "user", content: "hi" },
      { role: "assistant", content: "a", usage: { inputTokens: 100, outputTokens: 20 } },
      { role: "user", content: "more" },
      { role: "assistant", content: "b", usage: { inputTokens: 300, outputTokens: 40 } },
    ]);
    expect(used).toBe(340);
  });

  it("returns 0 until a reply with usage has landed", () => {
    expect(sessions.contextWindowTokens([{ role: "user", content: "hi" }])).toBe(0);
    expect(sessions.contextWindowTokens([])).toBe(0);
  });
});

describe("contextWindowUsage", () => {
  it("returns the most recent reply's input/output split", () => {
    const used = sessions.contextWindowUsage([
      { role: "assistant", content: "a", usage: { inputTokens: 100, outputTokens: 20 } },
      { role: "user", content: "more" },
      { role: "assistant", content: "b", usage: { inputTokens: 300, outputTokens: 40 } },
    ]);
    expect(used).toEqual({ inputTokens: 300, outputTokens: 40 });
  });

  it("returns zeros until a reply with usage has landed", () => {
    expect(sessions.contextWindowUsage([{ role: "user", content: "hi" }])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(sessions.contextWindowUsage([])).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("continueInNewSession", () => {
  /** Build a source conversation with several turns and one tool call. */
  function seedSource(): string {
    const id = sessions.createSession();
    sessions.renameSession(id, "Refactor the parser");
    sessions.setSessionMessages(id, [
      userMsg("first ask"),
      { role: "assistant", content: "first reply", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
      { role: "tool", content: "file body", toolCallId: "c1", risk: "readonly" },
      userMsg("second ask"),
      { role: "assistant", content: "second reply" },
      userMsg("third ask"),
      { role: "assistant", content: "third reply" },
    ]);
    return id;
  }

  it("creates a new current session seeded with a user digest and an assistant reply", () => {
    const source = seedSource();
    const forked = sessions.continueInNewSession(source);
    expect(forked).toBeTruthy();
    expect(sessions.ensureCurrentSession()).toBe(forked);

    const seeded = sessions.getSessionMessages(forked!);
    expect(seeded).toHaveLength(2);
    expect(seeded[0].role).toBe("user");
    expect(seeded[0].handoff).toBe(true);
    // Alternation matters: the next message the user sends is a user turn, and
    // two user turns back to back are rejected by strict providers.
    expect(seeded[1].role).toBe("assistant");
    expect(seeded[1].handoff).toBe(true);
  });

  it("seeds the model-written summary when one is supplied, under the carried-over framing", () => {
    const source = seedSource();
    const forked = sessions.continueInNewSession(source, "## Goal\nShip the parser refactor.")!;
    const seeded = sessions.getSessionMessages(forked);
    expect(seeded[0].content).toContain('# Carried-over context from "Refactor the parser"');
    expect(seeded[0].content).toContain("## Goal\nShip the parser refactor.");
    // The model summary replaces the digest rather than sitting alongside it.
    expect(seeded[0].content).not.toContain("## Most recent exchange (verbatim)");
  });

  it("falls back to the local digest when the summary is missing or blank", () => {
    const source = seedSource();
    const blank = sessions.continueInNewSession(source, "   ")!;
    expect(sessions.getSessionMessages(blank)[0].content).toContain("## Most recent exchange (verbatim)");
  });

  it("leaves the source conversation untouched", () => {
    const source = seedSource();
    const before = sessions.getSessionMessages(source);
    sessions.continueInNewSession(source);
    expect(sessions.getSessionMessages(source)).toEqual(before);
    expect(sessions.getSessionTitle(source)).toBe("Refactor the parser");
  });

  it("carries the per-chat personality override", () => {
    const source = seedSource();
    sessions.setSessionPersonality(source, "concise");
    const forked = sessions.continueInNewSession(source)!;
    expect(sessions.getSessionPersonality(forked)).toBe("concise");
  });

  it("numbers repeat handoffs so chained continuations stay distinguishable", () => {
    const source = seedSource();
    const first = sessions.continueInNewSession(source)!;
    expect(sessions.getSessionTitle(first)).toBe("Refactor the parser (continued)");
    const second = sessions.continueInNewSession(first)!;
    expect(sessions.getSessionTitle(second)).toBe("Refactor the parser (continued 2)");
    const third = sessions.continueInNewSession(second)!;
    expect(sessions.getSessionTitle(third)).toBe("Refactor the parser (continued 3)");
  });

  it("returns null for an unknown or empty conversation", () => {
    expect(sessions.continueInNewSession("nope")).toBeNull();
    expect(sessions.continueInNewSession(sessions.createSession())).toBeNull();
  });
});

describe("buildHandoffDigest", () => {
  function session(messages: AgentMessage[]): Session {
    return { id: "s", title: "Refactor the parser", messages, createdAt: "", updatedAt: "" };
  }

  it("keeps the last two turns verbatim and reduces earlier ones to their requests", () => {
    const digest = sessions.buildHandoffDigest(
      session([
        userMsg("first ask"),
        { role: "assistant", content: "first reply" },
        userMsg("second ask"),
        { role: "assistant", content: "second reply" },
        userMsg("third ask"),
        { role: "assistant", content: "third reply" },
      ]),
    );
    expect(digest).toContain('Carried-over context from "Refactor the parser"');
    expect(digest).toContain("- first ask");
    expect(digest).toContain("second ask");
    expect(digest).toContain("second reply");
    expect(digest).toContain("third reply");
    // The first turn's reply is dropped; only its request survives.
    expect(digest).not.toContain("first reply");
  });

  it("lists tools that already ran, with their risk tier and count", () => {
    const digest = sessions.buildHandoffDigest(
      session([
        userMsg("go"),
        {
          role: "assistant",
          content: "working",
          toolCalls: [
            { id: "c1", name: "read_file", arguments: "{}" },
            { id: "c2", name: "read_file", arguments: "{}" },
          ],
        },
        { role: "tool", content: "a", toolCallId: "c1", risk: "readonly" },
        { role: "tool", content: "b", toolCallId: "c2", risk: "readonly" },
      ]),
    );
    expect(digest).toContain("- read_file (readonly) ×2");
  });

  it("bounds long content so the continuation does not inherit the problem", () => {
    const digest = sessions.buildHandoffDigest(
      session([userMsg("x".repeat(5000)), { role: "assistant", content: "y".repeat(5000) }]),
    );
    expect(digest).toContain("…[truncated]");
    expect(digest.length).toBeLessThan(4000);
  });

  it("handles a conversation with no assistant reply yet", () => {
    const digest = sessions.buildHandoffDigest(session([userMsg("only ask")]));
    expect(digest).toContain("only ask");
  });
});

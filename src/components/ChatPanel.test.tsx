// @vitest-environment jsdom
//
// src/components/ChatPanel.test.tsx
//
// ChatPanel owns the turn lifecycle: it sends a turn over window.moss.chat.send,
// subscribes to the streamed MossEvent feed, and renders text deltas, tool cards,
// the approval gate, and terminal turn states. The lib hooks (settings/sessions/
// dictation) are mocked so only this component's event handling is under test; a
// Harness owns real busy state so the Send/Stop swap and abort path are exercised.

import { useState } from "react";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatEventPayload, MossEvent, TaskSnapshot, TaskState } from "@common/types";

import { ChatPanel } from "./ChatPanel";

const mockExtractPdfText = vi.hoisted(() => vi.fn());

vi.mock("../lib/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/attachments")>()),
  extractPdfText: mockExtractPdfText,
}));

const mockSetSessionMessages = vi.fn();
const mockClearSession = vi.fn();
const mockContinueInNewSession = vi.fn();
const mockSummarize = vi.fn();
const mockMissionAuthorize = vi.fn();
const mockMissionCapabilities = vi.fn();
const mockSetSessionTaskId = vi.fn();

// Holds the session ChatPanel renders; tests override `value.messages` to drive
// messagesToItems (e.g. multi-round turns) and beforeEach resets it to empty.
const mockSession = vi.hoisted(() => ({
  value: { id: "s1", title: "New chat", messages: [], createdAt: 0, updatedAt: 0, ...({} as { taskId?: string }) },
}));

// Drives the header tool-activity badge and audit popover; reset in beforeEach.
const mockToolState = vi.hoisted(() => ({
  usage: { total: 0, autoApproved: 0 },
  audit: [] as { callId: string; name: string; risk: string; autoApproved: boolean }[],
}));

const mockSettingsDefaults = {
  model: "gpt-4",
  enableTools: true,
  maxToolRounds: 8,
  autoApproveTools: false,
  workspaceRoot: null as string | null,
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  sttBaseUrl: "",
  sttModel: "whisper-1",
  emailApiKey: "",
  emailFrom: "",
  verifyEnabled: false,
  verifyCommands: "",
  presetIndex: 0,
  kind: "openai-compatible",
};
const mockSettings = vi.hoisted(() => ({
  model: "gpt-4",
  enableTools: true,
  maxToolRounds: 8,
  autoApproveTools: false,
  workspaceRoot: null as string | null,
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  sttBaseUrl: "",
  sttModel: "whisper-1",
  emailApiKey: "",
  emailFrom: "",
  verifyEnabled: false,
  verifyCommands: "",
  presetIndex: 0,
  kind: "openai-compatible",
}));

vi.mock("../lib/settings", () => ({
  useSettings: () => mockSettings,
  modelsStore: { use: () => ["gpt-4"] },
  toProviderConfig: () => ({}),
  toEmbedConfig: () => ({ baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" }),
  updateSettings: vi.fn(),
}));

vi.mock("../lib/sessions", () => ({
  useSessions: () => ({}),
  currentSession: () => mockSession.value,
  ensureCurrentSession: () => "s1",
  getSessionMessages: () => [],
  getSessionPersonality: () => undefined,
  setSessionPersonality: vi.fn(),
  setSessionMessages: (...args: unknown[]) => mockSetSessionMessages(...args),
  setSessionTitle: vi.fn(),
  setSessionTaskId: (...args: unknown[]) => mockSetSessionTaskId(...args),
  clearSession: (...args: unknown[]) => mockClearSession(...args),
  continueInNewSession: (...args: unknown[]) => mockContinueInNewSession(...args),
  sessionTokenUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  contextWindowTokens: () => 0,
  contextWindowUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  sessionToolUsage: () => mockToolState.usage,
  sessionToolAudit: () => mockToolState.audit,
}));

vi.mock("../lib/dictation", () => ({
  useDictation: () => ({ state: "idle", error: null, toggle: vi.fn() }),
}));

let eventHandler: ((payload: ChatEventPayload) => void) | null = null;
const off = vi.fn();
const openChats = vi.fn();

function Harness(): React.ReactElement {
  const [busy, setBusy] = useState(false);
  return <ChatPanel busy={busy} setBusy={setBusy} onOpenChats={openChats} onOpenSettings={vi.fn()} />;
}

function startTurn(): string {
  fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "hi there" } });
  fireEvent.click(screen.getByText("Send"));
  return (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0].turnId;
}

function emit(turnId: string, event: MossEvent): void {
  act(() => {
    eventHandler?.({ turnId, event });
  });
}

function taskSnapshot(state: TaskState, blocker?: TaskSnapshot["blocker"]): TaskSnapshot {
  return {
    id: "task-1",
    revision: 1,
    state,
    spec: {
      objective: "Complete the durable task",
      acceptanceCriteria: [{ id: "requested-outcome", description: "Requested outcome", mandatory: true }],
      constraints: [],
      assumptions: [],
      budget: { maxActions: 64 },
    },
    steps: [{
      id: "execute-request",
      description: "Execute request",
      state: ["completed", "failed", "cancelled"].includes(state) ? "completed" : "running",
      dependsOn: [],
      requiredCapabilities: [],
    }],
    attempts: [],
    evidence: [],
    blocker,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  eventHandler = null;
  openChats.mockReset();
  mockExtractPdfText.mockReset();
  mockContinueInNewSession.mockReset();
  mockSummarize.mockReset();
  mockSummarize.mockResolvedValue({ ok: true, summary: "MODEL SUMMARY" });
  mockMissionAuthorize.mockReset();
  mockMissionAuthorize.mockResolvedValue({ token: "mission-token", expiresAt: "2026-01-01T00:05:00.000Z" });
  mockMissionCapabilities.mockReset();
  mockMissionCapabilities.mockResolvedValue([
    { id: "read_file", risk: "readonly" },
    { id: "write_file", risk: "mutating" },
  ]);
  mockSession.value = { id: "s1", title: "New chat", messages: [], createdAt: 0, updatedAt: 0 };
  mockToolState.usage = { total: 0, autoApproved: 0 };
  mockToolState.audit = [];
  Object.assign(mockSettings, mockSettingsDefaults);
  // jsdom does not implement Element.scrollTo; ChatPanel's autoscroll effect calls it.
  Element.prototype.scrollTo = vi.fn();
  Object.assign(window, {
    moss: {
      chat: {
        send: vi.fn(),
        abort: vi.fn(),
        summarize: mockSummarize,
        onEvent: vi.fn((h: (payload: ChatEventPayload) => void) => {
          eventHandler = h;
          return off;
        }),
      },
      tool: { approve: vi.fn() },
      task: {
        get: vi.fn(async () => null),
        resume: vi.fn(async () => taskSnapshot("executing")),
        cancel: vi.fn(async () => taskSnapshot("cancelled")),
        history: vi.fn(async () => []),
      },
      mission: {
        authorize: mockMissionAuthorize,
        capabilities: mockMissionCapabilities,
      },
      shell: { openExternal: vi.fn() },
      mcp: { status: vi.fn(() => Promise.resolve([])) },
      skills: { list: vi.fn(() => Promise.resolve([])) },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete (window as { moss?: unknown }).moss;
});

describe("ChatPanel", () => {
  it("opens the compact conversation navigator from the header", () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("Open conversations"));
    expect(openChats).toHaveBeenCalledTimes(1);
  });

  it("subscribes to the event feed on mount", () => {
    render(<Harness />);
    expect(window.moss.chat.onEvent).toHaveBeenCalledTimes(1);
    expect(eventHandler).toBeTypeOf("function");
  });

  it("does not run an ordinary message as a durable autonomous task", () => {
    render(<Harness />);
    const composer = screen.getByPlaceholderText("Message…");
    fireEvent.change(composer, { target: { value: "I need help choosing" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(window.moss.chat.send).toHaveBeenCalledWith(
      expect.not.objectContaining({ taskSpec: expect.anything(), mission: expect.anything() }),
    );
    expect(mockMissionAuthorize).not.toHaveBeenCalled();
  });

  it("launches a supervised mission with host-reviewed capabilities and budgets", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Mission" }));
    await waitFor(() => expect(mockMissionCapabilities).toHaveBeenCalledTimes(1));
    const composer = screen.getByPlaceholderText("Message…");
    fireEvent.change(composer, { target: { value: "Inspect and verify this repository" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(mockMissionAuthorize).not.toHaveBeenCalled();
    expect(window.moss.chat.send).toHaveBeenCalledWith(expect.objectContaining({
      taskSpec: expect.objectContaining({
        objective: "Inspect and verify this repository",
        acceptanceCriteria: [expect.objectContaining({ mandatory: true })],
        budget: { maxDurationMs: 900000, maxTokens: 50000, maxActions: 24, maxCostUsd: 5 },
      }),
      mission: {
        authority: "supervised",
        requestedCapabilities: ["read_file"],
        maxAutoApprovedRisk: "readonly",
        budget: { maxDurationMs: 900000, maxTokens: 50000, maxActions: 24, maxCostUsd: 5 },
      },
    }));
  });

  it("native-authorizes a policy-scoped mission immediately before sending", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Mission" }));
    await waitFor(() => expect(mockMissionCapabilities).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Review mission"));
    fireEvent.click(screen.getByRole("button", { name: "Policy-scoped" }));
    fireEvent.click(screen.getByLabelText(/write_file/));
    fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "Apply the bounded change" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(mockMissionAuthorize).toHaveBeenCalledWith(expect.objectContaining({
      objective: "Apply the bounded change",
      policy: expect.objectContaining({
        authority: "policy-scoped",
        requestedCapabilities: ["read_file", "write_file"],
        maxAutoApprovedRisk: "mutating",
      }),
    })));
    await waitFor(() => expect(window.moss.chat.send).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({
        authority: "policy-scoped",
        authorizationToken: "mission-token",
      }),
    })));
  });

  it("does not send when native mission authorization is cancelled", async () => {
    mockMissionAuthorize.mockResolvedValue(null);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Mission" }));
    await waitFor(() => expect(mockMissionCapabilities).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Review mission"));
    fireEvent.click(screen.getByRole("button", { name: "Policy-scoped" }));
    fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "Do not lose this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await screen.findByText("Mission launch cancelled.");
    expect(window.moss.chat.send).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("Message…") as HTMLTextAreaElement).value).toBe("Do not lose this draft");
  });

  it("forwards the configured tool-round limit", () => {
    mockSettings.maxToolRounds = 32;
    render(<Harness />);
    const composer = screen.getByPlaceholderText("Message…");
    fireEvent.change(composer, { target: { value: "Complete the long task" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(window.moss.chat.send).toHaveBeenCalledWith(
      expect.objectContaining({ maxToolRounds: 32 }),
    );
  });

  it("renders a terminal task snapshot that arrives after turn-complete", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "turn-complete", messages: [{ role: "assistant", content: "done" }] });
    emit(turnId, { type: "task-state", task: taskSnapshot("completed") });

    expect(screen.getByLabelText("Task status").textContent).toContain("completed");
    expect(screen.getByLabelText("Task status").textContent).toContain("Complete the durable task");
    expect(mockSetSessionTaskId).toHaveBeenCalledWith("s1", "task-1");
  });

  it("restores a paused task after remount without resuming automatically", async () => {
    mockSession.value.taskId = "task-1";
    vi.mocked(window.moss.task.get).mockResolvedValue(taskSnapshot("paused"));
    render(<Harness />);

    await screen.findByRole("button", { name: "Resume", exact: true });
    expect(window.moss.task.get).toHaveBeenCalledWith("task-1");
    expect(screen.getByLabelText("Task status").textContent).toContain("paused");
    expect(window.moss.task.resume).not.toHaveBeenCalled();
    expect(window.moss.chat.send).not.toHaveBeenCalled();
  });

  it("ignores a restored task after switching to another conversation", async () => {
    let resolveTask!: (task: TaskSnapshot) => void;
    mockSession.value.taskId = "task-1";
    vi.mocked(window.moss.task.get).mockReturnValue(new Promise((resolve) => { resolveTask = resolve; }));
    const view = render(<Harness />);
    mockSession.value = { ...mockSession.value, id: "s2", taskId: undefined };
    view.rerender(<Harness />);

    await act(async () => { resolveTask(taskSnapshot("paused")); });

    expect(screen.queryByLabelText("Task status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume", exact: true })).toBeNull();
    expect(window.moss.chat.send).not.toHaveBeenCalled();
  });

  it("resumes and cancels a blocked durable task", async () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, {
      type: "task-state",
      task: taskSnapshot("blocked", { kind: "verification", summary: "Tests failed", resumable: true, createdAt: "2026-01-01T00:00:00.000Z" }),
    });

    fireEvent.click(screen.getByText("Resume"));
    await waitFor(() => expect(window.moss.task.resume).toHaveBeenCalledWith("task-1"));
    expect(screen.getByLabelText("Task status").textContent).toContain("executing");
    expect(window.moss.chat.send).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      taskSpec: expect.objectContaining({ objective: "Complete the durable task" }),
    }));

    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(window.moss.task.cancel).toHaveBeenCalledWith("task-1"));
    expect(screen.getByLabelText("Task status").textContent).toContain("cancelled");
  });

  it("does not offer Resume while a durable approval is pending", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, {
      type: "task-state",
      task: {
        ...taskSnapshot("waiting_for_approval", {
          kind: "approval",
          summary: "Approval required for write_file",
          resumable: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        approval: {
          taskId: "task-1",
          turnId,
          callId: "call-1",
          toolName: "write_file",
          arguments: "{}",
          status: "pending",
          requestedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    expect(screen.getByLabelText("Task status").textContent).toContain("write_file pending");
    expect(screen.queryByText("Resume")).toBeNull();
  });

  it("loads and renders the sanitized task timeline", async () => {
    vi.mocked(window.moss.task.history).mockResolvedValue([
      {
        id: "event-1",
        taskId: "task-1",
        revision: 0,
        sequence: 0,
        occurredAt: "2026-01-01T00:00:00.000Z",
        kind: "created",
        summary: "Task created",
      },
      {
        id: "event-2",
        taskId: "task-1",
        revision: 3,
        sequence: 1,
        occurredAt: "2026-01-01T00:01:00.000Z",
        kind: "approval",
        summary: "write_file approval denied",
        turnId: "turn-1",
        callId: "call-1",
        toolName: "write_file",
        approvalStatus: "denied",
      },
    ]);
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "task-state", task: taskSnapshot("completed") });

    await screen.findByText("Timeline (2)");
    expect(window.moss.task.history).toHaveBeenCalledWith("task-1");
    expect(screen.getByText("Task created")).toBeDefined();
    expect(screen.getByText("write_file approval denied")).toBeDefined();
  });

  it("renders mission graph, evidence, artifacts, exclusive work, and remaining budgets", () => {
    render(<Harness />);
    const turnId = startTurn();
    const snapshot = taskSnapshot("executing");
    snapshot.spec.budget = { maxDurationMs: 900000, maxTokens: 50000, maxActions: 24, maxCostUsd: 5 };
    snapshot.steps = [{
      id: "implement",
      description: "Apply the verified change",
      state: "running",
      dependsOn: [],
      requiredCapabilities: ["write_file"],
      mission: {
        kind: "implement",
        workerRole: "implementer",
        executionLane: "exclusive",
        acceptanceCriterionIds: ["requested-outcome"],
        budget: { maxActions: 10 },
        expectedArtifacts: ["change-summary"],
      },
    }];
    snapshot.missionPlan = { schemaVersion: 1, revision: 3, steps: snapshot.steps };
    snapshot.attempts = [{
      id: "attempt-1",
      stepId: "implement",
      startedAt: snapshot.createdAt,
      actionCount: 4,
      usage: { inputTokens: 7000, outputTokens: 3000 },
      estimatedCostUsd: 1.25,
    }];
    snapshot.evidence = [{
      id: "evidence-1",
      criterionId: "requested-outcome",
      kind: "command",
      passed: true,
      summary: "Focused tests passed",
      capturedAt: snapshot.updatedAt,
    }];
    snapshot.artifacts = [{
      id: "artifact-1",
      taskId: snapshot.id,
      planRevision: 3,
      stepId: "implement",
      attemptId: "attempt-1",
      name: "change-summary",
      summary: "Verified source update",
      sha256: "a".repeat(64),
      byteLength: 42,
      createdAt: snapshot.updatedAt,
    }];
    emit(turnId, { type: "task-state", task: snapshot });

    expect(screen.getByLabelText("Task status").textContent).toContain("Plan r3 · 0/1 steps");
    expect(screen.getByLabelText("Remaining mission budget").textContent).toContain("20 actions left");
    expect(screen.getByLabelText("Remaining mission budget").textContent).toContain("40,000 tokens left");
    expect(screen.getByLabelText("Remaining mission budget").textContent).toContain("Exclusive: Apply the verified change");
    fireEvent.click(screen.getByText("Mission details"));
    expect(screen.getByText("Focused tests passed")).toBeDefined();
    expect(screen.getByLabelText("Mission artifacts").textContent).toContain("Verified source update");
  });

  it("stamps a per-turn token subtotal on the final reply of a multi-round turn", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
          usage: { inputTokens: 10, outputTokens: 2 },
        },
        { role: "tool", toolCallId: "c1", content: "ok" },
        { role: "assistant", content: "done", usage: { inputTokens: 8, outputTokens: 4 } },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const turnEl = screen.getByTitle(
      "Total token usage for this exchange across all tool rounds (input / output).",
    );
    expect(turnEl.textContent).toBe("turn 18/6 tok");
  });

  it("omits the per-turn subtotal for a single-round turn", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", usage: { inputTokens: 3, outputTokens: 5 } },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    expect(
      screen.queryByTitle(
        "Total token usage for this exchange across all tool rounds (input / output).",
      ),
    ).toBeNull();
  });

  it("shows a revert affordance on a turn that changed files and undoes them on click", async () => {
    const list = vi.fn(() => Promise.resolve([{ path: "a.ts", existed: true }, { path: "b.ts", existed: false }]));
    const revert = vi.fn(() => Promise.resolve({ reverted: 2, errors: [] }));
    (window.moss as { checkpoint?: unknown }).checkpoint = { list, revert };
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "edit files" },
        { role: "assistant", content: "done", turnId: "turn-42" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);

    const revertBtn = await screen.findByText("Revert");
    expect(list).toHaveBeenCalledWith("turn-42");
    expect(screen.getByText("2 files changed")).toBeTruthy();

    fireEvent.click(revertBtn);
    expect(revert).toHaveBeenCalledWith("turn-42");
    await screen.findByText("Reverted 2 files");
    expect(screen.queryByText("Revert")).toBeNull();
  });

  it("shows no revert affordance when a turn changed no files", async () => {
    const list = vi.fn(() => Promise.resolve([]));
    (window.moss as { checkpoint?: unknown }).checkpoint = { list, revert: vi.fn() };
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "just chat" },
        { role: "assistant", content: "hello", turnId: "turn-7" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);

    await waitFor(() => expect(list).toHaveBeenCalledWith("turn-7"));
    expect(screen.queryByText("Revert")).toBeNull();
  });

  it("formats large per-turn token counts with thousands separators", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
          usage: { inputTokens: 10000, outputTokens: 2000 },
        },
        { role: "tool", toolCallId: "c1", content: "ok" },
        { role: "assistant", content: "done", usage: { inputTokens: 8000, outputTokens: 4000 } },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const turnEl = screen.getByTitle(
      "Total token usage for this exchange across all tool rounds (input / output).",
    );
    expect(turnEl.textContent).toBe("turn 18,000/6,000 tok");
  });

  it("renders a fenced code block in an assistant reply as preformatted code", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "show me" },
        { role: "assistant", content: "Here you go:\n```ts\nconst x = 1;\n```" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    expect(screen.getByRole("img", { name: "Moss response" })).toBeDefined();
    const code = screen.getByText("const x = 1;");
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).not.toBeNull();
  });

  it("copies an assistant reply to the clipboard from its response action", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "the answer" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    expect(writeText).toHaveBeenCalledWith("the answer");
  });

  it("copies just the code block from its own copy button", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "show" },
        { role: "assistant", content: "```\ncode body\n```" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("code body");
  });

  it("shows copied feedback after clicking the reply copy action", () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "the answer" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    expect(screen.getByRole("button", { name: "Response copied" })).toBeTruthy();
  });

  it("regenerates a response from its originating user message", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);

    const actions = screen.getAllByRole("button", { name: "Regenerate response" });
    fireEvent.click(actions[1]);
    const payload = vi.mocked(window.moss.chat.send).mock.calls[0][0];
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages.at(-1)).toEqual({ role: "user", content: "second question" });
  });

  it("renders bold inline markdown as a strong element", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "this is **important** now" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const strong = screen.getByText("important");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders a bulleted list as list items", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "list" },
        { role: "assistant", content: "- alpha\n- beta" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const item = screen.getByText("alpha");
    expect(item.closest("li")).not.toBeNull();
    expect(item.closest("ul")).not.toBeNull();
  });

  it("renders a markdown heading as a styled element, not literal hashes", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "head" },
        { role: "assistant", content: "## Section title" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    expect(screen.getByText("Section title")).toBeDefined();
    expect(screen.queryByText("## Section title")).toBeNull();
  });

  it("renders a markdown pipe table as a table cell, not literal pipes", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "grid" },
        { role: "assistant", content: "| A | B |\n| --- | --- |\n| one | two |" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const cell = screen.getByText("one");
    expect(cell.closest("td")).not.toBeNull();
    expect(cell.closest("table")).not.toBeNull();
  });

  it("renders a markdown task list as disabled checkboxes with labels", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "todo" },
        { role: "assistant", content: "- [ ] open\n- [x] closed" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const boxes = document.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("closed")).toBeDefined();
  });

  it("renders strikethrough markdown with semantic markup", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "this is ~~gone~~ now" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    expect(screen.getByText("gone").tagName).toBe("DEL");
  });

  it("copies a response containing a table as its markdown source", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "grid" },
        { role: "assistant", content: "| A | B |\n| --- | --- |\n| one | two |" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    expect(writeText).toHaveBeenCalledWith("| A | B |\n| --- | --- |\n| one | two |");
  });

  it("copies a response containing a task list as its markdown source", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "todo" },
        { role: "assistant", content: "- [ ] open\n- [x] closed" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    expect(writeText).toHaveBeenCalledWith("- [ ] open\n- [x] closed");
  });

  it("renders a safe link with the URL in the title", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "link" },
        { role: "assistant", content: "see [docs](https://example.com)" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const link = screen.getByText("docs");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("title")).toBe("https://example.com");
  });

  it("opens a link's URL via the shell bridge when clicked, not by navigating", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "link" },
        { role: "assistant", content: "see [docs](https://example.com)" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("docs"));
    expect(window.moss.shell.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("shows a drop overlay while a file is dragged over the composer", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const footer = document.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(screen.queryByText("Drop files to attach")).toBeNull();
    fireEvent.dragEnter(footer as Element);
    expect(screen.getByText("Drop files to attach")).toBeDefined();
    fireEvent.dragLeave(footer as Element);
    expect(screen.queryByText("Drop files to attach")).toBeNull();
  });

  it("keeps the drop overlay up while the drag crosses nested children", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const footer = document.querySelector("footer") as Element;
    // Enter footer, then enter a child (depth 2), leave the child (depth 1):
    // the overlay must stay because the drag has not actually left the footer.
    fireEvent.dragEnter(footer);
    fireEvent.dragEnter(footer);
    fireEvent.dragLeave(footer);
    expect(screen.getByText("Drop files to attach")).toBeDefined();
    fireEvent.dragLeave(footer);
    expect(screen.queryByText("Drop files to attach")).toBeNull();
  });

  it("renders image attachments on a user message as thumbnails", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [{ role: "user", content: "look", images: ["data:image/png;base64,AAAA"] }],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const img = screen.getByAltText("attachment");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("does not send until a selected image has finished attaching", async () => {
    let reader: {
      result: string | null;
      onload: (() => void) | null;
      onerror: (() => void) | null;
      onloadend: (() => void) | null;
    } | null = null;

    class DeferredFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onloadend: (() => void) | null = null;

      constructor() {
        reader = this;
      }

      readAsDataURL(): void {}
      readAsText(): void {}
    }

    vi.stubGlobal("FileReader", DeferredFileReader);
    render(<Harness />);

    const file = new File(["pixels"], "photo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "describe this" } });

    expect(screen.getByText("Attaching 1 file...")).toBeDefined();
    expect((screen.getByText("Send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Send"));
    expect(window.moss.chat.send).not.toHaveBeenCalled();

    act(() => {
      if (!reader) throw new Error("Expected an attachment reader");
      reader.result = "data:image/png;base64,AAAA";
      reader.onload?.();
      reader.onloadend?.();
    });

    await waitFor(() => expect((screen.getByText("Send") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Send"));

    expect(window.moss.chat.send).toHaveBeenCalledOnce();
    const request = (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages).toEqual([
      { role: "user", content: "describe this", images: ["data:image/png;base64,AAAA"] },
    ]);
  });

  it("keeps a text document out of the chat body while sending it as an attachment", async () => {
    render(<Harness />);
    const file = new File(["private file body"], "notes.txt", { type: "text/plain" });

    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("notes.txt")).toBeDefined());
    expect((screen.getByPlaceholderText("Message…") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("private file body")).toBeNull();
    expect(screen.getByText("Attach (1)")).toBeDefined();

    fireEvent.click(screen.getByText("Send"));

    const request = (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages).toEqual([
      {
        role: "user",
        content: "",
        documents: [{ name: "notes.txt", mediaType: "text/plain", text: "private file body" }],
      },
    ]);
    expect(screen.queryByText("private file body")).toBeNull();
  });

  it("extracts and sends a selected PDF as a document attachment", async () => {
    mockExtractPdfText.mockResolvedValue("First page\n\nSecond page");
    render(<Harness />);

    const input = screen.getByLabelText("Attach files") as HTMLInputElement;
    expect(input.accept).toContain(".pdf");
    const file = new File(["pdf bytes"], "report.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("report.pdf")).toBeDefined());
    fireEvent.click(screen.getByText("Send"));

    const request = (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages).toEqual([
      {
        role: "user",
        content: "",
        documents: [
          { name: "report.pdf", mediaType: "application/pdf", text: "First page\n\nSecond page" },
        ],
      },
    ]);
  });

  it("shows enabled skills after slash and inserts the selected skill", async () => {
    window.moss.skills.list = vi.fn(() =>
      Promise.resolve([
        {
          id: "physics-tutor",
          name: "Physics Tutor",
          description: "Teach physics from first principles",
          instructions: "",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "disabled",
          name: "Disabled Skill",
          description: "Should not appear",
          instructions: "",
          enabled: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    render(<Harness />);
    const composer = screen.getByPlaceholderText("Message…") as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: "/phy" } });

    await waitFor(() => expect(screen.getByRole("option", { name: /Physics Tutor/ })).toBeDefined());
    expect(screen.queryByText("Disabled Skill")).toBeNull();
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(composer.value).toBe("/Physics Tutor ");
    expect(window.moss.chat.send).not.toHaveBeenCalled();
  });

  it("clears the current conversation when Clear is clicked", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Clear"));
    expect(mockClearSession).toHaveBeenCalledWith("s1");
  });

  it("hides the Clear action for an empty conversation", () => {
    render(<Harness />);
    expect(screen.queryByText("Clear")).toBeNull();
  });

  it("forks the conversation with a model-written summary when Continue in new chat is clicked", async () => {
    mockSession.value = {
      id: "s1",
      title: "Refactor the parser",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Continue in new chat"));
    await waitFor(() => expect(mockContinueInNewSession).toHaveBeenCalledWith("s1", "MODEL SUMMARY"));
    expect(mockSummarize).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Refactor the parser", messages: mockSession.value.messages }),
    );
  });

  it("falls back to the local digest and explains why when the summary fails", async () => {
    mockSummarize.mockResolvedValue({ ok: false, summary: "", error: "provider unreachable" });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Continue in new chat"));
    await waitFor(() => expect(mockContinueInNewSession).toHaveBeenCalledWith("s1", undefined));
    expect(screen.getByText(/provider unreachable/)).toBeDefined();
  });

  it("hides the Continue in new chat action for an empty conversation", () => {
    render(<Harness />);
    expect(screen.queryByText("Continue in new chat")).toBeNull();
  });

  it("renders a carried-over context message as a collapsed card", () => {
    mockSession.value = {
      id: "s1",
      title: "Old chat (continued)",
      messages: [
        { role: "user", content: "# Carried-over context", handoff: true },
        { role: "assistant", content: "Ready to continue.", handoff: true },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    expect(screen.getByText("Carried-over context")).toBeDefined();
    expect(screen.getByText("Summary of the previous chat, sent as the first message")).toBeDefined();
  });

  it("shows the auto-approve indicator only when the setting is on", () => {
    const { unmount } = render(<Harness />);
    expect(screen.queryByText("Auto-approving tools")).toBeNull();
    unmount();

    mockSettings.autoApproveTools = true;
    render(<Harness />);
    expect(screen.getByText("Auto-approving tools")).toBeDefined();
  });

  it("surfaces the connected MCP tool count in the header", async () => {
    window.moss.mcp.status = vi.fn(() =>
      Promise.resolve([
        { id: "a", enabled: true, connected: true, toolCount: 2 },
        { id: "b", enabled: true, connected: false, toolCount: 0, error: "down" },
        { id: "c", enabled: true, connected: true, toolCount: 3 },
      ]),
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("5 MCP tools")).toBeDefined());
    expect(screen.getByText("1 MCP server down")).toBeDefined();
  });

  it("sends a turn and shows the pending user message", () => {
    render(<Harness />);
    const turnId = startTurn();
    const req = (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "hi there" });
    expect(req.enableTools).toBe(true);
    expect(typeof turnId).toBe("string");
    expect(screen.getByText("hi there")).toBeDefined();
    // busy is now true, so the Send button has swapped to Stop
    expect(screen.getByText("Stop")).toBeDefined();
  });

  it("renders streamed text deltas for the active turn", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "text-delta", text: "Hel" });
    emit(turnId, { type: "text-delta", text: "lo" });
    expect(screen.getByText("Hello")).toBeDefined();
  });

  it("renders streamed deltas as markdown, not literal text", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "text-delta", text: "| A | B |\n| --- | --- |\n" });
    emit(turnId, { type: "text-delta", text: "| one | two |" });
    const cell = screen.getByText("one");
    expect(cell.closest("td")).not.toBeNull();
    expect(cell.closest("table")).not.toBeNull();
  });

  it("ignores events from a stale turn", () => {
    render(<Harness />);
    startTurn();
    emit("not-the-current-turn", { type: "text-delta", text: "ghost" });
    expect(screen.queryByText("ghost")).toBeNull();
  });

  it("runs the tool card through the approval gate to a result", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "tool-call", callId: "c1", name: "read_file", arguments: "{}" });
    emit(turnId, { type: "tool-approval-request", callId: "c1", name: "read_file", arguments: "{}" });

    expect(screen.getByText("Approve")).toBeDefined();
    fireEvent.click(screen.getByText("Approve"));
    expect(window.moss.tool.approve).toHaveBeenCalledWith({ turnId, callId: "c1", approved: true });

    emit(turnId, { type: "tool-result", callId: "c1", name: "read_file", ok: true, content: "file body" });
    const card = screen.getByText("read_file").closest("details") as HTMLDetailsElement;
    expect(card.open).toBe(false);
    fireEvent.click(screen.getByText("read_file"));
    expect(card.open).toBe(true);
    expect(screen.getByText("file body")).toBeDefined();
  });

  it("sends an optional reason with an approval decision", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "tool-call", callId: "c1", name: "write_file", arguments: "{}" });
    emit(turnId, { type: "tool-approval-request", callId: "c1", name: "write_file", arguments: "{}" });

    fireEvent.change(screen.getByLabelText("Approval reason"), { target: { value: "Use another path" } });
    fireEvent.click(screen.getByText("Deny"));

    expect(window.moss.tool.approve).toHaveBeenCalledWith({
      turnId,
      callId: "c1",
      approved: false,
      comment: "Use another path",
    });
  });

  it("renders completed tool history collapsed and expandable", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "search" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_search", arguments: '{"query":"news"}' }] },
        { role: "tool", toolCallId: "c1", content: "result body", autoApproved: true },
      ],
      createdAt: 0,
      updatedAt: 0,
    };

    render(<Harness />);
    const card = screen.getByText("web_search").closest("details") as HTMLDetailsElement;
    expect(card.open).toBe(false);
    fireEvent.click(screen.getByText("web_search"));
    expect(card.open).toBe(true);
    expect(screen.getByText("result body")).toBeDefined();
  });

  it("flags a destructive command on the approval prompt", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "tool-call", callId: "c2", name: "run_command", arguments: "{}" });
    emit(turnId, {
      type: "tool-approval-request",
      callId: "c2",
      name: "run_command",
      arguments: "{}",
      risk: "destructive",
    });

    expect(screen.getByText("Approval required.")).toBeDefined();
    expect(screen.getByText("destructive")).toBeDefined();
  });

  it("opens a tool-activity audit listing each call's name, risk tier, and auto flag", () => {
    mockToolState.usage = { total: 2, autoApproved: 1 };
    mockToolState.audit = [
      { callId: "c1", name: "read_file", risk: "readonly", autoApproved: true },
      { callId: "c2", name: "write_file", risk: "mutating", autoApproved: false },
    ];
    render(<Harness />);

    fireEvent.click(screen.getByText("2 tools (1 auto)"));

    expect(screen.getByText("Tool activity")).toBeDefined();
    expect(screen.getByText("read_file")).toBeDefined();
    expect(screen.getByText("readonly")).toBeDefined();
    expect(screen.getByText("write_file")).toBeDefined();
    expect(screen.getByText("mutating")).toBeDefined();
    expect(screen.getByText("auto")).toBeDefined();
  });

  it("filters readonly rows and sorts by risk in the audit popover", () => {
    mockToolState.usage = { total: 3, autoApproved: 0 };
    mockToolState.audit = [
      { callId: "c1", name: "read_file", risk: "readonly", autoApproved: false },
      { callId: "c2", name: "write_file", risk: "mutating", autoApproved: false },
      { callId: "c3", name: "run_command", risk: "destructive", autoApproved: false },
    ];
    render(<Harness />);

    fireEvent.click(screen.getByText(/3 tools/));
    expect(screen.getByText("read_file")).toBeDefined();

    // Hiding readonly rows drops the read_file call.
    fireEvent.click(screen.getByText("Hide readonly"));
    expect(screen.queryByText("read_file")).toBeNull();
    expect(screen.getByText("write_file")).toBeDefined();
    expect(screen.getByText("run_command")).toBeDefined();

    // Sorting by risk orders the remaining calls destructive-first.
    fireEvent.click(screen.getByText("By risk"));
    const order = screen.getAllByText(/^(write_file|run_command)$/).map((n) => n.textContent);
    expect(order).toEqual(["run_command", "write_file"]);
  });

  it("commits messages and clears busy on turn-complete", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "turn-complete", messages: [{ role: "assistant", content: "done" }] });

    expect(mockSetSessionMessages).toHaveBeenCalledTimes(1);
    expect(mockSetSessionMessages.mock.calls[0][0]).toBe("s1");
    // The committed history must keep the user message, not just the reply.
    expect(mockSetSessionMessages.mock.calls[0][1]).toEqual([
      { role: "user", content: "hi there" },
      { role: "assistant", content: "done" },
    ]);
    // busy cleared -> Send button is back
    expect(screen.getByText("Send")).toBeDefined();
  });

  it("persists the user message, shows an error, and clears busy on turn-error", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "turn-error", message: "boom", messages: [] });
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", [{ role: "user", content: "hi there" }]);
    expect(screen.getByText("Error: boom")).toBeDefined();
    expect(screen.getByText("Send")).toBeDefined();
  });

  it("persists the partial reply and flags it interrupted on turn-error", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, {
      type: "turn-error",
      message: "boom",
      messages: [{ role: "assistant", content: "partial reply" }],
    });
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", [
      { role: "user", content: "hi there" },
      { role: "assistant", content: "partial reply", interrupted: true },
    ]);
  });

  it("commits the user message and aborted output on turn-aborted", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "turn-aborted", messages: [{ role: "assistant", content: "partial" }] });
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", [
      { role: "user", content: "hi there" },
      { role: "assistant", content: "partial" },
    ]);
    expect(screen.getByText("Aborted")).toBeDefined();
  });

  it.each([
    { event: { type: "turn-aborted", messages: [] } as MossEvent, status: "Aborted" },
    { event: { type: "turn-error", message: "boom", messages: [] } as MossEvent, status: "Error: boom" },
  ])("clears $status when switching conversations", ({ event, status }) => {
    const { rerender } = render(<Harness />);
    const turnId = startTurn();
    emit(turnId, event);
    expect(screen.getByText(status)).toBeDefined();

    mockSession.value = { ...mockSession.value, id: "s2", title: "Other conversation" };
    rerender(<Harness />);

    expect(screen.queryByText(status)).toBeNull();
    expect(mockSetSessionMessages).toHaveBeenCalledTimes(1);
    expect(mockSetSessionMessages.mock.calls[0][0]).toBe("s1");
    expect(window.moss.chat.send).toHaveBeenCalledTimes(1);
  });

  it("aborts the active turn from the Stop button", () => {
    render(<Harness />);
    const turnId = startTurn();
    fireEvent.click(screen.getByText("Stop"));
    expect(window.moss.chat.abort).toHaveBeenCalledWith(turnId);
  });

  it("aborts the active turn and sends added context after the partial reply is committed", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "text-delta", text: "partial" });

    const composer = screen.getByPlaceholderText("Message…");
    expect(screen.getByText("Interrupt")).toBeDefined();
    fireEvent.change(composer, { target: { value: "Actually, focus on the parser" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(window.moss.chat.abort).toHaveBeenCalledWith(turnId);
    expect(window.moss.chat.send).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Queued")).toBeDefined();

    emit(turnId, { type: "turn-aborted", messages: [{ role: "assistant", content: "partial" }] });

    expect(window.moss.chat.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(window.moss.chat.send).mock.calls[1][0].messages).toEqual([
      { role: "user", content: "hi there" },
      { role: "assistant", content: "partial" },
      { role: "user", content: "Actually, focus on the parser" },
    ]);
  });

  it("unsubscribes from the event feed on unmount", () => {
    const { unmount } = render(<Harness />);
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("discards an interrupted follow-up when Stop is clicked", () => {
    render(<Harness />);
    const turnId = startTurn();
    const composer = screen.getByPlaceholderText("Message…");
    fireEvent.change(composer, { target: { value: "Queued follow-up" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.click(screen.getByText("Stop"));
    emit(turnId, { type: "turn-aborted", messages: [] });
    expect(window.moss.chat.send).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Queued")).toBeNull();
  });

  it("hides the per-bubble Regenerate and Edit actions for an empty conversation", () => {
    render(<Harness />);
    expect(screen.queryByText("Regenerate")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
  });

  it("regenerates by re-running the last user turn without its assistant reply", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Regenerate"));
    const req = (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The dropped assistant reply must not be replayed; only the user prompt goes back.
    expect(req.messages).toEqual([{ role: "user", content: "first" }]);
  });

  it("pulls the last user turn back into the composer and truncates history on edit", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "typo here" },
        { role: "assistant", content: "reply" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Edit"));
    const box = screen.getByPlaceholderText("Message…") as HTMLTextAreaElement;
    expect(box.value).toBe("typo here");
    // History is truncated before the edited turn so resending does not duplicate it.
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", []);
  });

  it("regenerates an earlier turn from its own bubble, dropping all later messages", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "second" },
        { role: "assistant", content: "a2" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    // Two user bubbles -> two Regenerate buttons; the first re-runs from index 0.
    fireEvent.click(screen.getAllByText("Regenerate")[0]);
    const req = (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.messages).toEqual([{ role: "user", content: "first" }]);
  });

  it("edits an earlier turn from its own bubble, truncating everything after it", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "second" },
        { role: "assistant", content: "a2" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getAllByText("Edit")[0]);
    const box = screen.getByPlaceholderText("Message…") as HTMLTextAreaElement;
    expect(box.value).toBe("first");
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", []);
  });
});

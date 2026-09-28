// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MissionContractEditor, missionContractIssues, type MissionContract } from "./MissionReview";

function contract(overrides: Partial<MissionContract> = {}): MissionContract {
  return {
    criteria: [{
      id: "done",
      description: "The report exists",
      mandatory: true,
      verification: { kind: "commands", commands: ["npm test"] },
    }],
    constraints: "",
    assumptions: "",
    ...overrides,
  };
}

describe("missionContractIssues", () => {
  it("accepts a mandatory criterion with an enabled command and workspace", () => {
    expect(missionContractIssues(contract(), ["npm test"], "C:\\workspace")).toEqual([]);
  });

  it("rejects missing outcomes, unconfigured commands, and workspace checks without a workspace", () => {
    const issues = missionContractIssues(contract({
      criteria: [{
        id: "done",
        description: "",
        mandatory: true,
        verification: { kind: "commands", commands: ["npm run unknown"] },
      }],
    }), ["npm test"], null);

    expect(issues).toEqual(expect.arrayContaining([
      "Criterion 1 needs a measurable outcome.",
      "Criterion 1 needs a selected workspace for command verification.",
      "Criterion 1 uses a command that is not enabled in Settings.",
    ]));
  });

  it("accepts a valid HTTP criterion without a workspace", () => {
    expect(missionContractIssues(contract({
      criteria: [{
        id: "health",
        description: "The service is healthy",
        mandatory: true,
        verification: { kind: "http", url: "https://example.com/health", expectedStatus: 200 },
      }],
    }), [], null)).toEqual([]);
  });

  it("requires an independent critic for a critic-bound criterion", () => {
    const critic = contract({ criteria: [{ id: "c", description: "Report answers it", mandatory: true, verification: { kind: "critic", rubric: "", paths: ["report.md"] } }] });
    expect(missionContractIssues(critic, [], "C:\\ws", { model: "claude-sonnet-4-5", workers: ["qwen2.5:7b"] })).toEqual([]);
    expect(missionContractIssues(critic, [], "C:\\ws", { workers: ["qwen2.5:7b"] })[0]).toMatch(/^Criterion 1: No critic model is configured/);
    expect(missionContractIssues(critic, [], "C:\\ws", { model: "qwen3.5:4b", workers: ["qwen2.5:7b"] })[0]).toMatch(/same model family/);
    expect(missionContractIssues(critic, [], null, { model: "claude-sonnet-4-5", workers: ["qwen2.5:7b"] })).toContain("Criterion 1 needs a selected workspace for the files the critic reviews.");
  });

  it("rejects invalid HTTP status values", () => {
    expect(missionContractIssues(contract({
      criteria: [{
        id: "health",
        description: "The service is healthy",
        mandatory: true,
        verification: { kind: "http", url: "https://example.com/health", expectedStatus: 700 },
      }],
    }), [], null)).toContain("Criterion 1 needs an HTTP status between 100 and 599.");
  });
});

describe("MissionContractEditor", () => {
  it("updates the measurable outcome and verification method", () => {
    const onChange = vi.fn();
    const input = contract({
      criteria: [{ id: "done", description: "", mandatory: true }],
    });
    const view = render(
      <MissionContractEditor contract={input} configuredCommands={["npm test"]} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Acceptance criterion 1"), { target: { value: "Tests pass" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      criteria: [expect.objectContaining({ description: "Tests pass" })],
    }));

    view.rerender(
      <MissionContractEditor contract={input} configuredCommands={["npm test"]} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText("Verification method 1"), { target: { value: "commands" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      criteria: [expect.objectContaining({ verification: { kind: "commands", commands: ["npm test"] } })],
    }));
  });

  it("edits a critic review's rubric and files", () => {
    const onChange = vi.fn();
    const input = contract({ criteria: [{ id: "c", description: "Report", mandatory: true, verification: { kind: "critic", rubric: "", paths: [] } }] });
    render(<MissionContractEditor contract={input} configuredCommands={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Critic rubric 1"), { target: { value: "Needs sources" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ criteria: [expect.objectContaining({ verification: { kind: "critic", rubric: "Needs sources", paths: [] } })] }));
    fireEvent.change(screen.getByLabelText("Critic files 1"), { target: { value: "a.md, my notes.md" } });
    // Kept as typed, so a space inside a name survives; the verifier trims each path.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ criteria: [expect.objectContaining({ verification: { kind: "critic", rubric: "", paths: ["a.md", " my notes.md"] } })] }));
  });
});

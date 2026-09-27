// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Skill } from "@common/types";

import { SkillTrustControls } from "./SkillTrustControls";
import { WorkingStatePanel } from "./WorkingStatePanel";

const addEntry = vi.fn();
const removeEntry = vi.fn();
vi.mock("../lib/sessions", () => ({
  addWorkingStateEntry: (...args: unknown[]) => addEntry(...args),
  removeWorkingStateEntry: (...args: unknown[]) => removeEntry(...args),
}));

afterEach(() => {
  cleanup();
  addEntry.mockReset();
  removeEntry.mockReset();
  Reflect.deleteProperty(window, "moss");
});

describe("WorkingStatePanel", () => {
  it("lists entries by kind, adds user entries, removes any entry, and closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <WorkingStatePanel
        sessionId="s1"
        state={{
          schemaVersion: 1,
          entries: [
            { id: "p1", kind: "protected", text: "config/**", source: "user", createdAt: "x" },
            { id: "d1", kind: "decision", text: "Use SQLite", rationale: "bundled", source: "model", createdAt: "x" },
          ],
        }}
        onClose={onClose}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close working state" }));
    expect(screen.getByRole("region", { name: "Protected paths" }).textContent).toContain("config/**");
    expect(screen.getByText("Because bundled")).toBeDefined();
    expect(screen.getByText("d1 · model")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Entry type"), { target: { value: "decision" } });
    fireEvent.change(screen.getByLabelText("Entry text"), { target: { value: "Ship Friday" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(addEntry).toHaveBeenCalledWith("s1", "decision", "Ship Friday", "demo");
    fireEvent.click(screen.getByRole("button", { name: "Remove Use SQLite" }));
    expect(removeEntry).toHaveBeenCalledWith("s1", "d1");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("explains each kind when empty", () => {
    render(<WorkingStatePanel sessionId="s1" state={undefined} onClose={vi.fn()} />);
    expect(screen.getByText(/Moss refuses to create, change, move, or delete/)).toBeDefined();
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SkillTrustControls", () => {
  const skill = (status: "trusted" | "candidate" | "demoted", version = 2): Skill => ({
    id: "deploy",
    name: "deploy",
    description: "",
    instructions: "",
    enabled: true,
    createdAt: "",
    trust: { status, version, uses: 5, verifiedSuccesses: 3, failures: 2, versionSuccesses: 1, consecutiveFailures: 2, stale: false, statusReason: "Demoted after 2 consecutive failures" },
  });

  beforeEach(() => {
    Object.assign(window, {
      moss: {
        skills: {
          setTrust: vi.fn(async () => null),
          history: vi.fn(async () => [{ version: 2, savedAt: "2026-09-26T00:00:00.000Z" }, { version: 1, savedAt: "2026-09-20T00:00:00.000Z" }]),
          rollback: vi.fn(async () => null),
        },
      },
    });
  });

  it("shows the verified record and restores or trusts a demoted skill", async () => {
    const onChanged = vi.fn();
    render(<SkillTrustControls skill={skill("demoted")} onChanged={onChanged} />);
    expect(screen.getByLabelText("Trust for deploy").textContent).toContain("v2 · 3 verified · 2 failed · 5 uses");
    fireEvent.click(screen.getByRole("button", { name: "Restore as candidate" }));
    await waitFor(() => expect(window.moss.skills.setTrust).toHaveBeenCalledWith("deploy", "candidate"));
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() => expect(window.moss.skills.setTrust).toHaveBeenCalledWith("deploy", "trusted"));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("lists versions and rolls back to an earlier one", async () => {
    render(<SkillTrustControls skill={skill("trusted")} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Roll back to v1" }));
    await waitFor(() => expect(window.moss.skills.rollback).toHaveBeenCalledWith("deploy", 1));
    expect(screen.queryByRole("button", { name: "Trust" })).toBeNull();
  });

  it("renders nothing before the ledger has seen the skill", () => {
    const { container } = render(<SkillTrustControls skill={{ ...skill("trusted"), trust: undefined }} onChanged={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});

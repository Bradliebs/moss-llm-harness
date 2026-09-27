// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recordTurnDecision, turnDecisionsStore } from "../lib/turnDecisions";
import { TurnDecisions } from "./TurnDecisions";

afterEach(() => {
  cleanup();
  turnDecisionsStore.set({});
});

describe("TurnDecisions", () => {
  it("lists a turn's harness decisions in order with links to their settings", () => {
    const open = vi.fn();
    recordTurnDecision("t1", { kind: "constrain", summary: "Using constrained tool output for tiny.", settings: "models" });
    recordTurnDecision("t1", { kind: "repair", summary: "Repaired read_file call: renamed argument file to path." });
    recordTurnDecision("t1", { kind: "gate", summary: "Asked before write_file because untrusted content entered the turn.", detail: "Changes after untrusted content always need approval.", settings: "safety" });
    recordTurnDecision("t2", { kind: "vote", summary: "other turn" });
    render(<TurnDecisions turnId="t1" onOpenSettings={open} />);
    expect(screen.getByText("Why? 3 harness decisions")).toBeDefined();
    const items = screen.getByLabelText("Harness decisions for this turn").querySelectorAll("li");
    expect([...items].map((item) => item.textContent)).toEqual([
      "ConstrainedUsing constrained tool output for tiny.Models settings",
      "RepairedRepaired read_file call: renamed argument file to path.",
      "Asked youAsked before write_file because untrusted content entered the turn.(Changes after untrusted content always need approval.)Safety settings",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Safety settings" }));
    expect(open).toHaveBeenCalledWith("safety");
  });

  it("renders nothing without decisions and updates live", () => {
    const { container } = render(<TurnDecisions turnId="t3" />);
    expect(container.textContent).toBe("");
    act(() => recordTurnDecision("t3", { kind: "escalate", summary: "Escalating to big." }));
    expect(screen.getByText("Why? 1 harness decision")).toBeDefined();
  });

  it("keeps only the most recent turns", () => {
    for (let index = 0; index < 205; index++) recordTurnDecision(`turn-${index}`, { kind: "scaffold", summary: "x" });
    const kept = Object.keys(turnDecisionsStore.get());
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe("turn-5");
  });
});

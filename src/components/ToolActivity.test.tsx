// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ToolActivity } from "./ToolActivity";

afterEach(cleanup);

describe("ToolActivity", () => {
  const entries = [
    { callId: "read", name: "read_file", risk: "readonly" as const, autoApproved: false, durationMs: 5 },
    { callId: "delete", name: "delete_file", risk: "destructive" as const, autoApproved: true, durationMs: 10 },
  ];

  it("opens, filters readonly calls, and sorts high-risk calls first", () => {
    render(<ToolActivity total={2} autoApproved={1} entries={entries} />);
    const trigger = screen.getByRole("button", { name: /2 tools/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(screen.getByText("read_file")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Hide readonly" }));
    expect(screen.queryByText("read_file")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "By risk" }));
    expect(screen.getByText("delete_file")).toBeDefined();
  });

  it("renders nothing when no tools ran", () => {
    const { container } = render(<ToolActivity total={0} autoApproved={0} entries={[]} />);
    expect(container.textContent).toBe("");
  });
});

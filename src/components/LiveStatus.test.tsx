// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveStatus, notificationFromMessage } from "./LiveStatus";

afterEach(cleanup);

describe("LiveStatus", () => {
  it("creates persistent correlated error notifications", () => {
    const notification = notificationFromMessage("Provider failed to connect");
    expect(notification).toMatchObject({ severity: "error", persistent: true });
    expect(notification.correlationId).toMatch(/^MOSS-/);

    render(<LiveStatus message={notification.message} />);
    expect(screen.getByRole("alert").textContent).toContain("Reference MOSS-");
  });

  it("supports explicit severity and recovery actions", () => {
    const onSelect = vi.fn();
    render(
      <LiveStatus
        message="Mission blocked"
        severity="warning"
        persistent
        correlationId="MOSS-TASK-1"
        action={{ label: "Review", onSelect }}
      />,
    );
    expect(screen.getByRole("status").getAttribute("data-persistent")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

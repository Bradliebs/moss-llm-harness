// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClarificationRequest } from "@common/clarification";
import { ClarificationForm } from "./ClarificationForm";

afterEach(cleanup);
const request: ClarificationRequest = { version: 1, title: "Output details", questions: [{ id: "format", prompt: "Which format?", options: ["Markdown", "Text"] }, { id: "folder", prompt: "Which folder?" }] };

describe("ClarificationForm", () => {
  it("submits ordinary answer text exactly once", () => {
    const onSubmit = vi.fn(() => true);
    render(<ClarificationForm request={request} disabled={false} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Which format?"), { target: { value: "choice-0" } });
    fireEvent.change(screen.getByLabelText("Which folder?"), { target: { value: "reports" } });
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.submit(screen.getByRole("form"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Answers to Output details:\n\nWhich format?\nMarkdown\n\nWhich folder?\nreports");
  });

  it("supports custom choices and does not accept incomplete answers", () => {
    const onSubmit = vi.fn(() => true);
    render(<ClarificationForm request={request} disabled={false} onSubmit={onSubmit} />);
    fireEvent.submit(screen.getByRole("form"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Answer each question");
    fireEvent.change(screen.getByLabelText("Which format?"), { target: { value: "other" } });
    fireEvent.change(screen.getByLabelText("Other answer for question 1"), { target: { value: "CSV" } });
    fireEvent.change(screen.getByLabelText("Which folder?"), { target: { value: "output" } });
    fireEvent.submit(screen.getByRole("form"));
    expect(onSubmit.mock.calls[0][0]).toContain("CSV");
  });

  it("retains answers after a refused send and permits retry", () => {
    const onSubmit = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ClarificationForm request={request} disabled={false} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Which format?"), { target: { value: "choice-1" } });
    fireEvent.change(screen.getByLabelText("Which folder?"), { target: { value: "reports" } });
    fireEvent.submit(screen.getByRole("form"));
    expect(screen.getByRole("alert").textContent).toContain("not sent");
    expect((screen.getByLabelText("Which folder?") as HTMLInputElement).value).toBe("reports");
    fireEvent.submit(screen.getByRole("form"));
    expect(screen.getByText("Answers sent")).toBeTruthy();
  });

  it("never submits disabled or historical forms", () => {
    const onSubmit = vi.fn();
    render(<ClarificationForm request={request} disabled onSubmit={onSubmit} />);
    fireEvent.submit(screen.getByRole("form"));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
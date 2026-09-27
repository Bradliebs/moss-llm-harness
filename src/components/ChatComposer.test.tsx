// @vitest-environment jsdom

import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatComposer } from "./ChatComposer";

function renderComposer(overrides: Partial<React.ComponentProps<typeof ChatComposer>> = {}) {
  const props: React.ComponentProps<typeof ChatComposer> = {
    value: "",
    onValueChange: vi.fn(),
    onKeyDown: vi.fn(),
    onPaste: vi.fn(),
    onFiles: vi.fn(),
    composerRef: createRef<HTMLTextAreaElement>(),
    attachmentCount: 0,
    dictationState: "idle",
    onToggleDictation: vi.fn(),
    busy: false,
    interruptQueued: false,
    modelSelected: true,
    pendingAttachmentReads: 0,
    hasSendContent: false,
    launchBlocked: false,
    mode: "chat",
    onSend: vi.fn(),
    onAbort: vi.fn(),
    ...overrides,
  };
  render(<ChatComposer {...props}>Toolbar</ChatComposer>);
  return props;
}

describe("ChatComposer", () => {
  it("owns controlled input, attachments, dictation, and send controls", () => {
    const props = renderComposer({ attachmentCount: 2 });

    fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "Next request" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "Mic" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(props.onValueChange).toHaveBeenCalledWith("Next request");
    expect(props.onToggleDictation).toHaveBeenCalled();
    expect(props.onSend).toHaveBeenCalled();
    expect(screen.getByText("Toolbar")).toBeDefined();
  });

  it("renders interrupt and stop controls while a turn is active", () => {
    const props = renderComposer({ busy: true, hasSendContent: true });

    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(props.onSend).toHaveBeenCalled();
    expect(props.onAbort).toHaveBeenCalled();
  });
});

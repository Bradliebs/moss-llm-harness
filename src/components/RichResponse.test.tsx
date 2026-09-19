// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RichResponse } from "./RichResponse";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("RichResponse", () => {
  it("activates Markdown table controls only after streaming and preserves safe cell rendering", () => {
    const openExternal = vi.fn();
    Object.assign(window, { moss: { shell: { openExternal } } });
    const content = "| File | Count |\n| --- | --- |\n| **Beta** | 10 |\n| [Alpha](https://example.com) | 2 |";
    const { rerender } = render(<RichResponse content={content} streaming onCopy={vi.fn()} />);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    rerender(<RichResponse content={content} onCopy={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Count" }));
    expect(screen.getAllByRole("row")[1].textContent).toContain("Alpha");
    fireEvent.click(screen.getByRole("link", { name: "Alpha" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Beta" } });
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta").tagName).toBe("STRONG");
  });

  it("renders nested GFM and copies fenced code", () => {
    const onCopy = vi.fn();
    render(
      <RichResponse
        content={"## Result\n\n- parent\n  - child\n\n```ts\nconst answer = 42;\n```"}
        onCopy={onCopy}
      />,
    );

    expect(screen.getByRole("heading", { name: "Result" })).toBeTruthy();
    expect(screen.getByText("child").closest("ul")?.parentElement?.closest("ul")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(onCopy).toHaveBeenCalledWith("const answer = 42;");
  });

  it("routes safe links through the shell and strips unsafe links", () => {
    const openExternal = vi.fn();
    Object.assign(window, { moss: { shell: { openExternal } } });
    render(
      <RichResponse
        content={"[docs](https://example.com) [unsafe](javascript:alert(1))"}
        onCopy={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "docs" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com");
    expect(screen.getByText("unsafe").getAttribute("href")).toBeNull();
  });

  it("shows a stable streaming indicator", () => {
    render(<RichResponse content="Working" streaming onCopy={vi.fn()} />);
    expect(screen.getByLabelText("Moss is writing")).toBeTruthy();
  });

  it("copies an arbitrary selection within the response", () => {
    const onCopy = vi.fn();
    render(<RichResponse content="Copy only this phrase from the response." onCopy={onCopy} />);
    const textNode = screen.getByText(/Copy only this phrase/).firstChild!;
    const selection = {
      anchorNode: textNode,
      focusNode: textNode,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "only this phrase",
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ left: 100, top: 80, width: 120 }),
      }),
      removeAllRanges: vi.fn(),
    };
    vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection);

    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));

    expect(onCopy).toHaveBeenCalledWith("only this phrase");
    expect(selection.removeAllRanges).toHaveBeenCalled();
  });
});
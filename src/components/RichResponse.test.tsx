// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RichResponse } from "./RichResponse";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("RichResponse", () => {
  it("activates Markdown table controls only after streaming and preserves safe cell rendering", () => {
    const openExternal = vi.fn();
    Object.assign(window, { moss: { shell: { openExternal } } });
    const content = "| File | Count |\n| --- | --- |\n| **Beta** | 10 |\n| [Alpha](https://example.com) | 2 |\n| Gamma | 5 |";
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

  it("renders the inline HTML models use, and nothing else from raw HTML", () => {
    const { container } = render(
      <RichResponse
        content={[
          "| Step | Notes |\n| --- | --- |\n| 1 | first<br>second |\n| 2 | x |\n| 3 | y |",
          "",
          "H<sub>2</sub>O, x<sup>2</sup>, press <kbd>Ctrl</kbd>+<kbd>K</kbd>, <del>old</del> <ins>new</ins> &amp; done",
          "",
          "<details>\n<summary>Full log</summary>\n\n- line one\n\n</details>",
          "",
          "<script>alert(1)</script><iframe src=\"https://evil.example\"></iframe><b onclick=\"steal()\">bold?</b>",
        ].join("\n")}
        onCopy={vi.fn()}
      />,
    );
    expect(container.querySelector("td br")).not.toBeNull();
    expect(container.querySelector("sub")?.textContent).toBe("2");
    expect(container.querySelector("sup")?.textContent).toBe("2");
    expect([...container.querySelectorAll("kbd")].map((node) => node.textContent)).toEqual(["Ctrl", "K"]);
    expect(container.querySelector("del")?.textContent).toBe("old");
    expect(screen.getByText(/& done/)).toBeTruthy();
    const details = container.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe("Full log");
    expect(details?.querySelector("li")?.textContent).toBe("line one");
    expect(container.querySelector("script, iframe, b, [onclick]")).toBeNull();
  });

  it("shows inline raster images and workspace images, and links web images instead of loading them", async () => {
    const pixel = "data:image/png;base64,iVBORw0KGgo=";
    const image = vi.fn(async (_root: string, path: string) => (path === "charts/q3.png" ? pixel : null));
    const openExternal = vi.fn();
    Object.assign(window, { moss: { shell: { openExternal }, workspace: { image } } });
    const { container } = render(
      <RichResponse
        content={`![inline](${pixel})\n\n![chart](charts/q3.png)\n\n![missing](charts/none.png)\n\n![svg](data:image/svg+xml;base64,PHN2Zz4=)\n\n![tracker](https://images.example/p.png?d=secret)\n\n<img src="charts/q3.png" alt="raw chart" onerror="steal()">`}
        onCopy={vi.fn()}
        workspaceRoot={"C:\\work"}
      />,
    );
    expect(screen.getByRole("img", { name: "inline" }).getAttribute("src")).toBe(pixel);
    expect((await screen.findByRole("img", { name: "chart" })).getAttribute("src")).toBe(pixel);
    expect((await screen.findByRole("img", { name: "raw chart" })).getAttribute("onerror")).toBeNull();
    expect(image).toHaveBeenCalledWith("C:\\work", "charts/q3.png");
    expect(await screen.findByText("Image not found: charts/none.png")).toBeTruthy();
    // SVG could carry script, so only raster data images show.
    expect(container.querySelector('img[src^="data:image/svg"]')).toBeNull();
    // A web image is never fetched: its URL could carry data out.
    expect(container.querySelector('img[src^="https:"]')).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /Image: tracker \(images\.example\)/ }));
    expect(openExternal).toHaveBeenCalledWith("https://images.example/p.png?d=secret");
  });

  it("opens a page the reply links to in the workspace, and shows other workspace paths as text", () => {
    const openInBrowser = vi.fn(async () => true);
    Object.assign(window, { moss: { shell: { openExternal: vi.fn() }, workspace: { openInBrowser } } });
    render(<RichResponse content="[the guide](docs/guide.html) and [the notes](docs/notes.md)" onCopy={vi.fn()} workspaceRoot={"C:\\work"} />);
    fireEvent.click(screen.getByRole("link", { name: "the guide" }));
    expect(openInBrowser).toHaveBeenCalledWith("C:\\work", "docs/guide.html");
    expect(screen.queryByRole("link", { name: "the notes" })).toBeNull();
    expect(screen.getByText("the notes").getAttribute("title")).toBe("docs/notes.md in the workspace");
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
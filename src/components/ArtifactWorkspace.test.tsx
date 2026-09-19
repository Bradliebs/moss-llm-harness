// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskArtifactReference } from "@common/types";
import { ArtifactWorkspace } from "./ArtifactWorkspace";

afterEach(cleanup);

const artifact: TaskArtifactReference = {
  id: "first", taskId: "task-1", planRevision: 1, stepId: "report", attemptId: "attempt-1",
  name: "report.md", summary: "Findings", sha256: "a".repeat(64), byteLength: 12, createdAt: "2026-09-19T00:00:00Z",
};

function props() {
  return { artifacts: [artifact], selectedId: artifact.id, onSelect: vi.fn(), onClose: vi.fn(), onCopy: vi.fn().mockResolvedValue(undefined), loadArtifact: vi.fn().mockResolvedValue({ ...artifact, content: "# Findings\nReport body" }) };
}

describe("ArtifactWorkspace", () => {
  it("provides table controls without enabling links or images in artifacts", async () => {
    const input = props();
    input.loadArtifact.mockResolvedValue({ ...artifact, content: '| File | Count |\n| --- | --- |\n| [Beta](https://example.com) | 10 |\n| Alpha | 2 |' });
    const { container } = render(<ArtifactWorkspace {...input} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sort by Count" }));
    expect(screen.getAllByRole("row")[1].textContent).toContain("Alpha");
    expect(container.querySelector("a, img")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Beta" } });
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("previews Markdown, switches to source, copies and closes", async () => {
    const input = props();
    render(<ArtifactWorkspace {...input} />);
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText(/# Findings/).tagName).toBe("PRE");
    fireEvent.click(screen.getByRole("button", { name: "Copy artifact" }));
    await screen.findByText("Copied");
    expect(input.onCopy).toHaveBeenCalledWith("# Findings\nReport body");
    fireEvent.click(screen.getByRole("button", { name: "Close artifact workspace" }));
    expect(input.onClose).toHaveBeenCalledOnce();
  });

  it("never embeds HTML, external images, or navigable links", async () => {
    const input = props();
    input.loadArtifact.mockResolvedValue({ ...artifact, content: '<script>alert(1)</script>\n\n![remote](https://example.com/a.png)\n\n[link](https://example.com)' });
    const { container } = render(<ArtifactWorkspace {...input} />);
    await screen.findByText("link");
    expect(container.querySelector("script, iframe, img, a")).toBeNull();
  });

  it("ignores a late response after switching artifacts", async () => {
    const input = props();
    let resolveFirst!: (record: TaskArtifactReference & { content: string }) => void;
    input.loadArtifact.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    const second = { ...artifact, id: "second", name: "other.txt" };
    input.loadArtifact.mockResolvedValueOnce({ ...second, content: "Newest" });
    const { rerender } = render(<ArtifactWorkspace {...input} artifacts={[artifact, second]} />);
    rerender(<ArtifactWorkspace {...input} artifacts={[artifact, second]} selectedId="second" />);
    await screen.findByText("Newest");
    resolveFirst({ ...artifact, content: "Stale" });
    await waitFor(() => expect(screen.queryByText("Stale")).toBeNull());
  });

  it("shows missing content and can retry", async () => {
    const input = props();
    input.loadArtifact.mockResolvedValueOnce(null);
    render(<ArtifactWorkspace {...input} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading artifact" }));
    await screen.findByRole("heading", { name: "Findings" });
    expect(input.loadArtifact).toHaveBeenCalledTimes(2);
  });

  it("keeps HTML artifacts as source text even in preview mode", async () => {
    const input = props();
    const html = { ...artifact, name: "page.html" };
    input.loadArtifact.mockResolvedValue({ ...html, content: '<h1>Example</h1><script>alert(1)</script>' });
    const { container } = render(<ArtifactWorkspace {...input} artifacts={[html]} />);
    expect((await screen.findByText(/<h1>Example/)).tagName).toBe("PRE");
    expect(container.querySelector("script, iframe")).toBeNull();
  });

  it("reports load and clipboard errors without claiming success", async () => {
    const input = props();
    input.loadArtifact.mockRejectedValueOnce(new Error("Read failed"));
    input.onCopy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    render(<ArtifactWorkspace {...input} />);
    await screen.findByText("Read failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading artifact" }));
    await screen.findByRole("heading", { name: "Findings" });
    fireEvent.click(screen.getByRole("button", { name: "Copy artifact" }));
    await screen.findByText("Copy failed");
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("displays empty content and forwards artifact selection", async () => {
    const input = props();
    input.loadArtifact.mockResolvedValue({ ...artifact, content: "" });
    render(<ArtifactWorkspace {...input} artifacts={[artifact, { ...artifact, id: "second", name: "other.txt" }]} />);
    await screen.findByText("Empty artifact.");
    fireEvent.change(screen.getByRole("combobox", { name: "Select artifact" }), { target: { value: "second" } });
    expect(input.onSelect).toHaveBeenCalledWith("second");
  });
});
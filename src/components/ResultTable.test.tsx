// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultTable, tableCsv } from "./ResultTable";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Fixture({ suffix = "" }: { suffix?: string }) {
  return <ResultTable><thead><tr><th>File</th><th>Score</th></tr></thead><tbody>
    <tr><td><strong>Beta{suffix}</strong></td><td>10</td></tr>
    <tr><td>Alpha</td><td>2.5</td></tr>
    <tr><td>Gamma</td><td>-1</td></tr>
  </tbody></ResultTable>;
}

const names = () => screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[1].textContent);

describe("ResultTable", () => {
  it("sorts numbers both ways and restores source order", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Score" }));
    expect(names()).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(screen.getByRole("button", { name: "Sort by Score" }).closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Score" }));
    expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Score" }));
    expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(screen.getByText("Beta").tagName).toBe("STRONG");
  });

  it("filters, preserves selection by source row, and resets", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByLabelText("Select row 1"));
    fireEvent.click(screen.getByRole("button", { name: "Sort by File" }));
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect((screen.getByLabelText("Select row 1") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ALPHA" } });
    expect(names()).toEqual(["Alpha"]);
    expect((screen.getByRole("button", { name: "Export table as CSV" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Select all visible rows"));
    expect(screen.getByRole("status").textContent).toContain("2 selected");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "absent" } });
    expect(screen.getByText("No matching rows.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset table" }));
    expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(screen.getByRole("status").textContent).toBe("3/3 rows");
  });

  it("resets controls when table data changes", () => {
    const { rerender } = render(<Fixture />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Beta" } });
    fireEvent.click(screen.getByLabelText("Select row 1"));
    rerender(<Fixture suffix=" revised" />);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toBe("3/3 rows");
  });

  it("limits controls to bounded rectangular tables without dropping fallback content", () => {
    const { rerender } = render(<ResultTable><thead><tr><th>Name</th></tr></thead><tbody><tr><td>One</td><td>Two</td></tr></tbody></ResultTable>);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByText("Two")).toBeTruthy();
    rerender(<ResultTable><thead><tr><th>Name</th></tr></thead><tbody>{Array.from({ length: 1001 }, (_, index) => <tr key={index}><td>Row {index}</td></tr>)}</tbody></ResultTable>);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByText("Row 1000")).toBeTruthy();
  });

  it("selects only visible rows and shows a mixed selection state", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByLabelText("Select row 1"));
    expect((screen.getByLabelText("Select all visible rows") as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByLabelText("Select all visible rows"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect((screen.getByLabelText("Select row 2") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Select row 3") as HTMLInputElement).checked).toBe(false);
  });

  it("escapes CSV cells and neutralizes spreadsheet formulas including headers", () => {
    expect(tableCsv(["=header", "Name"], [[' +SUM(1,2)', 'a"b\nc'], ["@formula", "plain"]])).toBe('"\'=header","Name"\r\n"\' +SUM(1,2)","a""b\nc"\r\n"\'@formula","plain"');
  });

  it("exports selected visible rows and reports download failures", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      if (typeof callback === "function") callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const createObjectURL = vi.fn(() => "blob:fixture");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<Fixture />);
    fireEvent.click(screen.getByLabelText("Select row 2"));
    fireEvent.click(screen.getByRole("button", { name: "Export table as CSV" }));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const csv = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
    expect(csv).toContain('"Alpha","2.5"');
    expect(csv).not.toContain("Beta");
    expect(click).toHaveBeenCalledOnce();
    createObjectURL.mockImplementation(() => { throw new Error("blocked"); });
    fireEvent.click(screen.getByRole("button", { name: "Export table as CSV" }));
    expect(screen.getByRole("alert").textContent).toBe("Could not export this table.");
    timer.mockRestore();
  });
});
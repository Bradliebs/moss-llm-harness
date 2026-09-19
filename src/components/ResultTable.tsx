import { ArrowDown, ArrowUp, ArrowUpDown, Download, RotateCcw, Search } from "lucide-react";
import { Children, isValidElement, useState, type ReactNode } from "react";

interface Cell {
  content: ReactNode;
  text: string;
}

function elements(children: ReactNode) {
  return Children.toArray(children).filter(isValidElement<{ children?: ReactNode; alt?: string }>);
}

function plainText(children: ReactNode): string {
  return Children.toArray(children).map((child): string => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!isValidElement<{ children?: ReactNode; alt?: string }>(child)) return "";
    if (child.type === "br") return "\n";
    return child.props.alt ?? plainText(child.props.children);
  }).join("");
}

function cells(children: ReactNode): Cell[] {
  return elements(children).map((cell) => ({ content: cell.props.children, text: plainText(cell.props.children) }));
}

export function tableCsv(headers: string[], rows: string[][]): string {
  const escape = (value: string): string => {
    const safe = /^[\s\uFEFF]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
function compare(left: string, right: string): number {
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  if (decimal.test(left.trim()) && decimal.test(right.trim()) && Number.isFinite(Number(left)) && Number.isFinite(Number(right))) {
    return Number(left) - Number(right);
  }
  return collator.compare(left, right);
}

function InteractiveTable({ headers, rows }: { headers: Cell[]; rows: Cell[][] }): React.ReactElement {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ column: number; direction: "ascending" | "descending" } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const query = filter.trim().toLocaleLowerCase();
  const visible = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.some((cell) => cell.text.toLocaleLowerCase().includes(query)));
  if (sort) visible.sort((left, right) => compare(left.row[sort.column].text, right.row[sort.column].text) * (sort.direction === "ascending" ? 1 : -1) || left.index - right.index);
  const exported = visible.filter(({ index }) => selected.size === 0 || selected.has(index));
  const allSelected = visible.length > 0 && visible.every(({ index }) => selected.has(index));

  function download(): void {
    setError("");
    let url: string | undefined;
    const anchor = document.createElement("a");
    try {
      const csv = tableCsv(headers.map((cell) => cell.text), exported.map(({ row }) => row.map((cell) => cell.text)));
      url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
      anchor.href = url;
      anchor.download = "moss-results.csv";
      document.body.append(anchor);
      anchor.click();
    } catch {
      setError("Could not export this table.");
    } finally {
      anchor.remove();
      if (url) { const objectUrl = url; setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); }
    }
  }

  return (
    <section aria-label="Result table" className="result-table">
      <div className="result-table-toolbar">
        <label className="result-table-filter"><Search size={15} aria-hidden="true" /><input aria-label="Filter table rows" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        <span role="status" className="result-table-count">{visible.length}/{rows.length} rows{selected.size ? ` · ${selected.size} selected` : ""}</span>
        <button type="button" className="response-icon-button" title={`Export ${exported.length} ${selected.size ? "selected visible" : "visible"} rows as CSV`} aria-label="Export table as CSV" disabled={exported.length === 0} onClick={download}><Download size={16} aria-hidden="true" /></button>
        <button type="button" className="response-icon-button" title="Reset table" aria-label="Reset table" disabled={!filter && !sort && selected.size === 0} onClick={() => { setFilter(""); setSort(null); setSelected(new Set()); setError(""); }}><RotateCcw size={16} aria-hidden="true" /></button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="result-table-scroll" role="region" aria-label="Table data" tabIndex={0}>
        <table>
          <thead><tr>
            <th scope="col" className="result-table-selection"><input type="checkbox" aria-label="Select all visible rows" disabled={!visible.length} checked={allSelected} ref={(node) => { if (node) node.indeterminate = !allSelected && visible.some(({ index }) => selected.has(index)); }} onChange={() => setSelected((previous) => {
              const next = new Set(previous);
              for (const { index } of visible) { if (allSelected) next.delete(index); else next.add(index); }
              return next;
            })} /></th>
            {headers.map((header, column) => <th key={column} scope="col" aria-sort={sort?.column === column ? sort.direction : "none"}>
              <button type="button" className="result-table-sort" aria-label={`Sort by ${header.text || `column ${column + 1}`}`} onClick={() => setSort((previous) => previous?.column === column ? previous.direction === "ascending" ? { column, direction: "descending" } : null : { column, direction: "ascending" })}>
                <span>{header.text}</span>{sort?.column !== column ? <ArrowUpDown size={14} /> : sort.direction === "ascending" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
              </button>
            </th>)}
          </tr></thead>
          <tbody>{visible.map(({ row, index }) => <tr key={index} data-selected={selected.has(index) || undefined}>
            <td className="result-table-selection"><input type="checkbox" aria-label={`Select row ${index + 1}`} checked={selected.has(index)} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /></td>
            {row.map((cell, column) => <td key={column}>{cell.content}</td>)}
          </tr>)}</tbody>
        </table>
        {!visible.length ? <p className="result-table-empty">No matching rows.</p> : null}
      </div>
    </section>
  );
}

export function ResultTable({ children }: { children?: ReactNode }): React.ReactElement {
  const sections = elements(children);
  const headers = cells(elements(sections.find((section) => section.type === "thead")?.props.children)[0]?.props.children);
  const rows = elements(sections.find((section) => section.type === "tbody")?.props.children).map((row) => cells(row.props.children));
  if (!headers.length || !rows.length || rows.length > 1000 || headers.length > 30 || rows.some((row) => row.length !== headers.length)) return <table>{children}</table>;
  const identity = JSON.stringify([headers.map((cell) => cell.text), ...rows.map((row) => row.map((cell) => cell.text))]);
  return <InteractiveTable key={identity} headers={headers} rows={rows} />;
}
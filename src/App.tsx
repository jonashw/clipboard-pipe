import { useState, useEffect, useRef } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import type { Root, Table, TableRow, PhrasingContent } from "mdast";
import { visit } from "unist-util-visit";
import Papa from "papaparse";

// ── Types ─────────────────────────────────────────────────────────────────────

type TableData = { headers: string[]; rows: string[][] };
type Format = "markdown" | "csv" | "tsv" | "html" | "json" | "monospace";

// ── Detection ─────────────────────────────────────────────────────────────────

function detectFormat(input: string): Format | null {
  const t = input.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      /* not JSON */
    }
  }
  if (/<table[\s>]/i.test(t)) return "html";
  if (t.startsWith("┌")) return "monospace";
  if (/^\|.+\|/m.test(t)) return "markdown";
  if (/\t/.test(t)) return "tsv";
  const lines = t.split("\n").filter((l) => l.trim());
  if (lines.length >= 2) {
    const counts = lines.map((l) => (l.match(/,/g) ?? []).length);
    if (counts[0] > 0 && counts.every((c) => c === counts[0])) return "csv";
  }
  return null;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function extractText(nodes: PhrasingContent[]): string {
  return nodes
    .map((n) =>
      "value" in n
        ? n.value
        : "children" in n
          ? extractText(n.children as PhrasingContent[])
          : "",
    )
    .join("");
}

function extractMarkdownTables(ast: Root): TableData[] {
  const tables: TableData[] = [];
  visit(ast, "table", (node: Table) => {
    const [headerRow, ...dataRows] = node.children as TableRow[];
    tables.push({
      headers: headerRow.children.map((cell) =>
        extractText(cell.children as PhrasingContent[]),
      ),
      rows: dataRows.map((row) =>
        row.children.map((cell) =>
          extractText(cell.children as PhrasingContent[]),
        ),
      ),
    });
  });
  return tables;
}

async function parseMarkdown(input: string): Promise<TableData[]> {
  let ast: Root | null = null;
  await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: Root) => {
      ast = tree;
    })
    .use(remarkHtml, { sanitize: false })
    .process(input);
  return ast ? extractMarkdownTables(ast) : [];
}

function fromRows(allRows: string[][]): TableData {
  const [headers = [], ...rows] = allRows;
  return { headers, rows };
}

function parseCsv(input: string): TableData[] {
  const result = Papa.parse<string[]>(input, { skipEmptyLines: true });
  return result.data.length > 1 ? [fromRows(result.data)] : [];
}

function parseTsv(input: string): TableData[] {
  const allRows = input
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  return allRows.length > 1 ? [fromRows(allRows)] : [];
}

function parseJson(input: string): TableData[] {
  const parsed = JSON.parse(input);
  const arr: Record<string, unknown>[] = Array.isArray(parsed)
    ? parsed
    : [parsed];
  if (!arr.length) return [];
  const headers = Object.keys(arr[0]);
  return [
    {
      headers,
      rows: arr.map((obj) => headers.map((k) => String(obj[k] ?? ""))),
    },
  ];
}

function parseHtml(input: string): TableData[] {
  const doc = new DOMParser().parseFromString(input, "text/html");
  return Array.from(doc.querySelectorAll("table")).map((table) => {
    const allRows = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll("th, td")).map(
        (cell) => cell.textContent ?? "",
      ),
    );
    return fromRows(allRows);
  });
}

function parseMonospace(input: string): TableData[] {
  const parseRow = (line: string) =>
    line
      .split("│")
      .slice(1, -1)
      .map((cell) => cell.trim());
  const dataLines = input
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("│"));
  if (dataLines.length < 1) return [];
  const [headerLine, ...rowLines] = dataLines;
  return [{ headers: parseRow(headerLine), rows: rowLines.map(parseRow) }];
}

// ── Serializers ───────────────────────────────────────────────────────────────

function csvCell(cell: string): string {
  const escaped = cell.replace(/"/g, '""');
  return /[,"\n\r]/.test(cell) ? `"${escaped}"` : escaped;
}

function toCsv({ headers, rows }: TableData): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function toTsv({ headers, rows }: TableData): string {
  return [headers, ...rows]
    .map((row) =>
      row.map((c) => c.replace(/\t/g, " ").replace(/\n/g, " ")).join("\t"),
    )
    .join("\n");
}

function toHtmlTable({ headers, rows }: TableData): string {
  const thead = `<thead><tr>${headers.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function toJson({ headers, rows }: TableData): string {
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(headers.map((key, i) => [key, row[i] ?? ""])),
    ),
    null,
    2,
  );
}

function toMarkdown({ headers, rows }: TableData): string {
  const cols = headers.length;
  const colWidths = Array.from({ length: cols }, (_, i) =>
    Math.max(headers[i].length, ...rows.map((r) => (r[i] ?? "").length), 3),
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const renderRow = (cells: string[]) =>
    "| " + cells.map((c, i) => pad(c, colWidths[i])).join(" | ") + " |";
  const separator =
    "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}

function toMonospace({ headers, rows }: TableData): string {
  const cols = headers.length;
  const colWidths = Array.from({ length: cols }, (_, i) =>
    Math.max(headers[i].length, ...rows.map((r) => (r[i] ?? "").length), 1),
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const top = "┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const divider = "├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bottom = "└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";
  const renderRow = (cells: string[]) =>
    "│ " + cells.map((c, i) => pad(c, colWidths[i])).join(" │ ") + " │";
  return [
    top,
    renderRow(headers),
    divider,
    ...rows.map(renderRow),
    bottom,
  ].join("\n");
}

// ── Shared display components ─────────────────────────────────────────────────

// Safe React-rendered table — no dangerouslySetInnerHTML, cells are escaped by React.
function TablePreview({ table }: { table: TableData }) {
  return (
    <table>
      <thead>
        <tr>
          {table.headers.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TextPreview({ content }: { content: string }) {
  return (
    <pre
      style={{
        margin: 0,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {content}
    </pre>
  );
}

// ToggleButton — use for any button that represents an active/inactive state.
// Applies a consistent active indicator (bold + bottom border) across the app.
function ToggleButton({
  active,
  onClick,
  children,
  title,
  style,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontWeight: active ? "bold" : "normal",
        borderBottom: active ? "3px solid" : "3px solid transparent",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function transposeTable({ headers, rows }: TableData): TableData {
  const allRows = [headers, ...rows];
  const transposed = Array.from({ length: headers.length }, (_, j) =>
    allRows.map((row) => row[j] ?? ""),
  );
  return fromRows(transposed);
}

// ── Output format registry ────────────────────────────────────────────────────

interface OutputFormat {
  id: string;
  label: string;
  /** Input formats for which this output is disabled (same-format guard). */
  disabledFor: Format[];
  serialize: (table: TableData) => string;
  copy: (table: TableData) => Promise<void>;
  render: (table: TableData) => React.ReactNode;
}

const OUTPUT_FORMATS: OutputFormat[] = [
  {
    id: "table",
    label: "Table",
    disabledFor: ["html"],
    serialize: toHtmlTable,
    copy: (t) => {
      const blob = new Blob([toHtmlTable(t)], { type: "text/html" });
      return navigator.clipboard.write([
        new ClipboardItem({ "text/html": blob }),
      ]);
    },
    render: (t) => <TablePreview table={t} />,
  },
  {
    id: "markdown",
    label: "Markdown",
    disabledFor: ["markdown"],
    serialize: toMarkdown,
    copy: (t) => navigator.clipboard.writeText(toMarkdown(t)),
    render: (t) => <TextPreview content={toMarkdown(t)} />,
  },
  {
    id: "csv",
    label: "CSV",
    disabledFor: ["csv"],
    serialize: toCsv,
    copy: (t) => navigator.clipboard.writeText(toCsv(t)),
    render: (t) => <TextPreview content={toCsv(t)} />,
  },
  {
    id: "tsv",
    label: "TSV",
    disabledFor: ["tsv"],
    serialize: toTsv,
    copy: (t) => navigator.clipboard.writeText(toTsv(t)),
    render: (t) => <TextPreview content={toTsv(t)} />,
  },
  {
    id: "json",
    label: "JSON",
    disabledFor: ["json"],
    serialize: toJson,
    copy: (t) => navigator.clipboard.writeText(toJson(t)),
    render: (t) => <TextPreview content={toJson(t)} />,
  },
  {
    id: "html",
    label: "HTML",
    disabledFor: ["html"],
    serialize: toHtmlTable,
    copy: (t) => navigator.clipboard.writeText(toHtmlTable(t)),
    render: (t) => <TextPreview content={toHtmlTable(t)} />,
  },
  {
    id: "monospace",
    label: "Monospace",
    disabledFor: ["monospace"],
    serialize: toMonospace,
    copy: (t) => navigator.clipboard.writeText(toMonospace(t)),
    render: (t) => <TextPreview content={toMonospace(t)} />,
  },
];

function defaultFormatId(detectedFormat: Format | null): string {
  const isDisabled = (f: OutputFormat) =>
    detectedFormat != null && f.disabledFor.includes(detectedFormat);
  const tableFormat = OUTPUT_FORMATS.find((f) => f.id === "table")!;
  if (!isDisabled(tableFormat)) return "table";
  return OUTPUT_FORMATS.find((f) => !isDisabled(f))?.id ?? "table";
}

// ── Format labels / badge ─────────────────────────────────────────────────────

const FORMAT_LABELS: Record<Format, string> = {
  markdown: "Markdown",
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  html: "HTML",
  monospace: "Monospace",
};

function FormatBadge({
  detectedFormat,
  hasContent,
}: {
  detectedFormat: Format | null;
  hasContent: boolean;
}) {
  if (!hasContent) return null;
  return (
    <div
      style={{
        marginBottom: "0.5rem",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <button
        disabled
        style={{
          cursor: "default",
          opacity: detectedFormat ? 1 : 0.4,
          fontSize: "0.8em",
          padding: "0.15em 0.5em",
        }}
      >
        {detectedFormat ? FORMAT_LABELS[detectedFormat] : "?"}
      </button>
      {!detectedFormat && (
        <span style={{ fontSize: "0.85em", opacity: 0.7 }}>
          ⚠ Format not recognized
        </span>
      )}
    </div>
  );
}

// ── Input column ──────────────────────────────────────────────────────────────

function InputDisplay({
  input,
  detectedFormat,
  tables,
  textareaRef,
  onChange,
}: {
  input: string;
  detectedFormat: Format | null;
  tables: TableData[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (v: string) => void;
}) {
  const [showSource, setShowSource] = useState(false);

  const isRenderable = detectedFormat === "html" && tables.length > 0;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {isRenderable && (
        <div style={{ marginBottom: "0.25rem" }}>
          <button
            onClick={() => setShowSource((v) => !v)}
            style={{ fontSize: "0.8em", padding: "0.15em 0.5em" }}
          >
            {showSource ? "Preview" : "Source"}
          </button>
        </div>
      )}
      {isRenderable && !showSource ? (
        <div style={{ flex: 1, overflow: "auto" }}>
          {tables.map((t, i) => (
            <TablePreview key={i} table={t} />
          ))}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste a table in Markdown, CSV, TSV, HTML, or JSON…"
          style={{
            flex: 1,
            width: "100%",
            resize: "none",
            fontFamily: "monospace",
            fontSize: "14px",
            boxSizing: "border-box",
          }}
        />
      )}
    </div>
  );
}

// ── Output panel ──────────────────────────────────────────────────────────────

function OutputPanel({
  table,
  detectedFormat,
}: {
  table: TableData;
  detectedFormat: Format | null;
}) {
  const [selectedId, setSelectedId] = useState(() =>
    defaultFormatId(detectedFormat),
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  // Only reset selection when the currently selected format becomes disabled
  useEffect(() => {
    const current = OUTPUT_FORMATS.find((f) => f.id === selectedId);
    if (
      current &&
      detectedFormat != null &&
      current.disabledFor.includes(detectedFormat)
    ) {
      setSelectedId(defaultFormatId(detectedFormat));
    }
  }, [detectedFormat, selectedId]);

  const selectedFormat =
    OUTPUT_FORMATS.find((f) => f.id === selectedId) ?? OUTPUT_FORMATS[0];

  const handleCopy = async () => {
    setCopied(false);
    setError(false);
    try {
      await selectedFormat.copy(table);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  };

  const isDisabled = (f: OutputFormat) =>
    detectedFormat != null && f.disabledFor.includes(detectedFormat);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: "0.25rem",
          flexWrap: "wrap",
          marginBottom: "0.5rem",
          alignItems: "center",
        }}
      >
        {OUTPUT_FORMATS.map((fmt) => (
          <button
            key={fmt.id}
            disabled={isDisabled(fmt)}
            onClick={() => setSelectedId(fmt.id)}
            style={{ fontWeight: fmt.id === selectedId ? "bold" : "normal" }}
          >
            {fmt.label}
          </button>
        ))}
        <button onClick={handleCopy} style={{ marginLeft: "auto" }}>
          {copied ? "✓ Copied" : error ? "✗ Failed" : "Copy"}
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {selectedFormat.render(table)}
      </div>
    </div>
  );
}

// ── Tables pane (nav + detail) ────────────────────────────────────────────────

function applyHeaderOverrides(
  table: TableData,
  overrides: Record<number, string>,
): TableData {
  if (!Object.keys(overrides).length) return table;
  return {
    ...table,
    headers: table.headers.map((h, i) =>
      h === "" && overrides[i] != null ? overrides[i] : h,
    ),
  };
}

function TablesPane({
  tables,
  detectedFormat,
}: {
  tables: TableData[];
  detectedFormat: Format | null;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [transposedFlags, setTransposedFlags] = useState<boolean[]>([]);
  // Two override maps per table: one per transposition state
  type OverridePair = {
    normal: Record<number, string>;
    transposed: Record<number, string>;
  };
  const [headerOverridesList, setHeaderOverridesList] = useState<
    OverridePair[]
  >([]);

  // Reset when tables change (new input)
  useEffect(() => {
    setSelectedIndex(0);
    setTransposedFlags(tables.map(() => false));
    setHeaderOverridesList(tables.map(() => ({ normal: {}, transposed: {} })));
  }, [tables]);

  if (!tables.length) return null;

  const safeIndex = Math.min(selectedIndex, tables.length - 1);
  const table = tables[safeIndex];
  const isTransposed = transposedFlags[safeIndex] ?? false;
  const overridePair = headerOverridesList[safeIndex] ?? {
    normal: {},
    transposed: {},
  };
  const headerOverrides = isTransposed
    ? overridePair.transposed
    : overridePair.normal;

  // Overrides apply to the post-transform view so positions always match what the user sees
  const transformedTable = isTransposed ? transposeTable(table) : table;
  const activeTable = applyHeaderOverrides(transformedTable, headerOverrides);

  const toggleTranspose = () =>
    setTransposedFlags((flags) =>
      flags.map((f, i) => (i === safeIndex ? !f : f)),
    );

  const setHeaderOverride = (colIndex: number, value: string) =>
    setHeaderOverridesList((list) =>
      list.map((pair, i) => {
        if (i !== safeIndex) return pair;
        const key = isTransposed ? "transposed" : "normal";
        return { ...pair, [key]: { ...pair[key], [colIndex]: value } };
      }),
    );

  // Empty headers in the current view (after transform, before overrides)
  const emptyHeaderIndices = transformedTable.headers
    .map((h, i) => (h.trim() === "" ? i : -1))
    .filter((i) => i !== -1);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Table nav */}
      <div
        style={{
          display: "flex",
          gap: "0.25rem",
          flexWrap: "wrap",
          marginBottom: "0.75rem",
        }}
      >
        {tables.map((t, i) => {
          const activeT = transposedFlags[i] ? transposeTable(t) : t;
          const cols = activeT.headers.length;
          const rows = activeT.rows.length;
          return (
            <ToggleButton
              key={i}
              active={i === safeIndex}
              onClick={() => setSelectedIndex(i)}
            >
              Table {i + 1}
              <span
                title={`Table ${i + 1} has ${cols} columns and ${rows} rows`}
                style={{ fontWeight: "normal", marginLeft: "0.4rem", opacity: 0.6, fontSize: "0.85em" }}
              >
                {cols} × {rows}
              </span>
            </ToggleButton>
          );
        })}
      </div>

      {/* Detail area */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.5rem",
          }}
        >
          <span style={{ fontWeight: "bold" }}>Table {safeIndex + 1}</span>
          <ToggleButton
            active={isTransposed}
            onClick={toggleTranspose}
            title="Transpose rows and columns"
          >
            ⇄ Transpose
          </ToggleButton>
        </div>

        {/* Empty header overrides — positions reflect current (post-transform) view */}
        {emptyHeaderIndices.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: "1rem",
              flexWrap: "wrap",
              marginBottom: "0.75rem",
              alignItems: "center",
            }}
          >
            {emptyHeaderIndices.map((colIndex) => (
              <label
                key={colIndex}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  fontSize: "0.85em",
                }}
              >
                <span style={{ opacity: 0.6 }}>
                  {colIndex === 0
                    ? "First column label:"
                    : `Column ${colIndex + 1} label:`}
                </span>
                <input
                  type="text"
                  value={headerOverrides[colIndex] ?? ""}
                  onChange={(e) => setHeaderOverride(colIndex, e.target.value)}
                  placeholder="unnamed"
                  style={{
                    width: "10em",
                    padding: "0.15em 0.4em",
                    fontSize: "inherit",
                  }}
                />
              </label>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: "1rem" }}>
          <div style={{ flex: "0 0 50%", minWidth: 0 }}>
            <DataProfile table={activeTable} />
          </div>
          <div style={{ flex: "0 0 50%", minWidth: 0 }}>
            <OutputPanel table={activeTable} detectedFormat={detectedFormat} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Data profiling ────────────────────────────────────────────────────────────

interface ColumnProfile {
  name: string;
  type: "numeric" | "text";
  count: number;
  empty: number;
  unique: number;
  min: string;
  max: string;
  mean: string;
}

function profileColumn(
  colIndex: number,
  { headers, rows }: TableData,
): ColumnProfile {
  const values = rows.map((r) => r[colIndex] ?? "");
  const nonEmpty = values.filter((v) => v.trim() !== "");
  const nums = nonEmpty.map(Number).filter((n) => !isNaN(n));
  const isNumeric = nums.length === nonEmpty.length && nonEmpty.length > 0;

  return {
    name: headers[colIndex],
    type: isNumeric ? "numeric" : "text",
    count: nonEmpty.length,
    empty: values.length - nonEmpty.length,
    unique: new Set(nonEmpty).size,
    min: isNumeric ? String(Math.min(...nums)) : "—",
    max: isNumeric ? String(Math.max(...nums)) : "—",
    mean: isNumeric
      ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)
      : "—",
  };
}

function DataProfile({ table }: { table: TableData }) {
  const profiles = table.headers.map((_, i) => profileColumn(i, table));

  return (
    <div
      style={{
        fontSize: "0.78em",
        background: "rgba(128,128,128,0.08)",
        border: "1px dashed rgba(128,128,128,0.35)",
        borderRadius: "4px",
        padding: "0.5rem 0.75rem",
      }}
    >
      <div
        style={{
          fontWeight: "bold",
          marginBottom: "0.4rem",
          opacity: 0.55,
          letterSpacing: "0.05em",
          fontSize: "0.9em",
          textTransform: "uppercase",
        }}
      >
        Profile
      </div>
      <table
        style={{
          width: "100%",
          fontSize: "inherit",
          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr>
            {[
              "Column",
              "Type",
              "Non-empty",
              "Empty",
              "Unique",
              "Min",
              "Max",
              "Mean",
            ].map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  paddingRight: "0.75rem",
                  opacity: 0.6,
                  fontWeight: 600,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {profiles.map((p, i) => (
            <tr key={i}>
              <td style={{ paddingRight: "0.75rem" }}>
                <code>{p.name}</code>
              </td>
              <td style={{ paddingRight: "0.75rem", opacity: 0.6 }}>
                {p.type}
              </td>
              <td style={{ paddingRight: "0.75rem" }}>{p.count}</td>
              <td style={{ paddingRight: "0.75rem" }}>{p.empty}</td>
              <td style={{ paddingRight: "0.75rem" }}>{p.unique}</td>
              <td style={{ paddingRight: "0.75rem" }}>{p.min}</td>
              <td style={{ paddingRight: "0.75rem" }}>{p.max}</td>
              <td>{p.mean}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [input, setInput] = useState("");
  const [tables, setTables] = useState<TableData[]>([]);
  const [detectedFormat, setDetectedFormat] = useState<Format | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  // Parse input (with Markdown race cancellation)
  useEffect(() => {
    const trimmed = input.trim();
    if (!trimmed) {
      setTables([]);
      setDetectedFormat(null);
      return;
    }

    const format = detectFormat(trimmed);
    setDetectedFormat(format);

    if (format === null) {
      setTables([]);
      return;
    }

    if (format === "markdown") {
      let cancelled = false;
      parseMarkdown(trimmed)
        .then((result) => {
          if (!cancelled) setTables(result);
        })
        .catch(console.error);
      return () => {
        cancelled = true;
      };
    } else if (format === "json") {
      try {
        setTables(parseJson(trimmed));
      } catch {
        setTables([]);
      }
    } else if (format === "html") {
      setTables(parseHtml(trimmed));
    } else if (format === "monospace") {
      setTables(parseMonospace(trimmed));
    } else if (format === "tsv") {
      setTables(parseTsv(trimmed));
    } else {
      setTables(parseCsv(trimmed));
    }
  }, [input]);

  // Global paste handler
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const html = e.clipboardData?.getData("text/html");
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const ta = textareaRef.current;
      const taFocused = ta && document.activeElement === ta;

      if (html) {
        e.preventDefault();
        setInput(html);
      } else if (taFocused) {
        e.preventDefault();
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? 0;
        const next =
          inputRef.current.slice(0, start) + text + inputRef.current.slice(end);
        setInput(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + text.length;
        });
      } else {
        e.preventDefault();
        setInput(text);
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, []);

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, gap: "1rem" }}>
      {/* Left: Input (33%) */}
      <div
        style={{
          flex: "0 0 33%",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <FormatBadge
          detectedFormat={detectedFormat}
          hasContent={!!input.trim()}
        />
        <InputDisplay
          input={input}
          detectedFormat={detectedFormat}
          tables={tables}
          textareaRef={textareaRef}
          onChange={setInput}
        />
      </div>

      {/* Right: Tables (67%) */}
      <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <TablesPane tables={tables} detectedFormat={detectedFormat} />
      </div>
    </div>
  );
}

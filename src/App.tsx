import { useState, useEffect, useRef } from "react";
import {
  type TableData,
  type Cell,
  type Format,
  cell,
  detectFormat,
  parseMarkdown,
  parseCsv,
  parseTsv,
  parseJson,
  parseHtmlDoc,
  parseMonospace,
  fromRows,
  toCsv,
  toTsv,
  toHtmlTable,
  toJson,
  toMarkdown,
  toMonospace,
} from "./lib.ts";

// ── Browser HTML parser ───────────────────────────────────────────────────────

function parseHtml(input: string): TableData[] {
  return parseHtmlDoc(new DOMParser().parseFromString(input, "text/html"));
}

// ── Shared display components ─────────────────────────────────────────────────

function CellContent({ c }: { c: Cell }) {
  if (c.href) return <a href={c.href}>{c.text}</a>;
  return <>{c.text}</>;
}

// Safe React-rendered table — no dangerouslySetInnerHTML, cells are escaped by React.
function TablePreview({ table }: { table: TableData }) {
  return (
    <table>
      <thead>
        <tr>
          {table.headers.map((h, i) => (
            <th key={i}><CellContent c={h} /></th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, i) => (
          <tr key={i}>
            {row.map((c, j) => (
              <td key={j}><CellContent c={c} /></td>
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
    allRows.map((row) => row[j] ?? cell("")),
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

// ── Link support matrix popover ───────────────────────────────────────────────

const LINK_SUPPORT: {
  format: string;
  readsLinks: boolean;
  writesLinks: boolean;
}[] = [
  { format: "Markdown", readsLinks: true, writesLinks: true },
  { format: "HTML", readsLinks: true, writesLinks: true },
  { format: "CSV", readsLinks: false, writesLinks: false },
  { format: "TSV", readsLinks: false, writesLinks: false },
  { format: "JSON", readsLinks: true, writesLinks: true },
  { format: "Monospace", readsLinks: false, writesLinks: false },
];

function LinkSupportPopover({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.3)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--background-body, #fff)",
          border: "1px solid var(--border, #ccc)",
          borderRadius: "6px",
          padding: "1.25rem",
          maxWidth: "360px",
          width: "90%",
        }}
      >
        <div style={{ fontWeight: "bold", marginBottom: "0.75rem" }}>
          Link Support by Format
        </div>
        <table style={{ width: "100%", fontSize: "0.9em", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", paddingRight: "1rem" }}>Format</th>
              <th style={{ textAlign: "center" }}>Reads Links</th>
              <th style={{ textAlign: "center" }}>Writes Links</th>
            </tr>
          </thead>
          <tbody>
            {LINK_SUPPORT.map((row) => (
              <tr key={row.format}>
                <td style={{ paddingRight: "1rem" }}>{row.format}</td>
                <td style={{ textAlign: "center" }}>{row.readsLinks ? "✓" : "—"}</td>
                <td style={{ textAlign: "center" }}>{row.writesLinks ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: "0.8em", opacity: 0.75, margin: "0.75rem 0 0" }}>
          Links are preserved when a cell contains a single link.
          Markdown uses <code>[text](url)</code>; HTML uses <code>&lt;a&gt;</code> tags.
          JSON encodes links as companion <code>_href</code> keys
          (e.g. <code>"Site_href"</code> alongside <code>"Site"</code>)
          and recognizes the same pattern on input for lossless round-tripping.
        </p>
        <button
          onClick={onClose}
          style={{ marginTop: "0.75rem", fontSize: "0.85em" }}
        >
          Close
        </button>
      </div>
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
  const [showLinkMatrix, setShowLinkMatrix] = useState(false);

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
        <button
          onClick={() => setShowLinkMatrix(true)}
          title="Link support by format"
          style={{ fontSize: "0.8em", padding: "0.15em 0.4em" }}
        >
          🔗
        </button>
      </div>
      <LinkSupportPopover open={showLinkMatrix} onClose={() => setShowLinkMatrix(false)} />
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
      h.text === "" && overrides[i] != null ? cell(overrides[i]) : h,
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
  const [showProfile, setShowProfile] = useState(false);

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
    .map((h, i) => (h.text.trim() === "" ? i : -1))
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
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              onClick={() => setShowProfile(true)}
              title="Show column profile"
              style={{ fontSize: "0.8em", padding: "0.15em 0.5em" }}
            >
              Profile
            </button>
            <ToggleButton
              active={isTransposed}
              onClick={toggleTranspose}
              title="Transpose rows and columns"
            >
              ⇄ Transpose
            </ToggleButton>
          </div>
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

        <div style={{ flex: 1, minHeight: 0 }}>
          <OutputPanel table={activeTable} detectedFormat={detectedFormat} />
        </div>

        {showProfile && (
          <div
            onClick={() => setShowProfile(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.3)",
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "var(--background-body, #fff)",
                border: "1px solid var(--border, #ccc)",
                borderRadius: "6px",
                padding: "1.25rem",
                maxWidth: "90vw",
                maxHeight: "80vh",
                overflow: "auto",
              }}
            >
              <DataProfile table={activeTable} />
              <button
                onClick={() => setShowProfile(false)}
                style={{ marginTop: "0.75rem", fontSize: "0.85em" }}
              >
                Close
              </button>
            </div>
          </div>
        )}
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
  const values = rows.map((r) => r[colIndex]?.text ?? "");
  const nonEmpty = values.filter((v) => v.trim() !== "");
  const nums = nonEmpty.map(Number).filter((n) => !isNaN(n));
  const isNumeric = nums.length === nonEmpty.length && nonEmpty.length > 0;

  return {
    name: headers[colIndex]?.text ?? "",
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

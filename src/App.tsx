import { useState, useEffect, useRef } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import type { Root, Table, TableRow, PhrasingContent } from "mdast";
import { visit } from "unist-util-visit";
import Papa from "papaparse";

type TableData = { headers: string[]; rows: string[][] };
type Format = "markdown" | "csv" | "tsv" | "html" | "json";

// ── Detection ────────────────────────────────────────────────────────────────

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
  if (/^\|.+\|/m.test(t)) return "markdown";
  if (/\t/.test(t)) return "tsv";

  // CSV: require consistent comma count across all non-empty lines (min 1 comma)
  const lines = t.split("\n").filter((l) => l.trim());
  if (lines.length >= 2) {
    const counts = lines.map((l) => (l.match(/,/g) ?? []).length);
    if (counts[0] > 0 && counts.every((c) => c === counts[0])) return "csv";
  }

  return null;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

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
  const rows = arr.map((obj) => headers.map((k) => String(obj[k] ?? "")));
  return [{ headers, rows }];
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

// ── Serializers ──────────────────────────────────────────────────────────────

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
      row
        .map((cell) => cell.replace(/\t/g, " ").replace(/\n/g, " "))
        .join("\t"),
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

function CopyButton({
  label,
  onCopy,
  disabled,
  isCopied,
  isError,
}: {
  label: string;
  onCopy: () => void;
  disabled?: boolean;
  isCopied?: boolean;
  isError?: boolean;
}) {
  return (
    <button onClick={onCopy} disabled={disabled}>
      {isCopied ? "✓ Copied" : isError ? "✗ Failed" : label}
    </button>
  );
}

const FORMAT_LABELS: Record<Format, string> = {
  markdown: "Markdown",
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  html: "HTML",
};

const copyText = (text: string) => () => navigator.clipboard.writeText(text);
const copyRich = (html: string) => () => {
  const blob = new Blob([html], { type: "text/html" });
  return navigator.clipboard.write([new ClipboardItem({ "text/html": blob })]);
};

function TableCard({
  table,
  index,
  detectedFormat,
}: {
  table: TableData;
  index: number;
  detectedFormat: Format | null;
}) {
  const [preview, setPreview] = useState(false);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [errorLabel, setErrorLabel] = useState<string | null>(null);
  const html = toHtmlTable(table);
  const is = (f: Format) => detectedFormat === f;

  const handleCopy = (label: string, fn: () => Promise<void>) => async () => {
    setCopiedLabel(null);
    setErrorLabel(null);
    try {
      await fn();
      setCopiedLabel(label);
      setTimeout(() => setCopiedLabel(null), 2000);
    } catch {
      setErrorLabel(label);
      setTimeout(() => setErrorLabel(null), 2000);
    }
  };

  return (
    <div>
      <hr />
      <h2>Table {index + 1}</h2>
      <p>
        {table.headers.length} columns · {table.rows.length} rows
        {" · "}
        <button
          onClick={() => setPreview((v) => !v)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textDecoration: "underline",
            color: "inherit",
            font: "inherit",
          }}
        >
          {preview ? "hide preview" : "preview"}
        </button>
      </p>
      <p style={{ marginBottom: "0.25rem" }}>Copy as:</p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <CopyButton
          label="CSV"
          disabled={is("csv")}
          isCopied={copiedLabel === "CSV"}
          isError={errorLabel === "CSV"}
          onCopy={handleCopy("CSV", copyText(toCsv(table)))}
        />
        <CopyButton
          label="TSV"
          disabled={is("tsv")}
          isCopied={copiedLabel === "TSV"}
          isError={errorLabel === "TSV"}
          onCopy={handleCopy("TSV", copyText(toTsv(table)))}
        />
        <CopyButton
          label="JSON"
          disabled={is("json")}
          isCopied={copiedLabel === "JSON"}
          isError={errorLabel === "JSON"}
          onCopy={handleCopy("JSON", copyText(toJson(table)))}
        />
        <CopyButton
          label="Markdown"
          disabled={is("markdown")}
          isCopied={copiedLabel === "Markdown"}
          isError={errorLabel === "Markdown"}
          onCopy={handleCopy("Markdown", copyText(toMarkdown(table)))}
        />
        <CopyButton
          label="HTML"
          disabled={is("html")}
          isCopied={copiedLabel === "HTML"}
          isError={errorLabel === "HTML"}
          onCopy={handleCopy("HTML", copyText(html))}
        />
        <CopyButton
          label="Table"
          disabled={is("html")}
          isCopied={copiedLabel === "Table"}
          isError={errorLabel === "Table"}
          onCopy={handleCopy("Table", copyRich(html))}
        />
      </div>
      {preview && <div dangerouslySetInnerHTML={{ __html: html }} />}
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
    } else if (format === "markdown") {
      parseMarkdown(trimmed)
        .then(setTables)
        .catch((err) => console.error("Markdown parse error:", err));
    } else if (format === "json") {
      try {
        setTables(parseJson(trimmed));
      } catch (err) {
        console.error("JSON parse error:", err);
      }
    } else if (format === "html") {
      setTables(parseHtml(trimmed));
    } else if (format === "tsv") {
      setTables(parseTsv(trimmed));
    } else {
      setTables(parseCsv(trimmed));
    }
  }, [input]);

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
    <div
      style={{
        display: "flex",
        gap: "1.5rem",
        alignItems: "flex-start",
        height: "100%",
      }}
    >
      <div style={{ flex: "0 0 50%" }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste a table in Markdown, CSV, TSV, or HTML…"
          rows={24}
          style={{
            width: "100%",
            height: "95vh",
            resize: "vertical",
            fontFamily: "monospace",
            fontSize: "14px",
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {detectedFormat ? (
          <p>
            Detected: <strong>{FORMAT_LABELS[detectedFormat]}</strong>
          </p>
        ) : (
          input.trim() && (
            <p>
              ⚠ Format not recognized — paste Markdown, CSV, TSV, HTML, or JSON.
            </p>
          )
        )}
        {tables.map((table, i) => (
          <TableCard
            key={i}
            table={table}
            index={i}
            detectedFormat={detectedFormat}
          />
        ))}
      </div>
    </div>
  );
}

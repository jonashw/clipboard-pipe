import { useState, useEffect, useRef } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import type { Root, Table, TableRow, PhrasingContent } from "mdast";
import { visit } from "unist-util-visit";
import Papa from "papaparse";

type TableData = string[][];
type Format = "markdown" | "csv" | "tsv" | "html" | "json";

// ── Detection ────────────────────────────────────────────────────────────────

function detectFormat(input: string): Format {
  const t = input.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    try { JSON.parse(t); return "json"; } catch { /* not JSON */ }
  }
  if (/<table[\s>]/i.test(t)) return "html";
  if (/^\|.+\|/m.test(t)) return "markdown";
  if (/\t/.test(t)) return "tsv";
  return "csv";
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
    tables.push(
      node.children.map((row: TableRow) =>
        row.children.map((cell) =>
          extractText(cell.children as PhrasingContent[]),
        ),
      ),
    );
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

function parseCsv(input: string): TableData[] {
  const result = Papa.parse<string[]>(input, { skipEmptyLines: true });
  return result.data.length ? [result.data] : [];
}

function parseTsv(input: string): TableData[] {
  const rows = input
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  return rows.length ? [rows] : [];
}

function parseJson(input: string): TableData[] {
  const parsed = JSON.parse(input);
  const arr: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
  if (!arr.length) return [];
  const headers = Object.keys(arr[0]);
  const rows = arr.map((obj) => headers.map((k) => String(obj[k] ?? "")));
  return [[headers, ...rows]];
}

function parseHtml(input: string): TableData[] {
  const doc = new DOMParser().parseFromString(input, "text/html");
  return Array.from(doc.querySelectorAll("table")).map((table) =>
    Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll("th, td")).map(
        (cell) => cell.textContent ?? "",
      ),
    ),
  );
}

// ── Serializers ──────────────────────────────────────────────────────────────

function toCsv(table: TableData): string {
  return table
    .map((row) =>
      row
        .map((cell) => {
          const escaped = cell.replace(/"/g, '""');
          return /[,"\n\r]/.test(cell) ? `"${escaped}"` : escaped;
        })
        .join(","),
    )
    .join("\n");
}

function toTsv(table: TableData): string {
  return table
    .map((row) =>
      row
        .map((cell) => cell.replace(/\t/g, " ").replace(/\n/g, " "))
        .join("\t"),
    )
    .join("\n");
}

function toHtmlTable(table: TableData): string {
  const header = `<thead><tr>${table[0].map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${table
    .slice(1)
    .map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<table>${header}${body}</table>`;
}

function toJson(table: TableData): string {
  const [headers, ...rows] = table;
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(headers.map((key, i) => [key, row[i] ?? ""]))),
    null,
    2
  );
}

// ── Components ───────────────────────────────────────────────────────────────

function CopyButton({
  label,
  onCopy,
}: {
  label: string;
  onCopy: () => Promise<void>;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  const handleClick = async () => {
    try {
      await onCopy();
      setStatus("copied");
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2000);
    }
  };

  return (
    <button onClick={handleClick}>
      {status === "copied"
        ? "✓ Copied"
        : status === "error"
          ? "✗ Failed"
          : label}
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
const copyHtml = (html: string) => () => {
  const blob = new Blob([html], { type: "text/html" });
  return navigator.clipboard.write([new ClipboardItem({ "text/html": blob })]);
};

function TableCard({ table, index }: { table: TableData; index: number }) {
  const [preview, setPreview] = useState(false);
  const html = toHtmlTable(table);

  return (
    <div>
      <hr />
      <h2>Table {index + 1}</h2>
      <p>
        {table[0].length} columns · {table.length - 1} rows
        {' · '}
        <button
          onClick={() => setPreview((v) => !v)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline', color: 'inherit', font: 'inherit' }}
        >
          {preview ? "hide preview" : "preview"}
        </button>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ opacity: 0.6, fontSize: '0.9em' }}>Copy as:</span>
        <CopyButton label="CSV" onCopy={copyText(toCsv(table))} />
        <CopyButton label="TSV" onCopy={copyText(toTsv(table))} />
        <CopyButton label="JSON" onCopy={copyText(toJson(table))} />
        <CopyButton label="HTML" onCopy={copyText(html)} />
        <CopyButton label="Table" onCopy={copyHtml(html)} />
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
  useEffect(() => { inputRef.current = input }, [input]);

  useEffect(() => {
    const trimmed = input.trim();
    if (!trimmed) {
      setTables([]);
      setDetectedFormat(null);
      return;
    }

    const format = detectFormat(trimmed);
    setDetectedFormat(format);

    if (format === "markdown") {
      parseMarkdown(trimmed)
        .then(setTables)
        .catch((err) => console.error("Markdown parse error:", err));
    } else if (format === "json") {
      try { setTables(parseJson(trimmed)); } catch (err) { console.error("JSON parse error:", err); }
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
      const html = e.clipboardData?.getData('text/html')
      const text = e.clipboardData?.getData('text/plain') ?? ''
      const ta = textareaRef.current
      const taFocused = ta && document.activeElement === ta

      if (html) {
        // Always replace buffer with rich HTML (external source)
        e.preventDefault()
        setInput(html)
      } else if (taFocused) {
        // Insert plain text at cursor, re-parse full buffer
        e.preventDefault()
        const start = ta.selectionStart ?? 0
        const end = ta.selectionEnd ?? 0
        const next = inputRef.current.slice(0, start) + text + inputRef.current.slice(end)
        setInput(next)
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + text.length
        })
      } else {
        // Replace buffer with plain text
        e.preventDefault()
        setInput(text)
      }
    }
    document.addEventListener('paste', handler)
    return () => document.removeEventListener('paste', handler)
  }, [])

  return (
    <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', height: '100%' }}>
      <div style={{ flex: '0 0 50%' }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste a table in Markdown, CSV, TSV, or HTML…"
          rows={24}
          style={{
            width: "100%",
            resize: "vertical",
            fontFamily: "monospace",
            fontSize: "14px",
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {detectedFormat && (
          <p>
            Detected: <strong>{FORMAT_LABELS[detectedFormat]}</strong>
          </p>
        )}
        {tables.map((table, i) => (
          <TableCard key={i} table={table} index={i} />
        ))}
      </div>
    </div>
  );
}

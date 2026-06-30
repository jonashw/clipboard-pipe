import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import type { Root, Table, TableRow, PhrasingContent } from "mdast";
import { visit } from "unist-util-visit";
import Papa from "papaparse";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TableData = { headers: string[]; rows: string[][] };
export type Format = "markdown" | "csv" | "tsv" | "html" | "json" | "monospace";

// ── Detection ─────────────────────────────────────────────────────────────────

export function detectFormat(input: string): Format | null {
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

export function extractText(nodes: PhrasingContent[]): string {
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

export function extractMarkdownTables(ast: Root): TableData[] {
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

export async function parseMarkdown(input: string): Promise<TableData[]> {
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

export function fromRows(allRows: string[][]): TableData {
  const [headers = [], ...rows] = allRows;
  return { headers, rows };
}

export function parseCsv(input: string): TableData[] {
  const result = Papa.parse<string[]>(input, { skipEmptyLines: true });
  return result.data.length > 1 ? [fromRows(result.data)] : [];
}

export function parseTsv(input: string): TableData[] {
  const allRows = input
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  return allRows.length > 1 ? [fromRows(allRows)] : [];
}

export function parseJson(input: string): TableData[] {
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

export function parseMonospace(input: string): TableData[] {
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

// Minimal DOM-like interface satisfied by both browser DOM and node-html-parser.
export interface HtmlDocLike {
  querySelectorAll(selector: string): Iterable<{
    querySelectorAll(selector: string): Iterable<{
      querySelectorAll(selector: string): Iterable<{ textContent: string | null }>;
    }>;
  }>;
}

export function parseHtmlDoc(doc: HtmlDocLike): TableData[] {
  return Array.from(doc.querySelectorAll("table")).map((table) => {
    const allRows = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll("th, td")).map(
        (cell) => cell.textContent ?? "",
      ),
    );
    return fromRows(allRows);
  });
}

// ── Serializers ───────────────────────────────────────────────────────────────

function csvCell(cell: string): string {
  const escaped = cell.replace(/"/g, '""');
  return /[,"\n\r]/.test(cell) ? `"${escaped}"` : escaped;
}

export function toCsv({ headers, rows }: TableData): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function toTsv({ headers, rows }: TableData): string {
  return [headers, ...rows]
    .map((row) =>
      row.map((c) => c.replace(/\t/g, " ").replace(/\n/g, " ")).join("\t"),
    )
    .join("\n");
}

export function toHtmlTable({ headers, rows }: TableData): string {
  const thead = `<thead><tr>${headers.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

export function toJson({ headers, rows }: TableData): string {
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(headers.map((key, i) => [key, row[i] ?? ""])),
    ),
    null,
    2,
  );
}

export function toMarkdown({ headers, rows }: TableData): string {
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

export function toMonospace({ headers, rows }: TableData): string {
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

// ── Serializer registry ───────────────────────────────────────────────────────

export type ConversionName =
  | "toCsv"
  | "toTsv"
  | "toHtml"
  | "toHtmlTable"
  | "toJson"
  | "toMarkdown"
  | "toMonospace";

export const CONVERSIONS: Record<ConversionName, (t: TableData) => string> = {
  toCsv,
  toTsv,
  toHtml: toHtmlTable,
  toHtmlTable,
  toJson,
  toMarkdown,
  toMonospace,
};

// ── Parse dispatcher ──────────────────────────────────────────────────────────

export async function parseInput(
  input: string,
  parseHtml: (input: string) => TableData[],
): Promise<{ tables: TableData[]; format: Format | null }> {
  const trimmed = input.trim();
  if (!trimmed) return { tables: [], format: null };

  const format = detectFormat(trimmed);
  if (!format) return { tables: [], format: null };

  let tables: TableData[];
  if (format === "markdown") {
    tables = await parseMarkdown(trimmed);
  } else if (format === "json") {
    try {
      tables = parseJson(trimmed);
    } catch {
      tables = [];
    }
  } else if (format === "html") {
    tables = parseHtml(trimmed);
  } else if (format === "monospace") {
    tables = parseMonospace(trimmed);
  } else if (format === "tsv") {
    tables = parseTsv(trimmed);
  } else {
    tables = parseCsv(trimmed);
  }

  return { tables, format };
}

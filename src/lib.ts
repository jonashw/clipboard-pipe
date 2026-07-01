import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import type { Root, Table, TableRow, PhrasingContent } from "mdast";
import { visit } from "unist-util-visit";
import Papa from "papaparse";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Cell = { text: string; href?: string };
export type TableData = { headers: Cell[]; rows: Cell[][] };
export type Format = "markdown" | "csv" | "tsv" | "html" | "json" | "monospace";
export type Block =
  | { type: "text"; content: string }
  | { type: "table"; table: TableData };

export function cell(text: string, href?: string): Cell {
  return href ? { text, href } : { text };
}

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

export function extractCell(nodes: PhrasingContent[]): Cell {
  if (
    nodes.length === 1 &&
    nodes[0].type === "link" &&
    "url" in nodes[0]
  ) {
    const link = nodes[0] as { url: string; children: PhrasingContent[] };
    return cell(extractText(link.children), link.url);
  }
  return cell(extractText(nodes));
}

export function extractMarkdownTables(ast: Root): TableData[] {
  const tables: TableData[] = [];
  visit(ast, "table", (node: Table) => {
    const [headerRow, ...dataRows] = node.children as TableRow[];
    tables.push({
      headers: headerRow.children.map((c) =>
        extractCell(c.children as PhrasingContent[]),
      ),
      rows: dataRows.map((row) =>
        row.children.map((c) =>
          extractCell(c.children as PhrasingContent[]),
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

export function extractMarkdownBlocks(ast: Root, source: string): Block[] {
  const blocks: Block[] = [];
  let lastEnd = 0;

  for (const node of ast.children) {
    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;

    if (node.type === "table") {
      if (startOffset != null) {
        const textBefore = source.slice(lastEnd, startOffset).trim();
        if (textBefore) {
          blocks.push({ type: "text", content: textBefore });
        }
      }
      const [headerRow, ...dataRows] = (node as Table).children as TableRow[];
      blocks.push({
        type: "table",
        table: {
          headers: headerRow.children.map((c) =>
            extractCell(c.children as PhrasingContent[]),
          ),
          rows: dataRows.map((row) =>
            row.children.map((c) =>
              extractCell(c.children as PhrasingContent[]),
            ),
          ),
        },
      });
      if (endOffset != null) {
        lastEnd = endOffset;
      }
    }
  }

  const trailing = source.slice(lastEnd).trim();
  if (trailing) {
    blocks.push({ type: "text", content: trailing });
  }

  return blocks;
}

export async function parseMarkdownBlocks(input: string): Promise<Block[]> {
  let ast: Root | null = null;
  await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: Root) => {
      ast = tree;
    })
    .use(remarkHtml, { sanitize: false })
    .process(input);
  return ast ? extractMarkdownBlocks(ast, input) : [];
}

export function fromRows(allRows: Cell[][]): TableData {
  const [headers = [], ...rows] = allRows;
  return { headers, rows };
}

export function fromStringRows(allRows: string[][]): TableData {
  return fromRows(allRows.map((row) => row.map((s) => cell(s))));
}

export function parseCsv(input: string): TableData[] {
  const result = Papa.parse<string[]>(input, { skipEmptyLines: true });
  return result.data.length > 1 ? [fromStringRows(result.data)] : [];
}

export function parseTsv(input: string): TableData[] {
  const allRows = input
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  return allRows.length > 1 ? [fromStringRows(allRows)] : [];
}

export function parseJson(input: string): TableData[] {
  const parsed = JSON.parse(input);
  const arr: Record<string, unknown>[] = Array.isArray(parsed)
    ? parsed
    : [parsed];
  if (!arr.length) return [];
  const allKeys = Object.keys(arr[0]);
  // Separate _href companion keys from display keys
  const hrefSuffix = "_href";
  const hrefKeys = new Set(allKeys.filter((k) => k.endsWith(hrefSuffix)));
  const headers = allKeys.filter((k) => !hrefKeys.has(k));
  return [
    {
      headers: headers.map((h) => cell(h)),
      rows: arr.map((obj) =>
        headers.map((k) => {
          const href = obj[`${k}${hrefSuffix}`];
          return cell(
            String(obj[k] ?? ""),
            typeof href === "string" ? href : undefined,
          );
        }),
      ),
    },
  ];
}

export function parseMonospace(input: string): TableData[] {
  const parseRow = (line: string) =>
    line
      .split("│")
      .slice(1, -1)
      .map((s) => cell(s.trim()));
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
      textContent: string | null;
      querySelectorAll(selector: string): Iterable<{
        textContent: string | null;
        getAttribute?(attr: string): string | null;
        href?: string;
      }>;
    }>;
  }>;
}

export function parseHtmlDoc(doc: HtmlDocLike): TableData[] {
  return Array.from(doc.querySelectorAll("table")).map((table) => {
    const allRows = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll("th, td")).map((td) => {
        const anchors = Array.from(
          (td as unknown as { querySelectorAll(s: string): Iterable<{ textContent: string | null; getAttribute?(a: string): string | null; href?: string }> }).querySelectorAll("a"),
        );
        if (anchors.length === 1) {
          const a = anchors[0];
          const href = a.getAttribute ? a.getAttribute("href") : a.href;
          if (href) return cell(a.textContent ?? "", href);
        }
        return cell(td.textContent ?? "");
      }),
    );
    return fromRows(allRows);
  });
}

// ── Serializers ───────────────────────────────────────────────────────────────

function csvCell(c: Cell): string {
  const escaped = c.text.replace(/"/g, '""');
  return /[,"\n\r]/.test(c.text) ? `"${escaped}"` : escaped;
}

export function toCsv({ headers, rows }: TableData): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function toTsv({ headers, rows }: TableData): string {
  return [headers, ...rows]
    .map((row) =>
      row.map((c) => c.text.replace(/\t/g, " ").replace(/\n/g, " ")).join("\t"),
    )
    .join("\n");
}

function htmlCell(c: Cell): string {
  return c.href ? `<a href="${c.href}">${c.text}</a>` : c.text;
}

export function toHtmlTable({ headers, rows }: TableData): string {
  const thead = `<thead><tr>${headers.map((c) => `<th>${htmlCell(c)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${htmlCell(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

export function toJson({ headers, rows }: TableData): string {
  return JSON.stringify(
    rows.map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((key, i) => {
        const c = row[i];
        obj[key.text] = c?.text ?? "";
        if (c?.href) {
          obj[`${key.text}_href`] = c.href;
        }
      });
      return obj;
    }),
    null,
    2,
  );
}

function cellToMarkdown(c: Cell): string {
  return c.href ? `[${c.text}](${c.href})` : c.text;
}

export function toMarkdown({ headers, rows }: TableData): string {
  const cols = headers.length;
  const headerStrs = headers.map(cellToMarkdown);
  const rowStrs = rows.map((row) => row.map(cellToMarkdown));
  const colWidths = Array.from({ length: cols }, (_, i) =>
    Math.max(headerStrs[i].length, ...rowStrs.map((r) => (r[i] ?? "").length), 3),
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const renderRow = (cells: string[]) =>
    "| " + cells.map((c, i) => pad(c, colWidths[i])).join(" | ") + " |";
  const separator =
    "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  return [renderRow(headerStrs), separator, ...rowStrs.map(renderRow)].join("\n");
}

export function toMonospace({ headers, rows }: TableData): string {
  const cols = headers.length;
  const headerStrs = headers.map((c) => c.text);
  const rowStrs = rows.map((row) => row.map((c) => c.text));
  const colWidths = Array.from({ length: cols }, (_, i) =>
    Math.max(headerStrs[i].length, ...rowStrs.map((r) => (r[i] ?? "").length), 1),
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const top = "┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const divider = "├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bottom = "└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";
  const renderRow = (cells: string[]) =>
    "│ " + cells.map((c, i) => pad(c, colWidths[i])).join(" │ ") + " │";
  return [
    top,
    renderRow(headerStrs),
    divider,
    ...rowStrs.map(renderRow),
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

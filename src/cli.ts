#!/usr/bin/env node
import { parse as parseHtmlNode } from "node-html-parser";
import {
  type ConversionName,
  type TableData,
  CONVERSIONS,
  parseInput,
} from "./lib.ts";

// ── HTML parser (Node.js) ─────────────────────────────────────────────────────

function parseHtml(input: string): TableData[] {
  const doc = parseHtmlNode(input);
  return doc.querySelectorAll("table").map((table) => {
    const allRows = table.querySelectorAll("tr").map((row) =>
      row.querySelectorAll("th, td").map((cell) => cell.text),
    );
    const [headers = [], ...rows] = allRows;
    return { headers, rows };
  });
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const CONVERSION_NAMES = Object.keys(CONVERSIONS) as ConversionName[];

function usage(): void {
  console.error(
    `Usage: tableshift <conversion>

Reads table data from stdin, auto-detects the format, and writes the
converted output to stdout.

Conversions:
  toCsv
  toTsv
  toHtml        (toHtmlTable is an alias)
  toJson
  toMarkdown
  toMonospace

Supported input formats: markdown, csv, tsv, html, json, monospace

Examples:
  echo "Name,Age\\nAlice,30\\nBob,25" | tableshift toMarkdown
  cat data.json | tableshift toMonospace
  cat table.html | tableshift toCsv`,
  );
}

async function main(): Promise<void> {
  const [, , conversionArg] = process.argv;

  if (!conversionArg || conversionArg === "--help" || conversionArg === "-h") {
    usage();
    process.exit(conversionArg ? 0 : 1);
  }

  if (!CONVERSION_NAMES.includes(conversionArg as ConversionName)) {
    console.error(
      `Error: unknown conversion "${conversionArg}"\n\nValid conversions: ${CONVERSION_NAMES.join(", ")}`,
    );
    process.exit(1);
  }

  const conversion = CONVERSIONS[conversionArg as ConversionName];

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = Buffer.concat(chunks).toString("utf8");

  const { tables, format } = await parseInput(input, parseHtml);

  if (!format) {
    console.error("Error: could not detect input format");
    process.exit(1);
  }

  if (!tables.length) {
    console.error(`Error: no tables found in ${format} input`);
    process.exit(1);
  }

  const output = tables.map(conversion).join("\n\n");
  process.stdout.write(output + "\n");
}

main().catch((err: unknown) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

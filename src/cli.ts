#!/usr/bin/env node
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseHtmlNode } from "node-html-parser";
import {
  type ConversionName,
  type TableData,
  cell,
  CONVERSIONS,
  parseInput,
} from "./lib.ts";

// ── HTML parser (Node.js) ─────────────────────────────────────────────────────

function parseHtml(input: string): TableData[] {
  const doc = parseHtmlNode(input);
  return doc.querySelectorAll("table").map((table) => {
    const allRows = table.querySelectorAll("tr").map((row) =>
      row.querySelectorAll("th, td").map((td) => {
        const anchors = td.querySelectorAll("a");
        if (anchors.length === 1) {
          const href = anchors[0].getAttribute("href");
          if (href) return cell(anchors[0].text, href);
        }
        return cell(td.text);
      }),
    );
    const [headers = [], ...rows] = allRows;
    return { headers, rows };
  });
}

// ── Clipboard helpers ─────────────────────────────────────────────────────────

function copyHtml(html: string): void {
  const dir = mkdtempSync(join(tmpdir(), "tableshift-"));
  try {
    const file = join(dir, "t.html");
    writeFileSync(file, html, "utf8");
    execSync(
      `osascript -e 'set the clipboard to (read (POSIX file "${file}") as «class HTML»)'`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function copyText(text: string): void {
  execSync("pbcopy", { input: text });
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage(): void {
  console.error(
    `Usage: tableshift <conversion> [--copy]

Reads table data from stdin, auto-detects the format, and writes the
converted output to stdout.  Pass --copy to send directly to the clipboard
instead (toHtml uses a rich text/html clipboard type; all others use pbcopy).

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
  cat data.json | tableshift toMonospace --copy
  cat table.html | tableshift toHtml --copy`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const copyFlag = args.includes("--copy");
  const conversionArg = args.find((a) => !a.startsWith("-"));

  if (!conversionArg || conversionArg === "--help" || conversionArg === "-h") {
    usage();
    process.exit(conversionArg ? 0 : 1);
  }

  const CONVERSION_NAMES = Object.keys(CONVERSIONS) as ConversionName[];
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

  if (copyFlag) {
    const isHtml =
      conversionArg === "toHtml" || conversionArg === "toHtmlTable";
    isHtml ? copyHtml(output) : copyText(output);
    console.error(`Copied to clipboard.`);
  } else {
    process.stdout.write(output + "\n");
  }
}

main().catch((err: unknown) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

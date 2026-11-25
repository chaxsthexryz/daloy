import { StepError } from "./retry";

/** The most data rows and bytes the read_spreadsheet step reads from one file (M1, decision 0139). */
export const READ_SPREADSHEET_MAX_ROWS = 2000;
export const READ_SPREADSHEET_MAX_BYTES = 2 * 1024 * 1024;

/**
 * RFC 4180 CSV: comma-separated cells, records ended by CRLF (LF or a lone CR also work), a cell in double quotes may
 * hold commas, line breaks and "" for one quote. A leading UTF-8 BOM is dropped and rows with only empty cells are
 * skipped. A quote in the middle of an unquoted cell is kept as text, as Excel does. Comma only: a file that uses
 * semicolons reads as one column.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false; // the current record has at least one character, so a last record with no line break is kept
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') cell += text[++i];
      else quoted = false;
      continue;
    }
    started = true;
    if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      started = false;
    } else cell += c;
  }
  if (quoted) throw new Error("A quoted cell is never closed.");
  if (started) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

const column = (i: number): string => (i < 26 ? String.fromCharCode(97 + i) : column(Math.floor(i / 26) - 1) + column(i % 26));

/**
 * Template-safe keys for a header row: "Order ID" is order_id, so a later step reads {{item.order_id}}. An empty
 * header is named by its column letter, a repeat gets _2, _3, and width names any cells past the header.
 */
export function cellKeys(header: string[], width = header.length): string[] {
  const keys: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = (header[i] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || column(i);
    if (!/^[a-z]/.test(name)) name = `col_${name}`;
    let unique = name;
    for (let n = 2; keys.includes(unique); n++) unique = `${name}_${n}`;
    keys.push(unique);
  }
  return keys;
}

/** A CSV file as rows keyed by its first row. Over the row cap, or unreadable, it stops with a plain message. */
export function csvTable(text: string, maxRows = READ_SPREADSHEET_MAX_ROWS): { rows: Record<string, string>[]; count: number; columns: string[] } {
  let parsed: string[][];
  try {
    parsed = parseCsv(text);
  } catch (err) {
    throw new StepError(`The file is not valid CSV: ${(err as Error).message}`, false);
  }
  const [header = [], ...data] = parsed;
  if (data.length > maxRows) {
    throw new StepError(`The file has ${data.length.toLocaleString("en-US")} rows, and kymavo reads at most ${maxRows.toLocaleString("en-US")} at a time. Split the export into smaller files.`, false);
  }
  const columns = cellKeys(header, data.reduce((w, r) => Math.max(w, r.length), header.length));
  const rows = data.map((r) => Object.fromEntries(columns.map((k, i) => [k, r[i] ?? ""])));
  return { rows, count: rows.length, columns };
}

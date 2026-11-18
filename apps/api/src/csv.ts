/** Text a spreadsheet would run as a formula starts with one of these. */
const FORMULA = /^[=+\-@\t\r]/;

/** One CSV cell: formula starters get a leading quote, then RFC 4180 quoting where needed. Objects become JSON. */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

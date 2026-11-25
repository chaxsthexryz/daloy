import { randomUUID } from "node:crypto";
import { saveUploads, type Db } from "@daloy/db";
import { FILE_MAX_BYTES, safeFileName, StepError, type FileRef } from "@daloy/engine";
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * N23 (decision 0140): a one-page invoice PDF drawn with pdf-lib and stored as an upload of the run, the same store
 * and FileRef as a form's files, so an email step can attach it and the 7-day upload purge removes it.
 */
export type InvoiceItem = { description: string; quantity: string; unitPrice: string };
export type InvoiceInput = { businessName: string; clientName: string; clientEmail?: string; invoiceNumber: string; items: InvoiceItem[]; currency: "PHP"; dueDate?: string; notes?: string };
export type InvoiceLine = { description: string; quantity: string; unitPrice: number; amount: number };

const MAX_UNIT_CENTAVOS = 999_999_999;
const MAX_QUANTITY_HUNDREDTHS = 1_000_000;

/** "1,500.50" or "1500.5" as integer hundredths. Commas only in groups of three. Null when it is not such a number. */
function hundredths(text: string): number | null {
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]!.replaceAll(",", "")) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/**
 * Each line's amount and the total, in integer centavos. A quantity has up to 2 decimals (2.5 hours), so a line is
 * quantity hundredths times unit centavos over 100, rounded half up. The caps keep every product under 2^53.
 */
export function invoiceTotals(items: InvoiceItem[]): { lines: InvoiceLine[]; total: number } {
  const lines = items
    .filter((i) => i.description.trim() !== "")
    .map((i, n) => {
      const at = `Line ${n + 1} (${i.description.trim().slice(0, 40)})`;
      const unit = hundredths(i.unitPrice);
      if (unit === null || unit > MAX_UNIT_CENTAVOS) throw new StepError(`${at}: the unit price "${i.unitPrice.slice(0, 40)}" is not pesos from 0 to 9,999,999.99, such as 1500 or 1,500.50.`, false);
      const qty = hundredths(i.quantity);
      if (qty === null || qty === 0 || qty > MAX_QUANTITY_HUNDREDTHS) throw new StepError(`${at}: the quantity "${i.quantity.slice(0, 40)}" is not a number above 0 and up to 10,000, with at most 2 decimals.`, false);
      return { description: i.description.trim(), quantity: i.quantity.trim(), unitPrice: unit, amount: Math.floor((qty * unit + 50) / 100) };
    });
  if (lines.length === 0) throw new StepError("The invoice has no line items: every description came out empty.", false);
  return { lines, total: lines.reduce((sum, l) => sum + l.amount, 0) };
}

/** 150050 centavos as "1500.50", the form a paymongo_link step takes. */
export const pesoPlain = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
/** 150050 centavos as "PHP 1,500.50". Standard PDF fonts have no peso sign, so the code is used everywhere. */
export const pesoText = (c: number) => `PHP ${Math.floor(c / 100).toLocaleString("en-US")}.${String(c % 100).padStart(2, "0")}`;

const A4: [number, number] = [595.28, 841.89];
const LEFT = 50;
const RIGHT = 545;
const ROW = 16;
const GREY = rgb(0.4, 0.4, 0.4);

/** Draws the invoice on one A4 page. 30 rows and 6 lines of notes fit by construction (INVOICE_MAX_ITEMS). */
export async function drawInvoice(input: InvoiceInput, totals: { lines: InvoiceLine[]; total: number }, issued: Date): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // The standard fonts draw Latin-1 (WinAnsi) only; anything else becomes "?" instead of failing the run.
  const drawable = new Set(font.getCharacterSet());
  const clean = (s: string) => Array.from(s.replace(/\s+/g, " ").trim(), (ch) => (drawable.has(ch.codePointAt(0)!) ? ch : "?")).join("");
  const line = (s: string, f: PDFFont, size: number, width: number) => fit(clean(s), f, size, width);
  const text = (p: PDFPage, s: string, x: number, y: number, size = 10, f = font, color = rgb(0, 0, 0)) => p.drawText(s, { x, y, size, font: f, color });
  const right = (s: string, x: number, y: number, size = 10, f = font) => text(page, s, x - f.widthOfTextAtSize(s, size), y, size, f);

  doc.setTitle(clean(`Invoice ${input.invoiceNumber}`));
  doc.setProducer("kymavo");
  doc.setCreator("kymavo");

  text(page, line(input.businessName, bold, 18, 330), LEFT, 790, 18, bold);
  right("INVOICE", RIGHT, 790, 18, bold);
  const issuedText = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", dateStyle: "long" }).format(issued);
  const meta = [`Invoice no. ${input.invoiceNumber}`, `Issued ${issuedText}`, ...(input.dueDate?.trim() ? [`Due ${input.dueDate}`] : [])];
  meta.forEach((m, i) => right(line(m, font, 10, 240), RIGHT, 765 - i * 15, 10));
  text(page, "Bill to", LEFT, 765, 10, bold);
  [input.clientName, input.clientEmail ?? ""].filter((s) => s.trim()).forEach((s, i) => text(page, line(s, font, 10, 250), LEFT, 750 - i * 15));

  let y = 690;
  text(page, "Description", LEFT, y, 10, bold);
  right("Qty", 360, y, 10, bold);
  right("Unit price", 450, y, 10, bold);
  right("Amount", RIGHT, y, 10, bold);
  page.drawLine({ start: { x: LEFT, y: y - 6 }, end: { x: RIGHT, y: y - 6 }, thickness: 0.5, color: GREY });
  for (const l of totals.lines) {
    y -= ROW;
    text(page, line(l.description, font, 10, 250), LEFT, y);
    right(line(l.quantity, font, 10, 50), 360, y);
    right(pesoText(l.unitPrice), 450, y);
    right(pesoText(l.amount), RIGHT, y);
  }
  page.drawLine({ start: { x: LEFT, y: y - 8 }, end: { x: RIGHT, y: y - 8 }, thickness: 0.5, color: GREY });
  y -= 26;
  right(pesoText(totals.total), RIGHT, y, 12, bold);
  right("Total", 430, y, 12, bold);

  const notes = clean(input.notes ?? "");
  if (notes) {
    y -= 30;
    text(page, "Notes", LEFT, y, 10, bold);
    for (const line of wrap(notes, font, 9, RIGHT - LEFT, 6)) text(page, line, LEFT, (y -= 13), 9, font, GREY);
  }
  return doc.save();
}

/** s cut to width with "..." at the end. */
function dots(s: string, font: PDFFont, size: number, width: number) {
  let out = s;
  while (out && font.widthOfTextAtSize(`${out}...`, size) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}...`;
}
const fit = (s: string, font: PDFFont, size: number, width: number) => (font.widthOfTextAtSize(s, size) <= width ? s : dots(s, font, size, width));

/** Word-wraps text into at most max lines; the last ends in "..." when some was left out. */
function wrap(s: string, font: PDFFont, size: number, width: number, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (!line || font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  const kept = lines.slice(0, max).map((l) => fit(l, font, size, width));
  if (lines.length > max) kept[max - 1] = dots(kept[max - 1]!, font, size, width);
  return kept;
}

/**
 * The step: totals, PDF, upload. A test run draws the PDF (so bad amounts fail the same way) but stores nothing.
 * Each attempt stores its own file; the purge removes unused ones with the run's other uploads.
 */
export async function invoicePdfStep(db: Db, at: { userId: string; runId: string; stepId: string }, input: InvoiceInput, mock: boolean) {
  const totals = invoiceTotals(input.items);
  const data = Buffer.from(await drawInvoice(input, totals, new Date()));
  if (data.length > FILE_MAX_BYTES) throw new StepError("The invoice PDF came out larger than 5 MB.", false);
  const summary = { invoiceNumber: input.invoiceNumber, currency: "PHP", total: pesoPlain(totals.total), totalText: pesoText(totals.total), totalCentavos: totals.total, items: totals.lines.length };
  if (mock) return { mocked: true, ...summary, file: null };
  const name = safeFileName(`invoice-${input.invoiceNumber}.pdf`);
  const id = randomUUID();
  await saveUploads(db, { userId: at.userId, runId: at.runId, files: [{ id, field: at.stepId, name, type: "pdf", data }] });
  const file: FileRef = { id, name, type: "pdf", size: data.length };
  return { ...summary, file };
}

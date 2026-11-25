import { randomBytes, randomUUID } from "node:crypto";
import { readUpload, runs, saveUploads, uploads, users, workflows, workflowVersions, type Db } from "@daloy/db";
import type { FileRef, Step } from "@daloy/engine";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { pdfText } from "./ai-files";
import { createExecutor } from "./index";
import { drawInvoice, invoiceTotals, pesoText, type InvoiceInput } from "./invoice-pdf";

const key = randomBytes(32);
let db: Db;
let pool: Pool;
const sent: string[] = [];

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);
afterAll(async () => {
  await pool?.end();
});

const executor = () =>
  createExecutor({
    db,
    secretsKey: key,
    mail: {
      installation: {
        transport: {
          sendMail: async (msg: SendMailOptions) => {
            const info = await nodemailer.createTransport({ jsonTransport: true }).sendMail(msg);
            sent.push(String(info.message));
            return info;
          },
        } as unknown as Transporter,
        from: "d@example.com",
      },
      gmail: () => {
        throw new Error("no Gmail in this test");
      },
      sharedMail: "open",
    },
  });

async function newRun() {
  const [u] = await db.insert(users).values({ email: `inv-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Invoice", slug: `w${randomUUID().slice(0, 8)}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {}, published: true }).returning();
  const runRow = async () => (await db.insert(runs).values({ workflowVersionId: v!.id }).returning())[0]!.id;
  return { userId: u!.id, workflowId: wf!.id, runId: await runRow(), otherRunId: await runRow() };
}

const exec = (at: { userId: string; runId: string; workflowId: string }, step: Step, ctx: { trigger?: unknown; steps?: Record<string, { output: unknown }> } = {}, mock = false) =>
  executor().execute({ ...at, stepRunId: "00000000-0000-0000-0000-000000000000", step, attempt: 1, idempotencyKey: `${at.runId}:${step.id}`, ctx: { trigger: ctx.trigger ?? {}, steps: ctx.steps ?? {} }, mock });

const INVOICE: InvoiceInput = {
  businessName: "Ana Reyes Design",
  clientName: "Kape Co.",
  clientEmail: "billing@kape.example",
  invoiceNumber: "INV-2026-014",
  items: [
    { description: "Logo design", quantity: "1", unitPrice: "3,500" },
    { description: "Revisions (hours)", quantity: "2.5", unitPrice: "100.10" },
    { description: "Stickers", quantity: "3", unitPrice: "0.10" },
  ],
  currency: "PHP",
  dueDate: "December 15, 2026",
  notes: "Pay through the link in the email.\nThank you!",
};

describe("invoiceTotals", () => {
  it("adds line items in integer centavos", () => {
    const t = invoiceTotals(INVOICE.items);
    // 3 x 0.10 is 0.30000000000000004 in floating point; in centavos it is 30.
    expect(t.lines.map((l) => l.amount)).toEqual([350_000, 25_025, 30]);
    expect(t.total).toBe(375_055);
    expect(t.lines.every((l) => Number.isInteger(l.amount))).toBe(true);
    expect(pesoText(t.total)).toBe("PHP 3,750.55");
  });

  it("rounds a fractional centavo half up", () => {
    // 0.5 x 0.01 is half a centavo.
    expect(invoiceTotals([{ description: "x", quantity: "0.5", unitPrice: "0.01" }]).total).toBe(1);
    expect(invoiceTotals([{ description: "x", quantity: "0.25", unitPrice: "0.01" }]).total).toBe(0);
  });

  it("skips rows whose description is empty", () => {
    const t = invoiceTotals([...INVOICE.items, { description: "  ", quantity: "", unitPrice: "" }]);
    expect(t.lines).toHaveLength(3);
  });

  it.each([
    [{ description: "x", quantity: "1", unitPrice: "abc" }, "unit price"],
    [{ description: "x", quantity: "1", unitPrice: "-5" }, "unit price"],
    [{ description: "x", quantity: "1", unitPrice: "1.234" }, "unit price"],
    [{ description: "x", quantity: "1", unitPrice: "10000000" }, "unit price"],
    [{ description: "x", quantity: "0", unitPrice: "5" }, "quantity"],
    [{ description: "x", quantity: "1.005", unitPrice: "5" }, "quantity"],
    [{ description: "x", quantity: "10001", unitPrice: "5" }, "quantity"],
  ])("refuses %o", (item, word) => {
    expect(() => invoiceTotals([item])).toThrow(word);
  });

  it("refuses an invoice with no rows left", () => {
    expect(() => invoiceTotals([{ description: "", quantity: "1", unitPrice: "5" }])).toThrow("no line items");
  });
});

describe("drawInvoice", () => {
  it("draws a PDF whose text has the invoice number, the client and the total", async () => {
    const bytes = await drawInvoice(INVOICE, invoiceTotals(INVOICE.items), new Date("2026-11-25T02:00:00Z"));
    const text = await pdfText(Buffer.from(bytes));
    expect(text).toContain("INV-2026-014");
    expect(text).toContain("Kape Co.");
    expect(text).toContain("PHP 3,750.55");
    expect(text).toContain("Thank you!");
    expect(text).toContain("November 25, 2026");
  });

  it("replaces characters the PDF font cannot draw instead of failing", async () => {
    const odd = { ...INVOICE, clientName: "Señora 🌸 李", items: [{ description: "Café ☕", quantity: "1", unitPrice: "1" }] };
    const text = await pdfText(Buffer.from(await drawInvoice(odd, invoiceTotals(odd.items), new Date())));
    expect(text).toContain("Señora ? ?");
    expect(text).toContain("Café ?");
  });

  it("fits 30 long rows and long notes on one page", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ description: `Row ${i + 1} ${"very long words ".repeat(20)}`, quantity: "1", unitPrice: "1" }));
    const many = { ...INVOICE, items, notes: "note ".repeat(2000) };
    const bytes = await drawInvoice(many, invoiceTotals(items), new Date());
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    const text = await pdfText(Buffer.from(bytes));
    expect(text).toContain("Row 30");
    expect(text).toContain("PHP 30.00");
  });
});

describe("the invoice_pdf step and email attachments", () => {
  const pdfStep: Step = {
    id: "pdf",
    type: "invoice_pdf",
    config: {
      businessName: "{{trigger.business}}",
      clientName: "{{trigger.name}}",
      clientEmail: "{{trigger.email}}",
      invoiceNumber: "{{trigger.number}}",
      items: [{ description: "{{trigger.service}}", quantity: "{{trigger.hours}}", unitPrice: "{{trigger.rate}}" }],
      currency: "PHP",
    },
  };
  const trigger = { business: "Ana Reyes Design", name: "Kape Co.", email: "billing@kape.example", number: "INV-7", service: "Design work", hours: "4", rate: "1,250.50" };
  const mailStep = (attachments: string[]): Step => ({ id: "mail", type: "email", config: { to: "billing@kape.example", subject: "Invoice", text: "Attached.", attachments } });

  it("stores the PDF as an upload of this run and returns it as output.file", async () => {
    const at = await newRun();
    const { output } = (await exec(at, pdfStep, { trigger })) as { output: { file: FileRef; total: string; totalText: string; invoiceNumber: string } };
    expect(output).toMatchObject({ total: "5002.00", totalText: "PHP 5,002.00", invoiceNumber: "INV-7", file: { type: "pdf", name: "invoice-INV-7.pdf" } });
    const stored = await readUpload(db, { userId: at.userId, runId: at.runId, id: output.file.id });
    expect(stored?.size).toBe(output.file.size);
    expect(await pdfText(stored!.data)).toContain("INV-7");
  });

  it("a test run draws the invoice but stores nothing", async () => {
    const at = await newRun();
    const { output } = (await exec(at, pdfStep, { trigger }, true)) as { output: Record<string, unknown> };
    expect(output).toMatchObject({ mocked: true, total: "5002.00", file: null });
    expect(await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.runId, at.runId))).toHaveLength(0);
  });

  it("attaches the PDF from an earlier step to the email", async () => {
    const at = await newRun();
    const pdf = await exec(at, pdfStep, { trigger });
    sent.length = 0;
    const out = (await exec(at, mailStep(["{{steps.pdf.output.file}}"]), { trigger, steps: { pdf: { output: pdf.output } } })) as { output: Record<string, unknown> };
    expect(out.output).toMatchObject({ to: ["billing@kape.example"], attachments: 1 });
    const msg = JSON.parse(sent[0]!) as { attachments: { filename: string; contentType: string; content: string }[] };
    const file = msg.attachments.find((a) => a.contentType === "application/pdf")!;
    expect(file.filename).toBe("invoice-INV-7.pdf");
    expect(await pdfText(Buffer.from(file.content, "base64"))).toContain("PHP 5,002.00");
  });

  it("refuses an attachment stored by another run, and sends nothing", async () => {
    const at = await newRun();
    const id = randomUUID();
    await saveUploads(db, { userId: at.userId, runId: at.otherRunId, files: [{ id, field: "pdf", name: "other.pdf", type: "pdf", data: Buffer.from("%PDF-1.4 other") }] });
    const foreign: FileRef = { id, name: "other.pdf", type: "pdf", size: 14 };
    sent.length = 0;
    await expect(exec(at, mailStep(["{{trigger.file}}"]), { trigger: { file: foreign } })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("not a file from this run") });
    expect(sent).toHaveLength(0);
  });

  it("refuses a value that is not a file", async () => {
    const at = await newRun();
    await expect(exec(at, mailStep(["{{trigger.name}}"]), { trigger })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("not a file") });
  });

  it("refuses more than 3 files once a form field's list is spread out", async () => {
    const at = await newRun();
    const refs: FileRef[] = Array.from({ length: 4 }, () => ({ id: randomUUID(), name: "a.pdf", type: "pdf", size: 1 }));
    await expect(exec(at, mailStep(["{{trigger.files}}"]), { trigger: { files: refs } })).rejects.toMatchObject({ message: expect.stringContaining("at most 3") });
  });
});

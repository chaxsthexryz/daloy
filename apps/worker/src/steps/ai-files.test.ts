import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runs, saveAiSettings, saveUploads, uploads, usageCounts, users, workflows, workflowVersions, type Db } from "@daloy/db";
import type { FileKind, FileRef } from "@daloy/engine";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { MAX_PDF_CHARS, pdfText } from "./ai-files";
import { createExecutor } from "./index";

const key = randomBytes(32);
let db: Db;
let pool: Pool;
let server: Server;
const bodies: { messages: { role: string; content: string; images?: string[] }[] }[] = [];

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { role: "assistant", content: '{"label":"support"}' }, prompt_eval_count: 1, eval_count: 1 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  server?.closeAllConnections();
  server?.close();
  await pool?.end();
});
beforeEach(() => {
  bodies.length = 0;
  vi.stubEnv("LLM_VISION", "on");
});

/** A one-page PDF built byte by byte, so the xref offsets are right and the text layer is known. */
function pdf(text?: string) {
  const chunks = text ? (text.match(/.{1,25}/gs) ?? []) : [];
  const stream = chunks.length ? `BT /F1 12 Tf ${chunks.map((c) => `1 0 0 1 72 700 Tm (${c}) Tj`).join(" ")} ET` : "";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

describe("pdfText", () => {
  it("reads the text layer", async () => {
    expect(await pdfText(pdf("Invoice 4471 for Ana"))).toBe("Invoice 4471 for Ana");
  });
  it("says a PDF without text is probably a scan", async () => {
    await expect(pdfText(pdf())).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("probably a scan") });
  });
  it("refuses bytes that only look like a PDF", async () => {
    await expect(pdfText(Buffer.from("%PDF-1.4 garbage garbage"))).rejects.toMatchObject({ retryable: false, message: "This PDF could not be read." });
  });
  it("stops reading at the timeout", async () => {
    await expect(pdfText(pdf("hello"), 1)).rejects.toMatchObject({ retryable: false, message: "This PDF took too long to read." });
  });

  it("caps extracted PDF text characters cleanly (S4)", async () => {
    const huge = pdf("A".repeat(MAX_PDF_CHARS + 10_000));
    const text = await pdfText(huge);
    expect(text.length).toBeLessThanOrEqual(MAX_PDF_CHARS + 200);
    expect(text).toContain("truncated");
  });
});

describe("an AI step with files", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const marker = Buffer.from("OTHER-FIELD-MARKER-77");
  async function setup(stored: { field: string; type: FileKind; data: Buffer }[]) {
    const [u] = await db.insert(users).values({ email: `ai-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
    const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Intake", slug: `w${randomUUID().slice(0, 8)}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {}, published: true }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
    const files = stored.map((f, i) => ({ id: randomUUID(), name: `${f.field}-${i}.${f.type}`, ...f }));
    await saveUploads(db, { userId: u!.id, runId: r!.id, files });
    const refs = (field: string): FileRef[] => files.filter((f) => f.field === field).map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.data.length }));
    const trigger = Object.fromEntries([...new Set(stored.map((f) => f.field))].map((f) => [f, refs(f)]));
    const used = async () => (await db.select({ n: usageCounts.used }).from(usageCounts).where(and(eq(usageCounts.userId, u!.id), eq(usageCounts.kind, "ai")))).reduce((n, x) => n + x.n, 0);
    const run = (fileFields: string[]) =>
      createExecutor({ db, secretsKey: key, mail: {} as never }).execute({
        runId: r!.id, stepRunId: "00000000-0000-0000-0000-000000000000", userId: u!.id, workflowId: wf!.id, attempt: 1, idempotencyKey: `${r!.id}:think`, mock: false, aiLive: true,
        step: { id: "think", type: "ai", config: { task: "classify", input: "hi", labels: { billing: "Invoices", support: "Everything else" }, files: ["photo"] } } as never,
        ctx: { trigger, steps: {} }, fileFields,
      });
    return { userId: u!.id, runId: r!.id, used, run };
  }

  it("sends the stored bytes of a listed file and never those of another field, and counts 1 + files once", async () => {
    const s = await setup([{ field: "photo", type: "png", data: PNG }, { field: "other", type: "png", data: marker }]);
    await s.run(["photo"]);
    expect(bodies[0]!.messages[1]!.images).toEqual([PNG.toString("base64")]);
    expect(JSON.stringify(bodies)).not.toContain(marker.toString("base64"));
    expect(await s.used()).toBe(2);
    await s.run(["photo"]);
    expect(await s.used()).toBe(2);
  });

  it("refuses images when the model reads none, counting and sending nothing", async () => {
    vi.stubEnv("LLM_VISION", "off");
    const s = await setup([{ field: "photo", type: "png", data: PNG }]);
    await expect(s.run(["photo"])).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("does not read images") });
    expect(await s.used()).toBe(0);
    expect(bodies).toHaveLength(0);
  });

  it("refuses a HEIC photo for a model that lists no HEIC", async () => {
    const s = await setup([{ field: "photo", type: "heic", data: PNG }]);
    await saveAiSettings(db, key, s.userId, { preset: "openai", model: "gpt-x", apiKey: "sk-test" });
    await expect(s.run(["photo"])).rejects.toMatchObject({ message: expect.stringContaining("HEIC") });
    expect(await s.used()).toBe(0);
  });

  it("refuses photos that add up to more than 10 MB", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 1);
    const s = await setup([{ field: "photo", type: "png", data: big }, { field: "photo", type: "png", data: big }, { field: "photo", type: "png", data: big }]);
    await expect(s.run(["photo"])).rejects.toMatchObject({ message: expect.stringContaining("10 MB") });
    expect(await s.used()).toBe(0);
    expect(bodies).toHaveLength(0);
  });

  it("refuses a file whose upload is gone", async () => {
    const s = await setup([{ field: "photo", type: "png", data: PNG }]);
    await db.delete(uploads).where(eq(uploads.runId, s.runId));
    await expect(s.run(["photo"])).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("no longer stored") });
    expect(await s.used()).toBe(0);
  });

  it("puts a PDF's text inside <data> even for a model that reads no images, and counts 1 + 1", async () => {
    vi.stubEnv("LLM_VISION", "off");
    const s = await setup([{ field: "photo", type: "pdf", data: pdf("Total due 900 pesos") }]);
    await s.run(["photo"]);
    const user = bodies[0]!.messages[1]!;
    expect(user.images).toBeUndefined();
    expect(user.content).toMatch(/<data>[\s\S]*Total due 900 pesos[\s\S]*<\/data>/);
    expect(await s.used()).toBe(2);
  });
});

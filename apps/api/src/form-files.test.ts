import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { joinWorkspace, sessions, uploads, users, workflows, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { sha256 } from "./http";

// N21: files sent through a hosted form, their download, and the Google Drive connection. Fake providers only.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  // trustProxy lets each submission use its own X-Forwarded-For, so the 10 a minute limit does not mix the tests up.
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, trustProxy: 1, providers: { ...fake.urls, timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

type Agent = ReturnType<typeof request.agent>;
let seq = 0;
let ip = 0;
const nextIp = () => `10.${(ip >> 16) & 255}.${(ip >> 8) & 255}.${++ip & 255}`;

const MARKER = "SECRET-MARKER-9f3a1c";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 7)]);
const PDF = Buffer.from(`%PDF-1.4\n% ${MARKER}\n%%EOF`);

async function owner() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `files${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  const workspaceId = (await agent.get("/auth/me").expect(200)).body.workspaceId as string;
  return { agent, workspaceId };
}
async function member(o: Agent, role: "operator" | "approver" | "requester") {
  const workspaceId = (await o.get("/auth/me").expect(200)).body.workspaceId as string;
  const [u] = await db.insert(users).values({ email: `filesm${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}

const FIELDS = [
  { name: "name", label: "Name", type: "text", required: false },
  { name: "photo", label: "Photo", type: "file", required: false },
  { name: "doc", label: "Document", type: "file", required: false },
];
async function form(agent: Agent, fields: object[] = FIELDS, tracked = false) {
  const wf = await agent.post("/workflows").send({ name: "Intake", slug: `files-${++seq}` }).expect(201);
  const definition = { trigger: { type: "form", config: { fields } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  if (tracked) await db.update(workflows).set({ setup: { template: "office-request" } }).where(eq(workflows.id, wf.body.id));
  const formId = (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body.trigger.id as string;
  return { workflowId: wf.body.id as string, formId };
}
const submit = (formId: string, ipAddr = nextIp()) => request(server).post(`/forms/${formId}`).set("X-Forwarded-For", ipAddr);
const stored = (workspaceId: string) => db.select().from(uploads).where(eq(uploads.userId, workspaceId));
const runsOf = async (agent: Agent, workflowId: string) => (await agent.get(`/runs?workflowId=${workflowId}`).expect(200)).body as { id: string; triggerPayload: Record<string, unknown> }[];

describe("form file upload", () => {
  it("stores a JPEG and a PDF, and the run payload holds references only", async () => {
    const o = await owner();
    const f = await form(o.agent);
    await submit(f.formId).field("name", "Ana").attach("photo", JPEG, "front.jpg").attach("doc", PDF, "id card.pdf").expect(200);
    const rows = await stored(o.workspaceId);
    expect(rows.map((r) => [r.field, r.type, r.name]).sort()).toEqual([["doc", "pdf", "id card.pdf"], ["photo", "jpeg", "front.jpg"]]);
    const [run] = await runsOf(o.agent, f.workflowId);
    expect(run!.triggerPayload).toMatchObject({ name: "Ana", photo: [{ name: "front.jpg", type: "jpeg", size: JPEG.length }], doc: [{ name: "id card.pdf", type: "pdf", size: PDF.length }] });
    const text = JSON.stringify(run!.triggerPayload);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(JPEG.toString("base64"));
    expect(Object.keys((run!.triggerPayload.photo as object[])[0]!).sort()).toEqual(["id", "name", "size", "type"]);
  });

  it("goes by the bytes, not the browser's type or the name", async () => {
    const o = await owner();
    const f = await form(o.agent);
    await submit(f.formId).attach("photo", PNG, { filename: "photo.jpg", contentType: "image/jpeg" }).expect(200);
    expect((await stored(o.workspaceId)).map((r) => r.type)).toEqual(["png"]);
    const refused: [string, Buffer][] = [
      ["logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
      ["photo.jpg", Buffer.from("<html><script>alert(1)</script></html>")],
      ["anim.gif", Buffer.from("GIF89a\u0001\u0000")],
      ["notes.pdf", Buffer.from("plain text, no signature")],
    ];
    for (const [name, data] of refused) await submit(f.formId).attach("photo", data, { filename: name, contentType: "image/jpeg" }).expect(400);
    expect(await stored(o.workspaceId)).toHaveLength(1);
  });

  it("refuses a file over 5 MB, six files and four files in one field", async () => {
    const o = await owner();
    const f = await form(o.agent);
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await submit(f.formId).attach("photo", big, "big.jpg");
    expect([400, 413]).toContain(res.status);
    expect(res.body.message).toEqual(expect.any(String));
    let six = submit(f.formId);
    for (let i = 0; i < 6; i++) six = six.attach(i < 3 ? "photo" : "doc", JPEG, `p${i}.jpg`);
    expect([400, 413]).toContain((await six).status);
    let four = submit(f.formId);
    for (let i = 0; i < 4; i++) four = four.attach("photo", JPEG, `p${i}.jpg`);
    await four.expect(400);
    expect(await stored(o.workspaceId)).toHaveLength(0);
  });

  it("refuses a file under a text field, and ignores a text value for a file field", async () => {
    const o = await owner();
    const f = await form(o.agent);
    await submit(f.formId).attach("name", JPEG, "x.jpg").expect(400);
    await submit(f.formId).field("name", "Ana").field("photo", '[{"id":"x"}]').expect(200);
    const [run] = await runsOf(o.agent, f.workflowId);
    expect(run!.triggerPayload).toEqual({ name: "Ana" });
    expect(await stored(o.workspaceId)).toHaveLength(0);
  });

  it("answers 400 when a required file field is missing", async () => {
    const o = await owner();
    const f = await form(o.agent, [{ name: "id", label: "ID", type: "file", required: true }]);
    const res = await submit(f.formId).field("x", "y").expect(400);
    expect(JSON.stringify(res.body)).toContain("id");
    await submit(f.formId).attach("id", JPEG, "id.jpg").expect(200);
  });

  it("stores the files once when a tracked submission is replayed", async () => {
    const o = await owner();
    const f = await form(o.agent, FIELDS, true);
    const key = randomUUID();
    const send = () => submit(f.formId).field("submission_key", key).field("name", "Ana").attach("photo", JPEG, "front.jpg");
    await send().expect(200);
    await send().expect(200);
    expect(await stored(o.workspaceId)).toHaveLength(1);
    expect(await runsOf(o.agent, f.workflowId)).toHaveLength(1);
  });

  it("stores nothing when another field is invalid", async () => {
    const o = await owner();
    const f = await form(o.agent, [{ name: "email", label: "Email", type: "email", required: true }, { name: "photo", label: "Photo", type: "file", required: false }]);
    await submit(f.formId).field("email", "not-an-email").attach("photo", JPEG, "a.jpg").expect(400);
    expect(await stored(o.workspaceId)).toHaveLength(0);
    expect(await runsOf(o.agent, f.workflowId)).toHaveLength(0);
  });

  it("limits a workspace with no plan to 20 files a day", async () => {
    const o = await owner();
    const f = await form(o.agent);
    for (let i = 0; i < 4; i++) {
      let s = submit(f.formId);
      for (let j = 0; j < 5; j++) s = s.attach(j < 3 ? "photo" : "doc", JPEG, `p${j}.jpg`);
      await s.expect(200);
    }
    const res = await submit(f.formId).attach("photo", JPEG, "one-more.jpg").expect(429);
    expect(res.body.message).toBe("This form cannot take more files today. Send it without files, or try again tomorrow.");
    await submit(f.formId).field("name", "No files").expect(200);
    expect(await stored(o.workspaceId)).toHaveLength(20);
  });

  it("checks the rate limit before it reads the body", async () => {
    const o = await owner();
    const f = await form(o.agent);
    const mine = "198.51.100.77";
    for (let i = 0; i < 10; i++) await submit(f.formId, mine).field("name", "x").expect(200);
    const big = Buffer.concat([JPEG, Buffer.alloc(6 * 1024 * 1024)]);
    // Refused before the body is read: a file that would be a 400 is a 429, and a body over the size limit never gets to be a 413.
    await submit(f.formId, mine).attach("photo", Buffer.from("<svg/>"), "x.svg").expect(429);
    const res = await submit(f.formId, mine).attach("photo", big, "big.jpg").catch((err: unknown) => err);
    // The server may close the connection before the 6 MB are sent, so the client sees either the 429 or a reset.
    expect(String((res as { status?: number }).status ?? (res as { code?: string }).code)).toMatch(/^(429|ECONNRESET|EPIPE)$/);
  });

  it("renders the multipart form and the file input only when there is a file field", async () => {
    const o = await owner();
    const withFile = await form(o.agent, [{ name: "id", label: "ID", type: "file", required: true }]);
    const page = (await request(server).get(`/forms/${withFile.formId}`).expect(200)).text;
    expect(page).toContain('enctype="multipart/form-data"');
    expect(page).toContain('type="file"');
    expect(page).toContain("required");
    expect(page).toContain('accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif"');
    expect(page).toContain("multiple");
    const without = await form(o.agent, [{ name: "name", label: "Name", type: "text", required: true }]);
    expect((await request(server).get(`/forms/${without.formId}`).expect(200)).text).not.toMatch(/enctype|type="file"/);
  });
});

describe("file download", () => {
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  };
  async function withFile(name = "front.jpg", data = JPEG) {
    const o = await owner();
    const f = await form(o.agent);
    await submit(f.formId).attach("photo", data, name).expect(200);
    const [run] = await runsOf(o.agent, f.workflowId);
    const fileId = (run!.triggerPayload.photo as { id: string }[])[0]!.id;
    return { ...o, runId: run!.id, fileId };
  }

  it("gives the owner and an operator the bytes with every header", async () => {
    const o = await withFile("evil.svg");
    for (const agent of [o.agent, await member(o.agent, "operator")]) {
      const res = await agent.get(`/runs/${o.runId}/files/${o.fileId}`).buffer(true).parse(binary).expect(200);
      expect((res.body as Buffer).toString("hex")).toBe(JPEG.toString("hex"));
      expect(res.headers["content-type"]).toBe("image/jpeg");
      expect(res.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''evil.svg");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(res.headers["cache-control"]).toBe("private, no-store");
    }
  });

  it("refuses an approver and a requester, and answers 404 for anything that is not theirs", async () => {
    const o = await withFile();
    const path = `/runs/${o.runId}/files/${o.fileId}`;
    await (await member(o.agent, "approver")).get(path).expect(403);
    await (await member(o.agent, "requester")).get(path).expect(403);
    await request(server).get(path).expect(401);
    await (await owner()).agent.get(path).expect(404);
    const other = await withFile();
    await o.agent.get(`/runs/${o.runId}/files/${other.fileId}`).expect(404);
    await o.agent.get(`/runs/${o.runId}/files/${randomUUID()}`).expect(404);
  });
});

describe("Google Drive connection", () => {
  function keyFile(email: string) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    fake.addServiceAccount(email, publicKey.export({ type: "spki", format: "pem" }).toString());
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    return JSON.stringify({ type: "service_account", project_id: "office", private_key_id: "abc", private_key: pem, client_email: email });
  }

  it("saves a folder in a shared drive and never returns the key", async () => {
    const o = await owner();
    const email = `drive${seq}@office.iam.gserviceaccount.com`;
    const id = `shared-folder-${seq}-abcd`;
    fake.addDriveFolder(id, "Client IDs", [email], "drive-1");
    const res = await o.agent.put("/settings/connections/google-drive").send({ serviceAccount: keyFile(email), folder: `https://drive.google.com/drive/u/0/folders/${id}?usp=sharing` }).expect(200);
    expect(res.body.connections[0]).toMatchObject({ provider: "google_drive", status: "active", account: email, destination: { folderId: id, title: "Client IDs" } });
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE KEY");
    await o.agent.delete("/settings/connections/google-drive").expect(204);
  });

  it("asks for a shared drive when the folder is in My Drive, and refuses a bad link", async () => {
    const o = await owner();
    const email = `mydrive${seq}@office.iam.gserviceaccount.com`;
    const id = `my-drive-folder-${seq}-ab`;
    fake.addDriveFolder(id, "Mine", [email], null);
    const key = keyFile(email);
    const res = await o.agent.put("/settings/connections/google-drive").send({ serviceAccount: key, folder: id }).expect(400);
    expect(res.body.message).toContain("shared drive");
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE KEY");
    const bad = await o.agent.put("/settings/connections/google-drive").send({ serviceAccount: key, folder: "https://example.com/not-a-folder" }).expect(400);
    expect(JSON.stringify(bad.body)).not.toContain("PRIVATE KEY");
    await o.agent.put("/settings/connections/google-drive").send({ serviceAccount: "{not json", folder: id }).expect(400);
  });
});

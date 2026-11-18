import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

let app: INestApplication;
let boss: PgBoss;
let pool: Pool;
let server: Parameters<typeof request>[0];

beforeAll(async () => {
  const fresh = await freshDatabase();
  pool = fresh.pool;
  boss = new PgBoss(fresh.url);
  await boss.start();
  app = await createApp({ db: fresh.db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

let seq = 0;
async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `brand${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  const wf = await agent.post("/workflows").send({ name: "Inquiries", slug: `inq-${seq}` }).expect(201);
  const definition = { trigger: { type: "form", config: { fields: [{ name: "name", label: "Name", type: "text", required: true }] } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  const formId = (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body.trigger.id as string;
  return { agent, id: res.body.id as string, formId };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const upload = (agent: ReturnType<typeof request.agent>, bytes: Buffer | string) => agent.put("/settings/brand/logo").send({ data: Buffer.from(bytes).toString("base64") });

describe("brand kit", () => {
  it("leaves forms as they were when nothing is set", async () => {
    const o = await owner();
    const page = await request(server).get(`/forms/${o.formId}`).expect(200);
    expect(page.text).not.toMatch(/<style|<header|brand\/logo/);
    await request(server).get(`/brand/logo/${o.id}`).expect(404);
    expect((await o.agent.get("/settings/brand").expect(200)).body).toEqual({ accent: null, logo: false });
  });

  it("puts the name, logo and accent on the form and on the page after sending it", async () => {
    const o = await owner();
    await o.agent.put("/settings/email/profile").send({ businessName: "Cruz <Bakery>", website: null, inquiryEmail: null, replyTo: null }).expect(204);
    await o.agent.put("/settings/brand").send({ accent: "#ffe08a" }).expect(200);
    await upload(o.agent, PNG).expect(200);
    const page = await request(server).get(`/forms/${o.formId}`).expect(200);
    expect(page.text).toContain("Cruz &lt;Bakery&gt;");
    expect(page.text).toContain(`src="/brand/logo/${o.id}"`);
    expect(page.text).toContain("background:#ffe08a;color:#111111");
    const sent = await request(server).post(`/forms/${o.formId}`).type("form").send({ name: "Ana", _website: "" }).expect(200);
    expect(sent.text).toContain("#ffe08a");

    const logo = await request(server).get(`/brand/logo/${o.id}`).expect(200);
    expect(logo.headers["content-type"]).toBe("image/png");
    expect(logo.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(logo.body as Buffer).equals(PNG)).toBe(true);

    await o.agent.delete("/settings/brand/logo").expect(204);
    await o.agent.put("/settings/brand").send({ accent: null }).expect(200);
    expect((await request(server).get(`/forms/${o.formId}`).expect(200)).text).not.toMatch(/<style|<header/);
  });

  it("refuses SVG, other types, disguised files, big files and empty uploads", async () => {
    const o = await owner();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    await upload(o.agent, svg).expect(400);
    await upload(o.agent, "GIF89a" + "x".repeat(40)).expect(400);
    await upload(o.agent, "<html><script>alert(1)</script></html>").expect(400);
    await upload(o.agent, Buffer.concat([PNG, Buffer.alloc(100 * 1024)])).expect(400);
    await upload(o.agent, Buffer.alloc(0)).expect(400);
    await o.agent.put("/settings/brand/logo").send({ data: "not base64 !!!" }).expect(400);
    await o.agent.put("/settings/brand/logo").send({ data: Buffer.from(PNG).toString("base64"), url: "https://example.com/logo.png" }).expect(400);
    await request(server).get(`/brand/logo/${o.id}`).expect(404);
  });

  it("checks the accent as a hex colour and needs a signed-in owner", async () => {
    const o = await owner();
    for (const accent of ["red", "#fff", "#FFE08A", "#ffe08a;}</style>", 5]) await o.agent.put("/settings/brand").send({ accent }).expect(400);
    await request(server).put("/settings/brand").send({ accent: "#ffe08a" }).expect(401);
    await request(server).put("/settings/brand/logo").send({ data: PNG.toString("base64") }).expect(401);
  });
});

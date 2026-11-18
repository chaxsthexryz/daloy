import { randomBytes } from "node:crypto";
import { joinWorkspace, sessions, users, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

// N19: CSV downloads for an automation's Activity and for Bookings.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

type Agent = ReturnType<typeof request.agent>;
let seq = 0;
async function owner() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `csv${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return agent;
}
async function member(boss: Agent, role: "operator" | "approver" | "requester") {
  const workspaceId = (await boss.get("/auth/me").expect(200)).body.workspaceId as string;
  const [u] = await db.insert(users).values({ email: `csvm${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}
async function workflow(agent: Agent) {
  const wf = await agent.post("/workflows").send({ name: "Orders", slug: `csv-${++seq}` }).expect(201);
  const definition = { trigger: { type: "manual" }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  return wf.body.id as string;
}
const text = async (agent: Agent, path: string) => {
  const res = await agent.get(path).expect(200);
  return { res, lines: (res.text as string).split("\r\n").filter(Boolean) };
};

describe("activity CSV", () => {
  it("lists the standard columns, then the form fields, and escapes formulas and hides secrets", async () => {
    const o = await owner();
    const id = await workflow(o);
    await o.post(`/workflows/${id}/runs`).send({ payload: { name: "=HYPERLINK(\"x\")", note: "a,b", phone: "+639171234567", password: "hunter2", plain: "Ana" } }).expect(202);
    const { res, lines } = await text(o, `/runs/export.csv?workflowId=${id}`);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    // The database stores the payload as jsonb, which orders keys by length, so only the set of field columns is fixed.
    const head = lines[0]!.split(",");
    expect(head.slice(0, 5)).toEqual(["reference", "state", "test", "created", "finished"]);
    expect(head.slice(5).sort()).toEqual(["name", "note", "password", "phone", "plain"]);
    const row = lines[1]!;
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row).toContain('"a,b"');
    expect(row).toContain("'+639171234567");
    expect(row).toContain("[secret]");
    expect(row).not.toContain("hunter2");
    expect(row).toMatch(/(^|,)Ana(,|$)/);
  });

  it("allows owners and operators only, and only the caller's workspace", async () => {
    const o = await owner();
    const id = await workflow(o);
    const path = `/runs/export.csv?workflowId=${id}`;
    await text(await member(o, "operator"), path);
    await (await member(o, "approver")).get(path).expect(403);
    await (await member(o, "requester")).get(path).expect(403);
    await request(server).get(path).expect(401);
    await (await owner()).get(path).expect(200).then((r) => expect((r.text as string).split("\r\n").filter(Boolean)).toHaveLength(1));
    await o.get("/runs/export.csv").expect(400);
  });
});

describe("bookings CSV", () => {
  it("has the booking columns and the same role rules", async () => {
    const o = await owner();
    const { lines } = await text(o, "/bookings/export.csv");
    expect(lines).toEqual(["reference,resource,start,end,minutes,timezone,status"]);
    await text(await member(o, "operator"), "/bookings/export.csv");
    await (await member(o, "approver")).get("/bookings/export.csv").expect(403);
    await request(server).get("/bookings/export.csv").expect(401);
  });
});

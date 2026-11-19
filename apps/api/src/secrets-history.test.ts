import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  bookings,
  connectionCredential,
  connections,
  createApproval,
  deliveries,
  emailSources,
  encryptSecret,
  mailSenders,
  purgeRetiredSecrets,
  readTokenBlob,
  requests,
  resources,
  retiredSecrets,
  retireSecret,
  runs,
  secrets,
  smtpMailer,
  stepRuns,
  users,
  workflows,
  workflowVersions,
  type Db,
  type MailDeps,
} from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";

// Regression for the fec03cc report: run history must not reveal a secret in any encoding, including rows written
// before the fix and values the owner has since rotated or deleted (decision 0025).
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let server: Parameters<typeof request>[0];
const key = randomBytes(32);
let seq = 0;
let echoSmtpSecret: string | undefined;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  const baseTransport = smtpMailer({}).transport;
  const mail: MailDeps = {
    installation: smtpMailer({}),
    gmail: (auth) =>
      auth.user === "echo-error@test.local"
        ? ({
            sendMail: async () => {
              throw new Error(`SMTP 500 echoed ${echoSmtpSecret ?? ""}`);
            },
          } as never)
        : baseTransport,
    sharedMail: "open",
  };
  const microsoft = { clientId: fake.microsoft.clientId, clientSecret: fake.microsoft.clientSecret, tenant: "organizations" };
  app = await createApp({
    db,
    boss,
    secretsKey: key,
    secureCookies: false,
    mail,
    publicUrl: "https://daloy.example.com",
    providers: { ...fake.urls, timeoutMs: 2000, microsoft },
  });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

async function owner() {
  const agent = request.agent(server);
  const email = `hist${++seq}@test.local`;
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: user!.id };
}

const V1 = 'old"se\\cret\nvalue%';
const forms = (v: string) => [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)];

describe("run history and secrets", () => {
  it("hides every form of a secret in rows written before the fix, also after the secret is rotated and deleted", async () => {
    const { agent, userId } = await owner();
    await agent.put("/secrets/tricky").send({ value: V1 }).expect(204);
    // A row as the old worker could leave it: the secret JSON-escaped in the body, URL-encoded in a reply, raw in an error.
    const [wf] = await db.insert(workflows).values({ userId, name: "Old", slug: `old-${seq}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "failed", triggerPayload: { note: V1 }, error: `step call: ${V1}` }).returning();
    await db.insert(stepRuns).values({
      runId: r!.id,
      stepId: "call",
      attempt: 1,
      state: "failed",
      input: { body: JSON.stringify({ token: V1 }) },
      output: { body: `echo=${encodeURIComponent(V1)}&form=${new URLSearchParams({ v: V1 }).toString().slice(2)}` },
      error: `failed with ${V1}`,
    });

    await db.insert(deliveries).values({ userId, runId: r!.id, stepId: "send", provider: "slack", reference: `HIST-${seq}`, payload: { text: "x" }, state: "failed", errorKind: "permission", lastError: `refused ${V1}` });
    await db.insert(requests).values({ userId, workflowId: wf!.id, runId: r!.id, reference: `HIST-${seq}`, submissionKey: randomUUID(), subject: "Old" });
    if (!app.getHttpServer().listening) await app.listen(0, "127.0.0.1");
    const token = ((await agent.post("/tokens").send({ name: "claude", scopes: ["read"] }).expect(201)).body as { token: string }).token;
    const client = new Client({ name: "history-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const leaked = async () => {
      const status = await client.callTool({ name: "get_run_status", arguments: { runId: r!.id } });
      const bodies = [
        (await agent.get(`/runs/${r!.id}`).expect(200)).body,
        (await agent.get("/runs").expect(200)).body,
        (await agent.get(`/workflows/${wf!.id}/requests`).expect(200)).body,
        (await agent.get(`/deliveries?runId=${r!.id}`).expect(200)).body,
        status.structuredContent ?? status.content,
      ];
      const text = JSON.stringify(bodies);
      return forms(V1).filter((f) => text.includes(f) || text.includes(JSON.stringify(f).slice(1, -1)));
    };
    expect(await leaked()).toEqual([]);
    await agent.put("/secrets/tricky").send({ value: "new-value" }).expect(204);
    expect(await leaked()).toEqual([]);
    await agent.delete("/secrets/tricky").expect(204);
    expect(await leaked()).toEqual([]);
    // Retired values are for redaction only: the secret is gone for workflows.
    expect((await agent.get("/secrets").expect(200)).body).toEqual([]);
  });

  it("keeps every replaced value hidden when rotations and a deletion of one secret race (retest of ecb5ade)", async () => {
    const { agent, userId } = await owner();
    const [wf] = await db.insert(workflows).values({ userId, name: "Race", slug: `race-${seq}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    for (let round = 0; round < 8; round++) {
      const values = [1, 2, 3, 4].map((i) => `race-${round}-value-${i}-${randomBytes(4).toString("hex")}`);
      const name = `race_${round}`;
      // Each value was in use at some point, so history may hold any of them.
      const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "succeeded", triggerPayload: { seen: values } }).returning();
      await agent.put(`/secrets/${name}`).send({ value: values[0] }).expect(204);
      await Promise.all([
        agent.put(`/secrets/${name}`).send({ value: values[1] }),
        agent.put(`/secrets/${name}`).send({ value: values[2] }),
        agent.delete(`/secrets/${name}`),
        agent.put(`/secrets/${name}`).send({ value: values[3] }),
      ]);
      const text = JSON.stringify((await agent.get(`/runs/${r!.id}`).expect(200)).body);
      expect(values.filter((x) => text.includes(x)), `round ${round}`).toEqual([]);
    }
  });

  it("hides a value rotated or deleted while a history read is in progress, in the run list and the detail (retest of 6e603de)", async () => {
    // Pause the history read right after its query of retired values, and change the secret there, as Astra did.
    // Read in one snapshot, the old value is either still current or already retired: hidden either way.
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    let inFlight: (() => Promise<void>) | undefined;
    Object.assign(pool, {
      query: async (...args: unknown[]) => {
        const result = await query(...args);
        const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string }).text;
        if (inFlight && text?.includes("retired_secrets")) {
          const change = inFlight;
          inFlight = undefined;
          await change();
        }
        return result;
      },
    });
    try {
      for (const change of ["rotate", "delete"] as const) {
        for (const read of ["detail", "list"] as const) {
          const { agent, userId } = await owner();
          const old = `in-flight-${change}-${read}-${randomBytes(4).toString("hex")}`;
          await agent.put("/secrets/k").send({ value: old }).expect(204);
          const [wf] = await db.insert(workflows).values({ userId, name: "Read race", slug: `read-race-${seq}` }).returning();
          const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
          const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "succeeded", triggerPayload: { seen: old } }).returning();
          // The same steps as PUT and DELETE /secrets/:name, on a connection of their own.
          inFlight = () =>
            db.transaction(async (tx) => {
              await retireSecret(tx, userId, "k");
              const mine = and(eq(secrets.userId, userId), eq(secrets.name, "k"));
              if (change === "delete") await tx.delete(secrets).where(mine);
              else await tx.update(secrets).set(encryptSecret(key, userId, "k", `new-${old}`)).where(mine);
            });
          const body = (await agent.get(read === "detail" ? `/runs/${r!.id}` : "/runs").expect(200)).body as unknown;
          expect(inFlight, `${change} ${read}: the read was not paused`).toBeUndefined();
          expect(JSON.stringify(body), `${change} ${read}`).not.toContain(old);
        }
      }
    } finally {
      Object.assign(pool, { query });
    }
  });

  it("refuses to save JSON bodies that will not parse, secrets outside HTTP steps and secrets sent to data-chosen hosts", async () => {
    const { agent } = await owner();
    const wf = (await agent.post("/workflows").send({ name: "Checks", slug: `checks-${seq}` }).expect(201)).body as { id: string };
    const save = (steps: unknown[]) => agent.post(`/workflows/${wf.id}/versions`).send({ definition: { trigger: { type: "manual", config: {} }, steps, edges: [] } });
    const http = (config: object) => ({ id: "call", type: "http", config: { method: "POST", headers: {}, ...config } });

    expect((await save([http({ url: "https://a.example/x", headers: { "content-type": "application/json" }, body: '{"a": 1' })]).expect(400)).body.message).toEqual([expect.stringContaining("not valid JSON")]);
    expect((await save([{ id: "mail", type: "email", config: { to: "a@example.com", subject: "s", text: "{{secrets.k}}" } }]).expect(400)).body.message).toEqual([expect.stringContaining("only be used in HTTP steps")]);
    expect((await save([http({ url: "https://{{trigger.host}}/x", headers: { Authorization: "{{secrets.k}}" } })]).expect(400)).body.message).toEqual([expect.stringContaining("fixed address")]);
    await save([http({ url: "https://a.example/x/{{trigger.id}}", headers: { Authorization: "{{secrets.k}}", "content-type": "application/json" }, body: '{"amount": {{trigger.amount}}}' })]).expect(201);
    // A test run saves the draft too, so it gets the same check.
    await agent.post(`/workflows/${wf.id}/test-runs`).send({ definition: { trigger: { type: "manual", config: {} }, steps: [http({ url: "{{trigger.url}}", headers: { Authorization: "{{secrets.k}}" } })], edges: [] }, payload: {} }).expect(400);
  });

  it("hides current, retired and OAuth secrets across approvals, requests, deliveries, connections, email settings, email sources, CSV and bookings", async () => {
    const { agent, userId } = await owner();
    const secretVal = `audit-sec-${randomBytes(4).toString("hex")}/a+b`;
    await agent.put("/secrets/audit_key").send({ value: secretVal }).expect(204);

    // Connect Outlook through the fake Microsoft provider so we have live OAuth tokens and can test live test-error redaction too.
    const startRes = await agent.post("/settings/connections/outlook/start").expect(200);
    const back = new URL((await fetch(startRes.body.url as string, { redirect: "manual" })).headers.get("location")!);
    await agent.get(back.pathname + back.search).expect(302);
    const blob = readTokenBlob((await connectionCredential(db, key, userId, "outlook"))!.credential);
    const oauthAccess = blob.accessToken;
    const oauthRefresh = blob.refreshToken!;
    await db
      .update(connections)
      .set({ lastError: `provider refused ${secretVal} and ${oauthAccess}` })
      .where(and(eq(connections.userId, userId), eq(connections.provider, "outlook")));

    // Seed an email source and mail sender whose lastError holds a secret.
    const [wf] = await db.insert(workflows).values({ userId, name: "Audit", slug: `audit-${seq}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {}, published: true }).returning();
    const [r] = await db.insert(runs).values({
      workflowVersionId: v!.id,
      state: "failed",
      triggerPayload: { note: secretVal, oauth: oauthRefresh },
      error: `run failed with ${secretVal}`,
    }).returning();
    const [step] = await db.insert(stepRuns).values({
      runId: r!.id,
      stepId: "approve",
      attempt: 1,
      state: "waiting",
      input: { message: `Please approve request ${secretVal} (${encodeURIComponent(secretVal)}) ${oauthAccess}` },
      output: { body: oauthRefresh },
      error: `step err ${secretVal}`,
    }).returning();

    const approval = (await createApproval(db, step!.id, new Date(Date.now() + 600_000)))!;
    await db.insert(requests).values({
      userId,
      workflowId: wf!.id,
      runId: r!.id,
      reference: `REQ-AUD${seq}`,
      submissionKey: randomUUID(),
      subject: `Invoice ${secretVal} / ${oauthAccess}`,
      requestedBy: userId,
    });
    await db.insert(deliveries).values({
      userId,
      runId: r!.id,
      stepId: "notify",
      provider: "slack",
      reference: `REF-${secretVal}-${oauthAccess}`,
      payload: { text: secretVal },
      state: "failed",
      errorKind: "permission",
      lastError: `slack refused ${secretVal}`,
      result: { info: oauthRefresh },
    });
    const imapEnc = encryptSecret(key, userId, `imap:${wf!.id}`, "imap-pass");
    await db.insert(emailSources).values({
      workflowId: wf!.id,
      host: "imap.office.example",
      username: "inbox@office.example",
      folder: "INBOX",
      ...imapEnc,
      status: "failed",
      lastError: `imap refused ${secretVal} and ${oauthAccess}`,
    });
    const gmailEnc = encryptSecret(key, userId, "gmail_app_password", "app-pass");
    await db.insert(mailSenders).values({
      userId,
      address: "echo-error@test.local",
      status: "active",
      authMethod: "app_password",
      passwordCiphertext: gmailEnc.ciphertext,
      passwordIv: gmailEnc.iv,
      passwordAuthTag: gmailEnc.authTag,
      verifiedAt: new Date(),
      lastError: `smtp refused ${secretVal} and ${oauthAccess}`,
    });
    const [res] = await db.insert(resources).values({ userId, name: "Room A" }).returning();
    await db.insert(bookings).values({
      userId,
      test: false,
      reference: `BK-AUD${seq}`,
      resourceId: res!.id,
      during: sql`tstzrange(now() + interval '1 day', now() + interval '25 hours')` as unknown as string,
      timezone: "UTC",
      workflowId: wf!.id,
      runId: r!.id,
    });

    if (!app.getHttpServer().listening) await app.listen(0, "127.0.0.1");
    const token = ((await agent.post("/tokens").send({ name: "audit-mcp", scopes: ["read"] }).expect(201)).body as { token: string }).token;
    const client = new Client({ name: "audit-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );

    const checkAll = async (stage: string) => {
      echoSmtpSecret = secretVal;
      const surfaces: Record<string, string> = {
        approvalPage: (await request(server).get(`/approvals/${approval.token}`).expect(200)).text,
        workflowRequests: (await agent.get(`/workflows/${wf!.id}/requests`).expect(200)).text,
        myRequests: (await agent.get("/my/requests").expect(200)).text,
        deliveries: (await agent.get(`/deliveries?runId=${r!.id}`).expect(200)).text,
        connections: (await agent.get("/settings/connections").expect(200)).text,
        emailSource: (await agent.get(`/workflows/${wf!.id}/email-source`).expect(200)).text,
        emailSettings: (await agent.get("/settings/email").expect(200)).text,
        emailTest: (await agent.post("/settings/email/test").expect(200)).text,
        runsList: (await agent.get("/runs").expect(200)).text,
        runDetail: (await agent.get(`/runs/${r!.id}`).expect(200)).text,
        runsCsv: (await agent.get(`/runs/export.csv?workflowId=${wf!.id}`).expect(200)).text,
        bookingsList: (await agent.get("/bookings").expect(200)).text,
        bookingsCsv: (await agent.get("/bookings/export.csv").expect(200)).text,
        mcpRunStatus: JSON.stringify(await client.callTool({ name: "get_run_status", arguments: { runId: r!.id } })),
        mcpBookings: JSON.stringify(await client.callTool({ name: "list_bookings", arguments: {} })),
      };
      const mustHide = [...forms(secretVal), oauthAccess, oauthRefresh];
      for (const [name, body] of Object.entries(surfaces)) {
        const found = mustHide.filter((f) => body.includes(f) || body.includes(JSON.stringify(f).slice(1, -1)));
        expect(found, `${stage}: ${name} leaked secret forms`).toEqual([]);
      }
      expect(surfaces.approvalPage).toContain("[secret]");
      expect(surfaces.workflowRequests).toContain("[secret]");
      expect(surfaces.myRequests).toContain("[secret]");
      expect(surfaces.deliveries).toContain("[secret]");
      expect(surfaces.connections).toContain("[secret]");
      expect(surfaces.emailSource).toContain("[secret]");
      expect(surfaces.emailSettings).toContain("[secret]");
      expect(surfaces.emailTest).toContain("[secret]");
    };

    try {
      await checkAll("current");
      await agent.put("/secrets/audit_key").send({ value: "rotated-value" }).expect(204);
      await checkAll("rotated");
      await agent.delete("/secrets/audit_key").expect(204);
      await checkAll("deleted");

      // Connection test live error redaction: provider echoes both the retired secret and the refresh token.
      fake.once("/me/sendMail", { status: 400, body: { error: { code: "ErrorInvalidRequest", message: `echo ${secretVal} and ${oauthRefresh}` } } });
      const testOut = (await agent.post("/settings/connections/outlook/test").expect(200)).text;
      expect(testOut).not.toContain(secretVal);
      expect(testOut).not.toContain(oauthRefresh);
      expect(testOut).toContain("[secret]");

      // Age the retired secret past 90 days and run the scrub-then-delete purge: zero retired_secrets remain,
      // yet every read surface still shows [secret] and never leaks any form of secretVal.
      await db
        .update(retiredSecrets)
        .set({ retiredAt: new Date(Date.now() - 91 * 86_400_000) })
        .where(eq(retiredSecrets.userId, userId));
      const purged = await purgeRetiredSecrets(db, key);
      expect(purged.retiredDeleted).toBeGreaterThanOrEqual(2);
      expect(purged.rowsScrubbed).toBeGreaterThanOrEqual(6);
      expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, userId))).toEqual([]);

      // Re-verify all stored read surfaces after retired_secrets is empty (exclude live SMTP echo since secretVal is purged).
      echoSmtpSecret = "unrelated";
      const afterPurge: Record<string, string> = {
        approvalPage: (await request(server).get(`/approvals/${approval.token}`).expect(200)).text,
        workflowRequests: (await agent.get(`/workflows/${wf!.id}/requests`).expect(200)).text,
        myRequests: (await agent.get("/my/requests").expect(200)).text,
        deliveries: (await agent.get(`/deliveries?runId=${r!.id}`).expect(200)).text,
        connections: (await agent.get("/settings/connections").expect(200)).text,
        emailSource: (await agent.get(`/workflows/${wf!.id}/email-source`).expect(200)).text,
        emailSettings: (await agent.get("/settings/email").expect(200)).text,
        runsList: (await agent.get("/runs").expect(200)).text,
        runDetail: (await agent.get(`/runs/${r!.id}`).expect(200)).text,
        runsCsv: (await agent.get(`/runs/export.csv?workflowId=${wf!.id}`).expect(200)).text,
        mcpRunStatus: JSON.stringify(await client.callTool({ name: "get_run_status", arguments: { runId: r!.id } })),
      };
      for (const [name, body] of Object.entries(afterPurge)) {
        const found = forms(secretVal).filter((f) => body.includes(f) || body.includes(JSON.stringify(f).slice(1, -1)));
        expect(found, `post-purge: ${name} leaked secret forms`).toEqual([]);
        expect(body, `post-purge: ${name} lost [secret] marker`).toContain("[secret]");
      }
    } finally {
      echoSmtpSecret = undefined;
      await client.close();
    }
  });
});

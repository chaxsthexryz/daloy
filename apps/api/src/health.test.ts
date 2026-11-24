import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { createErrorReporter } from "@daloy/engine";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { ErrorReportFilter } from "./health";

let app: INestApplication;
let boss: PgBoss;
let pool: Pool;
let server: Parameters<typeof request>[0];

beforeAll(async () => {
  const { url, db, pool: p } = await freshDatabase();
  pool = p;
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

describe("health check & error reporting (A2)", () => {
  it("answers GET /health with 200 ok when the database responds", async () => {
    const res = await request(server).get("/health").expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("reports unexpected 5xx exceptions to the configured DSN while ignoring 4xx", async () => {
    const events: Record<string, unknown>[] = [];
    const sink = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        events.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" }).end('{"id":"1"}');
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const port = (sink.address() as AddressInfo).port;

    @Controller("boom")
    class BoomController {
      @Get()
      boom() {
        throw new Error("boom with https://secret.test?token=123");
      }
    }

    @Module({
      controllers: [BoomController],
      providers: [{
        provide: APP_FILTER,
        useValue: new ErrorReportFilter(createErrorReporter({ dsn: `http://k@127.0.0.1:${port}/1`, service: "api", environment: "test" })),
      }],
    })
    class BoomModule {}

    const mini = await NestFactory.create(BoomModule, { logger: false });
    await mini.init();

    try {
      await request(mini.getHttpServer()).get("/missing-route").expect(404);
      expect(events).toHaveLength(0);

      const errRes = await request(mini.getHttpServer()).get("/boom").expect(500);
      expect(errRes.body).toEqual({ statusCode: 500, message: "Internal server error" });
      await new Promise((r) => setTimeout(r, 150));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tags: { service: "api", method: "GET", path: "/boom" },
        exception: { values: [{ type: "Error", value: "boom with https://secret.test/" }] },
      });
    } finally {
      await mini.close();
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });
});

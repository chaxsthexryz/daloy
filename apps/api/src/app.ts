import "reflect-metadata";
import { RUN_QUEUE, RUN_QUEUE_OPTIONS, SCHEDULE_QUEUE, type Db } from "@daloy/db";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { PgBoss } from "pg-boss";
import { ApprovalsController } from "./approvals";
import { AuthController, SessionGuard } from "./auth";
import { BOSS, CONFIG, DB, RateLimit, type ApiConfig } from "./http";
import { McpController } from "./mcp";
import { FormsController, HooksController } from "./public";
import { RunsController } from "./runs";
import { SecretsController } from "./secrets";
import { TokensController } from "./tokens";
import { CatalogController, WorkflowsController } from "./workflows";

export type AppOptions = ApiConfig & { db: Db; boss: PgBoss };

/** Builds the Nest app without listening, so tests can drive it with supertest. */
export async function createApp({ db, boss, ...config }: AppOptions) {
  if (config.secretsKey.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64 encoded");
  await boss.createQueue(RUN_QUEUE, RUN_QUEUE_OPTIONS);
  await boss.createQueue(SCHEDULE_QUEUE);

  @Module({
    controllers: [AuthController, WorkflowsController, CatalogController, SecretsController, TokensController, RunsController, HooksController, FormsController, ApprovalsController, McpController],
    providers: [
      { provide: DB, useValue: db },
      { provide: BOSS, useValue: boss },
      { provide: CONFIG, useValue: config },
      // Default limit for every route; login, forms, webhooks and approvals add stricter ones.
      { provide: APP_GUARD, useClass: RateLimit(120) },
      SessionGuard,
    ],
  })
  class AppModule {}

  // rawBody keeps the exact bytes for webhook signature checks.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: ["error", "warn"] });
  app.useBodyParser("json", { limit: "256kb" });
  app.useBodyParser("urlencoded", { limit: "64kb", extended: false });
  app.use(helmet());
  app.use(cookieParser());
  return app;
}

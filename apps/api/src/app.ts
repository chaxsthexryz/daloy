import "reflect-metadata";
import { mailDeps, providerUrls, RUN_QUEUE, RUN_QUEUE_OPTIONS, SCHEDULE_QUEUE, type Db } from "@daloy/db";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { PgBoss } from "pg-boss";
import { AiDraftController } from "./ai-draft";
import { ApprovalsController } from "./approvals";
import { AuthController, SessionGuard } from "./auth";
import { ConnectionsController, DeliveriesController } from "./connections";
import { EmailSettingsController } from "./email-settings";
import { BOSS, CONFIG, DB, RateLimit, type ApiConfig } from "./http";
import { McpController } from "./mcp";
import { MembersController, MyRequestsController } from "./members";
import { FormsController, HooksController } from "./public";
import { RunsController } from "./runs";
import { SecretsController } from "./secrets";
import { SettingsController } from "./settings";
import { TokensController } from "./tokens";
import { CatalogController, WorkflowsController } from "./workflows";

export type AppOptions = ApiConfig & { db: Db; boss: PgBoss };

/** Builds the Nest app without listening, so tests can drive it with supertest. */
export async function createApp({ db, boss, ...config }: AppOptions) {
  if (config.secretsKey.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64 encoded");
  await boss.createQueue(RUN_QUEUE, RUN_QUEUE_OPTIONS);
  await boss.createQueue(SCHEDULE_QUEUE);

  @Module({
    controllers: [AuthController, WorkflowsController, CatalogController, SecretsController, TokensController, RunsController, HooksController, FormsController, ApprovalsController, McpController, SettingsController, EmailSettingsController, ConnectionsController, DeliveriesController, AiDraftController, MembersController, MyRequestsController],
    providers: [
      { provide: DB, useValue: db },
      { provide: BOSS, useValue: boss },
      { provide: CONFIG, useValue: { ...config, mail: config.mail ?? mailDeps(), providers: config.providers ?? providerUrls(), publicUrl: (config.publicUrl ?? process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "") } },
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

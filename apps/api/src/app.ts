import "reflect-metadata";
import { mailDeps, providerUrls, RUN_QUEUE, RUN_QUEUE_OPTIONS, SCHEDULE_QUEUE, type Db } from "@daloy/db";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import type { RequestHandler } from "express";
import helmet from "helmet";
import type { PgBoss } from "pg-boss";
import { AiChatController } from "./ai-chat";
import { AiDraftController } from "./ai-draft";
import { ApprovalsController } from "./approvals";
import { AuthController, SessionGuard } from "./auth";
import { ConnectionsController, DeliveriesController, OutlookCallbackController } from "./connections";
import { EmailSettingsController } from "./email-settings";
import { EmailSourceController } from "./email-source";
import { BOSS, CONFIG, DB, RateLimit, type ApiConfig } from "./http";
import { McpController } from "./mcp";
import { LanguageController } from "./language";
import { MembersController, MyRequestsController } from "./members";
import { FormsController, HooksController, isFormEmbed, PaymongoHooksController } from "./public";
import { RunsController } from "./runs";
import { BrandController, BrandLogoController } from "./brand";
import { BookingsController } from "./bookings";
import { ResourcesController } from "./resources";
import { SecretsController } from "./secrets";
import { SettingsController } from "./settings";
import { TokensController } from "./tokens";
import { UsageController } from "./usage";
import { CatalogController, WorkflowsController } from "./workflows";

export type AppOptions = ApiConfig & { db: Db; boss: PgBoss };

/** Builds the Nest app without listening, so tests can drive it with supertest. */
export async function createApp({ db, boss, ...config }: AppOptions) {
  if (config.secretsKey.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64 encoded");
  await boss.createQueue(RUN_QUEUE, RUN_QUEUE_OPTIONS);
  await boss.createQueue(SCHEDULE_QUEUE);

  @Module({
    controllers: [AuthController, WorkflowsController, CatalogController, SecretsController, ResourcesController, BookingsController, TokensController, RunsController, HooksController, PaymongoHooksController, FormsController, ApprovalsController, McpController, SettingsController, LanguageController, EmailSettingsController, EmailSourceController, ConnectionsController, OutlookCallbackController, DeliveriesController, AiDraftController, AiChatController, MembersController, MyRequestsController, UsageController, BrandController, BrandLogoController],
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
  // Hop count, not true: trusting every X-Forwarded-For entry would let a client pick its own rate-limit bucket.
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  app.useBodyParser("json", { limit: "256kb" });
  app.useBodyParser("urlencoded", { limit: "64kb", extended: false });
  const standardHeaders = helmet();
  const embedHeaders = helmet({
    xFrameOptions: false,
    contentSecurityPolicy: { directives: { frameAncestors: ["'self'", "https:", "http:"] } },
  });
  const headers: RequestHandler = (req, res, next) =>
    (isFormEmbed(req.path) ? embedHeaders : standardHeaders)(req, res, next);
  app.use(headers);
  app.use(cookieParser());
  return app;
}

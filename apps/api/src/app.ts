import "reflect-metadata";
import { mailDeps, OAUTH_PROVIDERS, providerUrls, RUN_QUEUE, RUN_QUEUE_OPTIONS, SCHEDULE_QUEUE, type Db } from "@daloy/db";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import type { RequestHandler } from "express";
import helmet from "helmet";
import type { PgBoss } from "pg-boss";
import { AdminController } from "./admin";
import { AdminPageController, hideAdminHtml } from "./admin-page";
import { AdminFeedbackController, SupportFeedbackController } from "./feedback";
import { AiChatController } from "./ai-chat";
import { AiDraftController } from "./ai-draft";
import { ApprovalsController } from "./approvals";
import { AuthController, SessionGuard } from "./auth";
import { ConnectionsController, DeliveriesController } from "./connections";
import { OAuthCallbackController, OAuthStartController } from "./oauth";
import { consoleHeaders, GoogleController, GoogleTriggersController } from "./google";
import { MailboxTriggersController } from "./mailbox-triggers";
import { GoogleCalendarController } from "./google-calendar";
import { MonitorTriggersController } from "./monitor";
import { EmailSettingsController } from "./email-settings";
import { EmailSourceController } from "./email-source";
import { EventHub, EventsController, NotificationPrefsController } from "./events";
import { BOSS, CONFIG, DB, RateLimit, type ApiConfig } from "./http";
import { KnowledgeController } from "./knowledge";
import { McpController } from "./mcp";
import { DigestController } from "./digest";
import { LanguageController } from "./language";
import { MembersController, MyRequestsController } from "./members";
import { createErrorReporter, parseSentryDsn } from "@daloy/engine";
import { PausedFilter } from "./paused";
import { ErrorReportFilter, HealthController } from "./health";
import { ConversationsController } from "./conversations";
import { HomeController } from "./home";
import { InboxController } from "./inbox";
import { DiscordHooksController, FormsController, HooksController, isFormEmbed, MetaHooksController, PaymongoHooksController, PublicAssetsController, ShopifyHooksController, SlackHooksController, TeamsHooksController, TelegramHooksController, WhatsAppHooksController } from "./public";
import { RunsController } from "./runs";
import { BrandController, BrandLogoController } from "./brand";
import { OnboardingController } from "./onboarding";
import { BookingsController } from "./bookings";
import { PayPageController, PaymentsController } from "./payments";
import { PrivacyController } from "./privacy";
import { ResourcesController } from "./resources";
import { SecretsController } from "./secrets";
import { SettingsController } from "./settings";
import { AirtableOAuthController } from "./oauth-airtable";
import { NotionOAuthController } from "./oauth-notion";
import { RecordTriggersController } from "./oauth-records";
import { TrelloOAuthController } from "./oauth-trello";
import { TokensController } from "./tokens";
import { UsageController } from "./usage";
import { CatalogController, WorkflowsController } from "./workflows";

export type AppOptions = ApiConfig & { db: Db; boss: PgBoss };

const GLOBAL_RATE_LIMIT = Number(process.env.GLOBAL_RATE_LIMIT_PER_MINUTE || 120);
if (!Number.isInteger(GLOBAL_RATE_LIMIT) || GLOBAL_RATE_LIMIT < 1) {
  throw new Error("GLOBAL_RATE_LIMIT_PER_MINUTE must be a whole number above 0");
}

/** Builds the Nest app without listening, so tests can drive it with supertest. */
export async function createApp({ db, boss, ...config }: AppOptions) {
  if (config.secretsKey.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64 encoded");
  await boss.createQueue(RUN_QUEUE, RUN_QUEUE_OPTIONS);
  await boss.createQueue(SCHEDULE_QUEUE);

  const reporter = createErrorReporter({ dsn: config.sentryDsn, service: "api", environment: config.sentryEnvironment });
  const webSentry = parseSentryDsn(config.webSentryDsn);

  @Module({
    controllers: [AuthController, AdminController, AdminPageController, AdminFeedbackController, SupportFeedbackController, HealthController, ConversationsController, HomeController, InboxController, WorkflowsController, CatalogController, SecretsController, ResourcesController, BookingsController, PaymentsController, PayPageController, PrivacyController, TokensController, RunsController, HooksController, PaymongoHooksController, MetaHooksController, WhatsAppHooksController, ShopifyHooksController, TelegramHooksController, SlackHooksController, TeamsHooksController, DiscordHooksController, FormsController, PublicAssetsController, ApprovalsController, McpController, SettingsController, LanguageController, DigestController, EmailSettingsController, EmailSourceController, ConnectionsController, OAuthStartController, OAuthCallbackController, GoogleController, GoogleTriggersController, MailboxTriggersController, GoogleCalendarController, MonitorTriggersController, AirtableOAuthController, NotionOAuthController, TrelloOAuthController, RecordTriggersController, DeliveriesController, AiDraftController, AiChatController, MembersController, MyRequestsController, UsageController, BrandController, BrandLogoController, OnboardingController, KnowledgeController, EventsController, NotificationPrefsController],
    providers: [
      { provide: DB, useValue: db },
      { provide: BOSS, useValue: boss },
      { provide: CONFIG, useValue: { ...config, mail: config.mail ?? mailDeps(), providers: config.providers ?? providerUrls(), oauthProviders: config.oauthProviders ?? OAUTH_PROVIDERS, publicUrl: (config.publicUrl ?? process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "") } },
      // Default limit for every route; login, forms, webhooks and approvals add stricter ones.
      { provide: APP_GUARD, useClass: RateLimit(GLOBAL_RATE_LIMIT) },
      { provide: APP_FILTER, useValue: new ErrorReportFilter(reporter) },
      { provide: APP_FILTER, useClass: PausedFilter },
      SessionGuard,
      EventHub,
    ],
  })
  class AppModule {}

  // rawBody keeps the exact bytes for webhook signature checks.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: ["error", "warn"] });
  // Hop count, not true: trusting every X-Forwarded-For entry would let a client pick its own rate-limit bucket.
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  app.useBodyParser("json", { limit: "256kb" });
  app.useBodyParser("urlencoded", { limit: "64kb", extended: false });
  // The console policy gains the Google Picker hosts only when the Picker is set up (decision 0060).
  const standardHeaders = helmet(consoleHeaders(config.providers ?? providerUrls(), webSentry ? [webSentry.origin] : []));
  const embedHeaders = helmet({
    xFrameOptions: false,
    contentSecurityPolicy: { directives: { frameAncestors: ["'self'", "https:", "http:"] } },
  });
  const headers: RequestHandler = (req, res, next) =>
    (isFormEmbed(req.path) ? embedHeaders : standardHeaders)(req, res, next);
  app.use(headers);
  app.use(cookieParser());
  // The built console (apps/web/dist), from the API's origin so the session cookie needs no CORS. It uses hash routes, so
  // index.html at / is enough. admin.html is only served by the guarded /admin route (decision 0152).
  if (config.webDist) {
    app.use(hideAdminHtml);
    app.useStaticAssets(config.webDist);
  }
  return app;
}

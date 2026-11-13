import { sql } from "drizzle-orm";
import { RUN_STATES, STEP_STATES } from "@daloy/engine";
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const runState = pgEnum("run_state", RUN_STATES);
export const stepState = pgEnum("step_state", STEP_STATES);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  // SHA-256 of the cookie value, so a database leak does not leak live sessions.
  idHash: text("id_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

export const workflows = pgTable(
  "workflows",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // Guided setup progress ({ template, step, answers }) for workflows made from a guided template. Null for the others.
    setup: jsonb("setup"),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.userId, t.slug)],
);

/** Immutable: a change to a workflow is a new row with the next version number. */
export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: id(),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(),
    published: boolean("published").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.workflowId, t.version)],
);

export const triggers = pgTable("triggers", {
  id: id(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  config: jsonb("config").notNull().default({}),
  // Random 32-byte path for webhook triggers, null for the others.
  webhookPath: text("webhook_path").unique(),
  createdAt: createdAt(),
});

export const runs = pgTable("runs", {
  id: id(),
  workflowVersionId: uuid("workflow_version_id").notNull().references(() => workflowVersions.id, { onDelete: "cascade" }),
  state: runState("state").notNull().default("pending"),
  triggerPayload: jsonb("trigger_payload").notNull().default({}),
  // Test runs come from the builder. Unless live is set, the worker mocks steps that reach outside (http, email).
  test: boolean("test").notNull().default(false),
  live: boolean("live").notNull().default(false),
  error: text("error"),
  // Lease: the worker that holds it renews it with a heartbeat. An expired lease means the run can be resumed.
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: ts("lease_expires_at"),
  // Set while a retry waits for its backoff delay, so a resumed run does not retry early.
  nextAttemptAt: ts("next_attempt_at"),
  createdAt: createdAt(),
  finishedAt: ts("finished_at"),
});

/** One row per step attempt. The unique key is the idempotency key, so an attempt can never be recorded twice. */
export const stepRuns = pgTable(
  "step_runs",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    attempt: integer("attempt").notNull(),
    state: stepState("state").notNull().default("pending"),
    // The resolved config the attempt ran with, secrets redacted by the worker. Run history shows it.
    input: jsonb("input"),
    output: jsonb("output"),
    branch: text("branch"),
    error: text("error"),
    // True when a retryable error used up every attempt. The API lists these as the dead-letter list.
    deadLetter: boolean("dead_letter").notNull().default(false),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [unique().on(t.runId, t.stepId, t.attempt)],
);

export const approvals = pgTable("approvals", {
  id: id(),
  stepRunId: uuid("step_run_id").notNull().references(() => stepRuns.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  decision: text("decision"),
  createdAt: createdAt(),
});

/** AES-256-GCM. The key comes from an env var and never touches the database. Base64 fields. */
export const secrets = pgTable(
  "secrets",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.userId, t.name)],
);

export const apiTokens = pgTable("api_tokens", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
});

/** The AI model a user picked in the console. No row: the env vars decide (LLM_PROVIDER, LLM_BASE_URL, LLM_MODEL). */
export const aiSettings = pgTable("ai_settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  preset: text("preset").notNull(),
  model: text("model").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** One API key per user and hosted provider, encrypted like secrets, so switching providers never loses a key. */
export const aiKeys = pgTable(
  "ai_keys",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    preset: text("preset").notNull(),
    keyCiphertext: text("key_ciphertext").notNull(),
    keyIv: text("key_iv").notNull(),
    keyAuthTag: text("key_auth_tag").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.preset] })],
);

/**
 * One row per live submission of a guided office request form. The run carries the reference in its trigger payload.
 * The unique submission key per form makes a double-click or a phone retry return the first request instead of a new one.
 */
export const requests = pgTable(
  "requests",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    reference: text("reference").notNull().unique(),
    submissionKey: uuid("submission_key").notNull(),
    subject: text("subject").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.workflowId, t.submissionKey)],
);

/** What the owner tells Daloy about their business. Used in templates, the hosted form and the From and Reply-To headers. */
export const businessProfiles = pgTable("business_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  businessName: text("business_name"),
  website: text("website"),
  inquiryEmail: text("inquiry_email"),
  replyTo: text("reply_to"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * The owner's own Gmail sender. No row: mail goes through the installation's SMTP server (SMTP_* env vars).
 * Any other status than active blocks sending, and nothing ever falls back to another sender (decision 0020).
 * The app password is encrypted like secrets; disconnecting deletes it. Only the SHA-256 of the verify link is stored.
 */
export const mailSenders = pgTable("mail_senders", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  status: text("status", { enum: ["unverified", "active", "failed", "disconnected"] }).notNull(),
  passwordCiphertext: text("password_ciphertext"),
  passwordIv: text("password_iv"),
  passwordAuthTag: text("password_auth_tag"),
  verifyTokenHash: text("verify_token_hash").unique(),
  verifyExpiresAt: ts("verify_expires_at"),
  verifiedAt: ts("verified_at"),
  lastError: text("last_error"),
  lastTestedAt: ts("last_tested_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [check("mail_senders_status", sql`${t.status} in ('unverified', 'active', 'failed', 'disconnected')`)]);

export const PROVIDERS = ["google_sheets", "slack"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * An owner's Google Sheets or Slack connection (roadmap phase 3, decision 0021). One per owner and provider. The
 * credential (service account key or bot token) is encrypted like secrets, with the owner and provider bound in.
 * destination is where deliveries go: { spreadsheetId, tab, title } or { channelId, channelName }. Deleting the row
 * disconnects; queued deliveries then fail with "not connected" and wait for Retry.
 */
export const connections = pgTable(
  "connections",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    status: text("status", { enum: ["active", "failed"] }).notNull(),
    account: text("account").notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    credentialIv: text("credential_iv").notNull(),
    credentialAuthTag: text("credential_auth_tag").notNull(),
    destination: jsonb("destination").$type<Record<string, string>>(),
    lastError: text("last_error"),
    lastTestedAt: ts("last_tested_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.provider] }),
    check("connections_provider", sql`${t.provider} in ('google_sheets', 'slack')`),
    check("connections_status", sql`${t.status} in ('active', 'failed')`),
  ],
);

export const DELIVERY_STATES = ["queued", "sending", "delivered", "needs_review", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * One Sheets row or Slack message a run asked for, delivered by the worker apart from the run (decision 0021).
 * One per run and step, so a step re-run never queues a second one. payload is what gets sent (secrets already
 * redacted), fixed at queue time. checkFirst: an earlier call may have reached the provider, so look before sending.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    reference: text("reference").notNull(),
    payload: jsonb("payload").$type<{ row: string[] } | { text: string }>().notNull(),
    state: text("state", { enum: DELIVERY_STATES }).notNull().default("queued"),
    checkFirst: boolean("check_first").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    result: jsonb("result").$type<Record<string, string | boolean>>(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.runId, t.stepId),
    // The worker polls for due deliveries every couple of seconds.
    index("deliveries_due").on(t.nextAttemptAt).where(sql`${t.state} in ('queued', 'sending')`),
    check("deliveries_state", sql`${t.state} in ('queued', 'sending', 'delivered', 'needs_review', 'failed')`),
    check("deliveries_provider", sql`${t.provider} in ('google_sheets', 'slack')`),
  ],
);

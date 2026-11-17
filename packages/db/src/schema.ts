import { sql } from "drizzle-orm";
import { LANGUAGES, RUN_STATES, STEP_STATES } from "@daloy/engine";
import { bigint, boolean, check, customType, date, index, integer, jsonb, pgEnum, pgSequence, pgTable, primaryKey, text, timestamp, unique, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

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
  // Recipients a day this workspace owner may send through the installation's shared mail server when SHARED_MAIL is
  // "approved". Null: not approved. Only the operator sets it (decision 0024).
  sharedMailDailyLimit: integer("shared_mail_daily_limit"),
  // The plan the operator set; null means none yet (no limits, and no shared AI key). plan_started_on anchors the monthly cycle.
  plan: text("plan"),
  planStartedOn: date("plan_started_on"),
  language: text("language", { enum: LANGUAGES }).notNull().default("en"),
}, (t) => [
  check("users_plan", sql`${t.plan} in ('pilot', 'business', 'business_plus')`),
  check("users_language", sql`${t.language} in ('en', 'tl')`),
]);

/** Metered work per workspace, kind (ai, email, http) and period (a Manila day, or a monthly cycle start). */
export const usageCounts = pgTable(
  "usage_counts",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    period: text("period").notNull(),
    used: integer("used").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.period] })],
);

/** Keys of work already counted, so a retried step is not counted twice. */
export const usageClaims = pgTable(
  "usage_claims",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.key] })],
);

/** Recipients sent through the shared mail server per workspace and UTC day. One row per day, counted atomically. */
export const sharedMailUsage = pgTable(
  "shared_mail_usage",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    sent: integer("sent").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

export const ROLES = ["owner", "operator", "approver", "requester"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Who belongs to which office (roadmap phase 4, decision 0022). A workspace is identified by its owner's user id, so
 * every older `user_id` column already names the workspace. One workspace per account. The owner row is the one where
 * workspace_id = user_id, and the check keeps it that way: nobody else can be made owner and the owner can't be demoted.
 */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("workspace_members_workspace").on(t.workspaceId),
    check("workspace_members_role", sql`${t.role} in ('owner', 'operator', 'approver', 'requester')`),
    check("workspace_members_owner", sql`(${t.role} = 'owner') = (${t.workspaceId} = ${t.userId})`),
  ],
);

/** A one-time link the owner copies to a new member. Only the SHA-256 of the token is stored, as for approval links. */
export const invites = pgTable(
  "invites",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [check("invites_role", sql`${t.role} in ('operator', 'approver', 'requester')`)],
);

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

/** One dedicated mailbox per workflow. Revision and claim fence old checks, polls and disconnected credentials. */
export const emailSources = pgTable("email_sources", {
  id: id(),
  workflowId: uuid("workflow_id").notNull().unique().references(() => workflows.id, { onDelete: "cascade" }),
  host: text("host").notNull(),
  username: text("username").notNull(),
  folder: text("folder").notNull(),
  ciphertext: text("ciphertext"),
  iv: text("iv"),
  authTag: text("auth_tag"),
  revision: uuid("revision").notNull().defaultRandom(),
  mailboxId: uuid("mailbox_id").notNull().defaultRandom(),
  status: text("status").$type<"pending" | "active" | "failed" | "disconnected">().notNull().default("pending"),
  listening: boolean("listening").notNull().default(false),
  uidValidity: text("uid_validity"),
  // IMAP UIDs are unsigned 32-bit values, above PostgreSQL's signed integer range.
  lastUid: bigint("last_uid", { mode: "number" }),
  claimId: uuid("claim_id"),
  claimUntil: ts("claim_until"),
  nextPollAt: ts("next_poll_at").notNull().defaultNow(),
  lastCheckedAt: ts("last_checked_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
}, (t) => [check("email_sources_status", sql`${t.status} in ('pending', 'active', 'failed', 'disconnected')`)]);

export const runs = pgTable("runs", {
  id: id(),
  workflowVersionId: uuid("workflow_version_id").notNull().references(() => workflowVersions.id, { onDelete: "cascade" }),
  state: runState("state").notNull().default("pending"),
  triggerPayload: jsonb("trigger_payload").notNull().default({}),
  // Test runs come from the builder. Unless live is set, the worker mocks steps that reach outside (http, email).
  test: boolean("test").notNull().default(false),
  live: boolean("live").notNull().default(false),
  // An "AI only" test run calls the model and fakes the rest. Choices fix a step's outcome in a faked test run (decision 0028).
  aiLive: boolean("ai_live").notNull().default(false),
  testChoices: jsonb("test_choices"),
  error: text("error"),
  // Lease: the worker that holds it renews it with a heartbeat. An expired lease means the run can be resumed.
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: ts("lease_expires_at"),
  // Set while a retry waits for its backoff delay, so a resumed run does not retry early.
  nextAttemptAt: ts("next_attempt_at"),
  // The booking version this run belongs to. Once the booking moves on, the run stops at its next step (decision 0032).
  bookingId: uuid("booking_id").references((): AnyPgColumn => bookings.id, { onDelete: "set null" }),
  bookingVersion: integer("booking_version"),
  createdAt: createdAt(),
  finishedAt: ts("finished_at"),
});

/**
 * One row per business event a workflow has started a run for (decision 0029). The key comes from the trigger's
 * eventKey or the caller's Idempotency-Key. Test runs have their own scope, so a test never swallows a real event.
 */
export const runKeys = pgTable(
  "run_keys",
  {
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    test: boolean("test").notNull(),
    key: text("key").notNull(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.test, t.key] })],
);

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
    // What a failed outside call may have done: not_sent, rejected, throttled or unknown (decision 0030).
    outcome: text("outcome"),
    // Set by the worker that runs this attempt; it finishes the row only while the claim is still its own.
    claimId: uuid("claim_id"),
    // Set before a send that is not safe to repeat. A worker that takes over a row with it set parks the run for review.
    dispatchedAt: ts("dispatched_at"),
    // The operator who resolved a parked or failed attempt (It went through, Send again, Stop or Retry), and when.
    resolvedBy: text("resolved_by"),
    resolvedAt: ts("resolved_at"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [unique().on(t.runId, t.stepId, t.attempt), check("step_runs_outcome", sql`${t.outcome} in ('not_sent', 'rejected', 'throttled', 'unknown')`)],
);

export const approvals = pgTable("approvals", {
  id: id(),
  stepRunId: uuid("step_run_id").notNull().references(() => stepRuns.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  decision: text("decision"),
  // Set for a named approval: only this member may decide, signed in (decision 0022). Null is a link-holder approval
  // (decision 0009), including every link sent before phase 4. Cascade, never set null, so a named approval can't
  // turn into a link-holder one.
  approverId: uuid("approver_id").references(() => users.id, { onDelete: "cascade" }),
  // Who answered, when they were signed in. The email is kept apart so the record survives the account.
  decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
  decidedByEmail: text("decided_by_email"),
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

/**
 * Earlier values of replaced or deleted secrets, still encrypted exactly as they were. Workflows never read this
 * table: it exists so run history can keep hiding a value after the owner rotates or removes it (decision 0025).
 */
export const retiredSecrets = pgTable("retired_secrets", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  retiredAt: createdAt(),
});

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
    // The member who sent it while signed in; null for the public form and MCP.
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.workflowId, t.submissionKey)],
);

/**
 * Things a booking is for: a therapist, a room, a table (decision 0031). A resource field takes an active one's id.
 * There is no delete: runs and bookings keep pointing at the id, so a resource is archived (active false) instead.
 */
export const resources = pgTable(
  "resources",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.userId, t.name)],
);

/** A Postgres tstzrange in its text form. Read it with lower() and upper(). */
const tstzrange = customType<{ data: string }>({ dataType: () => "tstzrange" });

/**
 * A booked time for a resource (decision 0032). Migration 0019 adds the exclusion constraint drizzle cannot express:
 * no two active bookings of one workspace, test scope and resource overlap. That constraint is the only availability
 * check. Every change raises version, and runs linked to an older version stop at their next step.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    test: boolean("test").notNull(),
    reference: text("reference").notNull(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id),
    during: tstzrange("during").notNull(),
    timezone: text("timezone").notNull(),
    status: text("status", { enum: ["active", "cancelled"] }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
    // The run linked to the current version: the one that made the booking or its last change.
    runId: uuid("run_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.userId, t.reference), check("bookings_status", sql`${t.status} in ('active', 'cancelled')`)],
);

/** What a booking step did, written with the change itself, so a retried or taken-over attempt never books twice. */
export const bookingResults = pgTable(
  "booking_results",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    output: jsonb("output").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.stepId] })],
);

/**
 * Every change to a booking, one per version it moved from. The primary key lets a version change once, so a staff or
 * MCP request repeated after a lost answer finds its own change and gets the same result (decision 0032).
 */
export const bookingChanges = pgTable(
  "booking_changes",
  {
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    fromVersion: integer("from_version").notNull(),
    action: text("action").notNull(),
    start: ts("start"),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    actor: text("actor").notNull(),
    result: jsonb("result").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.fromVersion] })],
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

export const PROVIDERS = ["google_sheets", "slack", "outlook", "teams", "telegram", "google_calendar", "paymongo", "airtable", "notion", "trello"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * An owner's Google Sheets, Slack, Outlook or Teams connection (roadmap phases 3 and 5, decisions 0021 and 0023). One per owner and provider. The
 * credential (service account key or bot token) is encrypted like secrets, with the owner and provider bound in.
 * destination is where deliveries go: { spreadsheetId, tab, title }, { channelId, channelName }, { chatId, chatTitle } (Telegram), { baseId, tableId } (Airtable), { databaseId, databaseTitle, titleProperty } (Notion), { listId, listName } (Trello), { mailbox } (Outlook)
 * or { channelName } (Teams, where the channel is fixed by the workflow URL). Deleting the row
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
    check("connections_provider", sql`${t.provider} in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello')`),
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
/** Sheets developer metadata ids: positive 32-bit integers, unique per installation and so within any spreadsheet. */
export const sheetMetaSeq = pgSequence("sheet_meta_seq", { startWith: 1, minValue: 1, maxValue: 2147483647 });

export const deliveries = pgTable(
  "deliveries",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    reference: text("reference").notNull(),
    payload: jsonb("payload").$type<{ row: string[] } | { bookingId: string } | { text: string } | { fields?: Record<string, string>; title?: string; name?: string; desc?: string } | { to: string; subject: string; text: string }>().notNull(),
    state: text("state", { enum: DELIVERY_STATES }).notNull().default("queued"),
    checkFirst: boolean("check_first").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    result: jsonb("result").$type<Record<string, string | boolean>>(),
    lastError: text("last_error"),
    // What the last failure was, as a closed value (decision 0039), so explanations never need the error text.
    errorKind: text("error_kind"),
    // The connection's account and destination when the delivery was queued. Null: queued before pinning existed.
    pinnedAccount: text("pinned_account"),
    pinnedDestination: jsonb("pinned_destination").$type<Record<string, string>>(),
    // Sheets only: the developer metadata id and value that make the write happen once at Google (decision 0021).
    sheetMetaId: integer("sheet_meta_id"),
    sheetMetaValue: text("sheet_meta_value"),
    sheetMetaClearedAt: ts("sheet_meta_cleared_at"),
    // Set, and never cleared, once any attempt may still have a request in flight: an ambiguous answer, or a claim taken
    // back from a worker that died mid-call. Such a marker is never deleted (decision 0021).
    sheetMarkerUncertain: boolean("sheet_marker_uncertain").notNull().default(false),
    // A new random id per claim, never reused: only the worker holding the current claim may record an outcome.
    claimId: uuid("claim_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.runId, t.stepId),
    // The worker polls for due deliveries every couple of seconds.
    index("deliveries_due").on(t.nextAttemptAt).where(sql`${t.state} in ('queued', 'sending')`),
    check("deliveries_state", sql`${t.state} in ('queued', 'sending', 'delivered', 'needs_review', 'failed')`),
    check("deliveries_provider", sql`${t.provider} in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello')`),
  ],
);

/**
 * A booking that has a Google Calendar event (decision 0043). The calendar step writes it with the event's title and
 * description; from then on every change to the booking queues a sync delivery. The event id is derived from booking_id,
 * so no id is stored.
 */
export const calendarEvents = pgTable("calendar_events", {
  bookingId: uuid("booking_id").primaryKey().references(() => bookings.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const PAYMENT_STATES = ["pending", "paid", "refunded", "needs_review"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/** One PayMongo checkout link a run created. Moves pending -> paid -> refunded, only forward; an amount mismatch parks it in needs_review. */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    reference: text("reference").notNull(),
    amountCentavos: integer("amount_centavos").notNull(),
    currency: text("currency").notNull().default("PHP"),
    livemode: boolean("livemode").notNull(),
    providerSessionId: text("provider_session_id").notNull().unique(),
    url: text("url").notNull(),
    status: text("status", { enum: PAYMENT_STATES }).notNull().default("pending"),
    providerPaymentId: text("provider_payment_id"),
    paidAt: ts("paid_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.runId, t.stepId),
    index("payments_provider_payment").on(t.providerPaymentId),
    check("payments_amount", sql`${t.amountCentavos} > 0`),
    check("payments_status", sql`${t.status} in ('pending', 'paid', 'refunded', 'needs_review')`),
  ],
);

/** PayMongo webhook events already handled, so a redelivered event does nothing twice. */
export const paymongoEvents = pgTable("paymongo_events", {
  eventId: text("event_id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

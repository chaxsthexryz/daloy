import {
  emailSources,
  googleTriggerStatus,
  isGoogleTrigger,
  isMailboxTrigger,
  isRecordTrigger,
  mailboxTriggerStatus,
  PLANS,
  PROVIDER_NAMES,
  readConnections,
  readKnowledge,
  recordTriggerStatus,
  resources,
  secrets,
  SMS_NOT_SET_UP,
  unismsConfig,
  usageSummary,
  workspaceMembers,
  users,
  workflows,
  workflowVersions,
  type Db,
  type Provider,
} from "@daloy/db";
import { configProblems, type Language, type ReadinessBlocker, type ReadinessReport, type Trigger, type WorkflowDefinition } from "@daloy/engine";
import { CronExpressionParser } from "cron-parser";
import { and, eq, inArray, sql } from "drizzle-orm";

/** Step types whose connection must be working before the workflow is turned on. */
export const CHECKED_PROVIDERS: Partial<Record<string, Provider>> = {
  sheets: "google_sheets",
  slack: "slack",
  outlook: "outlook",
  teams: "teams",
  discord: "discord",
  telegram: "telegram",
  calendar: "google_calendar",
  airtable: "airtable",
  notion: "notion",
  trello: "trello",
  meta_reply: "meta_messenger",
  whatsapp_reply: "whatsapp",
  shopify_create_product: "shopify",
  shopify_update_product: "shopify",
  drive: "google_drive",
  read_spreadsheet: "google_drive",
  paymongo_link: "paymongo",
};

/** Every step type that uses an app, for the overview's apps list. */
export const APP_PROVIDERS: Partial<Record<string, Provider>> = {
  ...CHECKED_PROVIDERS,
  google_docs: "google_drive",
};

export type WorkspaceReadinessEnv = {
  connections: Awaited<ReturnType<typeof readConnections>>;
  secretNames: Set<string>;
  resourceCount: number;
  knowledgePublished: boolean;
  approvers: Set<string>;
  planKey: keyof typeof PLANS | null;
  smsConfigured: boolean;
  smsLimit: number | null;
  smsUsed: number;
  liveWorkflowIds: Set<string>;
};

export async function loadWorkspaceReadinessEnv(db: Db, workspaceId: string): Promise<WorkspaceReadinessEnv> {
  const conns = await readConnections(db, workspaceId);
  const secretRows = await db.select({ name: secrets.name }).from(secrets).where(eq(secrets.userId, workspaceId));
  const resourceRows = await db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(resources).where(and(eq(resources.userId, workspaceId), eq(resources.active, true)));
  const knowledgeRow = await readKnowledge(db, workspaceId);
  const memberRows = await db
    .select({ email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.role, ["owner", "approver"])));
  const usage = await usageSummary(db, workspaceId);
  const liveRows = await db
    .selectDistinct({ id: workflows.id })
    .from(workflows)
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.published, true)))
    .where(eq(workflows.userId, workspaceId));
  const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, workspaceId));
  const approvers = new Set(memberRows.map((m) => m.email.toLowerCase()));
  if (owner) approvers.add(owner.email.toLowerCase());
  return {
    connections: conns,
    secretNames: new Set(secretRows.map((s) => s.name)),
    resourceCount: resourceRows[0]?.count ?? 0,
    knowledgePublished: Boolean(knowledgeRow && knowledgeRow.entries.length > 0),
    approvers,
    planKey: (usage.plan ?? null) as keyof typeof PLANS | null,
    smsConfigured: unismsConfig() !== null,
    smsLimit: usage.sms?.limit ?? null,
    smsUsed: usage.sms?.used ?? 0,
    liveWorkflowIds: new Set(liveRows.map((w) => w.id)),
  };
}

/** Smallest gap in minutes between the next 10 fire times (UTC, as pg-boss schedules). A cron that does not parse is left for pg-boss to reject. */
export function fastestGapMinutes(cron: string): number {
  try {
    const next = CronExpressionParser.parse(cron, { tz: "UTC" });
    let last = next.next().getTime();
    let gap = Infinity;
    for (let i = 0; i < 9; i++) {
      const at = next.next().getTime();
      gap = Math.min(gap, at - last);
      last = at;
    }
    return gap / 60_000;
  } catch {
    return Infinity;
  }
}

const DESTINATION_HINT: Partial<Record<Provider, { en: string; tl: string }>> = {
  slack: { en: " and pick a channel", tl: " at pumili ng channel" },
  telegram: { en: " and choose a chat", tl: " at pumili ng chat" },
  google_sheets: { en: " and pick a sheet", tl: " at pumili ng sheet" },
  google_calendar: { en: " and choose a calendar", tl: " at pumili ng calendar" },
  airtable: { en: " and choose where it goes", tl: " at pumili ng patutunguhan" },
  notion: { en: " and choose where it goes", tl: " at pumili ng patutunguhan" },
  trello: { en: " and choose where it goes", tl: " at pumili ng patutunguhan" },
  discord: { en: " with a webhook link", tl: " gamit ang webhook link" },
  whatsapp: { en: " with your Phone Number ID", tl: " gamit ang Phone Number ID mo" },
};

function appFix() {
  return `#/apps`;
}

export async function evaluateReadinessWithEnv(
  db: Db,
  env: WorkspaceReadinessEnv,
  opts: { workspaceId: string; definition: WorkflowDefinition; workflowId?: string; language?: Language },
): Promise<ReadinessReport> {
  const language: Language = opts.language ?? "en";
  const tl = language === "tl";
  const blockers: ReadinessBlocker[] = [];
  const warnings: ReadinessBlocker[] = [];
  const seenIds = new Set<string>();
  const push = (item: ReadinessBlocker) => {
    if (seenIds.has(item.id)) return;
    seenIds.add(item.id);
    if (item.severity === "blocker") blockers.push(item);
    else warnings.push(item);
  };

  const def = opts.definition;
  const activeSteps = def.steps.filter((s) => !s.disabled);

  // 1. Trigger-specific external connection & source checks
  if (isGoogleTrigger(def.trigger.type)) {
    const { app, problem } = await googleTriggerStatus(db, opts.workspaceId, def.trigger.type);
    if (problem) push({ id: `connect:${app}`, kind: "connect", severity: "blocker", app, stepId: "trigger", text: problem, fix: appFix() });
  }
  if (isMailboxTrigger(def.trigger.type)) {
    const { app, problem } = await mailboxTriggerStatus(db, opts.workspaceId, def.trigger.type);
    if (problem) push({ id: `connect:${app}`, kind: "connect", severity: "blocker", app, stepId: "trigger", text: problem, fix: appFix() });
  }
  if (isRecordTrigger(def.trigger.type)) {
    const { app, problem } = await recordTriggerStatus(db, opts.workspaceId, def.trigger.type);
    if (problem) push({ id: `connect:${app}`, kind: "connect", severity: "blocker", app, stepId: "trigger", text: problem, fix: appFix() });
  }
  if (def.trigger.type === "email") {
    let active = false;
    if (opts.workflowId) {
      const [source] = await db.select({ status: emailSources.status }).from(emailSources).where(eq(emailSources.workflowId, opts.workflowId));
      active = source?.status === "active";
    }
    if (!active) {
      push({
        id: "email_source:inactive",
        kind: "email_source",
        severity: "blocker",
        what: "email_source",
        stepId: "trigger",
        text: tl
          ? "Ikonekta muna ang mailbox at hintaying maging active bago i-on ang email trigger."
          : "Connect the mailbox and wait for its status to be active before publishing an email trigger.",
        fix: opts.workflowId ? `#/w/${opts.workflowId}` : "#/apps",
      });
    }
  }

  // 2. App connections needed by trigger and active steps
  const needed = new Map<Provider, string>();
  const need = (provider: Provider, stepId: string) => {
    if (!needed.has(provider)) needed.set(provider, stepId);
  };
  if (def.trigger.type === "meta_dm") need("meta_messenger", "trigger");
  if (def.trigger.type === "whatsapp_message") need("whatsapp", "trigger");
  if (def.trigger.type === "shopify_order") need("shopify", "trigger");
  if (def.trigger.type === "telegram_message") need("telegram", "trigger");
  for (const s of activeSteps) {
    const p = CHECKED_PROVIDERS[s.type];
    if (p) need(p, s.id);
    if (s.type === "payment_due") {
      if (s.config.checkout) need("paymongo", s.id);
      if (s.config.channel === "messenger") need("meta_messenger", s.id);
    }
  }

  const makesDocs = activeSteps.find((s) => s.type === "google_docs");
  if (makesDocs) {
    const drive = env.connections.find((x) => x.provider === "google_drive");
    if (!drive || drive.authMethod !== "oauth" || !drive.destination?.folderId) {
      push({
        id: "connect:google_drive:docs",
        kind: "connect",
        severity: "blocker",
        app: "google_drive",
        stepId: makesDocs.id,
        text: tl
          ? "Ikonekta ang Google Drive gamit ang Google at pumili ng folder sa Apps bago i-on ang Make a document."
          : "Connect Google Drive with Google and pick a folder in Apps before turning on a Make a document step.",
        fix: appFix(),
      });
    } else if (drive.status !== "active") {
      push({
        id: "connect:google_drive:reauth",
        kind: "connect",
        severity: "blocker",
        app: "google_drive",
        stepId: makesDocs.id,
        text: tl
          ? "Kailangang ikonekta ulit ang Google Drive sa Apps bago ito i-on."
          : "Google Drive needs to be connected again in Apps before turning this on.",
        fix: appFix(),
      });
    }
  }

  for (const [provider, stepId] of needed) {
    const c = env.connections.find((x) => x.provider === provider);
    const name = PROVIDER_NAMES[provider];
    const where = DESTINATION_HINT[provider]?.[language] ?? "";
    if (!c || !c.destination) {
      push({
        id: `connect:${provider}`,
        kind: "connect",
        severity: "blocker",
        app: provider,
        stepId,
        text: tl
          ? `Ikonekta ang ${name}${where} sa Apps bago ito i-on.`
          : `Connect ${name}${where} in Apps before turning this on.`,
        fix: appFix(),
      });
    } else if (c.status !== "active") {
      push({
        id: `connect:${provider}`,
        kind: "connect",
        severity: "blocker",
        app: provider,
        stepId,
        text: tl
          ? `Kailangang ikonekta ulit ang ${name} sa Apps bago ito i-on.`
          : `${name} needs to be connected again in Apps before turning this on.`,
        fix: appFix(),
      });
    }
  }

  if (def.trigger.type === "telegram_message" && !env.connections.find((x) => x.provider === "telegram")?.destination?.webhookPath) {
    push({
      id: "connect:telegram:receive",
      kind: "connect",
      severity: "blocker",
      app: "telegram",
      stepId: "trigger",
      text: tl
        ? "I-on ang Receive messages para sa Telegram sa Apps bago ito i-on."
        : "Turn on Receive messages for Telegram in Apps before turning this on.",
      fix: appFix(),
    });
  }

  // 3. Lalamove API credentials stored in Secrets
  const lalamoveStep = activeSteps.find((s) => s.type === "lalamove");
  if (lalamoveStep && (!env.secretNames.has("lalamove_api_key") || !env.secretNames.has("lalamove_api_secret"))) {
    push({
      id: "connect:lalamove",
      kind: "connect",
      severity: "blocker",
      app: "lalamove",
      stepId: lalamoveStep.id,
      text: tl
        ? "I-save ang Lalamove API key at secret (lalamove_api_key at lalamove_api_secret) bago ito i-on."
        : "Save your Lalamove API key and secret (lalamove_api_key and lalamove_api_secret) before turning this on.",
      fix: "#/secrets",
    });
  }

  // 4. Resources (rooms/slots)
  const hasResourceField =
    (def.trigger.type === "form" || def.trigger.type === "webhook" || def.trigger.type === "sub_workflow") &&
    (def.trigger.config.fields ?? []).some((f) => f.type === "resource");
  const bookingCreate = activeSteps.find((s) => s.type === "booking" && s.config.action === "create");
  if ((hasResourceField || bookingCreate) && env.resourceCount === 0) {
    push({
      id: "resource:missing",
      kind: "resource",
      severity: "blocker",
      what: "resources",
      stepId: hasResourceField ? "trigger" : bookingCreate!.id,
      text: tl
        ? "Magdagdag muna ng kahit isang kuwarto o resource sa Resources bago subukan o i-on ito."
        : "Add at least one room or resource on the Resources page before testing or turning on.",
      fix: "#/resources",
    });
  }

  // 5. Knowledge published
  const knowledgeStep = activeSteps.find((s) => (s.type === "ai" && s.config.task === "answer") || s.type === "stay_quote");
  if (knowledgeStep && !env.knowledgePublished) {
    push({
      id: "knowledge:unpublished",
      kind: "knowledge",
      severity: "blocker",
      what: "knowledge",
      stepId: knowledgeStep.id,
      text: tl
        ? "I-publish muna ang knowledge sheet sa Knowledge page bago patakbuhin ang hakbang na ito."
        : "Publish your knowledge sheet on the Knowledge page before running this step.",
      fix: "#/knowledge",
    });
  }

  // 6. SMS (server operator configuration + plan + monthly quota)
  const smsStep = activeSteps.find((s) => s.type === "sms" || (s.type === "payment_due" && s.config.channel === "sms"));
  if (smsStep) {
    const blocks = activeSteps.some((s) => s.type === "sms");
    const severity = blocks ? "blocker" : "warning";
    if (!env.smsConfigured) {
      push({
        id: "operator:sms_unavailable",
        kind: "operator",
        severity,
        what: "sms_unavailable",
        stepId: smsStep.id,
        text: tl ? "Hindi naka-set up ang SMS sa server na ito, kaya hindi maipapadala ang mga SMS step." : SMS_NOT_SET_UP,
      });
    }
    if (env.smsLimit === 0) {
      push({
        id: "operator:sms_plan",
        kind: "operator",
        severity,
        what: "sms_plan",
        stepId: smsStep.id,
        text: tl
          ? "Walang kasamang pagpapadala ng SMS sa Preview plan (0 SMS bawat buwan). Humiling ng paid plan bago i-on."
          : "SMS sending is not included on the Preview plan (0 SMS per month). Ask kymavo to move you to a paid plan before turning on.",
        fix: "#/settings",
      });
    } else if (env.smsLimit !== null && env.smsLimit > 0 && env.smsUsed >= env.smsLimit) {
      push({
        id: "operator:sms_quota",
        kind: "operator",
        severity: "warning",
        what: "sms_quota",
        stepId: smsStep.id,
        text: tl
          ? "Naubos na ang buwanang SMS limit ng opisinang ito. Hintayin ang pag-reset o humiling ng mas mataas na plan."
          : "This office used all of its monthly SMS messages. Wait for the reset or ask kymavo for a larger plan.",
        fix: "#/settings",
      });
    }
  }

  // 7. Plan limits (schedule frequency and live automation cap)
  if (env.planKey) {
    const plan = PLANS[env.planKey];
    if (def.trigger.type === "schedule" && fastestGapMinutes(def.trigger.config.cron) < plan.minScheduleMinutes) {
      push({
        id: "operator:schedule_plan",
        kind: "operator",
        severity: "blocker",
        what: "schedule_plan",
        stepId: "trigger",
        text: `Your ${plan.label} plan runs a schedule at most once every ${plan.minScheduleMinutes} minutes. Pick a less frequent schedule, or ask kymavo to move you to a larger plan.`,
        fix: "#/settings",
      });
    }
    if (env.liveWorkflowIds.size >= plan.automations && (!opts.workflowId || !env.liveWorkflowIds.has(opts.workflowId))) {
      push({
        id: "operator:automation_limit",
        kind: "operator",
        severity: "blocker",
        what: "automation_limit",
        text: `Your ${plan.label} plan allows ${plan.automations} live automation${plan.automations === 1 ? "" : "s"}. Delete one, or ask kymavo to move you to a larger plan.`,
        fix: "#/settings",
      });
    }
  }

  // 8. Signing secret
  const t: Trigger = def.trigger;
  const secretName =
    t.type === "webhook"
      ? t.config.hmacSecret
      : t.type === "slack_message" || t.type === "teams_message" || t.type === "discord_message"
        ? t.config.signingSecret
        : undefined;
  if (secretName !== undefined && !env.secretNames.has(secretName)) {
    push({
      id: `secret:${secretName}`,
      kind: "secret",
      severity: "blocker",
      what: secretName,
      stepId: "trigger",
      text: `Add a secret named ${secretName} on the Secrets page first, so calls to this webhook can be checked against it.`,
      fix: "#/secrets",
    });
  }

  // 9. Named approvers
  for (const step of activeSteps) {
    if (step.type !== "approval" || !step.config.approver) continue;
    if (!env.approvers.has(step.config.approver.toLowerCase())) {
      push({
        id: `approver:${step.id}`,
        kind: "approver",
        severity: "blocker",
        what: step.config.approver,
        stepId: step.id,
        text: `${step.config.approver} can't approve in this workspace. Invite them as an approver on the Team page first.`,
        fix: "#/team",
      });
    }
  }

  // 10. Step/trigger configuration checks (required fields, empty forms)
  for (const [idx, prob] of configProblems(def, language).entries()) {
    push({
      id: `config:${prob.stepId}:${idx}`,
      kind: "config",
      severity: "blocker",
      stepId: prob.stepId,
      text: prob.message,
      fix: opts.workflowId ? `#/w/${opts.workflowId}` : undefined,
    });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
  };
}

export async function evaluateReadiness(
  deps: { db: Db },
  opts: { workspaceId: string; definition: WorkflowDefinition; workflowId?: string; language?: Language },
): Promise<ReadinessReport> {
  const env = await loadWorkspaceReadinessEnv(deps.db, opts.workspaceId);
  return evaluateReadinessWithEnv(deps.db, env, opts);
}

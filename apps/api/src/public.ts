import { publicCopy } from "./public-copy";
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { dmClaimByMid, downloadTelegramFile, openDueForGuest, parseTelegramUpdate, ProviderError, submitDmReceiptClaim, telegramWebhookSecret, TooManyClaimsError, conversationPayload, parseMetaEchoes, recordEcho, recordInbound, normalizeShopDomain, parseShopifyCredential, parseShopifyOrder, verifyShopifyHmac, assertNotPaused, busyBetween, claimUsage, constantTimeEqual, downloadMetaImage, keyedRun, MetaImageError, MetaTransientImageError, parseMetaCredential, parseMetaWebhook, QuotaError, readBrand, saveUploads, usageSummary, verifyMetaSignature, workspaceLanguage, businessProfiles, connectionCredential, connections, createKeyedRun, createRun, eventSeen, finishEvent, keptEvent, markPaymentPaid, markPaymentRefunded, centavosToPesos, paymongoMode, readSecret, recordEvent, requests, runs, settleCheckout, triggers, verifyPaymongoSignature, WorkflowPausedError, workflows, workflowVersions, type Db, type NewUpload, type Payment } from "@daloy/db";
import { definitionSchema, workflowChoices, FILE_MAX_BYTES, FILES_PER_FIELD, FILES_PER_SUBMISSION, fileType, OFFICE_REQUEST, parsePayload, PURCHASE_REQUEST, safeFileName, type FileRef, type FormField, type Resource } from "@daloy/engine";
import {
  BadRequestException,
  Body,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  type RawBodyRequest,
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { and, eq, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { BOSS, CONFIG, DB, enqueueRun, eventKey, isUniqueViolation, notifyDueConfirmed, RateLimit, replayedRun, validPayload, ZodPipe, type ApiConfig } from "./http";
import { sessionUser } from "./auth";
import { COMPRESS_JS, COMPRESS_TAG } from "./compress";
import { resourcesFor } from "./resources";
import { escapeHtml, groupFields, shell, SLOTS_JS, splitErrors, type PageBrand } from "./public-pages";
import { clock, dayLabel, daySlots, dayWindow, isTaken } from "./slots";

// Starts with "_", which no field name can (definition.ts), so a real "website" field is never mistaken for it.
const HONEYPOT = "_website";

/**
 * Join condition for a trigger's latest published version. With the trigger row in the same statement, the row and the
 * version come from one snapshot, so a republish cannot land between two reads (decision 0057).
 */
const latestPublished = and(eq(workflowVersions.workflowId, triggers.workflowId), eq(workflowVersions.published, true), sql`${workflowVersions.version} = (select max(v.version) from workflow_versions v where v.workflow_id = ${triggers.workflowId} and v.published)`);

/** The trigger as that version saved it, or undefined when its type is another one: the row can be newer than the version. */
const savedTrigger = (definition: unknown, type: string) => {
  const t = (definition as { trigger?: { type?: unknown; config?: Record<string, unknown> } } | null)?.trigger;
  return t?.type === type ? (t.config ?? {}) : undefined;
};

/** Both guided templates record a request with a reference, from the form and from MCP; a custom form only starts a run. */
export const isTracked = (setup: unknown) => [OFFICE_REQUEST, PURCHASE_REQUEST].includes((setup as { template?: string } | null)?.template ?? "");
const SUBMISSION_KEY = "submission_key";

const slotsQuery = z.object({
  resource: z.uuid(),
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).refine((d) => { const t = Date.parse(`${d}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); }, "is not a real date"),
  field: z.string().max(64).optional(),
});

/** The parts of a multer file this handler reads (@types/multer is not installed). */
type Part = { fieldname: string; originalname: string; buffer: Buffer; size: number };
const FILE_TYPES_MESSAGE = "must be a JPEG, PNG, WebP or HEIC photo, or a PDF";
const OVER_QUOTA = "This form cannot take more files today. Send it without files, or try again tomorrow.";

// Both spellings use one submit handler so they share the same per-IP limit.
const FORM_PATHS = [":id", ":id/embed"];
export const isFormEmbed = (path: string) => /^\/forms\/[^/]+\/embed\/?$/i.test(path);

/** Public, unauthenticated routes that start runs. Each one is rate limited per IP. */
@Controller("hooks")
@UseGuards(RateLimit(60))
export class HooksController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post(":path")
  @HttpCode(202)
  async receive(
    @Param("path", new ZodPipe(z.string().regex(/^[A-Za-z0-9_-]{43}$/))) path: string,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
    @Headers("x-daloy-signature") signature: string | undefined,
    @Headers("x-daloy-timestamp") timestamp: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    const [row] = await this.db
      .select({ trigger: triggers, userId: workflows.userId, version: workflowVersions })
      .from(triggers)
      .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
      .innerJoin(workflowVersions, latestPublished)
      .where(eq(triggers.webhookPath, path));
    const config = row && savedTrigger(row.version.definition, "webhook");
    if (!row || !config) throw new NotFoundException();
    const version = row.version;

    const { hmacSecret: secretName, requireTimestamp } = config as { hmacSecret?: string; requireTimestamp?: boolean };
    // The signature of a timestamped call names the call exactly, so a replay in the window gets the first run back. The signature wins over the Idempotency-Key header, which it does not cover (decisions 0054, 0056).
    let replayKey: string | undefined;
    // A key that is present, blank included, means the call must be signed: an old blank name fails closed (M1).
    if ("hmacSecret" in config) {
      // Fails closed: a missing secret rejects every call instead of accepting unsigned ones.
      const key = typeof secretName !== "string" ? null : await readSecret(this.db, this.config.secretsKey, row.userId, secretName);
      const checked = key
        ? checkSignature({ body: req.rawBody ?? Buffer.alloc(0), signature, timestamp, key, requireTimestamp: requireTimestamp === true, nowSeconds: Math.floor(Date.now() / 1000) })
        : ({ ok: false, reason: "bad signature" } as const);
      if (!checked.ok) throw new UnauthorizedException(checked.reason);
      replayKey = checked.replayKey === undefined ? undefined : `sig:${checked.replayKey}`;
      if (checked.legacy) {
        // Not a failure: the owner sees the date in the editor and the caller sees the header, then they move to the timestamp (decision 0054).
        res.setHeader("Daloy-Signature-Warning", "timestamp-missing");
        await this.db.update(triggers).set({ legacySignatureAt: new Date() }).where(and(eq(triggers.id, row.trigger.id), sql`(${triggers.legacySignatureAt} is null or ${triggers.legacySignatureAt} < now() - interval '1 hour')`));
      }
    }

    const { trigger } = definitionSchema.parse(version.definition);
    const callerKey = replayKey ?? idempotencyKey;
    const first = await replayedRun(this.db, row.trigger.workflowId, trigger, req.body, callerKey);
    if (first) return { runId: first, duplicate: true };
    const fields = (config as { fields?: FormField[] }).fields;
    const payload = validPayload(fields, req.body ?? {}, await resourcesFor(this.db, row.userId, fields));
    // A repeated event gets the first run back and starts nothing (decision 0029).
    const { runId, duplicate } = await createKeyedRun(this.db, row.trigger.workflowId, version.id, payload, eventKey(trigger, payload, callerKey));
    if (!duplicate) await enqueueRun(this.boss, runId);
    return duplicate ? { runId, duplicate } : { runId };
  }
}

/**
 * PayMongo's webhook. The URL path is the secret that finds the owner's connection; the signature then proves PayMongo sent it.
 * PayMongo disables a webhook that keeps failing, so only a bad signature, an unknown path or a server error is not a 2xx.
 * The event is recorded last: a crash before that is retried, and the state changes and keyed runs are safe to repeat.
 */
@Controller("hooks/paymongo")
@UseGuards(RateLimit(60))
export class PaymongoHooksController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post(":path")
  @HttpCode(200)
  async receive(@Param("path") path: string, @Req() req: RawBodyRequest<Request>, @Headers("paymongo-signature") signature: string | undefined) {
    const [owner] = await this.db
      .select({ userId: connections.userId })
      .from(connections)
      .where(and(eq(connections.provider, "paymongo"), sql`${connections.destination}->>'webhookPath' = ${path}`));
    const conn = owner && (await connectionCredential(this.db, this.config.secretsKey, owner.userId, "paymongo"));
    if (!owner || !conn) throw new NotFoundException();
    const { secretKey, webhookSecret } = JSON.parse(conn.credential) as { secretKey: string; webhookSecret: string };
    const mode = paymongoMode(secretKey);
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    if (!webhookSecret || !signature || !verifyPaymongoSignature({ header: signature, rawBody, secret: webhookSecret, mode, nowSeconds: Math.floor(Date.now() / 1000) })) throw new UnauthorizedException();

    const data = (req.body as { data?: { id?: unknown; attributes?: { type?: unknown; livemode?: unknown; data?: { id?: unknown; attributes?: { payments?: { id?: unknown; attributes?: { amount?: unknown; currency?: unknown; status?: unknown } }[] } } } } } | undefined)?.data;
    const eventId = data?.id;
    const type = data?.attributes?.type;
    if (!data || typeof eventId !== "string" || typeof type !== "string") throw new BadRequestException();
    if ((data.attributes?.livemode === true) !== (mode === "live")) throw new BadRequestException("event mode does not match the connection");
    if (await eventSeen(this.db, owner.userId, eventId)) return { duplicate: true };

    const livemode = mode === "live";
    const resource = data.attributes?.data;
    let started: { payment: Payment; status: "paid" | "refunded" } | undefined;
    let kept: Record<string, unknown> | undefined;
    let finishedRefundId: string | undefined;
    if (type === "checkout_session.payment.paid" && typeof resource?.id === "string") {
      const paid = resource.attributes?.payments?.find((p) => p.attributes?.status === "paid");
      const { amount, currency } = paid?.attributes ?? {};
      if (typeof paid?.id === "string" && typeof amount === "number" && typeof currency === "string") {
        const r = await markPaymentPaid(this.db, { userId: owner.userId, sessionId: resource.id, paymentId: paid.id, amount, currency, livemode });
        // R3: a checkout for a due confirms it only on a full match; anything else goes to Receipts to review (decision 0089).
        const settledDue = r.payment ? await settleCheckout(this.db, owner.userId, r.payment.id) : undefined;
        if (settledDue) await notifyDueConfirmed(this.db, this.boss, owner.userId, settledDue);
        if (!r.payment) {
          kept = { sessionId: resource.id, paymentId: paid.id, amount, currency, livemode };
        } else {
          // A refund that came before this paid event was kept: apply it before starting paid listeners (decision 0056).
          const refund =
            r.payment.providerPaymentId && (r.payment.status === "paid" || r.payment.status === "refunded")
              ? await keptEvent(this.db, owner.userId, "payment.refunded", "paymentId", r.payment.providerPaymentId, livemode)
              : undefined;
          if (refund && (refund.payload as { livemode?: boolean } | null)?.livemode === livemode) {
            const ref = await markPaymentRefunded(this.db, { userId: owner.userId, providerPaymentId: r.payment.providerPaymentId!, livemode });
            const settledRefDue = ref.payment ? await settleCheckout(this.db, owner.userId, ref.payment.id) : undefined;
            if (settledRefDue) await notifyDueConfirmed(this.db, this.boss, owner.userId, settledRefDue);
            if (ref.payment?.status === "refunded") started = { payment: ref.payment, status: "refunded" };
            finishedRefundId = refund.eventId;
          } else if (r.payment.status === "paid") {
            started = { payment: r.payment, status: "paid" };
          }
        }
      }
    } else if (type === "payment.refunded" && typeof resource?.id === "string") {
      const r = await markPaymentRefunded(this.db, { userId: owner.userId, providerPaymentId: resource.id, livemode });
      if (!r.payment) kept = { paymentId: resource.id, livemode };
      else await settleCheckout(this.db, owner.userId, r.payment.id);
      if (r.payment?.status === "refunded") started = { payment: r.payment, status: "refunded" };
    }
    // Started on the payment's state, not on whether this call changed it: a crash after the update but before the runs
    // is retried by PayMongo and still starts them. The key is payment + status, so a replay or a second event starts nothing.
    if (started) await this.startRuns(owner.userId, started.payment, started.status);
    if (finishedRefundId) await finishEvent(this.db, owner.userId, finishedRefundId);
    // An unmatched paid or refund event is kept so the payment it belongs to can apply it later; the answer is still 200.
    await recordEvent(this.db, { eventId, userId: owner.userId, type, ...(kept && { state: "kept" as const, payload: kept }) });
    return { ok: true };
  }

  /** One run for each published workflow of the owner that listens for this status. */
  private async startRuns(userId: string, p: Payment, status: "paid" | "refunded") {
    const listeners = await this.db
      .select({ workflowId: triggers.workflowId, version: workflowVersions })
      .from(triggers)
      .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
      .innerJoin(workflowVersions, latestPublished)
      .where(and(eq(workflows.userId, userId), eq(triggers.type, "payment")));
    const payload = { status, reference: p.reference, amount: p.amountCentavos, amountPesos: centavosToPesos(p.amountCentavos), livemode: p.livemode, currency: p.currency, paymentId: p.id, sourceRunId: p.runId, providerPaymentId: p.providerPaymentId };
    // A sandbox payment, or one the builder's test run made, starts test runs, which the worker mocks (decision 0056).
    const [source] = await this.db.select({ test: runs.test }).from(runs).where(eq(runs.id, p.runId));
    const test = !p.livemode || source?.test === true;
    for (const l of listeners) {
      const config = savedTrigger(l.version.definition, "payment") as { events?: string[] } | undefined;
      if (!config || !(config.events ?? ["paid"]).includes(status)) continue;
      const version = l.version;
      // Paused (N11b): acknowledged with 2xx and no run, so PayMongo does not disable its webhook.
      // A test run skips createRun's pause check, so check it here.
      const started = await Promise.resolve(test && assertNotPaused(this.db, version.id)).then(() => createKeyedRun(this.db, l.workflowId, version.id, payload, `paymongo:${p.id}:${status}`, { test })).catch((err: unknown) => {
        if (err instanceof WorkflowPausedError) return null;
        throw err;
      });
      if (started && !started.duplicate) await enqueueRun(this.boss, started.runId);
    }
  }
}

/**
 * Meta Messenger and Instagram DM webhook (decision 0075).
 * GET answers Meta's hub.challenge verification after constant-time verify_token check.
 * POST verifies X-Hub-Signature-256 against the raw body, deduplicates by message id (mid) via run_keys,
 * safely downloads verified image attachments from allowlisted Meta CDN hosts, and starts matching meta_dm runs.
 */
@Controller("hooks/meta")
@UseGuards(RateLimit(60))
export class MetaHooksController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  private async activeConnection(path: string) {
    const [owner] = await this.db
      .select({ userId: connections.userId })
      .from(connections)
      .where(and(eq(connections.provider, "meta_messenger"), eq(connections.status, "active"), sql`${connections.destination}->>'webhookPath' = ${path}`));
    if (!owner) return null;
    const conn = await connectionCredential(this.db, this.config.secretsKey, owner.userId, "meta_messenger");
    if (!conn || conn.status !== "active") return null;
    return { userId: owner.userId, conn, cred: parseMetaCredential(conn.credential) };
  }

  @Get(":path")
  async verify(@Param("path") path: string, @Req() req: Request, @Res() res: Response) {
    const found = await this.activeConnection(path);
    if (!found) throw new ForbiddenException();
    const q = req.query as Record<string, unknown>;
    const hub = q.hub && typeof q.hub === "object" ? (q.hub as Record<string, unknown>) : undefined;
    const mode = q["hub.mode"] ?? hub?.mode;
    const token = q["hub.verify_token"] ?? hub?.verify_token;
    const challenge = q["hub.challenge"] ?? hub?.challenge;
    if (
      mode !== "subscribe" ||
      typeof token !== "string" ||
      typeof challenge !== "string" ||
      challenge.length === 0 ||
      challenge.length > 256 ||
      !constantTimeEqual(token, found.cred.verifyToken)
    ) {
      throw new ForbiddenException();
    }
    res.status(200).type("text/plain; charset=utf-8").send(challenge);
  }

  @Post(":path")
  @HttpCode(200)
  async receive(@Param("path") path: string, @Req() req: RawBodyRequest<Request>, @Headers("x-hub-signature-256") signature: string | undefined) {
    const found = await this.activeConnection(path);
    if (!found) throw new ForbiddenException();
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    if (!verifyMetaSignature(rawBody, signature, found.cred.appSecret)) throw new UnauthorizedException("invalid signature");

    // A reply from the Page inbox hands the conversation to staff; Daloy's own reply changes nothing (decision 0115).
    for (const e of parseMetaEchoes(req.body, found.conn.destination)) {
      await recordEcho(this.db, { userId: found.userId, channel: e.channel, externalId: e.guestId, mid: e.messageId, text: e.text, ours: e.ours });
    }
    const events = parseMetaWebhook(req.body, found.conn.destination);
    if (events.length === 0) return { ok: true, started: 0 };

    // Resolve trigger and published version atomically in one snapshot (H3 rule, decision 0057).
    const listeners = await this.db
      .select({ workflowId: triggers.workflowId, pausedAt: workflows.pausedAt, version: workflowVersions })
      .from(triggers)
      .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
      .innerJoin(workflowVersions, latestPublished)
      .where(and(eq(workflows.userId, found.userId), eq(triggers.type, "meta_dm")));

    let startedCount = 0;
    for (const ev of events) {
      // C6 (decision 0121): check whether this guest has a pending open payment due before skipping unmatched events.
      const openDueId = ev.imageUrls.length > 0 ? await openDueForGuest(this.db, found.userId, ev.channel, ev.senderId) : null;
      const matching = listeners.filter((l) => {
        if (l.pausedAt) return false;
        const cfg = savedTrigger(l.version.definition, "meta_dm") as { channel?: string; requireImage?: boolean } | undefined;
        if (!cfg) return false;
        const channel = cfg.channel ?? "both";
        if (channel !== "both" && channel !== ev.channel) return false;
        if (cfg.requireImage && ev.imageUrls.length === 0) return false;
        // A postback is only a tap, so it starts nothing where the workflow's menu does not offer its choice (decision 0118).
        if (ev.postback && !workflowChoices(l.version.definition).includes(ev.choice!)) return false;
        return true;
      });
      if (matching.length === 0 && !openDueId) continue;

      const key = `meta:${ev.messageId}`;
      const pending: typeof matching = [];
      for (const l of matching) {
        if (!(await keyedRun(this.db, l.workflowId, key, false))) pending.push(l);
      }
      const existingClaim = openDueId ? await dmClaimByMid(this.db, found.userId, ev.messageId) : undefined;
      const needsClaim = Boolean(openDueId && !existingClaim);
      if (pending.length === 0 && !needsClaim) continue;

      const downloaded: { name: string; type: "jpeg" | "png" | "webp"; data: Buffer }[] = [];
      if (ev.imageUrls.length > 0) {
        const { upload } = await usageSummary(this.db, found.userId);
        const canUpload = upload.limit === null || upload.used < upload.limit;
        if (canUpload) {
          for (let i = 0; i < ev.imageUrls.length; i++) {
            try {
              downloaded.push(await downloadMetaImage(ev.imageUrls[i]!, { urls: this.config.providers, index: i + 1 }));
            } catch (err) {
              if (err instanceof MetaImageError) continue;
              if (err instanceof MetaTransientImageError) {
                throw new ServiceUnavailableException("Meta image CDN is temporarily unavailable.");
              }
              throw err;
            }
          }
        }
      }

      // Create at most one transfer claim on the conversation's open due, in its own transaction (locks only payment_dues,
      // never conversations, so it cannot deadlock against confirm/expireDue). Replays deduplicate by (userId, sourceMid).
      let claim = existingClaim;
      if (needsClaim && openDueId && downloaded.length > 0) {
        claim = await submitDmReceiptClaim(this.db, {
          userId: found.userId,
          dueId: openDueId,
          sourceMid: ev.messageId,
          channel: ev.channel,
          caption: ev.text,
          image: { bytes: downloaded[0]!.data },
        }).catch((err: unknown) => {
          if (err instanceof QuotaError || err instanceof TooManyClaimsError) return undefined;
          throw err;
        });
      }
      if (pending.length === 0 && !claim) continue;

      // The message joins its conversation and every run that answers it commits together, so a replayed mid adds
      // nothing and two messages at once get versions one after the other (decision 0115).
      const started = await this.db.transaction(async (tx) => {
        const convo = await recordInbound(tx, { userId: found.userId, channel: ev.channel, externalId: ev.senderId, mid: ev.messageId, text: ev.text, at: new Date(ev.timestamp) });
        const conversation = await conversationPayload(tx, convo);
        const linked = { conversationId: convo.id, conversationVersion: convo.version };
        const ids: string[] = [];
        for (const l of pending) {
          const cfg = savedTrigger(l.version.definition, "meta_dm") as { requireImage?: boolean } | undefined;
          if (cfg?.requireImage && downloaded.length === 0) continue;

          const runFiles: NewUpload[] = downloaded.map((img) => ({ id: randomUUID(), field: "image", name: img.name, type: img.type, data: img.data }));
          const imageRefs: FileRef[] = runFiles.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.data.length }));
          const payload = {
            channel: ev.channel,
            senderId: ev.senderId,
            messageId: ev.messageId,
            text: ev.text,
            timestamp: ev.timestamp,
            image: imageRefs,
            ...(claim ? { claimId: claim.id } : {}),
            ...(ev.choice && workflowChoices(l.version.definition).includes(ev.choice) ? { choice: ev.choice } : {}),
            conversation,
            ...(found.conn.destination?.pageId ? { pageId: found.conn.destination.pageId } : {}),
            ...(found.conn.destination?.instagramAccountId ? { instagramAccountId: found.conn.destination.instagramAccountId } : {}),
          };
          const uploadClaimKey = `meta-upload:${l.workflowId}:${ev.messageId}`;
          const run = await createKeyedRun(
            tx,
            l.workflowId,
            l.version.id,
            payload,
            key,
            runFiles.length > 0 ? { ...linked, uploads: { userId: found.userId, files: runFiles, claimKey: uploadClaimKey } } : linked,
          ).catch(async (err: unknown) => {
            if (err instanceof WorkflowPausedError) return null;
            if (err instanceof QuotaError) {
              if (cfg?.requireImage) return null;
              return createKeyedRun(tx, l.workflowId, l.version.id, { ...payload, image: [] }, key, linked).catch((e: unknown) => {
                if (e instanceof WorkflowPausedError) return null;
                throw e;
              });
            }
            throw err;
          });
          if (run && !run.duplicate) ids.push(run.runId);
        }
        return ids;
      });
      for (const runId of started) await enqueueRun(this.boss, runId);
      startedCount += started.length;
    }
    return { ok: true, started: startedCount };
  }
}

/**
 * Shopify order webhook (decision 0105). The path finds the workspace's connection. X-Shopify-Hmac-Sha256 is checked against
 * the raw bytes with the app's client secret in constant time, before anything in the body is used, and the shop header
 * must be the connected store. Shopify signs no timestamp, so replays are stopped by the order: each run is keyed
 * "shopify:<shop>:order:<order id>", and a retry, a replay or a second delivery of the same order answers 200 and starts
 * nothing. A valid call that needs no run (another topic, a paused workflow, no listener) is 200, because Shopify
 * deletes a webhook that keeps failing.
 */
@Controller("hooks/shopify")
@UseGuards(RateLimit(60))
export class ShopifyHooksController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Post(":path")
  @HttpCode(200)
  async receive(
    @Param("path") path: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-shopify-hmac-sha256") signature: string | undefined,
    @Headers("x-shopify-webhook-id") webhookId: string | undefined,
    @Headers("x-shopify-topic") topic: string | undefined,
    @Headers("x-shopify-shop-domain") shopHeader: string | undefined,
  ) {
    const [owner] = await this.db
      .select({ userId: connections.userId })
      .from(connections)
      .where(and(eq(connections.provider, "shopify"), eq(connections.status, "active"), sql`${connections.destination}->>'webhookPath' = ${path}`));
    const conn = owner && (await connectionCredential(this.db, this.config.secretsKey, owner.userId, "shopify"));
    if (!owner || !conn || conn.status !== "active") throw new ForbiddenException();
    if (!verifyShopifyHmac(req.rawBody ?? Buffer.alloc(0), signature, parseShopifyCredential(conn.credential).appSecret)) throw new UnauthorizedException("invalid signature");
    if (!webhookId || !/^[A-Za-z0-9._:-]{1,100}$/.test(webhookId)) throw new BadRequestException("missing X-Shopify-Webhook-Id");
    const shop = conn.destination?.shop ?? conn.account;
    // Signed by this app but sent for a store this connection is not: refused, since its orders are not this workspace's.
    if (normalizeShopDomain(shopHeader ?? "") !== shop) throw new ForbiddenException("unknown shop");
    if (topic !== "orders/create") return { ok: true, started: 0 };
    const payload = parseShopifyOrder(req.body, shop);
    if (!payload) return { ok: true, started: 0 };

    // The trigger row and the latest published version come from one snapshot (decision 0057).
    const listeners = await this.db
      .select({ workflowId: triggers.workflowId, pausedAt: workflows.pausedAt, version: workflowVersions })
      .from(triggers)
      .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
      .innerJoin(workflowVersions, latestPublished)
      .where(and(eq(workflows.userId, owner.userId), eq(triggers.type, "shopify_order")));
    let started = 0;
    for (const l of listeners) {
      if (l.pausedAt || !savedTrigger(l.version.definition, "shopify_order")) continue;
      const run = await createKeyedRun(this.db, l.workflowId, l.version.id, payload, `shopify:${shop}:order:${payload.order_id}`).catch((err: unknown) => {
        if (err instanceof WorkflowPausedError) return null;
        throw err;
      });
      if (run && !run.duplicate) {
        await enqueueRun(this.boss, run.runId);
        started++;
      }
    }
    return { ok: true, started };
  }
}

/**
 * Telegram message webhook (T9, decision 0117). The path finds the workspace's Telegram connection, and the
 * X-Telegram-Bot-Api-Secret-Token header must equal the secret derived from its bot token, compared in constant time,
 * before the body is used. Each run is keyed "telegram:<bot id>:<update_id>", so Telegram's retries start one run.
 * "my_chat" listeners take only the chat chosen in Apps. A photo or PDF is downloaded once, capped at FILE_MAX_BYTES and
 * checked by its bytes. A file server that is down answers 503 so Telegram sends the update again; everything else is
 * 200, since Telegram keeps retrying an update that fails.
 */
@Controller("hooks/telegram")
@UseGuards(RateLimit(120))
export class TelegramHooksController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Post(":path")
  @HttpCode(200)
  async receive(@Param("path") path: string, @Body() body: unknown, @Headers("x-telegram-bot-api-secret-token") secret: string | undefined) {
    const [owner] = await this.db
      .select({ userId: connections.userId })
      .from(connections)
      .where(and(eq(connections.provider, "telegram"), eq(connections.status, "active"), sql`${connections.destination}->>'webhookPath' = ${path}`));
    const conn = owner && (await connectionCredential(this.db, this.config.secretsKey, owner.userId, "telegram"));
    if (!owner || !conn || conn.status !== "active") throw new ForbiddenException();
    if (!secret || !constantTimeEqual(secret, telegramWebhookSecret(conn.credential, path))) throw new UnauthorizedException("invalid secret token");
    const msg = parseTelegramUpdate(body);
    if (!msg) return { ok: true, started: 0 };

    // The trigger row and the latest published version come from one snapshot (decision 0057).
    const listeners = await this.db
      .select({ workflowId: triggers.workflowId, pausedAt: workflows.pausedAt, version: workflowVersions })
      .from(triggers)
      .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
      .innerJoin(workflowVersions, latestPublished)
      .where(and(eq(workflows.userId, owner.userId), eq(triggers.type, "telegram_message")));
    const key = `telegram:${conn.credential.split(":")[0]}:${msg.updateId}`;
    const pending: (typeof listeners[number] & { requireFile: boolean })[] = [];
    for (const l of listeners) {
      const cfg = savedTrigger(l.version.definition, "telegram_message") as { from?: string; requireFile?: boolean } | undefined;
      if (l.pausedAt || !cfg) continue;
      if (cfg.from !== "anyone" && msg.chatId !== conn.destination?.chatId) continue;
      const requireFile = cfg.requireFile !== false;
      if (requireFile && !msg.file) continue;
      if (!(await keyedRun(this.db, l.workflowId, key, false))) pending.push({ ...l, requireFile });
    }
    if (pending.length === 0) return { ok: true, started: 0 };

    let file: Awaited<ReturnType<typeof downloadTelegramFile>> = null;
    if (msg.file) {
      const { upload } = await usageSummary(this.db, owner.userId);
      if (upload.limit === null || upload.used < upload.limit) {
        file = await downloadTelegramFile(this.config.providers, conn.credential, msg.file).catch((err: unknown) => {
          if (err instanceof ProviderError) throw new ServiceUnavailableException(err.message);
          throw err;
        });
      }
    }

    const payload = { chatId: msg.chatId, chatType: msg.chatType, fromId: msg.fromId, fromName: msg.fromName, username: msg.username, messageId: msg.messageId, updateId: msg.updateId, date: msg.date, text: msg.text, fileRefused: msg.fileRefused || (msg.file !== null && file === null) };
    let started = 0;
    for (const l of pending) {
      if (l.requireFile && !file) continue;
      const runFiles: NewUpload[] = file ? [{ id: randomUUID(), field: "file", name: file.name, type: file.type, data: file.data }] : [];
      const refs: FileRef[] = runFiles.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.data.length }));
      const options = runFiles.length > 0 ? { uploads: { userId: owner.userId, files: runFiles, claimKey: `telegram-upload:${l.workflowId}:${key}` } } : {};
      const start = (p: object, o: Parameters<typeof createKeyedRun>[5]) =>
        createKeyedRun(this.db, l.workflowId, l.version.id, p, key, o).catch((err: unknown) => {
          if (err instanceof WorkflowPausedError) return null;
          throw err;
        });
      const run = await start({ ...payload, file: refs }, options).catch((err: unknown) => {
        // Out of upload space: a listener that needs the file does not start, the others start without it.
        if (err instanceof QuotaError) return l.requireFile ? null : start({ ...payload, file: [], fileRefused: true }, {});
        throw err;
      });
      if (run && !run.duplicate) {
        await enqueueRun(this.boss, run.runId);
        started++;
      }
    }
    return { ok: true, started };
  }
}

/** How far a timestamped call may be from the server clock, either way (decision 0054). */
export const REPLAY_WINDOW_SECONDS = 300;
const NO_TIMESTAMP = "This webhook requires the X-Daloy-Timestamp header. See how-it-works.md, webhook signatures.";
const OUTSIDE_WINDOW = "The timestamp is outside the 5 minute window. Check the clock of the sender.";

export type SignatureCheck = { ok: true; legacy: boolean; replayKey: string | undefined } | { ok: false; reason: string };

/**
 * X-Daloy-Signature with X-Daloy-Timestamp: sha256=<hex HMAC of "<timestamp>.<raw body>">, and the timestamp (unix seconds)
 * within the replay window. Without the timestamp header the old format, sha256=<hex HMAC of the raw body>, is accepted
 * only while the trigger does not require a timestamp. A call that has the header is never read as the old format.
 * replayKey is the signature of a timestamped call: an identical replay has the same one.
 */
export function checkSignature(c: { body: Buffer; signature: string | undefined; timestamp: string | undefined; key: string; requireTimestamp: boolean; nowSeconds: number }): SignatureCheck {
  if (c.timestamp === undefined) {
    if (c.requireTimestamp) return { ok: false, reason: NO_TIMESTAMP };
    return validSignature(c.body, c.signature, c.key) ? { ok: true, legacy: true, replayKey: undefined } : { ok: false, reason: "bad signature" };
  }
  const expected = createHmac("sha256", c.key).update(`${c.timestamp}.`).update(c.body).digest("hex");
  if (!c.signature || !sameText(c.signature, `sha256=${expected}`)) return { ok: false, reason: "bad signature" };
  // Only now, so a caller that cannot sign is told nothing about the window.
  if (!/^\d{1,12}$/.test(c.timestamp)) return { ok: false, reason: "bad signature" };
  if (Math.abs(c.nowSeconds - Number(c.timestamp)) > REPLAY_WINDOW_SECONDS) return { ok: false, reason: OUTSIDE_WINDOW };
  return { ok: true, legacy: false, replayKey: expected };
}

const sameText = (a: string, b: string) => {
  const given = Buffer.from(a);
  const want = Buffer.from(b);
  return given.length === want.length && timingSafeEqual(given, want);
};

/** The old format: X-Daloy-Signature: sha256=<hex HMAC of the raw body>, compared in constant time. */
export function validSignature(body: Buffer, header: string | undefined, key: string): boolean {
  if (!header) return false;
  return sameText(header, `sha256=${createHmac("sha256", key).update(body).digest("hex")}`);
}

/** The form trigger with its latest published version, from one statement (decision 0057). */
async function findForm(db: Db, id: string) {
  const [row] = await db
    .select({ trigger: triggers, version: workflowVersions, workflow: { id: workflows.id, userId: workflows.userId, setup: workflows.setup, pausedAt: workflows.pausedAt }, businessName: businessProfiles.businessName })
    .from(triggers)
    .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
    .innerJoin(workflowVersions, latestPublished)
    .leftJoin(businessProfiles, eq(businessProfiles.userId, workflows.userId))
    .where(and(eq(triggers.id, id), eq(triggers.type, "form")));
  const config = row && savedTrigger(row.version.definition, "form");
  if (!row || !config) throw new NotFoundException();
  const tracked = isTracked(row.workflow.setup);
  return { fields: (config as { fields: FormField[] }).fields, versionId: row.version.id, workflow: row.workflow, tracked, businessName: row.businessName };
}

/** The most one submission can send: every file at its limit plus every text field at its limit. */
export const MULTIPART_MAX_BYTES = FILES_PER_SUBMISSION * FILE_MAX_BYTES + 50 * 64 * 1024 + 256 * 1024;
const DEFAULT_UPLOAD_BUDGET = 128 * 1024 * 1024;

/**
 * Bounds the bytes of multipart bodies being read at once, across all forms and visitors (review, before release 2).
 * multer buffers files in memory before the handler runs, and the per-file and per-IP limits do not add up to a bound.
 * Everything here is decided from the headers and one form lookup, before a byte of the body is read: the declared
 * length is reserved from a shared budget until the response ends, a form that takes no files is refused, and a size
 * above what one submission can hold is refused. Node never delivers more than the declared length, so the
 * reservation is the most the request can occupy.
 * shortcut: the counter is per process, like RateLimit; several API instances each get their own budget.
 */
export function UploadBudget(route: { maxBytes: number; check: (db: Db, req: Request) => Promise<void> } = { maxBytes: MULTIPART_MAX_BYTES, check: formTakesFiles }) {
  @Injectable()
  class UploadBudgetGuard implements CanActivate {
    constructor(
      @Inject(DB) private readonly db: Db,
      @Inject(CONFIG) private readonly config: ApiConfig,
    ) {}

    async canActivate(ctx: ExecutionContext) {
      const http = ctx.switchToHttp();
      const req = http.getRequest<Request>();
      const res = http.getResponse<Response>();
      if (!req.is("multipart/form-data")) return true;
      const length = /^\d+$/.test(req.get("content-length") ?? "") ? Number(req.get("content-length")) : 0;
      if (length === 0) throw new HttpException("send the form with its Content-Length", HttpStatus.LENGTH_REQUIRED);
      if (length > route.maxBytes) throw new HttpException("this form is larger than a submission can be", HttpStatus.PAYLOAD_TOO_LARGE);
      if (uploadBytesInFlight + length > (this.config.uploadBudgetBytes ?? DEFAULT_UPLOAD_BUDGET)) {
        res.setHeader("Retry-After", "5");
        throw new HttpException("the server is taking other uploads, try again in a moment", HttpStatus.SERVICE_UNAVAILABLE);
      }
      uploadBytesInFlight += length;
      res.once("close", () => (uploadBytesInFlight -= length));
      await route.check(this.db, req);
      return true;
    }
  }
  return UploadBudgetGuard;
}

/** One budget for every route that reads multipart bodies: forms and the pay page (review of 22 November, M1). */
let uploadBytesInFlight = 0;

async function formTakesFiles(db: Db, req: Request) {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new NotFoundException();
  const { fields } = await findForm(db, id.data);
  if (!fields.some((f) => f.type === "file")) throw new HttpException("this form does not take files", HttpStatus.UNSUPPORTED_MEDIA_TYPE);
}

@Controller("forms")
export class FormsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get(FORM_PATHS)
  @Header("Content-Type", "text/html; charset=utf-8")
  // A request form carries a fresh submission key per load. no-store keeps the back button from reusing an old one.
  @Header("Cache-Control", "no-store")
  async page(@Param("id", new ZodPipe(z.uuid())) id: string, @Req() req: Request) {
    const { fields, tracked, businessName, workflow } = await this.form(id);
    const embed = isFormEmbed(req.path);
    if (workflow.pausedAt) return this.pausedPage(workflow.userId, embed);
    return renderForm(fields, await resourcesFor(this.db, workflow.userId, fields), tracked ? randomUUID() : undefined, businessName ?? undefined, await workspaceLanguage(this.db, workflow.userId), await pageBrand(this.db, workflow.userId), { embed, formId: id });
  }

  /**
   * Which open times of a resource are taken on one day, for the booking form (decision 0080). It answers only for a
   * resource of this form's own workspace, only with times (no reference, no name), and is limited per IP.
   */
  @Get(":id/slots")
  @UseGuards(RateLimit(60))
  @Header("Cache-Control", "no-store")
  async slots(@Param("id", new ZodPipe(z.uuid())) id: string, @Query(new ZodPipe(slotsQuery)) q: z.output<typeof slotsQuery>) {
    const { fields, workflow } = await this.form(id);
    const field = fields.find((f) => f.type === "datetime" && f.slotMinutes && (q.field === undefined || f.name === q.field));
    const resource = (await resourcesFor(this.db, workflow.userId, fields)).find((r) => r.id === q.resource);
    if (workflow.pausedAt || !field || !resource) throw new NotFoundException();
    const language = await workspaceLanguage(this.db, workflow.userId);
    const copy = publicCopy[language];
    const { from, to } = dayWindow(q.date, field.timezone!);
    const busy = await busyBetween(this.db, workflow.userId, resource.id, from, to);
    return { title: fill(copy.openTimes, { date: dayLabel(q.date, field.timezone!, language) }), empty: copy.noTimes, slots: daySlots({ date: q.date, timezone: field.timezone!, slotMinutes: field.slotMinutes!, busy, now: Date.now() }) };
  }

  @Post(FORM_PATHS)
  @HttpCode(200)
  // Guards run before interceptors, so an IP over the limit is refused before multer reads a byte of the body.
  @UseGuards(RateLimit(10), UploadBudget())
  // No storage option: multer keeps the files in memory, which is all the 5 MB limit allows.
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: FILE_MAX_BYTES, files: FILES_PER_SUBMISSION, fields: 50, fieldSize: 64 * 1024, parts: 60 } }))
  @Header("Content-Type", "text/html; charset=utf-8")
  async submit(@Param("id", new ZodPipe(z.uuid())) id: string, @Body() body: Record<string, unknown> | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response, @UploadedFiles() parts: Part[] | undefined) {
    const { fields, versionId, workflow, tracked, businessName } = await this.form(id);
    const embed = isFormEmbed(req.path);
    // Paused (N11b): nothing is stored and the visitor is told, so they can try later or phone the business.
    if (workflow.pausedAt) {
      res.status(HttpStatus.CONFLICT);
      return this.pausedPage(workflow.userId, embed);
    }
    const language = await workspaceLanguage(this.db, workflow.userId);
    const copy = publicCopy[language];
    const brand = await pageBrand(this.db, workflow.userId);
    // Bots fill every field. Answer as if it worked so they learn nothing.
    if (body?.[HONEYPOT]) return page(`<p class="lead">${copy.thanks}</p>`, copy.form, language, brand, embed);
    const wantsHtml = req.accepts(["json", "html"]) === "html";
    try {
      const stored = readParts(fields, parts ?? []);
      const hasFiles = fields.some((f) => f.type === "file");
      const parsed = parsePayload(fields, body ?? {}, { resources: await resourcesFor(this.db, workflow.userId, fields), files: hasFiles ? stored.refs : undefined });
      if (!parsed.ok) throw new BadRequestException(parsed.errors);
      // A browser is told at once when the time it chose was booked meanwhile. An API caller still gets the booking step's "taken" branch (decision 0080).
      if (wantsHtml) await this.checkSlot(workflow.userId, fields, parsed.data, language);
      const key = z.uuid().safeParse(body?.[SUBMISSION_KEY]);
      if (tracked && !key.success) throw new BadRequestException(`${SUBMISSION_KEY}: reload the form and send it again`);
      // A tracked form claims inside recordRequest, after its key check, so a repeat costs nothing (decision 0057).
      const overQuota = (err: unknown): never => {
        throw err instanceof QuotaError ? new HttpException({ message: OVER_QUOTA }, HttpStatus.TOO_MANY_REQUESTS) : err;
      };
      if (!tracked && stored.files.length > 0) await claimUsage(this.db, workflow.userId, "upload", { n: stored.files.length }).catch(overQuota);
      if (!tracked) {
        const runId = await createRun(this.db, versionId, parsed.data, stored.files.length > 0 ? { uploads: { userId: workflow.userId, files: stored.files } } : {});
        await enqueueRun(this.boss, runId);
        return page(`<p class="lead">${copy.thanks}</p>`, copy.form, language, brand, embed);
      }

      // A member of this workspace who is signed in is recorded as the requester, for My requests (decision 0022).
      // SameSite=Lax stops other sites but not a sibling origin of the same site, so only this installation's own origin counts (decision 0057).
      const sameOrigin = req.get("origin") === new URL(this.config.publicUrl!).origin;
      const member = embed || !sameOrigin ? undefined : await sessionUser(this.db, req);
      const requestedBy = member?.workspaceId === workflow.userId ? member.id : undefined;
      const { reference, runId } = await recordRequest(this.db, workflow, versionId, key.success ? key.data : "", parsed.data, requestedBy, stored.files).catch(overQuota);
      if (runId) await enqueueRun(this.boss, runId);
      return page(
        `<h1>${copy.received}</h1><div class="receipt"><div><span class="k">${copy.reference}</span><strong class="ref">${reference}</strong></div><span class="pill">${copy.receivedPill}</span></div><p class="lead">${copy.receipt}</p><p><a href="">${copy.another}</a></p>`,
        copy.received,
        language,
        brand,
        embed,
      );
    } catch (err) {
      // A browser gets the form back with the reasons beside the fields; an API caller keeps the JSON error (decision 0079).
      const status = err instanceof HttpException ? err.getStatus() : 0;
      const taken = err instanceof SlotTaken ? err.view : undefined;
      if ((status !== HttpStatus.BAD_REQUEST && status !== HttpStatus.TOO_MANY_REQUESTS && !taken) || !wantsHtml) throw err;
      res.status(status);
      const resources = await resourcesFor(this.db, workflow.userId, fields);
      return renderForm(fields, resources, tracked ? randomUUID() : undefined, businessName ?? undefined, language, brand, { values: body, errors: taken ? undefined : messagesOf(err as HttpException), embed, formId: id, taken });
    }
  }

  private async pausedPage(workspaceId: string, embed: boolean) {
    const language = await workspaceLanguage(this.db, workspaceId);
    const copy = publicCopy[language];
    return page(`<h1>${copy.paused}</h1><span class="pill">${copy.pausedPill}</span><p class="lead">${copy.pausedNote}</p>`, copy.paused, language, await pageBrand(this.db, workspaceId), embed);
  }

  /** Throws SlotTaken when the resource and time in a booking form's answers overlap an active booking. */
  private async checkSlot(workspaceId: string, fields: FormField[], data: Record<string, unknown>, language: "en" | "tl") {
    const rf = fields.find((f) => f.type === "resource");
    const tf = fields.find((f) => f.type === "datetime" && f.slotMinutes);
    const resource = rf && (data[rf.name] as { id?: string; name?: string } | undefined);
    const when = tf && data[tf.name];
    if (!tf || !resource?.id || typeof when !== "string") return;
    const start = new Date(when);
    const busy = await busyBetween(this.db, workspaceId, resource.id, start, new Date(start.getTime() + tf.slotMinutes! * 60_000));
    if (!isTaken(start, tf.slotMinutes!, busy)) return;
    const copy = publicCopy[language];
    const label = `${dayLabel(when.slice(0, 10), tf.timezone!, language)}, ${clock(Number(when.slice(11, 13)) * 60 + Number(when.slice(14, 16)))}`;
    throw new SlotTaken({ field: tf.name, title: copy.slotGone, body: fill(copy.slotGoneBody, { resource: resource.name ?? "", when: label }) });
  }

  private form(id: string) {
    return findForm(this.db, id);
  }
}

/** The chosen time was booked while the visitor filled in the form. Carries what the re-rendered form says. */
class SlotTaken extends HttpException {
  constructor(readonly view: NonNullable<FormView["taken"]>) {
    super({ message: view.title }, HttpStatus.CONFLICT);
  }
}

/** Serves the small script behind the booking form's open times. Public and static, so script-src 'self' holds. */
@Controller("public")
export class PublicAssetsController {
  @Get("slots.js")
  @Header("Content-Type", "application/javascript; charset=utf-8")
  @Header("Cache-Control", "public, max-age=300")
  slotsScript() {
    return SLOTS_JS;
  }

  /** The phone-side photo compressor (R5). Public and static, so script-src 'self' holds. */
  @Get("compress.js")
  @Header("Content-Type", "application/javascript; charset=utf-8")
  @Header("Cache-Control", "public, max-age=300")
  compressScript() {
    return COMPRESS_JS;
  }
}

/** The reasons an HttpException carries: a list from parsePayload, or one message. */
function messagesOf(err: HttpException): string[] {
  const response = err.getResponse();
  const message = typeof response === "string" ? response : (response as { message?: unknown }).message;
  return Array.isArray(message) ? message.map(String) : [typeof message === "string" ? message : err.message];
}

/**
 * Checks the uploaded parts against the form's file fields. The type comes from the file's own bytes: the browser's
 * mimetype and the extension are ignored. Empty parts (a file input left blank) are skipped.
 */
function readParts(fields: FormField[], parts: Part[]): { files: NewUpload[]; refs: Record<string, FileRef[]> } {
  const fileFields = new Set(fields.filter((f) => f.type === "file").map((f) => f.name));
  const refs: Record<string, FileRef[]> = Object.fromEntries([...fileFields].map((n) => [n, []]));
  const files: NewUpload[] = [];
  for (const p of parts) {
    if (p.size === 0 && !p.originalname) continue;
    if (!fileFields.has(p.fieldname)) throw new BadRequestException(`${p.fieldname}: this field does not take files`);
    const type = fileType(p.buffer);
    if (!type || p.size === 0) throw new BadRequestException(`${p.fieldname}: ${FILE_TYPES_MESSAGE}`);
    const list = refs[p.fieldname]!;
    if (list.length >= FILES_PER_FIELD) throw new BadRequestException(`${p.fieldname}: must be at most ${FILES_PER_FIELD} files`);
    const name = safeFileName(p.originalname);
    const id = randomUUID();
    list.push({ id, name, type, size: p.size });
    files.push({ id, field: p.fieldname, name, type, data: p.buffer });
  }
  return { files, refs };
}

// Crockford base32 without I, L, O and U, so a reference read aloud or copied by hand stays unambiguous.
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// ponytail: 32^6 (about 1e9) random references; a collision fails that one submission with a 500. Lengthen when volume grows.
export const newReference = () => `REQ-${Array.from({ length: 6 }, () => REFERENCE_ALPHABET[randomInt(32)]).join("")}`;

/**
 * Saves the request and its pending run in one transaction. The unique (workflow, submission key) index makes a
 * double-click or a retried post return the first request's reference; runId is set only when this call created it.
 * The upload allowance is claimed in the same transaction, so a repeat or a losing duplicate spends nothing.
 */
export async function recordRequest(db: Db, workflow: { id: string; userId: string }, versionId: string, submissionKey: string, data: Record<string, unknown>, requestedBy?: string, files: NewUpload[] = []) {
  const find = () =>
    db
      .select({ reference: requests.reference, runId: requests.runId })
      .from(requests)
      .where(and(eq(requests.workflowId, workflow.id), eq(requests.submissionKey, submissionKey)));
  const [existing] = await find();
  if (existing) return { reference: existing.reference, existingRunId: existing.runId };

  const reference = newReference();
  try {
    const runId = await db.transaction(async (tx) => {
      await assertNotPaused(tx, versionId);
      if (files.length > 0) await claimUsage(tx, workflow.userId, "upload", { n: files.length });
      const [run] = await tx.insert(runs).values({ workflowVersionId: versionId, triggerPayload: { ...data, reference } }).returning({ id: runs.id });
      await tx.insert(requests).values({ userId: workflow.userId, workflowId: workflow.id, runId: run!.id, reference, submissionKey, subject: String(data.summary ?? ""), requestedBy });
      await saveUploads(tx, { userId: workflow.userId, runId: run!.id, files });
      return run!.id;
    });
    return { reference, runId };
  } catch (err) {
    // The same key committed between our lookup and insert: answer with that request.
    const [dup] = isUniqueViolation(err) ? await find() : [];
    if (dup) return { reference: dup.reference, existingRunId: dup.runId };
    throw err;
  }
}

export { escapeHtml, type PageBrand } from "./public-pages";

export async function pageBrand(db: Db, workspaceId: string): Promise<PageBrand | undefined> {
  const brand = await readBrand(db, workspaceId);
  return brand ? { id: workspaceId, name: brand.name, accent: brand.accent, ink: brand.ink, logo: !!brand.logo } : undefined;
}

export const page = (body: string, title = "Form", language: "en" | "tl" = "en", brand?: PageBrand, embed = false) => shell({ body, title, language, brand, embed });

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? "");

/** The line under a send button: who gets the answers, what for, and that the customer can ask to see or delete them (decision 0094). */
export function privacyNotice(language: "en" | "tl", business?: string) {
  const copy = publicCopy[language];
  const name = business ? escapeHtml(business) : undefined;
  return `<p class="hint">${fill(copy.notice, { a: name ?? copy.noticeA, b: name ?? copy.noticeB })}</p>`;
}

/** What a re-rendered form keeps: the visitor's answers (never files), the reasons it was refused and whether it sits in an iframe. */
export type FormView = { values?: Record<string, unknown>; errors?: string[]; embed?: boolean; formId?: string; taken?: { field: string; title: string; body: string } };

/** businessName comes from the owner's profile, so a form behind a website's contact button says whose form it is. */
export function renderForm(fields: FormField[], resources: Resource[], submissionKey?: string, businessName?: string, language: "en" | "tl" = "en", brand?: PageBrand, view: FormView = {}) {
  const copy = publicCopy[language];
  const { byField, general } = splitErrors(view.errors ?? [], fields.map((f) => f.name));
  const answer = (name: string) => (typeof view.values?.[name] === "string" ? (view.values[name] as string) : "");
  const control = (f: FormField) => {
    const bad = byField.has(f.name) || view.taken?.field === f.name;
    const attrs = `id="${f.name}" name="${f.name}"${f.required ? " required" : ""}${bad ? ` class="bad" aria-invalid="true" aria-describedby="e-${f.name}"` : ""}`;
    const value = answer(f.name);
    // The browser's own limits are a convenience; the server checks the same ones (parsePayload).
    const limits = f.type === "number" ? `${f.min !== undefined ? ` min="${f.min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""} step="${f.integer ? 1 : "any"}"` : "";
    const given = value ? ` value="${escapeHtml(value)}"` : "";
    if (f.type === "textarea") return `<textarea ${attrs} maxlength="5000">${escapeHtml(value)}</textarea>`;
    // The server reads a datetime in the field's zone and checks the slot and "in the future" itself (parseZoned).
    // The browser counts steps from 1970-01-01T00:00, which meets every local midnight only when the slot divides
    // the day; other grids get whole minutes here, so no slot the server accepts is blocked (decision 0031).
    if (f.type === "datetime") {
      const slot = f.slotMinutes && 1440 % f.slotMinutes === 0 ? f.slotMinutes : 1;
      const grid = f.slotMinutes ? ` ${f.slotMinutes === 60 ? copy.slotHour : fill(copy.slotEvery, { n: String(f.slotMinutes) })}` : "";
      return `<input ${attrs} type="datetime-local" step="${slot * 60}"${given}><div class="hint">${copy.times} ${escapeHtml(f.timezone!)}.${grid}</div>`;
    }
    if (f.type === "file") return `<input ${attrs} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif" multiple><div class="hint">${fill(copy.fileHint, { n: String(FILES_PER_FIELD), mb: String(FILE_MAX_BYTES / 1024 / 1024) })}</div>`;
    if (f.type === "resource") return `<select ${attrs}><option value="">${copy.choose}</option>${resources.map((r) => `<option value="${r.id}"${r.id === value ? " selected" : ""}>${escapeHtml(r.name)}</option>`).join("")}</select>`;
    return `<input ${attrs} type="${f.type}"${limits}${given}>`;
  };
  // A form with a resource and a datetime on a slot grid is a booking form: the open times appear under the date field (script at /public/slots.js).
  const resourceField = fields.find((f) => f.type === "resource");
  const slotField = fields.find((f) => f.type === "datetime" && f.slotMinutes);
  const booking = view.formId && resourceField && slotField ? { id: view.formId, resource: resourceField.name, field: slotField.name } : undefined;
  const slots = (f: FormField) => (booking && f.name === booking.field ? `<fieldset class="slots" data-slots hidden data-url="/forms/${booking.id}/slots" data-resource="${booking.resource}" data-field="${booking.field}"><legend></legend><div class="chips"></div></fieldset>` : "");
  const field = (f: FormField) => `<div class="f"><label for="${f.name}">${escapeHtml(f.label)}</label>${control(f)}${byField.has(f.name) ? `<div class="er" id="e-${f.name}">${escapeHtml(byField.get(f.name)!)}</div>` : ""}${slots(f)}</div>`;
  const inputs = groupFields(fields)
    .map((row) => (row.length > 1 ? `<div class="row">${row.map(field).join("")}</div>` : field(row[0]!)))
    .join("");
  const alert = view.taken ? `<div class="alert" role="alert"><b>${escapeHtml(view.taken.title)}</b><div>${escapeHtml(view.taken.body)}</div></div>` : view.errors?.length ? `<div class="alert" role="alert"><b>${copy.notSent}</b><div>${[...byField].map(([n, m]) => `${escapeHtml(n)}: ${escapeHtml(m)}`).concat(general.map(escapeHtml)).join("<br>")}</div></div>` : "";
  // Hidden from people (off screen, skipped by tab and screen readers) but visible to bots that fill every input.
  const honeypot = `<div aria-hidden="true" style="position:absolute;left:-9999px"><label for="${HONEYPOT}">Website</label><input id="${HONEYPOT}" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></div>`;
  const key = submissionKey ? `<input type="hidden" name="${SUBMISSION_KEY}" value="${submissionKey}">` : "";
  const heading = businessName ? `<h1>${escapeHtml(businessName)}</h1>` : "";
  const slotsScript = (booking ? '<script src="/public/slots.js" defer></script>' : "") + (fields.some((f) => f.type === "file") ? COMPRESS_TAG : "");
  return page(`${heading}${alert}<form method="post"${fields.some((f) => f.type === "file") ? ' enctype="multipart/form-data"' : ""}>${inputs}${honeypot}${key}<button class="btn" type="submit">${copy.send}</button>${privacyNotice(language, businessName)}</form>${slotsScript}`, businessName ? escapeHtml(businessName) : copy.form, language, brand, view.embed);
}

import { publicCopy } from "./public-copy";
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { claimUsage, QuotaError, readBrand, saveUploads, workspaceLanguage, businessProfiles, connectionCredential, connections, createKeyedRun, createRun, eventSeen, markPaymentPaid, markPaymentRefunded, paymongoMode, publishedVersion, readSecret, recordEvent, requests, runs, triggers, verifyPaymongoSignature, workflows, type Db, type NewUpload, type Payment } from "@daloy/db";
import { definitionSchema, FILE_MAX_BYTES, FILES_PER_FIELD, FILES_PER_SUBMISSION, fileType, OFFICE_REQUEST, parsePayload, PURCHASE_REQUEST, safeFileName, type FileRef, type FormField, type Resource } from "@daloy/engine";
import {
  BadRequestException,
  Body,
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
  Req,
  UnauthorizedException,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  type RawBodyRequest,
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { and, eq, sql } from "drizzle-orm";
import type { Request } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { BOSS, CONFIG, DB, enqueueRun, eventKey, isUniqueViolation, RateLimit, replayedRun, validPayload, ZodPipe, type ApiConfig } from "./http";
import { sessionUser } from "./auth";
import { resourcesFor } from "./resources";

// Starts with "_", which no field name can (definition.ts), so a real "website" field is never mistaken for it.
const HONEYPOT = "_website";

/** Both guided templates record a request with a reference, from the form and from MCP; a custom form only starts a run. */
export const isTracked = (setup: unknown) => [OFFICE_REQUEST, PURCHASE_REQUEST].includes((setup as { template?: string } | null)?.template ?? "");
const SUBMISSION_KEY = "submission_key";

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
    @Headers("x-daloy-signature") signature: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    const [row] = await this.db
      .select({ trigger: triggers, userId: workflows.userId })
      .from(triggers)
      .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
      .where(eq(triggers.webhookPath, path));
    const version = row && (await publishedVersion(this.db, row.trigger.workflowId));
    if (!row || !version) throw new NotFoundException();

    const secretName = (row.trigger.config as { hmacSecret?: string }).hmacSecret;
    if (secretName) {
      // Fails closed: a missing secret rejects every call instead of accepting unsigned ones.
      const key = await readSecret(this.db, this.config.secretsKey, row.userId, secretName);
      if (!key || !validSignature(req.rawBody ?? Buffer.alloc(0), signature, key)) throw new UnauthorizedException("bad signature");
    }

    const { trigger } = definitionSchema.parse(version.definition);
    const first = await replayedRun(this.db, row.trigger.workflowId, trigger, req.body, idempotencyKey);
    if (first) return { runId: first, duplicate: true };
    const fields = (row.trigger.config as { fields?: FormField[] }).fields;
    const payload = validPayload(fields, req.body ?? {}, await resourcesFor(this.db, row.userId, fields));
    // A repeated event gets the first run back and starts nothing (decision 0029).
    const { runId, duplicate } = await createKeyedRun(this.db, row.trigger.workflowId, version.id, payload, eventKey(trigger, payload, idempotencyKey));
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
    if (!signature || !verifyPaymongoSignature({ header: signature, rawBody, secret: webhookSecret, mode, nowSeconds: Math.floor(Date.now() / 1000) })) throw new UnauthorizedException();

    const data = (req.body as { data?: { id?: unknown; attributes?: { type?: unknown; livemode?: unknown; data?: { id?: unknown; attributes?: { payments?: { id?: unknown; attributes?: { amount?: unknown; currency?: unknown; status?: unknown } }[] } } } } } | undefined)?.data;
    const eventId = data?.id;
    const type = data?.attributes?.type;
    if (!data || typeof eventId !== "string" || typeof type !== "string") throw new BadRequestException();
    if ((data.attributes?.livemode === true) !== (mode === "live")) throw new BadRequestException("event mode does not match the connection");
    if (await eventSeen(this.db, eventId)) return { duplicate: true };

    const resource = data.attributes?.data;
    let started: { payment: Payment; status: "paid" | "refunded" } | undefined;
    if (type === "checkout_session.payment.paid" && typeof resource?.id === "string") {
      const paid = resource.attributes?.payments?.find((p) => p.attributes?.status === "paid");
      const { amount, currency } = paid?.attributes ?? {};
      if (typeof paid?.id === "string" && typeof amount === "number" && typeof currency === "string") {
        const r = await markPaymentPaid(this.db, { userId: owner.userId, sessionId: resource.id, paymentId: paid.id, amount, currency });
        if (r.payment?.status === "paid") started = { payment: r.payment, status: "paid" };
      }
    } else if (type === "payment.refunded" && typeof resource?.id === "string") {
      const r = await markPaymentRefunded(this.db, { userId: owner.userId, providerPaymentId: resource.id });
      if (r.payment?.status === "refunded") started = { payment: r.payment, status: "refunded" };
    }
    // Started on the payment's state, not on whether this call changed it: a crash after the update but before the runs
    // is retried by PayMongo and still starts them. The key is payment + status, so a replay or a second event starts nothing.
    if (started) await this.startRuns(owner.userId, started.payment, started.status);
    await recordEvent(this.db, { eventId, userId: owner.userId, type });
    return { ok: true };
  }

  /** One run for each published workflow of the owner that listens for this status. */
  private async startRuns(userId: string, p: Payment, status: "paid" | "refunded") {
    const listeners = await this.db
      .select({ workflowId: triggers.workflowId, config: triggers.config })
      .from(triggers)
      .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
      .where(and(eq(workflows.userId, userId), eq(triggers.type, "payment")));
    const payload = { status, reference: p.reference, amount: p.amountCentavos, currency: p.currency, paymentId: p.id, sourceRunId: p.runId, providerPaymentId: p.providerPaymentId };
    for (const l of listeners) {
      if (!((l.config as { events?: string[] }).events ?? ["paid"]).includes(status)) continue;
      const version = await publishedVersion(this.db, l.workflowId);
      if (!version) continue;
      const { runId, duplicate } = await createKeyedRun(this.db, l.workflowId, version.id, payload, `paymongo:${p.id}:${status}`);
      if (!duplicate) await enqueueRun(this.boss, runId);
    }
  }
}

/** X-Daloy-Signature: sha256=<hex HMAC of the raw body>, compared in constant time. */
export function validSignature(body: Buffer, header: string | undefined, key: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", key).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

@Controller("forms")
export class FormsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  @Get(FORM_PATHS)
  @Header("Content-Type", "text/html; charset=utf-8")
  // A request form carries a fresh submission key per load. no-store keeps the back button from reusing an old one.
  @Header("Cache-Control", "no-store")
  async page(@Param("id", new ZodPipe(z.uuid())) id: string) {
    const { fields, tracked, businessName, workflow } = await this.form(id);
    return renderForm(fields, await resourcesFor(this.db, workflow.userId, fields), tracked ? randomUUID() : undefined, businessName ?? undefined, await workspaceLanguage(this.db, workflow.userId), await pageBrand(this.db, workflow.userId));
  }

  @Post(FORM_PATHS)
  @HttpCode(200)
  // Guards run before interceptors, so an IP over the limit is refused before multer reads a byte of the body.
  @UseGuards(RateLimit(10))
  // No storage option: multer keeps the files in memory, which is all the 5 MB limit allows.
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: FILE_MAX_BYTES, files: FILES_PER_SUBMISSION, fields: 50, fieldSize: 64 * 1024, parts: 60 } }))
  @Header("Content-Type", "text/html; charset=utf-8")
  async submit(@Param("id", new ZodPipe(z.uuid())) id: string, @Body() body: Record<string, unknown> | undefined, @Req() req: Request, @UploadedFiles() parts: Part[] | undefined) {
    const { fields, versionId, workflow, tracked } = await this.form(id);
    const language = await workspaceLanguage(this.db, workflow.userId);
    const copy = publicCopy[language];
    const brand = await pageBrand(this.db, workflow.userId);
    // Bots fill every field. Answer as if it worked so they learn nothing.
    if (body?.[HONEYPOT]) return page(copy.thanks, copy.form, language, brand);
    const stored = readParts(fields, parts ?? []);
    const hasFiles = fields.some((f) => f.type === "file");
    const parsed = parsePayload(fields, body ?? {}, { resources: await resourcesFor(this.db, workflow.userId, fields), files: hasFiles ? stored.refs : undefined });
    if (!parsed.ok) throw new BadRequestException(parsed.errors);
    const key = z.uuid().safeParse(body?.[SUBMISSION_KEY]);
    if (tracked && !key.success) throw new BadRequestException(`${SUBMISSION_KEY}: reload the form and send it again`);
    if (stored.files.length > 0) {
      await claimUsage(this.db, workflow.userId, "upload", { n: stored.files.length }).catch((err: unknown) => {
        throw err instanceof QuotaError ? new HttpException({ message: OVER_QUOTA }, HttpStatus.TOO_MANY_REQUESTS) : err;
      });
    }
    if (!tracked) {
      const runId = await createRun(this.db, versionId, parsed.data, stored.files.length > 0 ? { uploads: { userId: workflow.userId, files: stored.files } } : {});
      await enqueueRun(this.boss, runId);
      return page(copy.thanks, copy.form, language, brand);
    }

    // A member of this workspace who is signed in is recorded as the requester, for My requests (decision 0022).
    // The session cookie is SameSite=Lax, so another site can't post the form as them.
    const member = isFormEmbed(req.path) ? undefined : await sessionUser(this.db, req);
    const requestedBy = member?.workspaceId === workflow.userId ? member.id : undefined;
    const { reference, runId } = await recordRequest(this.db, workflow, versionId, key.success ? key.data : "", parsed.data, requestedBy, stored.files);
    if (runId) await enqueueRun(this.boss, runId);
    return page(
      `<h1>${copy.received}</h1><p>${copy.reference} <strong>${reference}</strong>. ${copy.receipt}</p><p><a href="">${copy.another}</a></p>`,
      copy.received,
      language,
      brand,
    );
  }

  private async form(id: string) {
    const [row] = await this.db
      .select({ trigger: triggers, workflow: { id: workflows.id, userId: workflows.userId, setup: workflows.setup }, businessName: businessProfiles.businessName })
      .from(triggers)
      .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
      .leftJoin(businessProfiles, eq(businessProfiles.userId, workflows.userId))
      .where(and(eq(triggers.id, id), eq(triggers.type, "form")));
    const version = row && (await publishedVersion(this.db, row.trigger.workflowId));
    if (!row || !version) throw new NotFoundException();
    const tracked = isTracked(row.workflow.setup);
    return { fields: (row.trigger.config as { fields: FormField[] }).fields, versionId: version.id, workflow: row.workflow, tracked, businessName: row.businessName };
  }
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

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/** What the owner's brand adds to a public page. accent is a checked #rrggbb and ink the readable text colour on it. */
export type PageBrand = { id: string; name: string | null; accent: string | null; ink: string | null; logo: boolean };

export async function pageBrand(db: Db, workspaceId: string): Promise<PageBrand | undefined> {
  const brand = await readBrand(db, workspaceId);
  return brand ? { id: workspaceId, name: brand.name, accent: brand.accent, ink: brand.ink, logo: !!brand.logo } : undefined;
}

const brandHead = (b: PageBrand) =>
  `<style>header img{max-height:64px;max-width:240px}${b.accent ? `h1{border-bottom:4px solid ${b.accent};padding-bottom:.3em}button{background:${b.accent};color:${b.ink};border:0;padding:.6em 1.2em;border-radius:4px;font:inherit;cursor:pointer}` : ""}</style>`;
const brandLogo = (b: PageBrand) => (b.logo ? `<header><img src="/brand/logo/${b.id}" alt="${escapeHtml(b.name ?? "")}"></header>` : "");

export const page = (body: string, title = "Form", language: "en" | "tl" = "en", brand?: PageBrand) =>
  `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${brand ? brandHead(brand) : ""}</head><body>${brand ? brandLogo(brand) : ""}<main>${body}</main></body></html>`;

/** businessName comes from the owner's profile, so a form behind a website's contact button says whose form it is. */
export function renderForm(fields: FormField[], resources: Resource[], submissionKey?: string, businessName?: string, language: "en" | "tl" = "en", brand?: PageBrand) {
  const copy = publicCopy[language];
  const inputs = fields
    .map((f) => {
      const attrs = `id="${f.name}" name="${f.name}"${f.required ? " required" : ""}`;
      // The browser's own limits are a convenience; the server checks the same ones (parsePayload).
      const limits = f.type === "number" ? `${f.min !== undefined ? ` min="${f.min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""} step="${f.integer ? 1 : "any"}"` : "";
      let control = f.type === "textarea" ? `<textarea ${attrs} maxlength="5000"></textarea>` : `<input ${attrs} type="${f.type}"${limits}>`;
      // The server reads a datetime in the field's zone and checks the slot and "in the future" itself (parseZoned).
      // The browser counts steps from 1970-01-01T00:00, which meets every local midnight only when the slot divides
      // the day; other grids get whole minutes here, so no slot the server accepts is blocked (decision 0031).
      const slot = f.slotMinutes && 1440 % f.slotMinutes === 0 ? f.slotMinutes : 1;
      if (f.type === "datetime") control = `<input ${attrs} type="datetime-local" step="${slot * 60}"><br><small>${copy.times} ${escapeHtml(f.timezone!)}</small>`;
      if (f.type === "file") control = `<input ${attrs} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif" multiple>`;
      if (f.type === "resource") control = `<select ${attrs}><option value="">${copy.choose}</option>${resources.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join("")}</select>`;
      return `<p><label for="${f.name}">${escapeHtml(f.label)}</label><br>${control}</p>`;
    })
    .join("");
  // Hidden from people (off screen, skipped by tab and screen readers) but visible to bots that fill every input.
  const honeypot = `<div aria-hidden="true" style="position:absolute;left:-9999px"><label for="${HONEYPOT}">Website</label><input id="${HONEYPOT}" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></div>`;
  const key = submissionKey ? `<input type="hidden" name="${SUBMISSION_KEY}" value="${submissionKey}">` : "";
  const heading = businessName ? `<h1>${escapeHtml(businessName)}</h1>` : "";
  return page(`${heading}<form method="post"${fields.some((f) => f.type === "file") ? ' enctype="multipart/form-data"' : ""}>${inputs}${honeypot}${key}<button type="submit">${copy.send}</button></form>`, businessName ? escapeHtml(businessName) : copy.form, language, brand);
}

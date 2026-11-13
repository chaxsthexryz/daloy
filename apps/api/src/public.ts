import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createRun, publishedVersion, readSecret, requests, runs, triggers, workflows, type Db } from "@daloy/db";
import { OFFICE_REQUEST, type FormField } from "@daloy/engine";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  type RawBodyRequest,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { BOSS, CONFIG, DB, enqueueRun, isUniqueViolation, RateLimit, ZodPipe, type ApiConfig } from "./http";

const HONEYPOT = "website";
const SUBMISSION_KEY = "submission_key";

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

    const runId = await createRun(this.db, version.id, req.body ?? {});
    await enqueueRun(this.boss, runId);
    return { runId };
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

  @Get(":id")
  @Header("Content-Type", "text/html; charset=utf-8")
  // A request form carries a fresh submission key per load. no-store keeps the back button from reusing an old one.
  @Header("Cache-Control", "no-store")
  async page(@Param("id", new ZodPipe(z.uuid())) id: string) {
    const { fields, tracked } = await this.form(id);
    return renderForm(fields, tracked ? randomUUID() : undefined);
  }

  @Post(":id")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  @Header("Content-Type", "text/html; charset=utf-8")
  async submit(@Param("id", new ZodPipe(z.uuid())) id: string, @Body() body: Record<string, unknown> | undefined) {
    const { fields, versionId, workflow, tracked } = await this.form(id);
    // Bots fill every field. Answer as if it worked so they learn nothing.
    if (body?.[HONEYPOT]) return page("Thanks, we received your message.");
    const parsed = fieldsSchema(fields).safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    if (!tracked) {
      const runId = await createRun(this.db, versionId, parsed.data);
      await enqueueRun(this.boss, runId);
      return page("Thanks, we received your message.");
    }

    const key = z.uuid().safeParse(body?.[SUBMISSION_KEY]);
    if (!key.success) throw new BadRequestException(`${SUBMISSION_KEY}: reload the form and send it again`);
    const { reference, runId } = await recordRequest(this.db, workflow, versionId, key.data, parsed.data);
    if (runId) await enqueueRun(this.boss, runId);
    return page(
      `<h1>Request received</h1><p>Your reference is <strong>${reference}</strong>. Quote it if you ask about this request. A receipt is on its way to your email.</p><p><a href="">Send another request</a></p>`,
      "Request received",
    );
  }

  private async form(id: string) {
    const [row] = await this.db
      .select({ trigger: triggers, workflow: { id: workflows.id, userId: workflows.userId, setup: workflows.setup } })
      .from(triggers)
      .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
      .where(and(eq(triggers.id, id), eq(triggers.type, "form")));
    const version = row && (await publishedVersion(this.db, row.trigger.workflowId));
    if (!row || !version) throw new NotFoundException();
    const tracked = (row.workflow.setup as { template?: string } | null)?.template === OFFICE_REQUEST;
    return { fields: (row.trigger.config as { fields: FormField[] }).fields, versionId: version.id, workflow: row.workflow, tracked };
  }
}

// Crockford base32 without I, L, O and U, so a reference read aloud or copied by hand stays unambiguous.
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// ponytail: 32^6 (about 1e9) random references; a collision fails that one submission with a 500. Lengthen when volume grows.
export const newReference = () => `REQ-${Array.from({ length: 6 }, () => REFERENCE_ALPHABET[randomInt(32)]).join("")}`;

/**
 * Saves the request and its pending run in one transaction. The unique (workflow, submission key) index makes a
 * double-click or a retried post return the first request's reference; runId is set only when this call created it.
 */
export async function recordRequest(db: Db, workflow: { id: string; userId: string }, versionId: string, submissionKey: string, data: Record<string, unknown>) {
  const find = () =>
    db
      .select({ reference: requests.reference })
      .from(requests)
      .where(and(eq(requests.workflowId, workflow.id), eq(requests.submissionKey, submissionKey)));
  const [existing] = await find();
  if (existing) return { reference: existing.reference };

  const reference = newReference();
  try {
    const runId = await db.transaction(async (tx) => {
      const [run] = await tx.insert(runs).values({ workflowVersionId: versionId, triggerPayload: { ...data, reference } }).returning({ id: runs.id });
      await tx.insert(requests).values({ userId: workflow.userId, workflowId: workflow.id, runId: run!.id, reference, submissionKey, subject: String(data.summary ?? "") });
      return run!.id;
    });
    return { reference, runId };
  } catch (err) {
    // The same key committed between our lookup and insert: answer with that request.
    const [dup] = isUniqueViolation(err) ? await find() : [];
    if (dup) return { reference: dup.reference };
    throw err;
  }
}

/** Builds the zod schema for a submission. Unknown keys (the honeypot included) are dropped. */
export function fieldsSchema(fields: FormField[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    const base = f.type === "email" ? z.email().max(254) : f.type === "number" ? z.coerce.number() : z.string().trim().min(1).max(f.type === "textarea" ? 5000 : 500);
    // An empty input means "not given", so optional fields accept it and required ones reject it.
    shape[f.name] = z.preprocess((v) => (v === "" ? undefined : v), f.required ? base : base.optional());
  }
  return z.object(shape);
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

export const page = (body: string, title = "Form") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main>${body}</main></body></html>`;

function renderForm(fields: FormField[], submissionKey?: string) {
  const inputs = fields
    .map((f) => {
      const attrs = `id="${f.name}" name="${f.name}"${f.required ? " required" : ""}`;
      const control = f.type === "textarea" ? `<textarea ${attrs} maxlength="5000"></textarea>` : `<input ${attrs} type="${f.type}">`;
      return `<p><label for="${f.name}">${escapeHtml(f.label)}</label><br>${control}</p>`;
    })
    .join("");
  // Hidden from people (off screen, skipped by tab and screen readers) but visible to bots that fill every input.
  const honeypot = `<div aria-hidden="true" style="position:absolute;left:-9999px"><label for="${HONEYPOT}">Website</label><input id="${HONEYPOT}" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></div>`;
  const key = submissionKey ? `<input type="hidden" name="${SUBMISSION_KEY}" value="${submissionKey}">` : "";
  return page(`<form method="post">${inputs}${honeypot}${key}<button type="submit">Send</button></form>`);
}

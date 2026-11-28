import { randomBytes } from "node:crypto";
import { adminActions, adminRecoveryCodes, adminTotp, decryptSecret, encryptSecret, sessions, type Db } from "@daloy/db";
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Request } from "express";
import * as z from "zod";
import { AdminSessionGuard, twoFactorState } from "./admin";
import { sessionIdHash } from "./auth";
import { CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { base32Decode, base32Encode, otpauthUri, verifyTotp } from "./totp";

// The encryptSecret associated-data name, so this ciphertext cannot pass for any other secret of the same account.
const AAD_NAME = "admin_totp";
const ISSUER = "kymavo admin";
const RECOVERY_CODES = 10;
// Wrong codes per admin in 15 minutes before every check answers 429. Counted from admin_actions, so a restart keeps them.
const MAX_FAILURES = 5;

const code = z.string().regex(/^\d{6}$/, "enter the 6 digits your app shows");
const codeInput = new ZodPipe(z.strictObject({ code }));
const verifyInput = new ZodPipe(z.union([z.strictObject({ code }), z.strictObject({ recoveryCode: z.string().trim().min(1).max(40) })]));
// Recovery codes are shown as two groups of five; dashes, spaces and case do not matter when typed back.
const normalise = (s: string) => s.toLowerCase().replace(/[^a-z2-7]/g, "");
const newRecoveryCode = () => base32Encode(randomBytes(7)).slice(0, 10).toLowerCase().replace(/^(.{5})/, "$1-");
const WRONG = "that code is not right. Codes change every 30 seconds, and each one works once.";

type Row = typeof adminTotp.$inferSelect;

/**
 * Two-factor sign-in for platform admins (decision 0158). These routes need the admin's session but not a passed check,
 * since they are how an admin enrolls and passes it. No code, secret or recovery code is ever logged or stored in clear.
 */
@Controller("admin/2fa")
@UseGuards(AdminSessionGuard)
export class AdminTwoFactorController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async status(@Req() req: Request) {
    return { ...(await twoFactorState(this.db, req)), consoleUrl: this.config.publicUrl };
  }

  /** A new secret for an admin not yet enrolled. Starting again replaces an unconfirmed one; a confirmed one needs a reset. */
  @Post("enroll")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async enroll(@CurrentUser() admin: SessionUser) {
    const key = randomBytes(20);
    const secret = base32Encode(key);
    const encrypted = encryptSecret(this.config.secretsKey, admin.id, AAD_NAME, secret);
    const [row] = await this.db
      .insert(adminTotp)
      .values({ userId: admin.id, ...encrypted })
      .onConflictDoUpdate({ target: adminTotp.userId, set: { ...encrypted, lastStep: null, createdAt: sql`now()` }, setWhere: isNull(adminTotp.confirmedAt) })
      .returning({ userId: adminTotp.userId });
    if (!row) throw new ConflictException("two-factor sign-in is already on. Reset it first to set it up again.");
    return { secret, uri: otpauthUri(key, admin.email, ISSUER) };
  }

  /** One valid code confirms the enrollment, passes this session, and hands out the recovery codes, this once. */
  @Post("enroll/confirm")
  @HttpCode(200)
  async confirm(@CurrentUser() admin: SessionUser, @Req() req: Request, @Body(codeInput) body: { code: string }) {
    const row = await this.row(admin);
    if (!row || row.confirmedAt) throw new ConflictException("start the setup first");
    await this.useTotp(admin, row, body.code, "enroll");
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    const hashes = await Promise.all(codes.map((c) => hash(normalise(c))));
    await this.db.transaction(async (tx) => {
      const [confirmed] = await tx.update(adminTotp).set({ confirmedAt: sql`now()` }).where(and(eq(adminTotp.userId, admin.id), isNull(adminTotp.confirmedAt))).returning({ userId: adminTotp.userId });
      if (!confirmed) throw new ConflictException("start the setup first");
      await tx.insert(adminRecoveryCodes).values(hashes.map((codeHash) => ({ userId: admin.id, codeHash })));
      await tx.update(sessions).set({ secondFactorAt: sql`now()` }).where(eq(sessions.idHash, sessionIdHash(req)));
      await tx.insert(adminActions).values({ adminEmail: admin.email, action: "2fa_enroll", before: {}, after: { recoveryCodes: RECOVERY_CODES } });
    });
    return { recoveryCodes: codes };
  }

  /** Passes this session for 12 hours with a code from the app, or with a recovery code, which then stops working. */
  @Post("verify")
  @HttpCode(204)
  async verify(@CurrentUser() admin: SessionUser, @Req() req: Request, @Body(verifyInput) body: { code: string } | { recoveryCode: string }) {
    const row = await this.row(admin);
    if (!row?.confirmedAt) throw new ForbiddenException({ statusCode: 403, message: "set up two-factor sign-in first", twoFactor: "setup" });
    if ("code" in body) {
      await this.useTotp(admin, row, body.code, "verify");
    } else {
      const remaining = await this.useRecoveryCode(admin, body.recoveryCode);
      await this.db.insert(adminActions).values({ adminEmail: admin.email, action: "2fa_recovery", before: {}, after: { remaining } });
    }
    await this.db.update(sessions).set({ secondFactorAt: sql`now()` }).where(eq(sessions.idHash, sessionIdHash(req)));
  }

  /** Turns two-factor off for this admin, after a passed check and a fresh code; the console then asks to enroll again. */
  @Post("reset")
  @HttpCode(204)
  async reset(@CurrentUser() admin: SessionUser, @Req() req: Request, @Body(codeInput) body: { code: string }) {
    if (!(await twoFactorState(this.db, req)).verified) throw new ForbiddenException({ statusCode: 403, message: "enter your two-factor code", twoFactor: "verify" });
    const row = await this.row(admin);
    if (!row?.confirmedAt) throw new ConflictException("two-factor sign-in is not on");
    await this.useTotp(admin, row, body.code, "reset");
    await this.db.transaction(async (tx) => {
      await tx.delete(adminTotp).where(eq(adminTotp.userId, admin.id));
      await tx.insert(adminActions).values({ adminEmail: admin.email, action: "2fa_reset", before: {}, after: { by: "admin" } });
    });
  }

  private async row(admin: SessionUser): Promise<Row | undefined> {
    const [row] = await this.db.select().from(adminTotp).where(eq(adminTotp.userId, admin.id));
    return row;
  }

  /** Refuses every check once this admin has MAX_FAILURES wrong codes in 15 minutes. */
  private async underLimit(admin: SessionUser) {
    const [{ n }] = (await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(adminActions)
      .where(and(eq(adminActions.adminEmail, admin.email), eq(adminActions.action, "2fa_failed"), gt(adminActions.createdAt, sql`now() - interval '15 minutes'`)))) as [{ n: number }];
    if (n >= MAX_FAILURES) throw new HttpException("too many wrong codes. Wait 15 minutes and try again.", HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Records a wrong code without the code itself, then answers 400. */
  private async fail(admin: SessionUser, kind: "totp" | "recovery", during: "enroll" | "verify" | "reset"): Promise<never> {
    await this.db.insert(adminActions).values({ adminEmail: admin.email, action: "2fa_failed", before: {}, after: { kind, during } });
    throw new BadRequestException(WRONG);
  }

  /** Checks a code and claims its step in one guarded UPDATE, so the same code cannot pass twice, even at once. */
  private async useTotp(admin: SessionUser, row: Row, given: string, during: "enroll" | "verify" | "reset") {
    await this.underLimit(admin);
    const key = base32Decode(decryptSecret(this.config.secretsKey, admin.id, AAD_NAME, row));
    const step = verifyTotp(key, given, Date.now(), row.lastStep);
    const claimed =
      step !== null &&
      (await this.db.update(adminTotp).set({ lastStep: step }).where(and(eq(adminTotp.userId, admin.id), or(isNull(adminTotp.lastStep), lt(adminTotp.lastStep, step)))).returning({ userId: adminTotp.userId })).length > 0;
    if (!claimed) await this.fail(admin, "totp", during);
  }

  /** Marks the matching unused recovery code used, once, and returns how many are left. */
  private async useRecoveryCode(admin: SessionUser, given: string): Promise<number> {
    await this.underLimit(admin);
    const unused = await this.db.select().from(adminRecoveryCodes).where(and(eq(adminRecoveryCodes.userId, admin.id), isNull(adminRecoveryCodes.usedAt)));
    const typed = normalise(given);
    for (const c of unused) {
      if (typed.length === 10 && (await verify(c.codeHash, typed))) {
        const [used] = await this.db.update(adminRecoveryCodes).set({ usedAt: sql`now()` }).where(and(eq(adminRecoveryCodes.id, c.id), isNull(adminRecoveryCodes.usedAt))).returning({ id: adminRecoveryCodes.id });
        if (used) return unused.length - 1;
      }
    }
    return this.fail(admin, "recovery", "verify");
  }
}

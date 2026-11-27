import { adminActions, businessProfiles, FEEDBACK_MAX, FEEDBACK_STATUSES, FEEDBACK_TOPICS, feedback, users, workspaceLanguage, type Db } from "@daloy/db";
import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import * as z from "zod";
import { AdminGuard } from "./admin";
import { SessionGuard } from "./auth";
import { Allow, ANY_MEMBER, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";

const text = z.string().trim().min(1).max(FEEDBACK_MAX);
const sendBody = new ZodPipe(z.strictObject({ topic: z.enum(FEEDBACK_TOPICS), message: text }));
const replyBody = new ZodPipe(z.strictObject({ reply: text }));
const listQuery = new ZodPipe(z.object({ status: z.enum(FEEDBACK_STATUSES).optional() }));
const feedbackId = new ZodPipe(z.uuid());

const memberColumns = { id: feedback.id, topic: feedback.topic, message: feedback.message, status: feedback.status, reply: feedback.reply, createdAt: feedback.createdAt, repliedAt: feedback.repliedAt };

/** A4 (decision 0153): any member writes to the operator and reads this workspace's messages with their replies. */
@Controller("support/feedback")
@UseGuards(SessionGuard, Allow(ANY_MEMBER))
export class SupportFeedbackController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post()
  @UseGuards(RateLimit(5, 3_600_000))
  async send(@CurrentUser() user: SessionUser, @Body(sendBody) body: { topic: (typeof FEEDBACK_TOPICS)[number]; message: string }) {
    const [row] = await this.db.insert(feedback).values({ workspaceId: user.workspaceId, senderId: user.id, ...body }).returning(memberColumns);
    return row;
  }

  @Get()
  async mine(@CurrentUser() user: SessionUser) {
    return { items: await this.db.select(memberColumns).from(feedback).where(eq(feedback.workspaceId, user.workspaceId)).orderBy(desc(feedback.createdAt)) };
  }
}

const REPLY_MAIL = {
  en: { subject: "Reply to your feedback on kymavo", intro: "The kymavo team replied to your feedback:", yours: "Your message:" },
  tl: { subject: "Sagot sa feedback mo sa kymavo", intro: "Sumagot ang kymavo team sa feedback mo:", yours: "Ang mensahe mo:" },
} as const;

/** The operator's inbox. AdminGuard answers 404 to everyone outside PLATFORM_ADMINS; each write leaves an admin_actions row. */
@Controller("admin/feedback")
@UseGuards(AdminGuard)
export class AdminFeedbackController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  @UseGuards(RateLimit(30))
  async list(@Query(listQuery) q: { status?: (typeof FEEDBACK_STATUSES)[number] }) {
    const items = await this.db
      .select({ ...memberColumns, workspaceId: feedback.workspaceId, workspaceName: businessProfiles.businessName, senderEmail: users.email })
      .from(feedback)
      .innerJoin(users, eq(users.id, feedback.senderId))
      .leftJoin(businessProfiles, eq(businessProfiles.userId, feedback.workspaceId))
      .where(q.status ? eq(feedback.status, q.status) : undefined)
      .orderBy(desc(feedback.createdAt))
      .limit(200);
    return { items: items.map(({ workspaceName, ...i }) => (workspaceName ? { ...i, workspaceName } : i)) };
  }

  @Put(":id/reply")
  @UseGuards(RateLimit(20))
  async reply(@CurrentUser() admin: SessionUser, @Param("id", feedbackId) id: string, @Body(replyBody) body: { reply: string }) {
    const row = await this.apply(admin.email, id, "feedback_reply", (current) => {
      if (current === "closed") throw new ConflictException("this message is closed");
      return { status: "replied", reply: body.reply, repliedAt: new Date() };
    });
    return { ...row, emailed: await this.mailReply(row.workspaceId, row.senderId, row.message, body.reply) };
  }

  @Put(":id/close")
  @UseGuards(RateLimit(20))
  async close(@CurrentUser() admin: SessionUser, @Param("id", feedbackId) id: string) {
    return this.apply(admin.email, id, "feedback_close", () => ({ status: "closed" }));
  }

  /** Locks the row, changes it and records the before and after status in admin_actions, in one transaction. The audit row never holds the text. */
  private apply(adminEmail: string, id: string, action: "feedback_reply" | "feedback_close", change: (status: (typeof FEEDBACK_STATUSES)[number]) => Partial<typeof feedback.$inferInsert> & { status: (typeof FEEDBACK_STATUSES)[number] }) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(feedback).where(eq(feedback.id, id)).for("update");
      if (!current) throw new NotFoundException("no feedback with this id");
      const set = change(current.status);
      const [row] = await tx.update(feedback).set({ ...set, updatedAt: sql`now()` }).where(eq(feedback.id, id)).returning();
      await tx.insert(adminActions).values({ adminEmail, action, workspaceId: current.workspaceId, before: { feedbackId: id, status: current.status }, after: { feedbackId: id, status: set.status } });
      return row!;
    });
  }

  /** True when the sender's mail was handed to the installation's server. A failure is logged without the address and leaves the reply saved. */
  private async mailReply(workspaceId: string, senderId: string, original: string, reply: string) {
    const mail = this.config.mail?.installation;
    const [sender] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, senderId));
    if (!mail || !sender) return false;
    const copy = REPLY_MAIL[await workspaceLanguage(this.db, workspaceId)];
    try {
      await mail.transport.sendMail({ from: mail.from, to: sender.email, subject: copy.subject, text: `${copy.intro}\n\n${reply}\n\n${copy.yours}\n${original}` });
      return true;
    } catch (err) {
      console.error("feedback reply mail", err instanceof Error ? err.message : "failed");
      return false;
    }
  }
}

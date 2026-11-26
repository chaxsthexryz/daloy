import { onboardingProgress, readBrand, readProfile, saveProfile, workflowVersions, workflows, type Db } from "@daloy/db";
import { definitionSchema, identityInput, sampleOrder, suggestedGoal, templateFor, templatesForLanguage, typeInput, workflowInput, resumeStep, type BusinessCategory, type OnboardingGoal, type OnboardingPayment } from "@daloy/engine";
import { Body, ConflictException, Controller, Get, HttpCode, Inject, Post, Put, UseGuards } from "@nestjs/common";
import { and, eq, like } from "drizzle-orm";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, MANAGE, ZodPipe, type SessionUser } from "./http";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const SLUG = "first-workflow";

/**
 * First-time onboarding (roadmap R1, decision 0082). Each screen saves on its own, so a closed tab or "Save and close"
 * resumes where the owner stopped. The name and website go to the existing business profile, the logo is the brand kit's.
 * Nothing here connects an app, publishes, sends a message or invites anyone.
 */
@Controller("onboarding")
@UseGuards(SessionGuard, Allow(MANAGE))
export class OnboardingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async read(@CurrentUser() user: SessionUser) {
    const [row] = await this.db.select().from(onboardingProgress).where(eq(onboardingProgress.userId, user.workspaceId));
    const profile = await readProfile(this.db, user.workspaceId);
    const brand = await readBrand(this.db, user.workspaceId);
    const completed = row?.completed ?? 0;
    const goal = (row?.goal ?? null) as OnboardingGoal | null;
    const payment = (row?.payment ?? null) as OnboardingPayment | null;
    return {
      status: row?.status ?? "not_started",
      completed,
      step: resumeStep({ completed }),
      identity: { businessName: profile?.businessName ?? null, website: profile?.website ?? null, logoUrl: brand?.logo ? `/brand/logo/${user.workspaceId}` : null },
      primary: (row?.primaryCategory ?? null) as BusinessCategory | null,
      related: (row?.relatedCategories ?? []) as BusinessCategory[],
      suggestedGoal: suggestedGoal((row?.primaryCategory ?? null) as BusinessCategory | null),
      goal,
      payment,
      template: goal ? templateFor(goal, payment) : null,
      workflowId: row?.workflowId ?? null,
      sample: row?.sample ?? null,
    };
  }

  @Put("identity")
  async identity(@CurrentUser() user: SessionUser, @Body(new ZodPipe(identityInput)) body: ReturnType<typeof identityInput.parse>) {
    // The inbox and reply-to address from Business settings stay as they are.
    const profile = await readProfile(this.db, user.workspaceId);
    await saveProfile(this.db, user.workspaceId, { businessName: body.businessName, website: body.website, inquiryEmail: profile?.inquiryEmail ?? null, replyTo: profile?.replyTo ?? null });
    await this.save(user.workspaceId, 1, {});
    return body;
  }

  @Put("type")
  async type(@CurrentUser() user: SessionUser, @Body(new ZodPipe(typeInput)) body: ReturnType<typeof typeInput.parse>) {
    await this.save(user.workspaceId, 2, { primaryCategory: body.primary, relatedCategories: body.related });
    return body;
  }

  @Put("workflow")
  async workflow(@CurrentUser() user: SessionUser, @Body(new ZodPipe(workflowInput)) body: ReturnType<typeof workflowInput.parse>) {
    await this.save(user.workspaceId, 3, { goal: body.goal, payment: body.payment });
    return body;
  }

  /** "Not now": hides the prompt on Automations. The answers stay, and #/onboarding still resumes them. */
  @Post("dismiss")
  @HttpCode(204)
  async dismiss(@CurrentUser() user: SessionUser) {
    await this.db
      .insert(onboardingProgress)
      .values({ userId: user.workspaceId, status: "dismissed" })
      .onConflictDoUpdate({ target: onboardingProgress.userId, set: { status: "dismissed", updatedAt: new Date() }, setWhere: eq(onboardingProgress.status, "in_progress") });
  }

  /**
   * The last screen. The row is locked while the draft is made, so two taps or two tabs get the same draft, and the
   * second one finds workflowId already set. Changing an answer afterwards never rewrites the draft the owner may be editing.
   */
  @Post("finish")
  async finish(@CurrentUser() user: SessionUser) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(onboardingProgress).where(eq(onboardingProgress.userId, user.workspaceId)).for("update");
      if (!row || row.completed < 3 || !row.goal) throw new ConflictException("finish the three screens first");
      if (row.workflowId) return { workflowId: row.workflowId, created: false };

      const template = templatesForLanguage(user.language).find((t) => t.slug === templateFor(row.goal as OnboardingGoal, row.payment as OnboardingPayment | null).slug)!;
      // The owner reviews their own draft until they add someone else.
      const definition = definitionSchema.parse(JSON.parse(JSON.stringify(template.definition).replaceAll("owner@example.com", JSON.stringify(user.email).slice(1, -1))));
      const [wf] = await tx
        .insert(workflows)
        .values({
          userId: user.workspaceId,
          name: template.name,
          slug: await freeSlug(tx, user.workspaceId),
          setup: { kind: "generated", template: template.slug, step: "questions", answers: {} },
        })
        .returning({ id: workflows.id });
      await tx.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: false });
      await tx.update(onboardingProgress).set({ workflowId: wf!.id, status: "completed", sample: sampleOrder(definition), updatedAt: new Date() }).where(eq(onboardingProgress.userId, user.workspaceId));
      return { workflowId: wf!.id, created: true };
    });
  }

  /**
   * Screens save in order: screen n needs screen n-1. Saving an earlier screen again keeps the count, so editing a
   * name never forgets the later answers. A dismissed row reopens as in progress, and a completed one stays completed.
   */
  private async save(workspaceId: string, screen: 1 | 2 | 3, values: Partial<typeof onboardingProgress.$inferInsert>) {
    await this.db.transaction(async (tx) => {
      await tx.insert(onboardingProgress).values({ userId: workspaceId }).onConflictDoNothing();
      const [row] = await tx.select({ completed: onboardingProgress.completed, status: onboardingProgress.status }).from(onboardingProgress).where(eq(onboardingProgress.userId, workspaceId)).for("update");
      if (row!.completed < screen - 1) throw new ConflictException(`save screen ${screen - 1} first`);
      await tx
        .update(onboardingProgress)
        .set({ ...values, completed: Math.max(row!.completed, screen), status: row!.status === "completed" ? "completed" : "in_progress", updatedAt: new Date() })
        .where(eq(onboardingProgress.userId, workspaceId));
    });
  }
}

/** first-workflow, then first-workflow-2 and so on, skipping slugs the owner already has. */
async function freeSlug(tx: Tx, userId: string) {
  const taken = new Set((await tx.select({ slug: workflows.slug }).from(workflows).where(and(eq(workflows.userId, userId), like(workflows.slug, `${SLUG}%`)))).map((r) => r.slug));
  for (let n = 1; ; n++) {
    const slug = n === 1 ? SLUG : `${SLUG}-${n}`;
    if (!taken.has(slug)) return slug;
  }
}

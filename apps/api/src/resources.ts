import { resources, type Db } from "@daloy/db";
import type { FormField, Resource } from "@daloy/engine";
import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, ANY_MEMBER, CurrentUser, DB, isUniqueViolation, MANAGE, ZodPipe, type SessionUser } from "./http";

const name = z.string().trim().min(1, "is required").max(100, "must be at most 100 characters");
const createInput = z.object({ name });
const updateInput = z.object({ name: name.optional(), active: z.boolean().optional() }).refine((b) => b.name !== undefined || b.active !== undefined, "send name or active");
const columns = { id: resources.id, name: resources.name, active: resources.active, createdAt: resources.createdAt };

/** The workspace's active resources, the only ids a resource field accepts. No query when no field needs them. */
export async function resourcesFor(db: Db, workspaceId: string, fields: FormField[] | undefined): Promise<Resource[]> {
  if (!fields?.some((f) => f.type === "resource")) return [];
  return db
    .select({ id: resources.id, name: resources.name })
    .from(resources)
    .where(and(eq(resources.userId, workspaceId), eq(resources.active, true)))
    .orderBy(asc(resources.name));
}

/** Things a booking is for, such as a therapist or a room (decision 0031). Archived instead of deleted. */
@Controller("resources")
@UseGuards(SessionGuard)
export class ResourcesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @UseGuards(Allow(ANY_MEMBER))
  list(@CurrentUser() user: SessionUser) {
    return this.db.select(columns).from(resources).where(eq(resources.userId, user.workspaceId)).orderBy(asc(resources.name));
  }

  @Post()
  @UseGuards(Allow(MANAGE))
  async create(@CurrentUser() user: SessionUser, @Body(new ZodPipe(createInput)) body: z.output<typeof createInput>) {
    const [row] = await this.unique(body.name, () => this.db.insert(resources).values({ userId: user.workspaceId, name: body.name }).returning(columns));
    return row;
  }

  @Patch(":id")
  @UseGuards(Allow(MANAGE))
  async update(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string, @Body(new ZodPipe(updateInput)) body: z.output<typeof updateInput>) {
    // Runs already started keep the name they were given; only new submissions see the change.
    const [row] = await this.unique(body.name, () =>
      this.db
        .update(resources)
        .set(body)
        .where(and(eq(resources.id, id), eq(resources.userId, user.workspaceId)))
        .returning(columns),
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  private async unique<T>(wanted: string | undefined, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(`a resource named ${wanted} already exists`);
      throw err;
    }
  }
}

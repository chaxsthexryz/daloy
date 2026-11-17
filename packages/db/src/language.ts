import { eq } from "drizzle-orm";
import type { Db } from "./index";
import { users } from "./schema";

export async function workspaceLanguage(db: Db, workspaceId: string) {
  const [owner] = await db.select({ language: users.language }).from(users).where(eq(users.id, workspaceId));
  return owner?.language ?? "en";
}

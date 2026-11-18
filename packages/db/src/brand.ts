import { eq } from "drizzle-orm";
import { inkFor, type LogoType } from "@daloy/engine";
import type { Db } from "./index";
import { businessProfiles } from "./schema";

export type Brand = { name: string | null; accent: string | null; ink: string | null; logo: { type: LogoType; data: Buffer } | null };

/** The workspace's brand, or null when the owner set no logo and no accent (the default look stays). */
export async function readBrand(db: Db, userId: string): Promise<Brand | null> {
  const [row] = await db
    .select({ name: businessProfiles.businessName, accent: businessProfiles.accent, logo: businessProfiles.logo, logoType: businessProfiles.logoType })
    .from(businessProfiles)
    .where(eq(businessProfiles.userId, userId));
  if (!row || (!row.logo && !row.accent)) return null;
  return { name: row.name, accent: row.accent, ink: row.accent ? inkFor(row.accent) : null, logo: row.logo ? { type: row.logoType as LogoType, data: row.logo } : null };
}

/** Pass null to clear. The caller has already checked the bytes (engine logoType) and the colour (ACCENT). */
export async function saveBrand(db: Db, userId: string, change: { accent: string | null } | { logo: { type: LogoType; data: Buffer } | null }) {
  const values = "accent" in change ? { accent: change.accent } : { logo: change.logo?.data ?? null, logoType: change.logo?.type ?? null };
  await db.insert(businessProfiles).values({ userId, ...values }).onConflictDoUpdate({ target: businessProfiles.userId, set: { ...values, updatedAt: new Date() } });
}

export async function readLogo(db: Db, userId: string) {
  const [row] = await db.select({ data: businessProfiles.logo, type: businessProfiles.logoType }).from(businessProfiles).where(eq(businessProfiles.userId, userId));
  return row?.data && row.type ? { data: row.data, type: row.type as LogoType } : null;
}

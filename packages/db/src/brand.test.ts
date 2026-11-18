import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { readBrand, readLogo, saveBrand } from "./brand";
import { saveProfile } from "./mail-senders";
import type { Db } from "./index";
import { users } from "./schema";

let db: Db;
let pool: Pool;
let seq = 0;
const newUser = async () => (await db.insert(users).values({ email: `b${++seq}@test.local`, passwordHash: "x" }).returning())[0]!.id;
beforeAll(async () => ({ db, pool } = await freshDatabase()), 120_000);
afterAll(() => pool?.end());

it("has no brand until a logo or an accent is set", async () => {
  const id = await newUser();
  expect(await readBrand(db, id)).toBeNull();
  await saveProfile(db, id, { businessName: "Mila Dental", website: null, inquiryEmail: null, replyTo: null });
  expect(await readBrand(db, id)).toBeNull();
});

it("keeps the accent and the logo, and clears them", async () => {
  const id = await newUser();
  await saveProfile(db, id, { businessName: "Mila Dental", website: null, inquiryEmail: null, replyTo: null });
  await saveBrand(db, id, { accent: "#0b3d91" });
  await saveBrand(db, id, { logo: { type: "png", data: Buffer.from([0x89, 0x50]) } });
  const brand = await readBrand(db, id);
  expect(brand).toMatchObject({ name: "Mila Dental", accent: "#0b3d91", ink: "#ffffff", logo: { type: "png" } });
  expect((await readLogo(db, id))?.data.equals(Buffer.from([0x89, 0x50]))).toBe(true);
  // Saving the profile again must not drop the brand.
  await saveProfile(db, id, { businessName: "Mila Dental 2", website: null, inquiryEmail: null, replyTo: null });
  expect((await readBrand(db, id))?.accent).toBe("#0b3d91");
  await saveBrand(db, id, { logo: null });
  await saveBrand(db, id, { accent: null });
  expect(await readBrand(db, id)).toBeNull();
  expect(await readLogo(db, id)).toBeNull();
});

it("refuses a bad colour or a logo type the database does not know", async () => {
  const id = await newUser();
  await expect(saveBrand(db, id, { accent: "red" })).rejects.toThrow();
  await expect(saveBrand(db, id, { logo: { type: "svg" as never, data: Buffer.from("<svg/>") } })).rejects.toThrow();
});

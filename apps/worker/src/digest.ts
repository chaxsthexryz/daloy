import { digestCounts, manilaDay, users, workspaceLanguage } from "@daloy/db";
import { digestEmail } from "@daloy/engine";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { WatchdogDeps } from "./watchdog";

/** The digest goes out from 8 am until noon Manila time (UTC+8, no daylight saving): a worker that was down at 8 still sends it at 9, but not at 3 pm. */
export const DIGEST_FROM_HOUR = 8;
export const DIGEST_UNTIL_HOUR = 12;

/**
 * R5, decision 0092: one email to each owner who turned the digest on, once per Manila day, with what needs a person.
 * It goes to the owner's login address through the installation's server (like the broken-grant alert), so it never
 * spends the owner's Gmail daily cap. A morning with nothing to do sends nothing and uses up the day, so a receipt that
 * arrives at 10 waits for tomorrow's digest. A failed send gives the day back so the next tick tries again.
 */
export async function sendDigests(deps: WatchdogDeps) {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const hour = new Date(now.getTime() + 8 * 3600_000).getUTCHours();
  if (hour < DIGEST_FROM_HOUR || hour >= DIGEST_UNTIL_HOUR) return;
  const day = manilaDay(now);
  const notYet = or(isNull(users.digestSentOn), lt(users.digestSentOn, day));
  const owners = await db.select({ id: users.id, email: users.email, sentOn: users.digestSentOn }).from(users).where(and(eq(users.digestEnabled, true), notYet));
  for (const o of owners) {
    // The conditional UPDATE decides which worker sends.
    const claimed = await db.update(users).set({ digestSentOn: day }).where(and(eq(users.id, o.id), eq(users.digestEnabled, true), notYet)).returning({ id: users.id });
    if (claimed.length === 0) continue;
    try {
      const message = digestEmail(await digestCounts(db, o.id, now), deps.publicUrl, await workspaceLanguage(db, o.id));
      if (!message) continue;
      const mailer = deps.mail.installation;
      await mailer.transport.sendMail({ from: mailer.from, to: o.email, subject: message.subject, text: message.text });
    } catch (err) {
      await db.update(users).set({ digestSentOn: o.sentOn }).where(eq(users.id, o.id));
      console.error("digest: email failed", err instanceof Error ? err.message : err);
    }
  }
}

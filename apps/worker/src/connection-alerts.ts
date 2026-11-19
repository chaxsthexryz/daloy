import { connections, mailSenders, PROVIDER_NAMES, users, workspaceLanguage, type Provider } from "@daloy/db";
import { brokenConnectionEmail } from "@daloy/engine";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { WatchdogDeps } from "./watchdog";

const DAY_MS = 24 * 3600_000;

/**
 * Plan R8, open question 10: the owner gets one email per broken OAuth grant per day. A grant is broken when the
 * provider refused it (status failed). Pasted keys are left out: their card already says what to fix and they do
 * not stop on their own. The email goes through the installation's server, like a password reset, because the
 * broken grant may be the owner's own Gmail sender (decision 0065). It goes only to the owner's login address.
 */
export async function alertBrokenGrants(deps: WatchdogDeps) {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const due = or(isNull(connections.alertAt), lt(connections.alertAt, new Date(now.getTime() - DAY_MS)));
  const broken = await db
    .select({ userId: connections.userId, provider: connections.provider, alertAt: connections.alertAt })
    .from(connections)
    .where(and(eq(connections.authMethod, "oauth"), eq(connections.status, "failed"), due));
  for (const c of broken) {
    const where = and(eq(connections.userId, c.userId), eq(connections.provider, c.provider), eq(connections.status, "failed"));
    await alertOnce(deps, c.userId, PROVIDER_NAMES[c.provider as Provider], now, {
      claim: async () => (await db.update(connections).set({ alertAt: now }).where(and(where, due)).returning({ id: connections.userId })).length > 0,
      release: async () => void (await db.update(connections).set({ alertAt: c.alertAt }).where(where)),
    });
  }
  const senderDue = or(isNull(mailSenders.alertAt), lt(mailSenders.alertAt, new Date(now.getTime() - DAY_MS)));
  const gmail = await db
    .select({ userId: mailSenders.userId, alertAt: mailSenders.alertAt })
    .from(mailSenders)
    .where(and(eq(mailSenders.authMethod, "oauth"), eq(mailSenders.status, "failed"), senderDue));
  for (const s of gmail) {
    const where = and(eq(mailSenders.userId, s.userId), eq(mailSenders.status, "failed"));
    await alertOnce(deps, s.userId, "Gmail", now, {
      claim: async () => (await db.update(mailSenders).set({ alertAt: now }).where(and(where, senderDue)).returning({ id: mailSenders.userId })).length > 0,
      release: async () => void (await db.update(mailSenders).set({ alertAt: s.alertAt }).where(where)),
    });
  }
}

/** The conditional UPDATE in claim decides which worker sends; a failed send gives the claim back. */
async function alertOnce(deps: WatchdogDeps, workspaceId: string, app: string, now: Date, row: { claim: () => Promise<boolean>; release: () => Promise<void> }) {
  if (!(await row.claim())) return;
  try {
    const [owner] = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, workspaceId));
    const { subject, text } = brokenConnectionEmail(app, deps.publicUrl ? `${deps.publicUrl}/#/apps` : undefined, await workspaceLanguage(deps.db, workspaceId));
    const mailer = deps.mail.installation;
    await mailer.transport.sendMail({ from: mailer.from, to: owner!.email, subject, text });
  } catch (err) {
    await row.release();
    console.error("connection alert: owner email failed", app, err instanceof Error ? err.message : err);
  }
}

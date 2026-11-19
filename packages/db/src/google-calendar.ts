import { and, eq, isNull } from "drizzle-orm";
import { connectionCredential } from "./connections";
import { withGoogle } from "./google-access";
import type { Db } from "./index";
import { createCalendar, ProviderError, type ProviderUrls } from "./providers";
import { connections } from "./schema";

/** The calendar Daloy creates for a Google sign-in (decision 0064). */
export const DALOY_CALENDAR_TITLE = "Daloy bookings";

/**
 * Easy connect for Calendar: after "Connect with Google" Daloy creates its own calendar and stores its id as the
 * destination, so the owner picks and types nothing. A destination already there is kept (a reconnect with the same
 * Google account keeps it, see oauth/core.ts), so the calendar is made once. `again` makes a new one, for a calendar
 * deleted in Google Calendar: deliveries still pinned to the old id then wait for review (M11).
 * Not safe against two simultaneous calls: the loser's calendar is left unused in the owner's account.
 */
export async function ensureCalendar(db: Db, key: Buffer, urls: ProviderUrls, workspaceId: string, o: { again?: boolean } = {}): Promise<{ calendarId: string; title: string }> {
  const conn = await connectionCredential(db, key, workspaceId, "google_calendar");
  if (!conn) throw new ProviderError("Google Calendar is not connected.", "invalid");
  if (conn.authMethod !== "oauth") throw new ProviderError("This works with a Google sign-in. Choose Connect with Google first.", "invalid");
  const have = conn.destination?.calendarId;
  if (have && !o.again) return { calendarId: have, title: conn.destination?.title ?? have };
  const made = await withGoogle(db, key, urls, workspaceId, "google_calendar", conn, (auth) => createCalendar(urls, auth, DALOY_CALENDAR_TITLE));
  // Only the Google account this ran with may take the new calendar (a refresh changes the revision, so it cannot be the guard),
  // and a destination set meanwhile is kept unless asked to replace it.
  const sameAccount = conn.externalId ? eq(connections.externalId, conn.externalId) : isNull(connections.externalId);
  await db.update(connections).set({ destination: made, updatedAt: new Date() }).where(and(eq(connections.userId, workspaceId), eq(connections.provider, "google_calendar"), sameAccount, o.again ? undefined : isNull(connections.destination)));
  return made;
}

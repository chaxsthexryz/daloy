import type { Db } from "./index";
import { freshToken, oauthProvider, readTokenBlob, withFreshToken, type HeldConnection } from "./oauth";
import { driveApi, ProviderError, serviceAccountSchema, sheetsApi, type GoogleAuth, type ProviderUrls } from "./providers";
import type { AuthMethod } from "./schema";

/** The Sheets or Drive connection a caller holds: a service account key, or an OAuth grant (decision 0060). */
export type GoogleConnection = HeldConnection & { authMethod: AuthMethod };
type GoogleApp = "google_sheets" | "google_drive" | "google_calendar";

/**
 * Calls fn with whatever the connection signs in with: the service account key as before, or a fresh OAuth access
 * token through withFreshToken (one refresh after a 401). force refreshes first, as a console test does.
 */
export function withGoogle<T>(db: Db, key: Buffer, urls: ProviderUrls, workspaceId: string, provider: GoogleApp, conn: GoogleConnection, fn: (auth: GoogleAuth) => Promise<T>, o: { force?: boolean } = {}): Promise<T> {
  if (conn.authMethod !== "oauth") return fn(serviceAccountSchema.parse(JSON.parse(conn.credential)));
  const def = oauthProvider(provider);
  if (!def) throw new ProviderError("Google sign-in is not available here.", "invalid");
  return withFreshToken(db, key, urls, workspaceId, def, conn, (accessToken) => fn({ accessToken }), o);
}

/**
 * A drive.file access token for the Google Picker in the owner's browser (plan 6.1, open question 6). Refreshed first,
 * so the page gets close to Google's full hour. It reaches only files kymavo created or the owner picked. Never logged.
 */
export async function pickerToken(db: Db, key: Buffer, urls: ProviderUrls, workspaceId: string, provider: GoogleApp, conn: GoogleConnection) {
  const def = oauthProvider(provider);
  if (conn.authMethod !== "oauth" || !def) throw new ProviderError("The Picker works with a Google sign-in. Connect with Google first.", "invalid");
  const accessToken = await freshToken(db, key, urls, workspaceId, def, conn, { force: true });
  return { accessToken, expiresAt: readTokenBlob(conn.credential).accessExpiresAt };
}

/** Creates a spreadsheet in the owner's Drive. Under drive.file kymavo may use it because kymavo created it. */
export async function createSpreadsheet(urls: ProviderUrls, auth: GoogleAuth, title: string) {
  const body = await sheetsApi(urls, auth, "/v4/spreadsheets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ properties: { title } }) }, false);
  const spreadsheetId = String(body.spreadsheetId ?? "");
  if (!spreadsheetId) throw new ProviderError("Google Sheets answered without a spreadsheet id.", "unavailable");
  const tabs = ((body.sheets as { properties: { title: string } }[] | undefined) ?? []).map((s) => s.properties.title);
  return { spreadsheetId, title: String((body.properties as { title?: unknown } | undefined)?.title ?? title), tabs };
}

/** Creates a folder in My Drive (OAuth only: a service account has no Drive storage of its own). */
export async function createDriveFolder(urls: ProviderUrls, auth: GoogleAuth, name: string) {
  const res = await driveApi(urls, auth, "/drive/v3/files?fields=id,name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }) }, false);
  const folderId = String(res.body.id ?? "");
  if (!folderId) throw new ProviderError("Google Drive answered without a folder id.", "unavailable");
  return { folderId, title: String(res.body.name ?? name) };
}

import { createHash } from "node:crypto";
import { docsReplaceRequests, googleDocUrl, isGoogleFileId } from "@daloy/engine";
import { call, ProviderError, retryAfter, type GoogleAuth, type ProviderUrls, type Reply } from "./providers";

/**
 * "Make a document from a template" (phase I1, decision 0104): copy a Google Docs template into a Drive folder, then
 * replace its {{placeholders}}. Both calls use the drive.file grant of the Google Drive connection, so Daloy can reach
 * only the template the owner picked in the Google Picker and the copy Daloy made itself. Google Sign-in only: a service
 * account has no Drive storage of its own.
 *
 * Retrying is safe. Every copy carries an appProperties key made from the run and step, so a retry looks for its own
 * copy first and finishes filling it instead of copying again. That is why a lost answer on the copy is "unavailable",
 * not "ambiguous". ponytail: Drive's list can lag a few seconds behind a write, so a retry inside that window can leave
 * a second copy; a lookup that waits would need a stored document id on the step run.
 */

/** The appProperties value for one run and step. A hash, so the run id is not copied into the owner's Drive. */
export const docsKeyFor = (runAndStep: string): string => createHash("sha256").update(`daloy-docs:${runAndStep}`).digest("hex").slice(0, 40);

export type DocsResult = { documentId: string; url: string; name: string; reused: boolean; /** Placeholders that matched nothing in a fresh copy. Empty for a reused copy, whose first attempt already told. */ unmatched: string[] };
export type DocsRequest = { templateId: string; folderId: string; name: string; values: Record<string, string>; key: string };

const PICK_AGAIN = "Daloy cannot copy this template into the folder. Pick the template again in the step, and the folder again in Apps (Google lets Daloy reach only files and folders you picked or that Daloy created).";

function failure(res: Reply, phase: "list" | "copy" | "fill"): ProviderError {
  const error = (res.body.error ?? {}) as { message?: unknown; errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] };
  const reason = String(error.errors?.[0]?.reason ?? error.details?.[0]?.reason ?? "");
  const message = String(error.message ?? "");
  const api = phase === "fill" ? "Google Docs" : "Google Drive";
  if (res.status === 401) return new ProviderError("Google did not accept Daloy's access. Connect Google Drive again.", "auth");
  if (res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(reason))) {
    return new ProviderError(`${api} is limiting requests right now. Daloy will try again.`, "quota", retryAfter(res.headers));
  }
  if (res.status === 403 && (reason === "SERVICE_DISABLED" || /has not been used|is disabled/i.test(message))) {
    return new ProviderError(`The ${api} API is not turned on for this installation's Google project. The person who runs Daloy turns it on in the Google Cloud console, then you retry.`, "permission");
  }
  if (res.status === 403 && reason === "storageQuotaExceeded") return new ProviderError("The Google account's Drive storage is full. Free up space in Drive, then retry.", "permission");
  if (res.status === 403 || res.status === 404) {
    return new ProviderError(phase === "fill" ? "Google Docs would not open the new copy. Connect Google Drive again in Apps, then retry." : PICK_AGAIN, "permission");
  }
  // Safe to try again: the copy is found by its key, and a replace is all or nothing.
  if (res.status >= 500) return new ProviderError(`${api} answered ${res.status}. Daloy will try again.`, "unavailable");
  return new ProviderError(`${api} rejected the request (${res.status}).`, "invalid");
}

/** One API call with the grant's access token. write is false on purpose for every call (see the note at the top). */
async function api(urls: ProviderUrls, token: string, base: string, path: string, init: RequestInit, phase: "list" | "copy" | "fill") {
  const res = await call(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) } }, urls.timeoutMs ?? 30_000, false, phase === "fill" ? "Google Docs" : "Google Drive");
  if (res.status !== 200) throw failure(res, phase);
  return res;
}

export async function docsFromTemplate(urls: ProviderUrls, auth: GoogleAuth, r: DocsRequest): Promise<DocsResult> {
  if (!("accessToken" in auth)) throw new ProviderError("Make a document works with a Google sign-in. In Apps, connect Google Drive with Google instead of a service account key.", "invalid");
  const name = r.name.trim();
  if (!name) throw new ProviderError("The document name is empty.", "invalid");
  if (name.length > 200) throw new ProviderError(`The document name is ${name.length} characters, above the 200-character limit.`, "invalid");
  if (!isGoogleFileId(r.templateId)) throw new ProviderError("The template is not a Google Docs file. Pick the template again.", "invalid");
  if (!isGoogleFileId(r.folderId)) throw new ProviderError("The Drive folder is not set up. Pick the folder in Apps.", "invalid");
  const token = auth.accessToken;
  const drive = urls.drive;
  const docs = urls.docs ?? "https://docs.googleapis.com";

  const q = `appProperties has { key='daloyKey' and value='${r.key.replace(/[^\w-]/g, "")}' } and trashed = false`;
  const found = await api(urls, token, drive, `/drive/v3/files?${new URLSearchParams({ q, fields: "files(id,name)", pageSize: "1", spaces: "drive", supportsAllDrives: "true", includeItemsFromAllDrives: "true" })}`, {}, "list");
  const existing = (found.body.files as { id?: unknown; name?: unknown }[] | undefined)?.find((f) => typeof f.id === "string");
  let documentId = existing ? String(existing.id) : "";
  const reused = documentId !== "";
  if (!reused) {
    const copy = await api(urls, token, drive, `/drive/v3/files/${encodeURIComponent(r.templateId)}/copy?${new URLSearchParams({ supportsAllDrives: "true", fields: "id,name" })}`, { method: "POST", body: JSON.stringify({ name, parents: [r.folderId], appProperties: { daloyKey: r.key } }) }, "copy");
    documentId = typeof copy.body.id === "string" ? copy.body.id : "";
    if (!isGoogleFileId(documentId)) throw new ProviderError("Google Drive answered without a document id. Daloy will try again.", "unavailable");
  }

  const keys = Object.keys(r.values);
  let unmatched: string[] = [];
  if (keys.length > 0) {
    const filled = await api(urls, token, docs, `/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: docsReplaceRequests(r.values) }) }, "fill");
    // The first replies belong to the {{key}} to token requests, one per key, in order.
    const replies = (filled.body.replies as { replaceAllText?: { occurrencesChanged?: number } }[] | undefined) ?? [];
    if (!reused) unmatched = keys.filter((_, i) => (replies[i]?.replaceAllText?.occurrencesChanged ?? 0) === 0);
  }
  return { documentId, url: googleDocUrl(documentId), name: reused ? String(existing?.name ?? name) : name, reused, unmatched };
}

/**
 * Reads the file the owner picked in the Google Picker, with Daloy's own drive.file grant, before the editor keeps its id.
 * Google answers 404 for a file the owner did not pick, so a forged id gains nothing. Only a Google Docs file passes.
 */
export async function docsTemplateInfo(urls: ProviderUrls, auth: GoogleAuth, templateId: string): Promise<{ templateId: string; title: string }> {
  if (!("accessToken" in auth)) throw new ProviderError("Make a document works with a Google sign-in. In Apps, connect Google Drive with Google instead of a service account key.", "invalid");
  if (!isGoogleFileId(templateId)) throw new ProviderError("That is not a Google Docs file.", "invalid");
  const res = await api(urls, auth.accessToken, urls.drive, `/drive/v3/files/${encodeURIComponent(templateId)}?${new URLSearchParams({ supportsAllDrives: "true", fields: "id,name,mimeType,trashed" })}`, {}, "copy");
  if (res.body.mimeType !== "application/vnd.google-apps.document" || res.body.trashed === true) throw new ProviderError("That file is not a Google Docs document. Pick a document, not a Word file, sheet or folder.", "invalid");
  return { templateId, title: String(res.body.name ?? templateId) };
}

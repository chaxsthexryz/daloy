import { connectionCredential, docsFromTemplate, docsKeyFor, ProviderError, withGoogle, type Db, type ProviderUrls } from "@daloy/db";
import { StepError } from "@daloy/engine";
import { stepError } from "./paymongo";

export type DocsInput = { templateId: string; templateName?: string; name: string; values: Record<string, string> };

/**
 * "Make a document from a template" (phase I1, decision 0104). Runs inside the step, so the link is the step's output.
 * It uses the Google Drive connection: a Google sign-in (drive.file) and the folder picked in Apps. A retry of the same
 * run and step finds its own copy by key and does not copy again.
 */
export async function googleDocsStep(db: Db, key: Buffer, urls: ProviderUrls, at: { userId: string; runId: string; stepId: string }, cfg: DocsInput, claim: () => Promise<void>) {
  const name = cfg.name.trim();
  if (!name) throw new StepError("The document name is empty after the values were filled in.", false);
  const conn = await connectionCredential(db, key, at.userId, "google_drive");
  if (!conn) throw new StepError("Connect Google Drive first, with a Google sign-in, then retry.", false);
  if (conn.status === "failed") throw new StepError(`Google Drive needs to be connected again (${conn.account}). Reconnect it in Apps, then retry.`, false);
  if (conn.authMethod !== "oauth") throw new StepError("Make a document needs Google Drive connected with a Google sign-in, not a service account key. Reconnect it in Apps.", false);
  const folderId = conn.destination?.folderId;
  if (!folderId) throw new StepError("No Drive folder is chosen for Google Drive. Pick one in Apps, then retry.", false);
  // Counted under the step key, like an HTTP call, and only once Google is really going to be called.
  await claim();
  try {
    const out = await withGoogle(db, key, urls, at.userId, "google_drive", conn, (auth) => docsFromTemplate(urls, auth, { templateId: cfg.templateId, folderId, name, values: cfg.values, key: docsKeyFor(`${at.runId}:${at.stepId}`) }));
    return { documentId: out.documentId, url: out.url, name: out.name, unmatched: out.unmatched };
  } catch (err) {
    throw err instanceof ProviderError ? stepError(err) : err;
  }
}

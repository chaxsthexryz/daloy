import { randomUUID } from "node:crypto";
import { saveUploads, type Db } from "@daloy/db";
import { FILE_MAX_BYTES, fileType, StepError, type BrowserAction, type FileRef } from "@daloy/engine";
import * as z from "zod";

/**
 * The worker's side of the browser step (phase B2, decision 0108). The page itself runs in the browser service
 * (apps/browser), which only the worker can reach, over the compose network "browser", with BROWSER_TOKEN.
 */
export type BrowserInput = { url: string; actions: BrowserAction[] };
export type BrowserService = { url: string; token: string };

/** BROWSER_URL and BROWSER_TOKEN, or null when this server runs no browser service. */
export function browserService(env: NodeJS.ProcessEnv = process.env): BrowserService | null {
  const url = env.BROWSER_URL?.trim();
  const token = env.BROWSER_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

const answer = z.object({ url: z.string(), extracted: z.record(z.string(), z.string()), screenshots: z.array(z.string()).max(5) });

/**
 * Runs the action list and keeps each screenshot as an upload of this run, next to a form's files. The output is the
 * extracted names at the top level ({{steps.<id>.output.price}}), the final address and the screenshot file refs.
 */
export async function browserStep(db: Db, service: BrowserService | null, at: { userId: string; runId: string; stepId: string }, input: BrowserInput): Promise<Record<string, unknown>> {
  if (!service) throw new StepError("The browser step is not set up on this server: the operator has not started the browser service (BROWSER_URL and BROWSER_TOKEN, docs/deployment.md).", false);
  // Reading pages is safe to try again. A click or a typed value may already have done something on the site, so
  // only a run that was never started (busy) is retried then; a lost answer is an unknown outcome, for a person.
  const readOnly = input.actions.every((a) => a.action !== "click" && a.action !== "fill");
  const lost = (message: string) => new StepError(message, readOnly, readOnly ? {} : { outcome: "unknown" });
  let res: Response;
  try {
    res = await fetch(`${service.url}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw lost(`The browser service did not answer (${err instanceof Error ? err.message : String(err)}).`);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  const error = typeof body.error === "string" ? body.error.slice(0, 500) : `The browser service answered ${res.status}.`;
  if (res.status === 503) throw new StepError(error, true);
  if (res.status === 401) throw new StepError("The browser service refused the worker's token. BROWSER_TOKEN must be the same for both.", false);
  if (res.status >= 500) throw lost(error);
  if (!res.ok) throw new StepError(error, false);

  const parsed = answer.safeParse(body);
  if (!parsed.success) throw new StepError("The browser service sent an answer kymavo cannot read.", false);
  const files = parsed.data.screenshots.map((b64, i) => {
    const data = Buffer.from(b64, "base64");
    // The service is a separate process that runs untrusted pages: check what it hands back before storing it.
    if (fileType(data) !== "png" || data.length > FILE_MAX_BYTES) throw new StepError("A screenshot from the browser service is not a PNG under 5 MB.", false);
    return { id: randomUUID(), field: at.stepId, name: `${at.stepId}-${i + 1}.png`, type: "png" as const, data };
  });
  await saveUploads(db, { userId: at.userId, runId: at.runId, files });
  const screenshots: FileRef[] = files.map(({ id, name, type, data }) => ({ id, name, type, size: data.length }));
  return { ...parsed.data.extracted, url: parsed.data.url, screenshots };
}

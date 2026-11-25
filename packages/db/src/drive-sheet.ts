import { isGoogleFileId } from "@daloy/engine";
import { call, ProviderError, retryAfter, type GoogleAuth, type ProviderUrls, type Reply } from "./providers";

/**
 * The read_spreadsheet step's Drive calls (M1, decision 0139): one Drive file as CSV text.
 * - A .csv file is downloaded as it is.
 * - A Google Sheets file is exported as CSV (its first tab).
 * - An .xlsx or .xls file is copied as a Google Sheet into My Drive, exported as CSV, and the copy deleted. Google does
 *   the conversion, so kymavo needs no Excel parser. A service account has no Drive storage for the copy, so this one
 *   needs a Google sign-in.
 * Reads only, apart from the temporary copy. The file and the CSV are each capped at maxBytes.
 */
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const EXCEL = new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]);

const CANNOT_OPEN = "kymavo cannot open this file with your Google connection. Put it in the Drive folder picked for Google Drive in Apps (Google lets kymavo read only folders you picked and files kymavo made).";

function failure(res: { status: number; headers: Headers; body: Record<string, unknown> }): ProviderError {
  const error = (res.body.error ?? {}) as { message?: unknown; errors?: { reason?: unknown }[] };
  const reason = String(error.errors?.[0]?.reason ?? "");
  if (res.status === 401) return new ProviderError("Google did not accept kymavo's access. Connect Google Drive again.", "auth");
  if (res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(reason))) {
    return new ProviderError("Google Drive is limiting requests right now. kymavo will try again.", "quota", retryAfter(res.headers));
  }
  if (res.status === 403 && reason === "storageQuotaExceeded") return new ProviderError("Reading an Excel file needs room for a short-lived copy, and the Google account's Drive storage is full. Free up space in Drive, then retry.", "permission");
  if (res.status === 403 || res.status === 404) return new ProviderError(CANNOT_OPEN, "permission");
  if (res.status >= 500) return new ProviderError(`Google Drive answered ${res.status}. kymavo will try again.`, "unavailable");
  return new ProviderError(`Google Drive rejected the request (${res.status}).`, "invalid");
}

async function json(urls: ProviderUrls, token: string, path: string, init: RequestInit = {}): Promise<Reply> {
  const res = await call(`${urls.drive}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) } }, urls.timeoutMs ?? 30_000, false, "Google Drive");
  if (res.status !== 200 && res.status !== 204) throw failure(res);
  return res;
}

/** A download or export, at most maxBytes; null when it is larger. */
async function bytes(urls: ProviderUrls, token: string, path: string, maxBytes: number): Promise<Buffer | null> {
  let res: Response;
  try {
    res = await fetch(`${urls.drive}${path}`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(urls.timeoutMs ?? 30_000) });
  } catch {
    throw new ProviderError("Google Drive could not be reached. kymavo will try again.", "unavailable");
  }
  if (res.status !== 200 || !res.body) {
    const text = await res.text().catch(() => "");
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON: the status decides */
    }
    throw failure({ status: res.status, headers: res.headers, body });
  }
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body.cancel();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) return null;
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    throw new ProviderError("The download from Google Drive broke off. kymavo will try again.", "unavailable");
  }
  return Buffer.concat(chunks);
}

export async function driveSheetCsv(urls: ProviderUrls, auth: GoogleAuth, fileId: string, maxBytes: number): Promise<{ name: string; csv: string }> {
  if (!("accessToken" in auth)) throw new ProviderError("Read a spreadsheet works with a Google sign-in. In Apps, connect Google Drive with Google instead of a service account key.", "invalid");
  if (!isGoogleFileId(fileId)) throw new ProviderError("The file id is not a Google Drive file id. Use the file from the Drive trigger, {{trigger.fileId}}.", "invalid");
  const token = auth.accessToken;
  const id = encodeURIComponent(fileId);
  const meta = (await json(urls, token, `/drive/v3/files/${id}?${new URLSearchParams({ supportsAllDrives: "true", fields: "id,name,mimeType,size,trashed" })}`)).body;
  const name = String(meta.name ?? "");
  const mime = String(meta.mimeType ?? "");
  const tooBig = () => new ProviderError(`"${name}" is larger than ${maxBytes / 1024 / 1024} MB, the most kymavo reads at a time. Split the export into smaller files.`, "invalid");
  if (meta.trashed === true) throw new ProviderError(`"${name}" is in the Drive trash.`, "invalid");
  if (Number(meta.size) > maxBytes) throw tooBig();
  const csvExport = (sheetId: string) => bytes(urls, token, `/drive/v3/files/${encodeURIComponent(sheetId)}/export?mimeType=text%2Fcsv`, maxBytes);

  let data: Buffer | null;
  if (mime === SHEET_MIME) data = await csvExport(fileId);
  else if (mime === "text/csv" || /\.csv$/i.test(name)) data = await bytes(urls, token, `/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, maxBytes);
  else if (EXCEL.has(mime) || /\.xlsx?$/i.test(name)) {
    // In My Drive (root), not the watched folder, so the copy never starts the Drive trigger.
    const copy = await json(urls, token, `/drive/v3/files/${id}/copy?${new URLSearchParams({ supportsAllDrives: "true", fields: "id" })}`, { method: "POST", body: JSON.stringify({ name: `kymavo temporary copy of ${name}`.slice(0, 200), mimeType: SHEET_MIME, parents: ["root"] }) });
    const copyId = typeof copy.body.id === "string" ? copy.body.id : "";
    if (!isGoogleFileId(copyId)) throw new ProviderError("Google Drive answered without a file id. kymavo will try again.", "unavailable");
    try {
      data = await csvExport(copyId);
    } finally {
      // ponytail: a failed delete leaves the copy in My Drive; it is the owner's file, and a later run does not reuse it.
      await json(urls, token, `/drive/v3/files/${encodeURIComponent(copyId)}?supportsAllDrives=true`, { method: "DELETE" }).catch(() => undefined);
    }
  } else throw new ProviderError(`"${name}" is not a CSV, Excel or Google Sheets file.`, "invalid");
  if (!data) throw tooBig();
  return { name, csv: data.toString("utf8") };
}

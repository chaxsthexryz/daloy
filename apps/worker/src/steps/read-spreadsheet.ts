import { connectionCredential, driveSheetCsv, ProviderError, withGoogle, type Db, type ProviderUrls } from "@daloy/db";
import { csvTable, READ_SPREADSHEET_MAX_BYTES, StepError } from "@daloy/engine";
import { stepError } from "./paymongo";

export type ReadSpreadsheetInput = { fileId: string };

/** What a faked run returns: two orders shaped like a marketplace export. Nothing is read. */
export const SAMPLE_ORDERS = {
  name: "sample-orders.csv",
  columns: ["order_id", "order_status", "product_name", "quantity", "total_amount"],
  rows: [
    { order_id: "2411250001ABC", order_status: "To ship", product_name: "Canvas tote", quantity: "2", total_amount: "450.00" },
    { order_id: "2411250002DEF", order_status: "To ship", product_name: "Ceramic mug", quantity: "1", total_amount: "280.00" },
  ],
  count: 2,
};

/**
 * "Read a spreadsheet" (M1, decision 0139). A CSV, Excel or Google Sheets file in Drive becomes rows keyed by its header
 * row. Uses the Google Drive connection with a Google sign-in. Reads only, so a retry reads the file again.
 */
export async function readSpreadsheetStep(db: Db, key: Buffer, urls: ProviderUrls, userId: string, cfg: ReadSpreadsheetInput, claim: () => Promise<void>) {
  if (!cfg.fileId) throw new StepError("There is no file to read. Start this automation from the Drive trigger, or set the file id.", false);
  const conn = await connectionCredential(db, key, userId, "google_drive");
  if (!conn) throw new StepError("Connect Google Drive first, with a Google sign-in, then retry.", false);
  if (conn.status === "failed") throw new StepError(`Google Drive needs to be connected again (${conn.account}). Reconnect it in Apps, then retry.`, false);
  if (conn.authMethod !== "oauth") throw new StepError("Read a spreadsheet needs Google Drive connected with a Google sign-in, not a service account key. Reconnect it in Apps.", false);
  await claim();
  let file: { name: string; csv: string };
  try {
    file = await withGoogle(db, key, urls, userId, "google_drive", conn, (auth) => driveSheetCsv(urls, auth, cfg.fileId, READ_SPREADSHEET_MAX_BYTES));
  } catch (err) {
    throw err instanceof ProviderError ? stepError(err) : err;
  }
  return { name: file.name, ...csvTable(file.csv) };
}

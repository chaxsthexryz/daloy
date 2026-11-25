# 0143: Read a spreadsheet step for marketplace order exports (M1)

## Context

Sellers on Shopee, Lazada and TikTok Shop download their orders as a CSV or Excel file and type them into a sheet by hand. Live API sync with those marketplaces needs vendor app approval (G6), so it waits for a pilot seller. The `drive_file` trigger (decision 0129) already starts a run for each new file in the Drive folder picked in Apps, but it only keeps images and PDFs, and no step can read a spreadsheet.

## Options

1. Parse .xlsx in the worker with a library such as SheetJS or exceljs. That adds a dependency that parses untrusted zip and XML, and SheetJS's current builds are no longer on npm.
2. Let Google convert it: copy the Excel file as a Google Sheet through the Drive API, export the copy as `text/csv`, delete the copy, and parse CSV with a small parser of our own.
3. Ask sellers to save as CSV first. Most would not, and the marketplaces' default download is Excel.

## Decision

Option 2. A new `read_spreadsheet` step with one setting, `fileId`, a template that defaults to `{{trigger.fileId}}`.

- `packages/db/src/drive-sheet.ts` reads the file's metadata, then:
  - a `.csv` file (by type or name) is downloaded as it is,
  - a Google Sheets file is exported as CSV (its first tab),
  - an `.xlsx` or `.xls` file is copied as a Google Sheet into My Drive (`parents: ["root"]`), exported, and the copy deleted in a `finally`. The copy goes to My Drive, not the watched folder, so it never starts the trigger.
- It uses the Google Drive connection with a Google sign-in (`drive.file`), like the Google Docs step. A service account key has no Drive storage for the copy, so the step asks for a Google sign-in.
- `packages/engine/src/csv.ts` parses RFC 4180 CSV (quotes, commas and line breaks in quoted cells, `""`, a UTF-8 BOM, CRLF or LF, blank rows skipped) and keys each row by its header with `cellKeys`, the same rule the Sheets row trigger uses (`Order ID` is `order_id`, repeats get `_2`, an empty header gets its column letter). The Sheets trigger's `rowCells` now calls `cellKeys`, so the two cannot drift.
- Output is `{ name, rows, count, columns }`. The file and the CSV are each capped at 2 MB, and the rows at 2,000. Over a cap the step fails without retrying and says to split the export.
- No new dependency and no migration.

Templates: "Marketplace orders to Sheets" (drive_file, read_spreadsheet, a batched Sheets append with `rows: {{steps.read_orders.output.rows}}` and `{{item.<column>}}` columns, then a Slack note with the count) and "Low-stock alert" (sheets_row on a Stock tab, a number condition, an email, and an email for a row with no number).

## Consequences

- An order that appears in two overlapping exports is appended to the sheet twice. Nothing dedupes by order id. A dedupe step or a Sheets lookup can come when a pilot seller hits it.
- The Sheets batched append (E4, decision 0131) takes at most 100 rows, and a single `{{...}}` value is capped at 100,000 characters. An export with more than 100 orders, or very wide rows, fails at the Sheets step with its existing message, so the template suits a day's export for a small seller. Splitting a long list into batches of 100 is the upgrade.
- Column keys depend on the export's header text, which differs per marketplace and can change. The template's columns are an example the owner edits.
- A Google Sheets file exports only its first tab. A semicolon-separated file reads as one column.
- If deleting the temporary copy fails, the copy stays in the owner's My Drive. It is their own file and no later run reuses it.
- Retrying is safe: the step only reads, apart from the short-lived copy.

# 0140: Invoice PDF step and email attachments (N23)

## Context

Freelancers bill clients with an invoice and chase it until paid. The `invoice-paymongo` template already sends a PayMongo link and reminds while the payment is pending, but there is no invoice document, and the email step cannot send files. The worker only reads PDFs today, through `pdfjs-dist`, which cannot write them.

## Options

1. Fill a Google Docs template and export it as PDF. It needs a Google connection and a template document per owner, and the money maths would sit in a document the run cannot check.
2. Render HTML to PDF in the browser service (B2). It works only where the browser service runs, and it is a heavy path for one page of text.
3. Draw the page with `pdf-lib` in the worker. MIT, plain JavaScript with no native parts, and it uses the 14 standard PDF fonts, so no font files ship.

## Decision

- Option 3. `pdf-lib` 1.17.1 is pinned in `apps/worker`. It is the current release; it pulls in `pako` (MIT), `tslib` (0BSD) and two small `@pdf-lib` packages (MIT).
- New `invoice_pdf` step (`apps/worker/src/steps/invoice-pdf.ts`). Every field is a template: business name, client name and email, invoice number, line items (description, quantity, unit price), due date and notes. Currency is PHP only.
- Money is integer centavos. Unit prices are pesos with up to 2 decimals and optional thousands commas, from 0 to 9,999,999.99. Quantities have up to 2 decimals (2.5 hours), above 0 and up to 10,000. A line is quantity hundredths times unit centavos over 100, rounded half up; every product stays below 2^53.
- The page is one A4 sheet. Line items are capped at 30 (`INVOICE_MAX_ITEMS`): 30 rows, the total and 6 lines of notes fit by construction. Long text is cut with "...". A row whose description resolves empty is left off, so a template can list optional rows.
- The standard fonts draw Latin-1 (WinAnsi) only. Characters outside it (emoji, CJK, the peso sign) become "?" instead of failing the run, and amounts are written "PHP 1,500.00".
- The PDF is stored with `saveUploads` under the run, in the same `uploads` table and `FileRef` shape as form files, and returned as `output.file`. The output also has `total` ("1500.00", the form `paymongo_link` takes), `totalText`, `totalCentavos` and `invoiceNumber`. A test run draws the PDF but stores nothing and returns `file: null`.
- The email step (not Outlook, which shares the config schema) gets an optional `attachments` list of up to 3 templates. Each resolves to a FileRef or a form field's list of them. The worker (`apps/worker/src/steps/attachments.ts`) reads each file with `readUpload`, which matches the workspace, the run and the file id. Only the id is taken from the ref: name, type and bytes come from the stored row. Anything else is refused before the email is counted or sent. `packages/db/src/mail.ts` passes the files to nodemailer next to the brand logo, for SMTP and the Gmail API alike.
- `invoice_pdf` is not in the test-run `OUTSIDE` sets: it calls nothing outside kymavo, so a tester has nothing to make fail.
- Templates: "Invoice with PDF and reminders" (`invoice-pdf`) and "Deposit before work starts" (`deposit-first`). Both start with an approval to the owner, because a hosted form is public and the starter rule (no submitted text to the form's address before an approval) applies. The invoice reminders attach nothing: uploads are purged after 7 days, and the first reminder goes out after 7.

## Consequences

- A freelancer can send a PDF invoice and a payment link in one email and chase it with the existing reminder loop.
- Each attempt of the step stores its own PDF. A retried attempt leaves an unused file until the 7-day purge.
- Names in Chinese, Japanese or Korean script, and emoji, print as "?". Embedding a Unicode font (with `@pdf-lib/fontkit`) can come when a pilot user needs it.
- An attachment cannot come from another run, so a sub-workflow cannot attach its parent's files. Passing files between runs would need its own ownership rule.
- One currency (PHP), no tax lines and no discounts. Those can be added as fields when a user asks.

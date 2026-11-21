# 0091: The public pay page and private receipt images

## Context

The manual path needs a page where the customer sees what to pay and where, and sends the order reference, the transfer reference and an optional receipt image. It is public, takes uploads, and shows where the seller's money goes, so it is an entry point for spam, enumeration and redirecting payments.

## Options

- A page per workspace where the customer types the order reference, or a page per due behind a random token.
- Receipt images in the `uploads` table (tied to a run) or on the claim.

## Decision

- `/pay/<token>` per due. The token is 32 random bytes (base64url), so knowing D-1042 does not open its page, and nobody can list another order's amount or file claims against it. The `payment_due` step's output `payUrl` carries it, and staff send it by SMS or Messenger.
- The page shows the amount, the order reference, the seller's GCash or account number, account name and QR Ph image, the PayMongo checkout link when there is one (only an `https://` URL from PayMongo is shown), and the form. After a decision it shows Paid, the reviewer's question, or the rejection reason. It never says a screenshot proves payment.
- `POST /pay/<token>` is limited to 10 requests a minute per IP before multer reads the body, takes one file of at most 5 MB, validates the fields with zod (reference 4 to 64 characters of a small charset, amount parsed into centavos with no floats) and has a honeypot. An image counts against the workspace's daily `upload` quota.
- Receipt images are stored on the claim (`payment_claims.image`), only when their bytes are JPEG, PNG, WebP or HEIC. `GET /payments/claims/:id/image` serves them to owners and operators of the claim's workspace, with `nosniff`, a `sandbox` CSP and `no-store`. A claim of another workspace answers 404.
- `payment_settings` holds the number, name and QR image. Only the owner changes them (`PUT /payments/settings`), since they decide where customers send money. The QR image is served from `/pay/<token>/qr` to whoever holds a pay link, because it is meant for customers.

## Consequences

- Anyone with a pay link can send claims for that one order, up to the rate limit. Claims only add review work; they never confirm.
- Images stay in Postgres until the claim's due or workspace is deleted. Retention is R6 (RA 10173).
- The rate limit counts per API instance in memory, like the others (decision noted in `http.ts`).

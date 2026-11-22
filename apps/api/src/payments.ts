import { centavosToPesos, claimImage, decideClaim, dueByToken, duesForBooking, latestClaim, manilaDay, paymentsExport, pendingCheckout, pesosToCentavos, QuotaError, readPaymentSettings, readProfile, retryReply, reviewList, savePaymentSettings, submitTransferClaim, TooManyClaimsError, workspaceLanguage, type Db, type Due } from "@daloy/db";
import { FILE_MAX_BYTES, FILE_MIME, fileType } from "@daloy/engine";
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, Put, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { COMPRESS_TAG } from "./compress";
import { toCsv } from "./csv";
import { Allow, CurrentUser, DB, MANAGE, OPERATE, RateLimit, ZodPipe, type SessionUser } from "./http";
import { escapeHtml, page, pageBrand, privacyNotice, UploadBudget } from "./public";

/**
 * R3 payments (decisions 0088 to 0090). Staff routes are for the owner and operators of the workspace only: they see
 * receipt images and decide. The pay page is public, found by a 32-byte token, and never confirms a payment.
 */

export const decideInput = z.object({ version: z.int().min(1), decision: z.enum(["confirm", "reject", "clarify"]), reason: z.string().trim().max(500).optional() });
const duesQuery = z.object({ booking: z.uuid().optional(), reference: z.string().trim().min(1).max(200).optional() });
export const settingsInput = z.object({
  gcashNumber: z.string().trim().max(40).regex(/^[0-9 +()-]*$/, "use digits, spaces, +, ( ) and - only").transform((s) => s || null).nullable(),
  accountName: z.string().trim().max(100).transform((s) => s || null).nullable(),
  // A base64 image of at most 1 MB, or null to remove it. Left out, the stored image stays.
  // Days a receipt image stays after its payment closes (decision 0094). Left out, the stored value stays.
  receiptRetentionDays: z.int().min(1).max(3650).optional(),
  qr: z.string().max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, "send the image as base64").nullable().optional(),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine((d) => new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "not a real date");
/** A Manila day range of at most a year, so one download stays a reasonable size. */
export const exportQuery = z
  .object({ from: day, to: day })
  .refine((q) => q.from <= q.to, "from must not be after to")
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 365 * 86_400_000, "choose at most one year");

const REVIEW_ERRORS = {
  not_found: () => new NotFoundException("receipt not found"),
  conflict: () => new ConflictException("Someone decided this receipt or it changed since you loaded it. Reload and try again."),
  forbidden: () => new ForbiddenException("This payment is assigned to another reviewer."),
  already_confirmed: () => new ConflictException("This payment is already confirmed. Reject this receipt with a reason if the customer paid twice."),
  reason_needed: () => new BadRequestException("Write the reason the customer will see."),
} as const;

@Controller("payments")
@UseGuards(SessionGuard, Allow(OPERATE))
export class PaymentsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("review")
  review(@CurrentUser() user: SessionUser) {
    return reviewList(this.db, user.workspaceId);
  }

  /** Confirmed payments by Manila day for bookkeeping. Cells go through the same formula escaping as the other downloads (N19). */
  @Get("export.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  async exportCsv(@CurrentUser() user: SessionUser, @Query(new ZodPipe(exportQuery)) q: z.output<typeof exportQuery>, @Res({ passthrough: true }) res: Response) {
    const rows = await paymentsExport(this.db, user.workspaceId, q);
    res.set("Content-Disposition", `attachment; filename="payments-${q.from}-to-${q.to}.csv"`);
    return toCsv(
      ["confirmed_on", "confirmed_at", "reference", "booking", "kind", "amount_php", "total_php", "status", "source", "transfer_reference", "confirmed_by"],
      rows.map((r) => [manilaDay(r.confirmedAt!), r.confirmedAt!.toISOString(), r.reference, r.booking, r.kind, centavosToPesos(r.amount), r.total === null ? null : centavosToPesos(r.total), r.status, r.source, r.transferRef, r.confirmedBy]),
    );
  }

  @Get("dues")
  dues(@CurrentUser() user: SessionUser, @Query(new ZodPipe(duesQuery)) q: z.output<typeof duesQuery>) {
    return duesForBooking(this.db, user.workspaceId, { bookingId: q.booking, reference: q.reference });
  }

  /** The receipt image, for staff of the claim's workspace only. Shown inline as an image and never cached. */
  @Get("claims/:id/image")
  async image(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string, @Res({ passthrough: true }) res: Response) {
    const img = await claimImage(this.db, user.workspaceId, id);
    if (!img) throw new NotFoundException();
    res.set({ "Content-Type": FILE_MIME[img.type], "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, no-store" });
    return new StreamableFile(img.bytes);
  }

  @Post("claims/:id/decide")
  @HttpCode(200)
  async decide(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string, @Body(new ZodPipe(decideInput)) body: z.output<typeof decideInput>) {
    const r = await decideClaim(this.db, { workspaceId: user.workspaceId, actor: { id: user.id, role: user.role }, claimId: id, version: body.version, decision: body.decision, reason: body.reason });
    if (r.result !== "done") throw REVIEW_ERRORS[r.result]();
    const open = r.due && body.decision === "confirm" ? await pendingCheckout(this.db, r.due.id) : undefined;
    return { status: r.claim!.status, dueStatus: r.due!.status, checkoutOpen: Boolean(open) };
  }

  /** Payment confirmed, reply failed: sends the reply again. The payment state does not change. */
  @Post("dues/:id/retry-reply")
  @HttpCode(200)
  async retry(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    if (!(await retryReply(this.db, user.workspaceId, id))) throw new ConflictException("There is no failed reply to send again for this payment.");
    return { ok: true };
  }

  @Get("settings")
  async settings(@CurrentUser() user: SessionUser) {
    const s = await readPaymentSettings(this.db, user.workspaceId);
    return { gcashNumber: s?.gcashNumber ?? null, accountName: s?.accountName ?? null, hasQr: Boolean(s?.qrImage), receiptRetentionDays: s?.receiptRetentionDays ?? 90 };
  }

  /** Where customers send money: the owner alone may change it. */
  @Put("settings")
  @UseGuards(Allow(MANAGE))
  async save(@CurrentUser() user: SessionUser, @Body(new ZodPipe(settingsInput)) body: z.output<typeof settingsInput>) {
    let qr: { bytes: Buffer; type: "jpeg" | "png" | "webp" } | null | undefined;
    if (body.qr) {
      const bytes = Buffer.from(body.qr, "base64");
      const type = fileType(bytes);
      if (bytes.length > 1024 * 1024 || (type !== "jpeg" && type !== "png" && type !== "webp")) throw new BadRequestException("qr: use a JPEG, PNG or WebP image of at most 1 MB");
      qr = { bytes, type };
    } else qr = body.qr === null ? null : undefined;
    await savePaymentSettings(this.db, user.workspaceId, { gcashNumber: body.gcashNumber, accountName: body.accountName, qr, receiptRetentionDays: body.receiptRetentionDays });
    return this.settings(user);
  }
}

const COPY = {
  en: {
    title: "Payment",
    kinds: { deposit: "Deposit", full: "Payment", balance: "Balance" },
    for: "for",
    how: "Pay this amount to the QR Ph code or number below with GCash, Maya or your bank app, then send us the reference number from your transfer.",
    number: "GCash or account number",
    name: "Account name",
    qrAlt: "QR Ph code to pay",
    checkout: "Or pay online with GCash",
    order: "Order reference",
    ref: "Transfer reference number",
    refHint: "The reference number on your GCash or bank confirmation.",
    amount: "Amount you sent (pesos, optional)",
    receipt: "Receipt screenshot (optional)",
    receiptHint: "JPEG, PNG, WebP or HEIC, up to 5 MB.",
    send: "Send reference",
    sent: "Reference received",
    sentNote: "The seller checks their own GCash or bank history and confirms. Your order stays pending until then.",
    paid: "Paid",
    paidNote: "This payment is confirmed. Thank you.",
    cancelled: "This order was cancelled because it was not paid in time. If you already paid, send your reference and the seller will check it.",
    waiting: "We have your reference {ref}. The seller has not confirmed it yet.",
    clarify: "The seller asks: {reason}",
    rejected: "The seller could not confirm reference {ref}: {reason}",
    notFound: "This payment link is not valid.",
    bad: "Check these and send again.",
    tooMany: "Too many uploads today. Please send your reference without the screenshot.",
    tooManyOpen: "This order already has several references waiting for the seller. Wait for the seller to check them, or message the seller.",
  },
  tl: {
    title: "Bayad",
    kinds: { deposit: "Deposit", full: "Bayad", balance: "Balanse" },
    for: "para sa",
    how: "Bayaran ang halagang ito sa QR Ph code o numero sa ibaba gamit ang GCash, Maya o app ng iyong bangko, at ipadala sa amin ang reference number ng transfer.",
    number: "GCash o account number",
    name: "Pangalan ng account",
    qrAlt: "QR Ph code para magbayad",
    checkout: "O magbayad online gamit ang GCash",
    order: "Reference ng order",
    ref: "Reference number ng transfer",
    refHint: "Ang reference number sa kumpirmasyon ng GCash o bangko.",
    amount: "Halagang ipinadala (piso, opsyonal)",
    receipt: "Screenshot ng resibo (opsyonal)",
    receiptHint: "JPEG, PNG, WebP o HEIC, hanggang 5 MB.",
    send: "Ipadala ang reference",
    sent: "Natanggap ang reference",
    sentNote: "Titingnan ng seller ang sarili nilang GCash o bangko bago kumpirmahin. Nakabinbin ang order hanggang doon.",
    paid: "Bayad na",
    paidNote: "Kumpirmado na ang bayad na ito. Salamat.",
    cancelled: "Kinansela ang order na ito dahil hindi nabayaran sa oras. Kung nakabayad ka na, ipadala ang reference at titingnan ito ng seller.",
    waiting: "Natanggap namin ang reference {ref}. Hindi pa ito nakukumpirma ng seller.",
    clarify: "Tanong ng seller: {reason}",
    rejected: "Hindi makumpirma ng seller ang reference {ref}: {reason}",
    notFound: "Hindi valid ang payment link na ito.",
    bad: "Tingnan ang mga ito at ipadala muli.",
    tooMany: "Masyadong maraming upload ngayong araw. Ipadala ang reference nang walang screenshot.",
    tooManyOpen: "May ilang reference na ang order na ito na naghihintay sa seller. Hintaying matingnan ng seller ang mga ito, o i-message ang seller.",
  },
} as const;

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => escapeHtml(v[k] ?? ""));
const pesos = (c: number) => `PHP ${Number(centavosToPesos(c)).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;
const TOKEN = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const HONEYPOT = "website";
export const payInput = z.object({
  transfer_ref: z.string().trim().min(4, "transfer_ref: at least 4 characters").max(64, "transfer_ref: at most 64 characters").regex(/^[A-Za-z0-9 #./-]+$/, "transfer_ref: letters, digits, spaces and # . / - only"),
  amount: z.string().trim().max(20).optional().transform((s) => (s ? s : undefined)),
});

type Upload = { buffer: Buffer; size: number };

/** One receipt at its limit plus the small text fields. */
const PAY_MAX_BYTES = FILE_MAX_BYTES + 64 * 1024;
async function payLinkExists(db: Db, req: Request) {
  const token = req.params.token;
  if (typeof token !== "string" || !TOKEN.safeParse(token).success || !(await dueByToken(db, token))) throw new NotFoundException();
}

/** The customer's pay page: the seller's QR Ph code and number, the PayMongo link when there is one, and the reference form. */
@Controller("pay")
export class PayPageController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get(":token")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async show(@Param("token") token: string, @Res({ passthrough: true }) res: Response) {
    const due = TOKEN.safeParse(token).success ? await dueByToken(this.db, token) : undefined;
    if (!due) {
      res.status(HttpStatus.NOT_FOUND);
      return page(`<h1>${COPY.en.notFound}</h1>`, COPY.en.title);
    }
    return this.render(due);
  }

  /** The seller's QR Ph image. It is meant for customers, so it is served to whoever holds a pay link. */
  @Get(":token/qr")
  async qr(@Param("token") token: string, @Res({ passthrough: true }) res: Response) {
    const due = TOKEN.safeParse(token).success ? await dueByToken(this.db, token) : undefined;
    const s = due && (await readPaymentSettings(this.db, due.userId));
    if (!s?.qrImage || !s.qrType) throw new NotFoundException();
    res.set({ "Content-Type": FILE_MIME[s.qrType], "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300" });
    return new StreamableFile(s.qrImage);
  }

  @Post(":token")
  @HttpCode(200)
  // Guards run before interceptors, so an IP over the limit is refused before multer reads the body.
  // The shared upload budget, and an unknown link refused, before multer reads a byte (review of 22 November, M1).
  @UseGuards(RateLimit(10), UploadBudget({ maxBytes: PAY_MAX_BYTES, check: payLinkExists }))
  @UseInterceptors(FileInterceptor("receipt", { limits: { fileSize: FILE_MAX_BYTES, files: 1, fields: 10, fieldSize: 4096, parts: 12 } }))
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async submit(@Param("token") token: string, @Body() body: Record<string, unknown> | undefined, @UploadedFile() file: Upload | undefined, @Res({ passthrough: true }) res: Response) {
    const due = TOKEN.safeParse(token).success ? await dueByToken(this.db, token) : undefined;
    if (!due) {
      res.status(HttpStatus.NOT_FOUND);
      return page(`<h1>${COPY.en.notFound}</h1>`, COPY.en.title);
    }
    const language = await workspaceLanguage(this.db, due.userId);
    const copy = COPY[language];
    // Bots fill every field. Answer as if it worked so they learn nothing.
    if (body?.[HONEYPOT]) return this.render(due, { sent: true });
    const parsed = payInput.safeParse(body ?? {});
    const errors = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    let submittedCentavos: number | undefined;
    if (parsed.success && parsed.data.amount !== undefined) {
      try {
        submittedCentavos = pesosToCentavos(parsed.data.amount);
      } catch (err) {
        errors.push(`amount: ${(err as Error).message}`);
      }
    }
    if (errors.length > 0 || !parsed.success) {
      res.status(HttpStatus.BAD_REQUEST);
      return this.render(due, { errors, values: body });
    }
    const image = file && file.size > 0 ? { bytes: file.buffer } : undefined;
    try {
      await submitTransferClaim(this.db, token, { transferRef: parsed.data.transfer_ref, submittedCentavos, image });
    } catch (err) {
      if (!(err instanceof QuotaError) && !(err instanceof TooManyClaimsError)) throw err;
      res.status(HttpStatus.TOO_MANY_REQUESTS);
      return this.render(due, { errors: [err instanceof QuotaError ? copy.tooMany : copy.tooManyOpen], values: body });
    }
    return this.render(due, { sent: true });
  }

  private async render(due: Due, view: { sent?: boolean; errors?: string[]; values?: Record<string, unknown> } = {}) {
    const language = await workspaceLanguage(this.db, due.userId);
    const copy = COPY[language];
    const brand = await pageBrand(this.db, due.userId);
    const fresh = (await dueByToken(this.db, due.token))!;
    const settings = await readPaymentSettings(this.db, due.userId);
    const checkout = fresh.status === "pending" ? await pendingCheckout(this.db, fresh.id) : undefined;
    const last = await latestClaim(this.db, fresh.id);
    const head = `<h1>${copy.kinds[fresh.kind]} ${copy.for} ${escapeHtml(fresh.reference)}</h1><div class="receipt"><div><span class="k">${copy.order}</span><strong class="ref">${escapeHtml(fresh.reference)}</strong></div><strong>${pesos(fresh.amountCentavos)}</strong></div>`;
    if (fresh.status === "confirmed" || fresh.status === "refunded") return page(`${head}<span class="pill">${copy.paid}</span><p class="lead">${copy.paidNote}</p>`, copy.title, language, brand);

    const notes: string[] = [];
    if (view.sent) notes.push(`<div class="alert" role="status"><b>${copy.sent}</b><div>${copy.sentNote}</div></div>`);
    else if (last?.status === "clarify") notes.push(`<div class="alert" role="status">${fill(copy.clarify, { reason: last.reason ?? "" })}</div>`);
    else if (last?.status === "rejected") notes.push(`<div class="alert" role="status">${fill(copy.rejected, { ref: last.transferRef ?? "", reason: last.reason ?? "" })}</div>`);
    else if (last?.status === "open") notes.push(`<p class="lead">${fill(copy.waiting, { ref: last.transferRef ?? "" })}</p>`);
    if (fresh.status === "cancelled") notes.push(`<p class="lead">${copy.cancelled}</p>`);
    if (view.errors?.length) notes.push(`<div class="alert" role="alert"><b>${copy.bad}</b><div>${view.errors.map(escapeHtml).join("<br>")}</div></div>`);

    const where = [
      settings?.qrImage ? `<p><img src="/pay/${fresh.token}/qr" alt="${copy.qrAlt}" width="240" height="240"></p>` : "",
      settings?.gcashNumber ? `<div class="receipt"><div><span class="k">${copy.number}</span><strong class="ref">${escapeHtml(settings.gcashNumber)}</strong></div>${settings.accountName ? `<div><span class="k">${copy.name}</span><strong>${escapeHtml(settings.accountName)}</strong></div>` : ""}</div>` : "",
      // Only an https link from PayMongo is shown.
      checkout && /^https:\/\//.test(checkout.url) ? `<p><a class="btn" href="${escapeHtml(checkout.url)}" rel="noreferrer">${copy.checkout}</a></p>` : "",
    ].join("");
    const v = (k: string) => (typeof view.values?.[k] === "string" ? escapeHtml(view.values[k] as string) : "");
    const form = `<form method="post" enctype="multipart/form-data">
<div class="f"><label for="transfer_ref">${copy.ref}</label><input id="transfer_ref" name="transfer_ref" required minlength="4" maxlength="64" autocomplete="off" value="${v("transfer_ref")}"><div class="hint">${copy.refHint}</div></div>
<div class="f"><label for="amount">${copy.amount}</label><input id="amount" name="amount" inputmode="decimal" maxlength="20" value="${v("amount")}"></div>
<div class="f"><label for="receipt">${copy.receipt}</label><input id="receipt" name="receipt" type="file" accept="image/jpeg,image/png,image/webp,image/heic,.heic"><div class="hint">${copy.receiptHint}</div></div>
<div aria-hidden="true" style="position:absolute;left:-9999px"><label for="${HONEYPOT}">Website</label><input id="${HONEYPOT}" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></div>
<button class="btn" type="submit">${copy.send}</button>${privacyNotice(language, (await readProfile(this.db, due.userId))?.businessName ?? undefined)}</form>${COMPRESS_TAG}`;
    return page(`${head}${notes.join("")}<p class="lead">${copy.how}</p>${where}${form}`, copy.title, language, brand);
  }
}

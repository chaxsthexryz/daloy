import { lalamoveOrder, lalamoveQuote, ProviderError, readSecret, type Db, type ProviderUrls } from "@daloy/db";
import { normalizePhMobile, StepError } from "@daloy/engine";
import { stepError } from "./paymongo";

export type LalamoveInput = {
  serviceType: string;
  live: boolean;
  pickupAddress: string;
  pickupLat: string;
  pickupLng: string;
  senderName: string;
  senderPhone: string;
  dropoffAddress: string;
  dropoffLat: string;
  dropoffLng: string;
  recipientName: string;
  recipientPhone: string;
  remarks?: string;
};

/** What a sample or test run returns instead of a booking. Same keys as a real one, so later steps still resolve. */
export const SAMPLE_LALAMOVE = { orderId: "sample-order", status: "ASSIGNING_DRIVER", shareLink: "", total: "0", currency: "PHP", quotationId: "sample-quotation" };

const coordinate = (value: string, what: string, max: number) => {
  const n = Number(value);
  if (value === "" || !Number.isFinite(n) || Math.abs(n) > max) throw new StepError(`${what} must be a number in decimal degrees, like 14.5794. Got "${value.slice(0, 40)}".`, false);
  return value;
};
const mobile = (value: string, what: string) => {
  const p = normalizePhMobile(value);
  if (!p.ok) throw new StepError(`${what}: ${p.error}`, false);
  return p.value;
};

/**
 * Quotation, then order, with the seller's own key from Secrets (decision 0141). Everything is checked before the first
 * request. Only the order spends money, so only the order goes through claimSend: an attempt that dies after it was sent
 * is never sent again on its own, and a person checks the seller's Lalamove orders first.
 */
export async function bookLalamove(
  deps: { db: Db; secretsKey: Buffer; urls: ProviderUrls },
  at: { userId: string; runId: string; stepId: string },
  cfg: LalamoveInput,
  claim: () => Promise<void>,
  claimSend?: () => Promise<() => void>,
) {
  const pickup = { address: cfg.pickupAddress, lat: coordinate(cfg.pickupLat, "Pick-up latitude", 90), lng: coordinate(cfg.pickupLng, "Pick-up longitude", 180) };
  const dropoff = { address: cfg.dropoffAddress, lat: coordinate(cfg.dropoffLat, "Drop-off latitude", 90), lng: coordinate(cfg.dropoffLng, "Drop-off longitude", 180) };
  if (!pickup.address || !dropoff.address) throw new StepError("The pick-up and drop-off addresses cannot be empty.", false);
  const sender = { name: cfg.senderName, phone: mobile(cfg.senderPhone, "Sender mobile") };
  const recipient = { name: cfg.recipientName, phone: mobile(cfg.recipientPhone, "Recipient mobile"), ...(cfg.remarks ? { remarks: cfg.remarks } : {}) };

  const apiKey = await readSecret(deps.db, deps.secretsKey, at.userId, "lalamove_api_key");
  const apiSecret = await readSecret(deps.db, deps.secretsKey, at.userId, "lalamove_api_secret");
  if (!apiKey || !apiSecret) throw new StepError("Save your Lalamove API key and secret in Secrets as lalamove_api_key and lalamove_api_secret first.", false);
  // Live is the step's own switch. A production key never books from a step that is not live, and a sandbox key on a
  // live step would book nothing while the owner thinks a rider is coming.
  if (!cfg.live && !apiKey.startsWith("pk_test")) throw new StepError("This is a production Lalamove key, and the step is not live. Turn on live in the step to book real riders, or save your sandbox key (pk_test).", false);
  if (cfg.live && !apiKey.startsWith("pk_prod")) throw new StepError("The step is live, but lalamove_api_key is a sandbox key. Save your production key (pk_prod) or turn live off.", false);

  const keys = { urls: deps.urls, apiKey, apiSecret, live: cfg.live };
  await claim();
  try {
    const quote = await lalamoveQuote({ ...keys, serviceType: cfg.serviceType, pickup, dropoff });
    const release = claimSend ? await claimSend() : () => {};
    const sent = lalamoveOrder({ ...keys, quote, sender, recipient, metadata: { kymavo_run: at.runId, kymavo_step: at.stepId } });
    release();
    const order = await sent;
    return { ...order, quotationId: quote.quotationId, live: cfg.live };
  } catch (err) {
    throw err instanceof ProviderError ? stepError(err) : err;
  }
}

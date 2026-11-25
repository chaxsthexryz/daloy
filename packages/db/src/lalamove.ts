import { createHmac, randomUUID } from "node:crypto";
import { call, ProviderError, retryAfter, type ProviderUrls } from "./providers";

// Lalamove API v3 (decision 0141). Docs: https://developers.lalamove.com/. The seller's own key and secret, kept in
// their secrets (lalamove_api_key, lalamove_api_secret). Sandbox unless the step says live.
export const LALAMOVE_SANDBOX = "https://rest.sandbox.lalamove.com";
export const LALAMOVE_PRODUCTION = "https://rest.lalamove.com";

/** HmacSHA256ToHex("<time>\r\n<METHOD>\r\n<path>\r\n\r\n<body>", secret). The path includes /v3; a GET has no body. */
export const lalamoveSignature = (secret: string, time: string, method: string, path: string, body: string) =>
  createHmac("sha256", secret).update(`${time}\r\n${method}\r\n${path}\r\n\r\n${body}`).digest("hex");

export const lalamoveAuthorization = (key: string, secret: string, time: string, method: string, path: string, body: string) =>
  `hmac ${key}:${time}:${lalamoveSignature(secret, time, method, path, body)}`;

type Keys = { urls: ProviderUrls; apiKey: string; apiSecret: string; live: boolean };
type Stop = { address: string; lat: string; lng: string };
export type LalamoveQuote = { quotationId: string; pickupStopId: string; dropoffStopId: string; total: string; currency: string };

// The key and secret go into the Authorization header only. No error below echoes a header, the key or the body.
async function post(k: Keys, path: string, data: unknown, write: boolean) {
  const body = JSON.stringify({ data });
  const time = String(Date.now());
  const res = await call(
    `${k.urls.lalamove ?? (k.live ? LALAMOVE_PRODUCTION : LALAMOVE_SANDBOX)}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: lalamoveAuthorization(k.apiKey, k.apiSecret, time, "POST", path, body), market: "PH", "request-id": randomUUID() },
      body,
    },
    k.urls.timeoutMs ?? 10_000,
    write,
    "Lalamove",
  );
  if (res.status === 429) throw new ProviderError("Lalamove is limiting requests right now. kymavo will try again.", "quota", retryAfter(res.headers));
  if (res.status >= 500) throw new ProviderError(`Lalamove answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  if (res.status === 401) throw new ProviderError("Lalamove does not accept this API key and secret. Check lalamove_api_key and lalamove_api_secret in Secrets, and that live matches the key (pk_test is sandbox, pk_prod is live).", "auth");
  if (res.status === 402) throw new ProviderError("Lalamove says your wallet has too little credit. Top up your Lalamove Wallet, then send the step again.", "invalid");
  if (res.status >= 400) {
    const first = (res.body.errors as { id?: unknown; detail?: unknown }[] | undefined)?.[0];
    const detail = [first?.id, first?.detail, res.body.message].filter((v) => typeof v === "string").join(": ");
    throw new ProviderError(`Lalamove refused the request (${res.status})${detail ? `: ${detail}` : ""}.`, "invalid");
  }
  return (res.body.data ?? {}) as Record<string, unknown>;
}

const price = (d: Record<string, unknown>) => {
  const p = (d.priceBreakdown ?? {}) as { total?: unknown; currency?: unknown };
  return { total: String(p.total ?? ""), currency: String(p.currency ?? "") };
};

/** A quotation for one pick-up and one drop-off. Reads only, so a failure here is safe to retry. Honoured for 5 minutes. */
export async function lalamoveQuote(o: Keys & { serviceType: string; pickup: Stop; dropoff: Stop }): Promise<LalamoveQuote> {
  const stop = (s: Stop) => ({ coordinates: { lat: s.lat, lng: s.lng }, address: s.address });
  const d = await post(o, "/v3/quotations", { serviceType: o.serviceType, language: "en_PH", stops: [stop(o.pickup), stop(o.dropoff)] }, false);
  const stops = (d.stops ?? []) as { stopId?: unknown }[];
  const [a, b] = stops.map((s) => (typeof s.stopId === "string" || typeof s.stopId === "number" ? String(s.stopId) : ""));
  if (typeof d.quotationId !== "string" || !a || !b) throw new ProviderError("Lalamove answered without a quotation.", "invalid");
  return { quotationId: d.quotationId, pickupStopId: a, dropoffStopId: b, ...price(d) };
}

type Person = { name: string; phone: string };

/** Places the order for a quotation. In live mode this books a rider and charges the seller's Lalamove Wallet. */
export async function lalamoveOrder(o: Keys & { quote: LalamoveQuote; sender: Person; recipient: Person & { remarks?: string }; metadata: Record<string, string> }) {
  const d = await post(
    o,
    "/v3/orders",
    {
      quotationId: o.quote.quotationId,
      sender: { stopId: o.quote.pickupStopId, ...o.sender },
      recipients: [{ stopId: o.quote.dropoffStopId, ...o.recipient }],
      metadata: o.metadata,
    },
    true,
  );
  // The order may exist even though the answer is unreadable, so a person checks before anything is sent again.
  if (typeof d.orderId !== "string") throw new ProviderError("Lalamove answered without an order id. Check your Lalamove orders before sending this step again.", "review");
  return { orderId: d.orderId, status: String(d.status ?? ""), shareLink: String(d.shareLink ?? ""), ...price(d) };
}

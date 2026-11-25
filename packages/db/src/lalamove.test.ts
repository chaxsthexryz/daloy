import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lalamoveAuthorization, lalamoveOrder, lalamoveQuote, lalamoveSignature, LALAMOVE_SANDBOX, LALAMOVE_PRODUCTION } from "./lalamove";
import { ProviderError, type ProviderUrls } from "./providers";

// Values from the Authentication section of https://developers.lalamove.com/ (API v3). The docs elide the request body
// of their worked example ("JSON.stringify({...})"), so its published signature cannot be reproduced. The expected
// hex below was computed outside Node with: printf '<raw>' | openssl dgst -sha256 -hmac 'sk_test_Lalamove'.
const SECRET = "sk_test_Lalamove";
const TIME = "1545880607433";

describe("lalamoveSignature", () => {
  it("signs <time>\\r\\n<METHOD>\\r\\n<path>\\r\\n\\r\\n<body> with HMAC-SHA256 in lowercase hex, as the docs say", () => {
    expect(lalamoveSignature(SECRET, TIME, "POST", "/v3/quotations", '{"data":{}}')).toBe("a835ef8f07f61c04fb52186f3527b5d91b8a2a1816b4344a5db71888d4794119");
  });

  it("signs a GET with nothing after the blank line", () => {
    expect(lalamoveSignature(SECRET, TIME, "GET", "/v3/cities", "")).toBe("5f57cf16ff137c2f20c471b438c726853e3f46b38be11faa606e518c2fe163a0");
  });

  it("builds the docs' header shape: hmac <KEY>:<TIMESTAMP>:<SIGNATURE>", () => {
    const sig = lalamoveSignature(SECRET, TIME, "POST", "/v3/quotations", '{"data":{}}');
    expect(lalamoveAuthorization("pk_test_Lalamove", SECRET, TIME, "POST", "/v3/quotations", '{"data":{}}')).toBe(`hmac pk_test_Lalamove:${TIME}:${sig}`);
  });

  it("uses the documented sandbox and production hosts", () => {
    expect(LALAMOVE_SANDBOX).toBe("https://rest.sandbox.lalamove.com");
    expect(LALAMOVE_PRODUCTION).toBe("https://rest.lalamove.com");
  });
});

type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: string };
const seen: Seen[] = [];
let fake: Server;
let urls: ProviderUrls;
let answer: (s: Seen) => [number, unknown] = () => [500, {}];

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const s = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: raw };
      seen.push(s);
      const [status, json] = answer(s);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  urls = { lalamove: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` } as ProviderUrls;
});
afterAll(() => fake.close());

const stops = {
  pickup: { address: "Unit 1, 123 Shaw Blvd, Mandaluyong", lat: "14.5794", lng: "121.0359" },
  dropoff: { address: "45 Kalayaan Ave, Quezon City", lat: "14.6507", lng: "121.0494" },
};
const keys = { apiKey: "pk_test_abc", apiSecret: "sk_test_xyz" };

function verify(s: Seen) {
  const [, token] = String(s.headers.authorization).split(" ");
  const [key, time, sig] = token!.split(":");
  expect(key).toBe(keys.apiKey);
  expect(sig).toBe(createHmac("sha256", keys.apiSecret).update(`${time}\r\n${s.method}\r\n${s.path}\r\n\r\n${s.body}`).digest("hex"));
  expect(s.headers.market).toBe("PH");
  expect(s.headers["request-id"]).toMatch(/^[0-9a-f-]{36}$/);
}

describe("quote, then order", () => {
  it("gets a quotation for two stops, then places the order with its quotation and stop ids", async () => {
    seen.length = 0;
    answer = (s) =>
      s.path === "/v3/quotations"
        ? [201, { data: { quotationId: "Q1", expiresAt: "2026-11-25T10:05:00Z", stops: [{ stopId: "S1" }, { stopId: "S2" }], priceBreakdown: { total: "120", currency: "PHP" } } }]
        : [201, { data: { orderId: "O1", status: "ASSIGNING_DRIVER", shareLink: "https://share.lalamove.com/?PH1", priceBreakdown: { total: "120", currency: "PHP" } } }];
    const quote = await lalamoveQuote({ urls, ...keys, live: false, serviceType: "MOTORCYCLE", ...stops });
    expect(quote).toEqual({ quotationId: "Q1", pickupStopId: "S1", dropoffStopId: "S2", total: "120", currency: "PHP" });
    const order = await lalamoveOrder({ urls, ...keys, live: false, quote, sender: { name: "Tindahan ni Aling Rosa", phone: "+639171234567" }, recipient: { name: "Juan dela Cruz", phone: "+639181234567", remarks: "Order 1042" }, metadata: { kymavo_run: "r1" } });
    expect(order).toEqual({ orderId: "O1", status: "ASSIGNING_DRIVER", shareLink: "https://share.lalamove.com/?PH1", total: "120", currency: "PHP" });

    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v3/quotations", "POST /v3/orders"]);
    seen.forEach(verify);
    expect(JSON.parse(seen[0]!.body)).toEqual({
      data: {
        serviceType: "MOTORCYCLE",
        language: "en_PH",
        stops: [
          { coordinates: { lat: "14.5794", lng: "121.0359" }, address: stops.pickup.address },
          { coordinates: { lat: "14.6507", lng: "121.0494" }, address: stops.dropoff.address },
        ],
      },
    });
    expect(JSON.parse(seen[1]!.body)).toEqual({
      data: {
        quotationId: "Q1",
        sender: { stopId: "S1", name: "Tindahan ni Aling Rosa", phone: "+639171234567" },
        recipients: [{ stopId: "S2", name: "Juan dela Cruz", phone: "+639181234567", remarks: "Order 1042" }],
        metadata: { kymavo_run: "r1" },
      },
    });
  });

  it("reads Lalamove's refusals the way the other providers do", async () => {
    answer = () => [401, { message: "ERR_UNAUTHORIZED" }];
    await expect(lalamoveQuote({ urls, ...keys, live: false, serviceType: "MOTORCYCLE", ...stops })).rejects.toMatchObject({ kind: "auth" });
    answer = () => [422, { errors: [{ id: "ERR_INVALID_FIELD", message: "stops[1].coordinates" }] }];
    await expect(lalamoveQuote({ urls, ...keys, live: false, serviceType: "MOTORCYCLE", ...stops })).rejects.toThrow(/ERR_INVALID_FIELD/);
    answer = () => [402, { message: "ERR_INSUFFICIENT_CREDIT" }];
    const quote = { quotationId: "Q1", pickupStopId: "S1", dropoffStopId: "S2", total: "120", currency: "PHP" };
    const err = await lalamoveOrder({ urls, ...keys, live: true, quote, sender: { name: "a", phone: "+639171234567" }, recipient: { name: "b", phone: "+639181234567" }, metadata: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "invalid", message: expect.stringMatching(/top up your Lalamove Wallet/i) });
    // An order that got a 5xx may still exist, so a person checks before anything is sent again.
    answer = () => [503, {}];
    await expect(lalamoveOrder({ urls, ...keys, live: false, quote, sender: { name: "a", phone: "+639171234567" }, recipient: { name: "b", phone: "+639181234567" }, metadata: {} })).rejects.toMatchObject({ kind: "ambiguous" });
  });
});

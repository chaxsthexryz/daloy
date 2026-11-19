import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError, trelloAddCard, trelloIdentity, type ProviderUrls } from "./providers";

// Review, route and data checks: Trello's key and token travel in the query string, so no error Daloy builds (and
// stores as a delivery's last error, or shows in the console) may carry the request URL or its query.
const cred = { key: "KEY-0123456789abcdef0123456789ab", token: "ATTA-token-0123456789abcdefghijklmnopqrstu" }; // gitleaks:allow
let stub: Server;
let mode: "401" | "403" | "404" | "429" | "500" | "reset" | "redirect" | "400" = "401";
let urls: ProviderUrls;

beforeAll(async () => {
  stub = createServer((req, res) => {
    // A hostile or misconfigured server may echo the URL it was called with.
    const echo = JSON.stringify({ message: `bad request ${req.url}`, url: req.url });
    if (mode === "reset") return req.socket.destroy();
    if (mode === "redirect") return res.writeHead(307, { location: `http://127.0.0.1:1${req.url}` }).end();
    res.writeHead(Number(mode), { "content-type": "application/json" }).end(echo);
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  urls = { trello: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, timeoutMs: 1000 } as ProviderUrls;
});
afterAll(() => void stub.close());

async function failure(run: () => Promise<unknown>) {
  const err = await run().then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  return (err as ProviderError).message;
}
const leaks = (message: string) => [cred.key, cred.token, "key=", "token=", "127.0.0.1", "/1/"].filter((needle) => message.includes(needle));

describe("Trello errors never carry the request URL", () => {
  it.each(["400", "401", "403", "404", "429", "500", "reset", "redirect"] as const)("on a %s answer", async (m) => {
    mode = m;
    for (const run of [() => trelloIdentity(urls, cred), () => trelloAddCard(urls, cred, "list1", "Call Ana", "REQ-1")]) expect(leaks(await failure(run))).toEqual([]);
  });

  it("when the server cannot be reached at all", async () => {
    const dead = { ...urls, trello: "http://127.0.0.1:1" } as ProviderUrls;
    expect(leaks(await failure(() => trelloAddCard(dead, cred, "list1", "Call Ana", "REQ-1")))).toEqual([]);
  });
});

import { createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { blockListOf } from "./steps/ssrf";
import { connectImap, imapConnectionOptions, parseIncomingEmail, MAX_EMAIL_BYTES } from "./imap";

const source = { host: "imap.example.com", username: "office@example.com", password: "synthetic-password", folder: "INBOX" };
const guard = { blockList: blockListOf(), resolve: async () => [{ address: "93.184.216.34", family: 4 }], ports: [] };
describe("IMAP connection boundary", () => {
  it("pins a checked public IP and verifies TLS for the original mailbox host", async () => {
    expect(await imapConnectionOptions(source, {}, guard)).toMatchObject({
      host: "93.184.216.34",
      port: 993,
      secure: true,
      servername: source.host,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      logger: false,
    });
  });
  it("blocks every private, metadata and mapped-private answer, including mixed DNS results", async () => {
    for (const address of ["127.0.0.1", "10.2.3.4", "169.254.169.254", "::1", "::ffff:127.0.0.1"]) {
      await expect(
        imapConnectionOptions(
          source,
          {},
          {
            ...guard,
            resolve: async () => [
              { address, family: address.includes(":") ? 6 : 4 },
              { address: "93.184.216.34", family: 4 },
            ],
          },
        ),
      ).rejects.toThrow("public");
    }
  });
  it("only a test process and the fixed fixture host may use a local override", async () => {
    const fixture = { ...source, host: "imap.office.example" };
    const env = { NODE_ENV: "test", DALOY_TEST_IMAP_ENDPOINT: "imap://127.0.0.1:2529" };
    expect(await imapConnectionOptions(fixture, env, guard)).toMatchObject({ host: "127.0.0.1", port: 2529, secure: false });
    expect(await imapConnectionOptions(source, env, guard)).toMatchObject({ host: "93.184.216.34", secure: true });
    expect(await imapConnectionOptions(fixture, { ...env, NODE_ENV: "production" }, guard)).toMatchObject({
      host: "93.184.216.34",
      secure: true,
    });
    await expect(imapConnectionOptions(fixture, { ...env, DALOY_TEST_IMAP_ENDPOINT: "imap://192.168.1.2:2529" }, guard)).rejects.toThrow(
      "fixture",
    );
  });
  it("closes an unresponsive mailbox promptly when the worker shuts down", async () => {
    let accepted!: () => void;
    const connected = new Promise<void>((r) => (accepted = r));
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      accepted();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DALOY_TEST_IMAP_ENDPOINT", `imap://127.0.0.1:${address.port}`);
    const controller = new AbortController();
    try {
      const pending = connectImap({ ...source, host: "imap.office.example" }, controller.signal);
      const result = expect(pending).rejects.toThrow();
      await connected;
      controller.abort();
      await result;
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      vi.unstubAllEnvs();
    }
  }, 2_000);
});
describe("bounded incoming message", () => {
  const receivedAt = new Date("2026-11-17T10:00:00.000Z");
  it("decodes MIME, normalizes addresses and exposes only plain text", async () => {
    const raw = Buffer.from(
      "From: Ana <ana@example.com>\r\nReply-To: reply@example.com\r\nTo: office@example.com\r\nSubject: =?UTF-8?B?SGVsbG8=?=\r\nMessage-ID: <one@example.com>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>office</b></p><script>alert(1)</script>",
    );
    const parsed = await parseIncomingEmail(raw, receivedAt);
    expect(parsed).toMatchObject({
      from: "ana@example.com",
      replyTo: "reply@example.com",
      to: ["office@example.com"],
      subject: "Hello",
      messageId: "<one@example.com>",
      receivedAt: receivedAt.toISOString(),
    });
    expect(parsed!.text).toContain("Hello office");
    expect(parsed!.text).not.toContain("<script>");
    expect(Object.keys(parsed!)).not.toContain("html");
  });
  it("refuses messages beyond the raw byte limit and caps stored text", async () => {
    await expect(parseIncomingEmail(Buffer.alloc(MAX_EMAIL_BYTES + 1), receivedAt)).rejects.toThrow("large");
    const raw = Buffer.from(`From: ana@example.com\r\n\r\n${"a".repeat(30_000)}`);
    expect((await parseIncomingEmail(raw, receivedAt))!.text).toHaveLength(20_000);
  });

  it("extracts sanitized Message-ID, In-Reply-To and References and drops malformed header injection (C6)", async () => {
    const threaded = Buffer.from(
      "From: guest@example.com\r\nTo: resort@example.com\r\nSubject: Re: Rates\r\nMessage-ID: <m3@guest.example>\r\nIn-Reply-To: <m2@resort.example>\r\nReferences: <m1@guest.example> <m2@resort.example>\r\n\r\nThanks!",
    );
    const parsed = await parseIncomingEmail(threaded, receivedAt);
    expect(parsed.messageId).toBe("<m3@guest.example>");
    expect(parsed.inReplyTo).toBe("<m2@resort.example>");
    expect(parsed.references).toEqual(["<m1@guest.example>", "<m2@resort.example>"]);

    // Falls back to In-Reply-To when References is omitted.
    const replyOnly = Buffer.from(
      "From: guest@example.com\r\nTo: resort@example.com\r\nSubject: Re: Rates\r\nMessage-ID: <m4@guest.example>\r\nIn-Reply-To: <m3@resort.example>\r\n\r\nHello",
    );
    const parsedReplyOnly = await parseIncomingEmail(replyOnly, receivedAt);
    expect(parsedReplyOnly.references).toEqual(["<m3@resort.example>"]);

    // Malformed / non-message-id headers are dropped cleanly, and injected header lines never enter references.
    const hostile = Buffer.from(
      "From: guest@example.com\r\nTo: resort@example.com\r\nSubject: Bad\r\nMessage-ID: not-valid-id\r\nReferences: <good@example.com> bad-token <no-at-sign>\r\n\r\nHi",
    );
    const parsedHostile = await parseIncomingEmail(hostile, receivedAt);
    expect(parsedHostile.messageId).toBeNull();
    expect(parsedHostile.references).toEqual(["<good@example.com>"]);
  });
});

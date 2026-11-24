import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseDiscordWebhook,
  parseSlackWebhook,
  parseTeamsWebhook,
  verifyDaloyHmac,
  verifyDiscordEd25519,
  verifySlackSignature,
  verifyTeamsWebhook,
} from "./chat-triggers";

describe("Slack webhook verification and parsing", () => {
  const secret = "slack_test_signing_secret";
  const now = 1_800_000_000;
  const signSlack = (ts: number | string, raw: Buffer | string, k = secret) =>
    `v0=${createHmac("sha256", k).update(`v0:${ts}:`).update(raw).digest("hex")}`;

  it("verifies X-Slack-Signature and enforces a 5-minute replay window", () => {
    const body = Buffer.from('{"type":"event_callback","event_id":"Ev1","event":{"type":"message","channel":"C1","user":"U1","text":"hi","ts":"1700.1"}}');
    const sig = signSlack(now, body);
    expect(verifySlackSignature({ rawBody: body, signature: sig, timestamp: String(now), signingSecret: secret, nowSeconds: now })).toEqual({ ok: true });
    expect(verifySlackSignature({ rawBody: body, signature: sig, timestamp: String(now), signingSecret: secret, nowSeconds: now + 301 })).toEqual({
      ok: false,
      reason: "Slack timestamp outside 5 minute window",
    });
    expect(verifySlackSignature({ rawBody: body, signature: signSlack(now + 1, body), timestamp: String(now), signingSecret: secret, nowSeconds: now }).ok).toBe(false);
    expect(verifySlackSignature({ rawBody: Buffer.from("{}"), signature: sig, timestamp: String(now), signingSecret: secret, nowSeconds: now }).ok).toBe(false);
  });

  it("parses url_verification challenges, messages, bot flags, and ignores edits", () => {
    expect(parseSlackWebhook({ type: "url_verification", challenge: "abc-xyz" })).toEqual({
      kind: "challenge",
      challenge: "abc-xyz",
    });

    const msg = parseSlackWebhook({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev99",
      event_time: 1_800_000_000,
      event: { type: "message", channel: "C123", user: "U1", text: "New Order #101", ts: "173000.1" },
    });
    expect(msg).toMatchObject({
      kind: "message",
      key: "slack:Ev99",
      channelId: "C123",
      userId: "U1",
      text: "New Order #101",
      isBot: false,
      payload: {
        eventId: "Ev99",
        teamId: "T1",
        channelId: "C123",
        userId: "U1",
        text: "New Order #101",
        ts: "173000.1",
        threadTs: null,
      },
    });

    const bot = parseSlackWebhook({
      type: "event_callback",
      event_id: "Ev100",
      event: { type: "message", channel: "C123", bot_id: "B1", text: "order bot", ts: "1" },
    });
    expect(bot).toMatchObject({ kind: "message", isBot: true, key: "slack:Ev100" });

    expect(
      parseSlackWebhook({
        type: "event_callback",
        event_id: "Ev101",
        event: { type: "message", subtype: "message_changed", channel: "C123", text: "edited", ts: "2" },
      }),
    ).toEqual({ kind: "ignore" });

    expect(parseSlackWebhook({ bad: true })).toBeNull();
  });
});

describe("Microsoft Teams webhook verification and parsing", () => {
  const b64Secret = Buffer.from("teams-secret-key-123456").toString("base64");
  const now = 1_800_000_000;

  it("verifies both Authorization HMAC (base64) and X-Daloy-Signature headers", () => {
    const body = Buffer.from('{"id":"m1","text":"<at>kymavo</at> Need quote","from":{"id":"u1","name":"Ana"},"conversation":{"id":"19:abc"}}');
    const auth = `HMAC ${createHmac("sha256", Buffer.from(b64Secret, "base64")).update(body).digest("base64")}`;
    expect(verifyTeamsWebhook({ rawBody: body, authorization: auth, signature: undefined, timestamp: undefined, secret: b64Secret, nowSeconds: now })).toEqual({ ok: true });
    expect(verifyTeamsWebhook({ rawBody: body, authorization: "HMAC wrong==", signature: undefined, timestamp: undefined, secret: b64Secret, nowSeconds: now }).ok).toBe(false);

    const ts = String(now);
    const daloySig = `sha256=${createHmac("sha256", "plain-secret").update(`${ts}.`).update(body).digest("hex")}`;
    expect(verifyTeamsWebhook({ rawBody: body, authorization: undefined, signature: daloySig, timestamp: ts, secret: "plain-secret", nowSeconds: now })).toEqual({ ok: true });
    expect(verifyTeamsWebhook({ rawBody: body, authorization: undefined, signature: daloySig, timestamp: String(now - 400), secret: "plain-secret", nowSeconds: now }).ok).toBe(false);
    expect(verifyTeamsWebhook({ rawBody: body, authorization: undefined, signature: undefined, timestamp: undefined, secret: "plain-secret", nowSeconds: now }).ok).toBe(false);
  });

  it("strips mention tags and produces a stable run key", () => {
    const parsed = parseTeamsWebhook({
      id: "msg-42",
      text: "<at>kymavo</at>   urgent price check  ",
      timestamp: "2026-11-24T08:00:00Z",
      from: { id: "aad-1", name: "Marco" },
      channelData: { team: { id: "t-1" }, channel: { id: "19:general", name: "General" } },
    });
    expect(parsed).toMatchObject({
      messageId: "msg-42",
      key: "teams:msg-42",
      channelId: "19:general",
      channelName: "General",
      teamId: "t-1",
      senderId: "aad-1",
      senderName: "Marco",
      cleanText: "urgent price check",
      payload: {
        messageId: "msg-42",
        channelId: "19:general",
        channelName: "General",
        teamId: "t-1",
        senderId: "aad-1",
        senderName: "Marco",
        cleanText: "urgent price check",
        timestamp: "2026-11-24T08:00:00Z",
      },
    });
    expect(parseTeamsWebhook({})).toBeNull();
  });
});

describe("Discord Ed25519 / HMAC verification and parsing", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const now = 1_800_000_000;

  it("verifies Ed25519 interaction signatures and enforces the 5-minute replay window", () => {
    const body = Buffer.from('{"id":"int-1","type":1}');
    const ts = String(now);
    const sig = sign(null, Buffer.concat([Buffer.from(ts), body]), privateKey).toString("hex");
    expect(verifyDiscordEd25519({ rawBody: body, signature: sig, timestamp: ts, publicKeyHex: rawPub, nowSeconds: now })).toEqual({ ok: true });
    expect(verifyDiscordEd25519({ rawBody: body, signature: sig, timestamp: ts, publicKeyHex: rawPub, nowSeconds: now + 305 }).ok).toBe(false);
    expect(verifyDiscordEd25519({ rawBody: Buffer.from('{"id":"int-1","type":2}'), signature: sig, timestamp: ts, publicKeyHex: rawPub, nowSeconds: now }).ok).toBe(false);
    expect(verifyDiscordEd25519({ rawBody: body, signature: "00".repeat(64), timestamp: ts, publicKeyHex: "zz".repeat(32), nowSeconds: now }).ok).toBe(false);
  });

  it("verifies Daloy HMAC for Discord relay webhooks", () => {
    const body = Buffer.from('{"id":"m-1","channel_id":"c1","content":"hello"}');
    const ts = String(now);
    const sig = `sha256=${createHmac("sha256", "relay-secret").update(`${ts}.`).update(body).digest("hex")}`;
    expect(verifyDaloyHmac({ rawBody: body, signature: sig, timestamp: ts, secret: "relay-secret", nowSeconds: now })).toMatchObject({ ok: true });
  });

  it("parses PING, slash commands, and relay messages while ignoring bot relays", () => {
    expect(parseDiscordWebhook({ id: "i0", type: 1 })).toEqual({ kind: "ping" });

    const cmd = parseDiscordWebhook({
      id: "i1",
      type: 2,
      channel_id: "C1",
      guild_id: "G1",
      member: { user: { id: "U1", username: "ana" } },
      data: { name: "stock", options: [{ name: "sku", value: "UBE-1" }] },
    });
    expect(cmd).toMatchObject({
      kind: "event",
      interaction: true,
      key: "discord:i1",
      channelId: "C1",
      guildId: "G1",
      userId: "U1",
      username: "ana",
      commandName: "stock",
      text: "UBE-1",
      options: { sku: "UBE-1" },
    });

    const relay = parseDiscordWebhook({
      id: "msg-9",
      channel_id: "C1",
      guild_id: "G1",
      content: "alert: low paper",
      author: { id: "U2", username: "ben", bot: false },
    });
    expect(relay).toMatchObject({
      kind: "event",
      interaction: false,
      key: "discord:msg-9",
      channelId: "C1",
      userId: "U2",
      username: "ben",
      text: "alert: low paper",
    });

    expect(
      parseDiscordWebhook({
        id: "msg-10",
        channel_id: "C1",
        content: "bot msg",
        author: { id: "B1", username: "bot", bot: true },
      }),
    ).toEqual({ kind: "ignore" });
  });
});

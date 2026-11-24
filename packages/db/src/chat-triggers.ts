import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import * as z from "zod";

/**
 * G4 (decision 0133): Inbound verification and strict payload schemas for team chat triggers
 * (`slack_message`, `teams_message`, `discord_message`).
 */

export const CHAT_REPLAY_WINDOW_SECONDS = 300;

const sameText = (a: string, b: string) => {
  const given = Buffer.from(a);
  const want = Buffer.from(b);
  return given.length === want.length && timingSafeEqual(given, want);
};

export function verifyDaloyHmac(input: {
  rawBody: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  nowSeconds: number;
}): { ok: true; replayKey: string } | { ok: false; reason: string } {
  if (!input.timestamp || !input.signature) return { ok: false, reason: "missing signature" };
  const expected = createHmac("sha256", input.secret).update(`${input.timestamp}.`).update(input.rawBody).digest("hex");
  if (!sameText(input.signature, `sha256=${expected}`)) return { ok: false, reason: "bad signature" };
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(input.nowSeconds - Number(input.timestamp)) > CHAT_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "timestamp outside 5 minute window" };
  }
  return { ok: true, replayKey: expected };
}

// ---------------------------------------------------------------- Slack

export function verifySlackSignature(input: {
  rawBody: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  signingSecret: string;
  nowSeconds: number;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.timestamp || !input.signature) return { ok: false, reason: "missing Slack signature" };
  const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${input.timestamp}:`).update(input.rawBody).digest("hex")}`;
  if (!sameText(input.signature, expected)) return { ok: false, reason: "bad Slack signature" };
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: "bad Slack timestamp" };
  if (Math.abs(input.nowSeconds - Number(input.timestamp)) > CHAT_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "Slack timestamp outside 5 minute window" };
  }
  return { ok: true };
}

const slackChallengeSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1).max(256),
});

const slackCallbackSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().max(64).optional(),
  event_id: z.string().min(1).max(200).optional(),
  event_time: z.number().int().nonnegative().optional(),
  event: z.object({
    type: z.string().max(64),
    subtype: z.string().max(64).optional(),
    bot_id: z.string().max(64).optional(),
    channel: z.string().max(64).optional(),
    user: z.string().max(64).optional(),
    text: z.string().max(20_000).optional(),
    ts: z.string().max(64).optional(),
    thread_ts: z.string().max(64).optional(),
  }),
});

export type ParsedSlackWebhook =
  | { kind: "challenge"; challenge: string }
  | { kind: "ignore" }
  | {
      kind: "message";
      eventId: string;
      teamId: string;
      channelId: string;
      userId: string;
      text: string;
      ts: string;
      threadTs: string | null;
      isBot: boolean;
      key: string;
      payload: Record<string, unknown>;
    };

const SLACK_KEPT_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

export function parseSlackWebhook(body: unknown): ParsedSlackWebhook | null {
  const challenge = slackChallengeSchema.safeParse(body);
  if (challenge.success) return { kind: "challenge", challenge: challenge.data.challenge };
  const parsed = slackCallbackSchema.safeParse(body);
  if (!parsed.success) return null;
  const { team_id: teamId = "", event_id: eventId, event_time: eventTime, event } = parsed.data;
  if (event.type !== "message") return { kind: "ignore" };
  if (event.subtype !== undefined && !SLACK_KEPT_SUBTYPES.has(event.subtype)) return { kind: "ignore" };
  const channelId = event.channel ?? "";
  const ts = event.ts ?? "";
  const id = eventId ?? (channelId && ts ? `${channelId}:${ts}` : "");
  if (!id) return null;
  const userId = event.user ?? "";
  const text = (event.text ?? "").slice(0, 10_000);
  const threadTs = event.thread_ts ?? null;
  const isBot = Boolean(event.bot_id) || event.subtype === "bot_message";
  const receivedAt = eventTime ? new Date(eventTime * 1000).toISOString() : new Date().toISOString();
  return {
    kind: "message",
    eventId: id,
    teamId,
    channelId,
    userId,
    text,
    ts,
    threadTs,
    isBot,
    key: `slack:${id}`,
    payload: {
      eventId: id,
      teamId,
      channelId,
      userId,
      text,
      ts,
      threadTs,
      receivedAt,
    },
  };
}

// ---------------------------------------------------------------- Microsoft Teams

export function verifyTeamsWebhook(input: {
  rawBody: Buffer;
  authorization: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  nowSeconds: number;
}): { ok: true } | { ok: false; reason: string } {
  if (input.authorization && /^HMAC\s+/i.test(input.authorization)) {
    const given = input.authorization.replace(/^HMAC\s+/i, "").trim();
    const isBase64 = /^[A-Za-z0-9+/]{16,}={0,2}$/.test(input.secret) && input.secret.length % 4 === 0;
    const keyBuf = isBase64 ? Buffer.from(input.secret, "base64") : Buffer.from(input.secret, "utf8");
    const expected = createHmac("sha256", keyBuf).update(input.rawBody).digest("base64");
    return sameText(given, expected) ? { ok: true } : { ok: false, reason: "bad Teams HMAC signature" };
  }
  if (input.signature !== undefined || input.timestamp !== undefined) {
    const checked = verifyDaloyHmac({
      rawBody: input.rawBody,
      signature: input.signature,
      timestamp: input.timestamp,
      secret: input.secret,
      nowSeconds: input.nowSeconds,
    });
    return checked.ok ? { ok: true } : checked;
  }
  return { ok: false, reason: "missing Teams signature" };
}

const teamsPayloadSchema = z.object({
  id: z.string().trim().min(1).max(200),
  text: z.string().max(20_000).default(""),
  timestamp: z.string().max(100).optional(),
  from: z.object({ id: z.string().max(200).optional(), name: z.string().max(200).optional() }).optional(),
  conversation: z.object({ id: z.string().max(300).optional() }).optional(),
  channelId: z.string().max(200).optional(),
  teamId: z.string().max(200).optional(),
  senderId: z.string().max(200).optional(),
  senderName: z.string().max(200).optional(),
  channelData: z
    .object({
      team: z.object({ id: z.string().max(200).optional() }).optional(),
      channel: z.object({ id: z.string().max(200).optional(), name: z.string().max(200).optional() }).optional(),
    })
    .optional(),
});

export type ParsedTeamsMessage = {
  messageId: string;
  channelId: string;
  channelName: string;
  teamId: string;
  senderId: string;
  senderName: string;
  text: string;
  cleanText: string;
  timestamp: string;
  key: string;
  payload: Record<string, unknown>;
};

export function parseTeamsWebhook(body: unknown): ParsedTeamsMessage | null {
  const parsed = teamsPayloadSchema.safeParse(body);
  if (!parsed.success) return null;
  const d = parsed.data;
  const channelId = d.channelData?.channel?.id ?? d.channelId ?? d.conversation?.id ?? "";
  const channelName = d.channelData?.channel?.name ?? "";
  const teamId = d.channelData?.team?.id ?? d.teamId ?? "";
  const senderId = d.from?.id ?? d.senderId ?? "";
  const senderName = d.from?.name ?? d.senderName ?? "";
  const text = d.text.slice(0, 10_000);
  const cleanText = text.replace(/<at>[^<]*<\/at>\s*/gi, "").trim();
  const timestamp = d.timestamp ?? new Date().toISOString();
  return {
    messageId: d.id,
    channelId,
    channelName,
    teamId,
    senderId,
    senderName,
    text,
    cleanText,
    timestamp,
    key: `teams:${d.id}`,
    payload: {
      messageId: d.id,
      channelId,
      channelName,
      teamId,
      senderId,
      senderName,
      text,
      cleanText,
      timestamp,
    },
  };
}

// ---------------------------------------------------------------- Discord

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyDiscordEd25519(input: {
  rawBody: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  publicKeyHex: string;
  nowSeconds: number;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.signature || !input.timestamp) return { ok: false, reason: "missing Discord signature" };
  if (!/^[0-9a-f]{128}$/i.test(input.signature) || !/^[0-9a-f]{64}$/i.test(input.publicKeyHex)) {
    return { ok: false, reason: "bad Discord signature" };
  }
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: "bad Discord timestamp" };
  if (Math.abs(input.nowSeconds - Number(input.timestamp)) > CHAT_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "Discord timestamp outside 5 minute window" };
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    const ok = cryptoVerify(null, Buffer.concat([Buffer.from(input.timestamp), input.rawBody]), key, Buffer.from(input.signature, "hex"));
    return ok ? { ok: true } : { ok: false, reason: "bad Discord signature" };
  } catch {
    return { ok: false, reason: "bad Discord signature" };
  }
}

const discordOptionSchema = z.object({
  name: z.string().min(1).max(64),
  value: z.union([z.string().max(4000), z.number(), z.boolean()]).optional(),
});

const discordInteractionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.number().int(),
  channel_id: z.string().max(64).optional(),
  guild_id: z.string().max(64).optional(),
  member: z.object({ user: z.object({ id: z.string().max(64), username: z.string().max(100).optional() }).optional() }).optional(),
  user: z.object({ id: z.string().max(64), username: z.string().max(100).optional() }).optional(),
  data: z
    .object({
      name: z.string().max(64).optional(),
      custom_id: z.string().max(100).optional(),
      options: z.array(discordOptionSchema).max(25).optional(),
    })
    .optional(),
});

const discordRelayMessageSchema = z.object({
  id: z.string().trim().min(1).max(64),
  channel_id: z.string().trim().min(1).max(64),
  guild_id: z.string().max(64).optional(),
  content: z.string().max(4000),
  timestamp: z.string().max(100).optional(),
  author: z
    .object({
      id: z.string().max(64),
      username: z.string().max(100).optional(),
      bot: z.boolean().optional(),
    })
    .optional(),
});

export type ParsedDiscordWebhook =
  | { kind: "ping" }
  | { kind: "ignore" }
  | {
      kind: "event";
      interaction: boolean;
      eventId: string;
      channelId: string;
      guildId: string;
      userId: string;
      username: string;
      commandName: string;
      text: string;
      options: Record<string, unknown>;
      key: string;
      payload: Record<string, unknown>;
    };

export function parseDiscordWebhook(body: unknown): ParsedDiscordWebhook | null {
  const inter = discordInteractionSchema.safeParse(body);
  if (inter.success) {
    const d = inter.data;
    if (d.type === 1) return { kind: "ping" };
    if (d.type !== 2 && d.type !== 3) return { kind: "ignore" };
    const options = Object.fromEntries((d.data?.options ?? []).filter((o) => o.value !== undefined).map((o) => [o.name, o.value]));
    const firstText = (d.data?.options ?? []).find((o) => typeof o.value === "string")?.value;
    const commandName = d.data?.name ?? d.data?.custom_id ?? "";
    const text = typeof firstText === "string" ? firstText : Object.entries(options).map(([k, v]) => `${k}: ${String(v)}`).join(", ");
    const userId = d.member?.user?.id ?? d.user?.id ?? "";
    const username = d.member?.user?.username ?? d.user?.username ?? "";
    const channelId = d.channel_id ?? "";
    const guildId = d.guild_id ?? "";
    return {
      kind: "event",
      interaction: true,
      eventId: d.id,
      channelId,
      guildId,
      userId,
      username,
      commandName,
      text,
      options,
      key: `discord:${d.id}`,
      payload: {
        interactionId: d.id,
        channelId,
        guildId,
        userId,
        username,
        commandName,
        text,
        options,
        receivedAt: new Date().toISOString(),
      },
    };
  }
  const relay = discordRelayMessageSchema.safeParse(body);
  if (relay.success) {
    const m = relay.data;
    if (m.author?.bot) return { kind: "ignore" };
    const userId = m.author?.id ?? "";
    const username = m.author?.username ?? "";
    const guildId = m.guild_id ?? "";
    return {
      kind: "event",
      interaction: false,
      eventId: m.id,
      channelId: m.channel_id,
      guildId,
      userId,
      username,
      commandName: "",
      text: m.content,
      options: {},
      key: `discord:${m.id}`,
      payload: {
        messageId: m.id,
        channelId: m.channel_id,
        guildId,
        userId,
        username,
        commandName: "",
        text: m.content,
        options: {},
        receivedAt: m.timestamp ?? new Date().toISOString(),
      },
    };
  }
  return null;
}

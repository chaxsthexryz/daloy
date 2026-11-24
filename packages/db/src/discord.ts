import { checkDiscordContent } from "@daloy/engine";
import { call, MAX_PROVIDER_RETRY_AFTER_MS, ProviderError, retryAfter, type ProviderUrls } from "./providers";

/**
 * Discord incoming webhooks (phase I1, decision 0104). A webhook URL carries its own token, so the URL is the credential:
 * it is checked before it is stored or called, stored encrypted like a Teams workflow link, and never put in an error.
 */

/** The only hosts a webhook URL may use. Subdomains (canary, ptb) are allowed. A test may list one more, over http. */
export const DISCORD_HOSTS = ["discord.com", "discordapp.com"] as const;
const PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[\w-]{20,100}$/;

export function discordWebhookUrl(urls: ProviderUrls, input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const real = DISCORD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  // discordHosts is for tests and local fakes only; http is allowed on those hosts and nowhere else.
  const extra = (urls.discordHosts ?? []).includes(host);
  const scheme = u.protocol === "https:" ? real || extra : u.protocol === "http:" ? extra && !real : false;
  return scheme && !u.username && !u.password && !u.search && !u.hash && PATH.test(u.pathname) ? u.toString() : null;
}

/** Discord's own wait, in ms: the Retry-After header, else retry_after (seconds, may be a fraction) from the body. */
function waitMs(headers: Headers, body: Record<string, unknown>): number | undefined {
  const fromHeader = retryAfter(headers);
  if (fromHeader !== undefined) return fromHeader;
  return typeof body.retry_after === "number" && body.retry_after >= 0 ? Math.min(Math.ceil(body.retry_after * 1000), MAX_PROVIDER_RETRY_AFTER_MS) : undefined;
}

/**
 * Posts the text to the channel the webhook belongs to. ?wait=true makes Discord answer with the message, so success
 * is known and not guessed. allowed_mentions.parse is empty, so text from a public form cannot ping @everyone or a role.
 * - 429 -> quota, with Discord's own wait (the delivery retries after it)
 * - 401, 403, 404 -> auth: the webhook was deleted or its token changed, so the owner pastes a new link
 * - 400 and other 4xx -> invalid, never retried
 * - 5xx, or a connection lost after the request left -> ambiguous: the message may be in the channel, so a person decides
 * No message here includes the URL or anything Discord sent back.
 */
export async function discordPost(urls: ProviderUrls, webhookUrl: string, text: string): Promise<{ posted: true; messageId?: string }> {
  const content = checkDiscordContent(text);
  if (!content.ok) throw new ProviderError(content.error, "invalid");
  const url = discordWebhookUrl(urls, webhookUrl);
  if (!url) throw new ProviderError("The Discord webhook link is not a Discord address. Paste the link again.", "auth");
  const res = await call(`${url}?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: content.value, allowed_mentions: { parse: [] } }) }, urls.timeoutMs ?? 10_000, true, "Discord");
  if (res.status === 200 || res.status === 204) return { posted: true, ...(typeof res.body.id === "string" ? { messageId: res.body.id } : {}) };
  if (res.status === 429) throw new ProviderError("Discord is limiting requests right now. kymavo will try again.", "quota", waitMs(res.headers, res.body));
  if (res.status === 404) throw new ProviderError("The Discord webhook was deleted. Create a new webhook in the channel's settings and paste its link in Apps.", "auth");
  if (res.status === 401 || res.status === 403) throw new ProviderError("Discord does not accept this webhook any more. Create a new webhook in the channel's settings and paste its link in Apps.", "auth");
  if (res.status >= 500) throw new ProviderError(`Discord answered ${res.status}.`, "ambiguous");
  throw new ProviderError(`Discord rejected the message (${res.status}).`, "invalid");
}

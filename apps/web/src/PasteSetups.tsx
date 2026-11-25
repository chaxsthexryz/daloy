import { useState } from "react";
import { api } from "./api";
import { FieldBadge } from "./ConnectPanel";
import { GuidedStep, GuidedSteps, type StepCheck } from "./GuidedSteps";
import { useLanguage } from "./Language";
import type { Connection } from "./Connections";

// Guided setup for the providers that stay a paste (Telegram, Teams, PayMongo). Each one ends in the same PUT route as before.
type Test = { ok: true } | { ok: false; error: string };
type Chat = { id: string; type: string; title: string };
type Props = { conn: Connection | null; onChange: () => Promise<unknown>; onClose: (test?: Test) => void };

const TELEGRAM_BOT_HELP = "https://core.telegram.org/bots/tutorial";
const DISCORD_WEBHOOK_HELP = "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks";
const TEAMS_WORKFLOWS_HELP = "https://support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks";

function useStep() {
  const [check, setCheck] = useState<StepCheck>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<StepCheck>) => {
    setBusy(true);
    setCheck({ state: "busy" });
    try {
      setCheck(await fn());
    } catch (err) {
      setCheck({ state: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { check, busy, run, setCheck };
}

function Cancel({ conn, onClose }: Pick<Props, "conn" | "onClose">) {
  const { t } = useLanguage();
  return conn ? (
    <button type="button" className="quiet" onClick={() => onClose()}>
      {t("Cancel")}
    </button>
  ) : null;
}

export function TelegramSetup({ conn, onChange, onClose }: Props) {
  const { t } = useLanguage();
  const tokenStep = useStep();
  const chatStep = useStep();
  const saveStep = useStep();
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState(conn?.destination?.chatId ?? "");
  const [receive, setReceive] = useState(Boolean(conn?.destination?.webhookPath));
  const [chats, setChats] = useState<Chat[] | null>(null);

  // One route proves the token (getMe) and lists the chats the bot has recently seen. The token travels in the body, never in the address.
  const lookup = (step: ReturnType<typeof useStep>) =>
    void step.run(async () => {
      const res = await api<{ bot: string; chats: Chat[]; webhookSet: boolean }>("POST", "/settings/connections/telegram/chats", { token });
      setChats(res.chats);
      const found: StepCheck = res.webhookSet
        ? { state: "warn", text: t("This bot has a webhook set, so Telegram will not list its chats. Type the chat id below instead, or remove the webhook.") }
        : res.chats.length
          ? { state: "ok", text: t("Found {count} chat(s). Tap yours.", { count: res.chats.length }) }
          : { state: "warn", text: t("No chats yet. Add the bot to your chat, send any message there, then look again.") };
      if (step === chatStep) return found;
      chatStep.setCheck(found);
      return { state: "ok", text: t("Token works. The bot is {bot}.", { bot: res.bot }) };
    });

  return (
    <GuidedSteps>
      <GuidedStep title="Create the bot">
        <p>
          {t("In Telegram, open")}{" "}
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
            t.me/BotFather
          </a>
          {t(", send /newbot and answer its questions. BotFather then shows a token.")}{" "}
          <a href={TELEGRAM_BOT_HELP} target="_blank" rel="noreferrer">
            {t("How to create a Telegram bot")}
          </a>
        </p>
      </GuidedStep>
      <GuidedStep title="Paste the bot token" check={tokenStep.check}>
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="tg-token">{t("Bot token")}</label>
            <FieldBadge />
          </div>
          <input id="tg-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…" autoComplete="off" />
        </div>
        <div className="actions">
          <button type="button" disabled={tokenStep.busy || !token} onClick={() => lookup(tokenStep)}>
            {t("Check token")}
          </button>
        </div>
      </GuidedStep>
      <GuidedStep title="Add the bot to your chat and pick it" check={chatStep.check}>
        <p>{t("Add the bot to the chat, then send any message there. kymavo lists the chats the bot has seen. It reads only the chat name, never the messages, and keeps nothing.")}</p>
        <div className="actions">
          <button type="button" disabled={chatStep.busy || !token} onClick={() => lookup(chatStep)}>
            {t("Find my chats")}
          </button>
        </div>
        {chats && chats.length > 0 && (
          <ul className="chat-list">
            {chats.map((c) => (
              <li key={c.id}>
                <button type="button" className={c.id === chatId ? "primary" : ""} aria-pressed={c.id === chatId} onClick={() => setChatId(c.id)}>
                  {c.title} <span className="muted">({c.type})</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </GuidedStep>
      <GuidedStep title="Connect" check={saveStep.check}>
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="tg-chat">{t("Chat id")}</label>
            <FieldBadge />
          </div>
          <input id="tg-chat" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890 or @channelname" autoComplete="off" />
          <p className="muted">{t("Tapping a chat above fills this in. You can also type the chat id.")}</p>
        </div>
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={receive} onChange={(e) => setReceive(e.target.checked)} />{" "}
            {t("Receive messages: start automations when someone messages this bot")}
          </label>
          <p className="muted">{t("Telegram then sends the bot's messages to kymavo, so the chat list above stays empty until you turn this off. Needs kymavo on a public https address.")}</p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={saveStep.busy || !token || !chatId}
            onClick={() =>
              void saveStep.run(async () => {
                await api("PUT", "/settings/connections/telegram", { token, chatId, receive });
                setToken("");
                await onChange();
                onClose();
                return { state: "ok" };
              })
            }
          >
            {conn ? t("Save") : t("Connect Telegram")}
          </button>
          <Cancel conn={conn} onClose={onClose} />
        </div>
      </GuidedStep>
    </GuidedSteps>
  );
}

export function DiscordSetup({ conn, onChange, onClose }: Props) {
  const { t } = useLanguage();
  const step = useStep();
  const [url, setUrl] = useState("");
  const [channelName, setChannelName] = useState(conn?.account ?? "");
  const save = () =>
    void step.run(async () => {
      // The server checks that the link is a Discord webhook address. Then kymavo sends one test message so a wrong link shows up now.
      await api("PUT", "/settings/connections/discord", { url, channelName });
      setUrl("");
      const test = await api<Test>("POST", "/settings/connections/discord/test");
      await onChange();
      onClose(test);
      return { state: "ok" };
    });
  return (
    <GuidedSteps>
      <GuidedStep title="Make a webhook in Discord">
        <p>
          {t("In Discord, open the channel's settings, choose Integrations, then Webhooks, and make a new webhook. You need the Manage Webhooks permission on that channel. Menu names may differ.")}{" "}
          <a href={DISCORD_WEBHOOK_HELP} target="_blank" rel="noreferrer">
            {t("How to make a webhook")}
          </a>
        </p>
      </GuidedStep>
      <GuidedStep title="Copy the webhook link">
        <p>{t("Choose Copy Webhook URL. Anyone who has this link can post to the channel, so do not share it. kymavo keeps it encrypted and never shows it again.")}</p>
      </GuidedStep>
      <GuidedStep title="Paste the link and send a test message" check={step.check}>
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="dc-url">{t("Webhook link")}</label>
            <FieldBadge />
          </div>
          <input id="dc-url" type="password" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" placeholder="https://discord.com/api/webhooks/…" />
        </div>
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="dc-channel">{t("Discord channel name, to show in kymavo")}</label>
            <FieldBadge />
          </div>
          <input id="dc-channel" value={channelName} onChange={(e) => setChannelName(e.target.value)} maxLength={100} placeholder={t("orders")} />
        </div>
        <div className="actions">
          <button type="button" className="primary" disabled={step.busy || !url || !channelName} onClick={save}>
            {conn ? t("Save link") : t("Connect Discord")}
          </button>
          <Cancel conn={conn} onClose={onClose} />
        </div>
      </GuidedStep>
    </GuidedSteps>
  );
}

export function TeamsSetup({ conn, onChange, onClose }: Props) {
  const { t } = useLanguage();
  const step = useStep();
  const [url, setUrl] = useState("");
  const [channelName, setChannelName] = useState(conn?.account ?? "");
  const save = () =>
    void step.run(async () => {
      // The server checks the link's host. Then kymavo sends one test message so a wrong link shows up now, not on the first real run.
      await api("PUT", "/settings/connections/teams", { url, channelName });
      setUrl("");
      const test = await api<Test>("POST", "/settings/connections/teams/test");
      await onChange();
      onClose(test);
      return { state: "ok" };
    });
  return (
    <GuidedSteps>
      <GuidedStep title="Start a workflow in Teams">
        <p>
          {t("In Teams, open the Workflows app and start a new workflow that posts to a channel when a webhook request is received. Menu names may differ. Your organization may have to allow the Workflows app first; if you cannot find it, ask your Teams administrator.")}{" "}
          <a href={TEAMS_WORKFLOWS_HELP} target="_blank" rel="noreferrer">
            {t("How to create the workflow")}
          </a>
        </p>
      </GuidedStep>
      <GuidedStep title="Choose the team and channel, and who can trigger it">
        <p>{t("Pick the team and channel that should get the notes. If the workflow asks who can trigger it, choose anyone, or kymavo's messages will be refused.")}</p>
      </GuidedStep>
      <GuidedStep title="Paste the link and send a test message" check={step.check}>
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="tm-url">{t("Workflow link")}</label>
            <FieldBadge />
          </div>
          <input id="tm-url" type="password" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" placeholder="https://…logic.azure.com/…" />
        </div>
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="tm-channel">{t("Teams channel name, to show in kymavo")}</label>
            <FieldBadge />
          </div>
          <input id="tm-channel" value={channelName} onChange={(e) => setChannelName(e.target.value)} maxLength={100} placeholder={t("Purchasing")} />
        </div>
        <div className="actions">
          <button type="button" className="primary" disabled={step.busy || !url || !channelName} onClick={save}>
            {conn ? t("Save link") : t("Connect Teams")}
          </button>
          <Cancel conn={conn} onClose={onClose} />
        </div>
      </GuidedStep>
    </GuidedSteps>
  );
}

/** Shape check only, in the browser. PayMongo itself checks the key when it is saved. */
export function paymongoKeyCheck(key: string): StepCheck {
  if (!key) return { state: "idle" };
  if (/^sk_test_\S+$/.test(key)) return { state: "ok", text: "This is a test key. Money does not move." };
  if (/^sk_live_\S+$/.test(key)) return { state: "warn", text: "This is a live key. Start with a test key; live mode needs PayMongo business verification." };
  return { state: "error", text: "A secret key starts with sk_test_ or sk_live_. Do not paste the public key (pk_)." };
}

export function PaymongoSetup({ conn, webhookBase, onChange, onClose }: Props & { webhookBase: string }) {
  const { t } = useLanguage();
  const keyStep = useStep();
  const hookStep = useStep();
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [path, setPath] = useState<string | null>(conn?.destination?.webhookPath ?? null);
  const live = paymongoKeyCheck(secretKey);
  const url = path ? `${webhookBase}/${path}` : null;
  const keyCheck: StepCheck = keyStep.check.state !== "idle" ? keyStep.check : live.text ? { ...live, text: t(live.text) } : live;
  return (
    <GuidedSteps>
      <GuidedStep title="Use test mode first">
        <p>{t("Sign in to the PayMongo dashboard and switch to test mode. Test keys and test webhooks start with test, and no money moves. Menu names may differ.")}</p>
      </GuidedStep>
      <GuidedStep title="Copy the secret key and save it" check={keyCheck}>
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="pm-key">{t("Secret key")}</label>
            <FieldBadge />
          </div>
          <input id="pm-key" type="password" value={secretKey} onChange={(e) => { setSecretKey(e.target.value); keyStep.setCheck({ state: "idle" }); }} placeholder="sk_test_…" autoComplete="off" />
        </div>
        <div className="actions">
          <button
            type="button"
            className={url ? "" : "primary"}
            disabled={keyStep.busy || live.state === "error" || live.state === "idle"}
            onClick={() =>
              void keyStep.run(async () => {
                const res = await api<{ connections: Connection[] }>("PUT", "/settings/connections/paymongo", { secretKey });
                setPath(res.connections.find((c) => c.provider === "paymongo")?.destination?.webhookPath ?? null);
                return { state: "ok", text: t("PayMongo accepted the key. The webhook address is below.") };
              })
            }
          >
            {t("Save key")}
          </button>
        </div>
      </GuidedStep>
      <GuidedStep title="Add the webhook in PayMongo">
        {url ? (
          <>
            <p>{t("In PayMongo, add a webhook with this address and the events checkout_session.payment.paid and payment.refunded. Menu names may differ.")}</p>
            <p>
              <code>{url}</code>{" "}
              <button type="button" className="quiet" onClick={() => void navigator.clipboard?.writeText(url)}>
                {t("Copy")}
              </button>
            </p>
          </>
        ) : (
          <p className="muted">{t("Save the secret key first. kymavo then shows the webhook address.")}</p>
        )}
      </GuidedStep>
      <GuidedStep title="Paste the webhook secret" check={hookStep.check}>
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="pm-whsk">{t("Webhook secret")}</label>
            <FieldBadge />
          </div>
          <input id="pm-whsk" type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="whsk_…" autoComplete="off" />
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={hookStep.busy || !secretKey || !/^whsk_\S+$/.test(webhookSecret)}
            onClick={() =>
              void hookStep.run(async () => {
                await api("PUT", "/settings/connections/paymongo", { secretKey, webhookSecret });
                setSecretKey("");
                setWebhookSecret("");
                await onChange();
                onClose();
                return { state: "ok" };
              })
            }
          >
            {conn ? t("Save webhook secret") : t("Connect PayMongo")}
          </button>
          <Cancel conn={conn} onClose={onClose} />
        </div>
      </GuidedStep>
    </GuidedSteps>
  );
}

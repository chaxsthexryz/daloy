import "./workspace-admin.css";
import "./apps-design.css";
import { Text, useLanguage } from "./Language";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { GmailCard, PILL, type Settings } from "./BusinessSetup";
import { MetaMessengerConnection, WhatsAppConnection, ShopifyConnection, OutlookConnection, RecordConnection, PaymongoConnection, DiscordConnection, SlackConnection, TeamsConnection, TelegramConnection, type Connection, type OutlookSetup, type Provider } from "./Connections";
import { GoogleCalendarCard } from "./GoogleCalendar";
import { SharedGrants } from "./ConnectPanel";
import { GoogleDriveCard, GoogleSheetsCard } from "./GoogleConnect";
import { Header } from "./Nav";
import { APP_LOGO, AppMark } from "./AppMark";

// UniSMS is not an app a workspace connects: the server operator sets it in env (decision 0100).
type Key = "gmail" | Exclude<Provider, "unisms"> | "lalamove";
type SecretItem = { name: string; createdAt: string };
// Logos come from public/logos (sources and terms in its README, decision 0085). PayMongo and GCash have no usable asset, so AppMark shows a letter tile for them.
const APPS: { key: Key; name: string; line: string }[] = [
  { key: "gmail", name: "Gmail", line: "Send customer emails from your own address." },
  { key: "outlook", name: "Outlook", line: "Send purchase emails from an Outlook mailbox." },
  { key: "google_sheets", name: "Google Sheets", line: "Add a row to a sheet for every request." },
  { key: "slack", name: "Slack", line: "Post a short note to a channel." },
  { key: "teams", name: "Microsoft Teams", line: "Post a note to a Teams channel." },
  { key: "discord", name: "Discord", line: "Post a message to a Discord channel with a webhook link." },
  { key: "telegram", name: "Telegram", line: "Send a message to a Telegram chat." },
  { key: "google_calendar", name: "Google Calendar", line: "Put a booking on a calendar, and move or remove it with the booking." },
  { key: "google_drive", name: "Google Drive", line: "Save the files people attach to a form into a shared drive folder." },
  { key: "paymongo", name: "PayMongo", line: "Take payments and start automations when they are paid." },
  { key: "lalamove", name: "Lalamove", line: "Quote delivery fees and book riders from automations." },
  { key: "airtable", name: "Airtable", line: "Add a record to a table for every request." },
  { key: "notion", name: "Notion", line: "Add a page to a database for every request." },
  { key: "trello", name: "Trello", line: "Add a card to a list for every request." },
  { key: "meta_messenger", name: "Facebook Messenger & Instagram", line: "Receive DMs and receipt photos, and reply within Meta's 24-hour window." },
  { key: "whatsapp", name: "WhatsApp Cloud API", line: "Receive WhatsApp messages and send service replies or paid Meta utility templates." },
  { key: "shopify", name: "Shopify", line: "Start from new orders, and create or update products." },
];

function LalamoveConnection({ hasKey, hasSecret, onChange }: { hasKey: boolean; hasSecret: boolean; onChange: () => Promise<unknown> }) {
  const { t } = useLanguage();
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const connected = hasKey && hasSecret;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaved("");
    if (!hasKey && !apiKey.trim()) return setError(t("Enter your Lalamove API key."));
    if (!hasSecret && !apiSecret.trim()) return setError(t("Enter your Lalamove API secret."));
    if (!apiKey.trim() && !apiSecret.trim()) return setError(t("Enter a new key or secret to update."));
    setBusy(true);
    try {
      if (apiKey.trim()) await api("PUT", "/secrets/lalamove_api_key", { value: apiKey.trim() });
      if (apiSecret.trim()) await api("PUT", "/secrets/lalamove_api_secret", { value: apiSecret.trim() });
      setApiKey("");
      setApiSecret("");
      setSaved(t("Lalamove keys saved."));
      await onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(t("Disconnect Lalamove? Automations that quote or book riders will stop working until you save keys again."))) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await Promise.all([
        api("DELETE", "/secrets/lalamove_api_key").catch(() => undefined),
        api("DELETE", "/secrets/lalamove_api_secret").catch(() => undefined),
      ]);
      setSaved(t("Lalamove disconnected."));
      await onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connection" aria-busy={busy} aria-labelledby="lalamove-h">
      <h3 id="lalamove-h">Lalamove</h3>
      <p className="muted">
        {connected
          ? t("Connected. Keys are stored encrypted as lalamove_api_key and lalamove_api_secret.")
          : hasKey || hasSecret
            ? t("One Lalamove key is missing. Save both the API key and API secret.")
            : t("Paste your Lalamove Partner API key and secret from the Lalamove Developer Portal.")}
      </p>
      <form onSubmit={save} autoComplete="off">
        <div className="field">
          <label htmlFor="lalamove-api-key">{t("API key")}</label>
          <input
            id="lalamove-api-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasKey ? t("Saved (enter to replace)") : "pk_live_..."}
          />
        </div>
        <div className="field">
          <label htmlFor="lalamove-api-secret">{t("API secret")}</label>
          <input
            id="lalamove-api-secret"
            type="password"
            autoComplete="new-password"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            placeholder={hasSecret ? t("Saved (enter to replace)") : "sk_live_..."}
          />
        </div>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {connected ? t("Update keys") : t("Save Lalamove keys")}
          </button>
          {(hasKey || hasSecret) && (
            <button type="button" className="quiet" disabled={busy} onClick={() => void disconnect()}>
              {t("Disconnect")}
            </button>
          )}
        </div>
        <p role="status" className="message" hidden={!saved}>{saved}</p>
        <p role="alert" className="message error" hidden={!error}>{error}</p>
      </form>
    </div>
  );
}

/** Consent returns, including the legacy Outlook URL, reopen the provider in the same directory. */
export function AppsPage({ outcome, embedded = false, initialApp }: { outcome?: { app: string; code: string }; embedded?: boolean; initialApp?: string }) {
  const { t, language } = useLanguage();
  const [mail, setMail] = useState<Settings | null>(null);
  const [conns, setConns] = useState<{ connections: Connection[]; outlook: OutlookSetup; oauth: string[]; shared: string[]; sharedGoogleApps: Partial<Record<Key, Key[]>>; usage: Partial<Record<Key, { id: string; name: string }[]>>; latestPayment: { status: string; updatedAt: string; live: boolean } | null; paymongoWebhookBase: string; metaWebhookBase: string; whatsappWebhookBase: string; shopifyWebhookBase: string } | null>(null);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [error, setError] = useState("");
  // An app slug is its provider name with dashes (google-sheets is google_sheets). "oauth" means the flow was not found.
  const targetSlug = outcome?.app ?? initialApp ?? "";
  const landed = targetSlug ? APPS.find((a) => a.key === targetSlug.replaceAll("-", "_"))?.key : undefined;
  const [open, setOpen] = useState<Key | null>(landed ?? null);
  const [onlyConnected, setOnlyConnected] = useState(false);
  const [query, setQuery] = useState("");
  const load = async () => {
    try {
      const [m, c, s] = await Promise.all([
        api<Settings>("GET", "/settings/email"),
        api<NonNullable<typeof conns>>("GET", "/settings/connections"),
        api<SecretItem[]>("GET", "/secrets").catch(() => [] as SecretItem[]),
      ]);
      setMail(m);
      setConns(c);
      setSecrets(s);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(), []);
  const trigger = useRef<Key | null>(null);
  useEffect(() => { setOpen(landed ?? null); }, [landed, outcome?.code, initialApp]);
  const loaded = !!conns && !!mail;
  useEffect(() => {
    if (!loaded) return;
    if (open) document.getElementById("panel-title")?.focus();
    else if (trigger.current) (document.getElementById("select-" + trigger.current) ?? document.getElementById("app-find"))?.focus();
  }, [open, loaded]);
  function choose(key: Key) {
    trigger.current = key;
    setOpen(open === key ? null : key);
  }
  const Wrap = embedded ? "div" : "main";

  if (!mail || !conns) return <Wrap className="page workspace-admin admin-apps">{error ? <p role="alert" className="message error">{error}</p> : <p>{t("Loading…")}</p>}</Wrap>;
  const conn = (p: Provider) => conns.connections.find((c) => c.provider === p) ?? null;
  const hasSecret = (name: string) => secrets.some((s) => s.name === name);
  const state = (key: Key): string | null => {
    if (key === "gmail") return mail.sender && mail.sender.status !== "disconnected" ? PILL[mail.sender.status] : null;
    if (key === "lalamove") {
      const k = hasSecret("lalamove_api_key");
      const s = hasSecret("lalamove_api_secret");
      if (k && s) return "Connected";
      return k || s ? "Needs reconnecting" : null;
    }
    const c = conn(key);
    return c ? (c.status === "active" ? "Connected" : "Needs reconnecting") : null;
  };
  const q = query.trim().toLowerCase();
  const found = APPS.filter((a) => a.name.toLowerCase().includes(q));
  const connected = found.filter((a) => state(a.key));
  const more = found.filter((a) => !state(a.key));
  const total = APPS.filter((a) => state(a.key)).length;
  const activeTotal = APPS.filter((a) => state(a.key) === "Connected").length;
  const failed = APPS.filter((a) => (a.key === "gmail" ? mail.sender?.status === "failed" : a.key === "lalamove" ? state("lalamove") === "Needs reconnecting" : conn(a.key)?.status === "failed"));
  const setup: Record<Key, () => ReactNode> = {
    gmail: () => <GmailCard data={mail} google={conns.oauth.includes("gmail")} outcome={landed === "gmail" ? outcome?.code : undefined} onChange={load} />,
    google_sheets: () => <GoogleSheetsCard conn={conn("google_sheets")} configured={conns.oauth.includes("google-sheets")} outcome={landed === "google_sheets" ? outcome?.code : undefined} onChange={load} />,
    slack: () => <SlackConnection conn={conn("slack")} configured={conns.oauth.includes("slack")} outcome={landed === "slack" ? outcome?.code : undefined} onChange={load} />,
    outlook: () => <OutlookConnection conn={conn("outlook")} setup={conns.outlook} outcome={landed === "outlook" ? outcome?.code : undefined} onChange={load} />,
    teams: () => <TeamsConnection conn={conn("teams")} onChange={load} />,
    discord: () => <DiscordConnection conn={conn("discord")} onChange={load} />,
    telegram: () => <TelegramConnection conn={conn("telegram")} onChange={load} />,
    google_calendar: () => <GoogleCalendarCard conn={conn("google_calendar")} configured={conns.oauth.includes("google-calendar")} outcome={landed === "google_calendar" ? outcome?.code : undefined} onChange={load} />,
    google_drive: () => <GoogleDriveCard conn={conn("google_drive")} configured={conns.oauth.includes("google-drive")} outcome={landed === "google_drive" ? outcome?.code : undefined} onChange={load} />,
    paymongo: () => <PaymongoConnection conn={conn("paymongo")} webhookBase={conns.paymongoWebhookBase} onChange={load} />,
    lalamove: () => <LalamoveConnection hasKey={hasSecret("lalamove_api_key")} hasSecret={hasSecret("lalamove_api_secret")} onChange={load} />,
    airtable: () => <RecordConnection key="airtable" app="airtable" conn={conn("airtable")} configured={conns.oauth.includes("airtable")} outcome={landed === "airtable" ? outcome?.code : undefined} onChange={load} />,
    notion: () => <RecordConnection key="notion" app="notion" conn={conn("notion")} configured={conns.oauth.includes("notion")} outcome={landed === "notion" ? outcome?.code : undefined} onChange={load} />,
    trello: () => <RecordConnection key="trello" app="trello" conn={conn("trello")} configured={conns.oauth.includes("trello")} outcome={landed === "trello" ? outcome?.code : undefined} onChange={load} />,
    meta_messenger: () => <MetaMessengerConnection conn={conn("meta_messenger")} webhookBase={conns.metaWebhookBase} onChange={load} />,
    whatsapp: () => <WhatsAppConnection conn={conn("whatsapp")} webhookBase={conns.whatsappWebhookBase} onChange={load} />,
    shopify: () => <ShopifyConnection conn={conn("shopify")} webhookBase={conns.shopifyWebhookBase} onChange={load} />,
  };
  const selected = APPS.find((a) => a.key === open);
  const checked = (key: Key) => (key === "gmail" ? mail.sender?.lastTestedAt : key === "lalamove" ? null : conn(key)?.lastTestedAt);
  const date = (stamp: string) => new Intl.DateTimeFormat(language === "tl" ? "fil-PH" : "en-PH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(stamp));
  const renderMarks = (key: string, name: string, size: number) =>
    key === "meta_messenger" ? (
      <span className="app-mark-pair" data-size={size}>
        <AppMark mark="messenger" name="Facebook Messenger" size={size} />
        <AppMark mark="instagram" name="Instagram" size={size} />
      </span>
    ) : (
      <AppMark mark={APP_LOGO[key] ?? key} name={name} size={size} />
    );

  const card = (a: (typeof APPS)[number]) => {
    const status = state(a.key);
    const c = a.key === "gmail" || a.key === "lalamove" ? null : conn(a.key);
    const dest = c?.destination;
    const label = dest?.title || dest?.channelName || dest?.chatTitle || dest?.tableName || dest?.listName || dest?.databaseTitle;
    const stamp = checked(a.key);
    return (
      <li key={a.key} className="directory-row" data-selected={open === a.key} data-saved={!!status}>
        {renderMarks(a.key, a.name, 36)}
        <div className="app-text"><h3>{a.name}</h3><p>{t(a.line)}</p></div>
        {status && !open && <>
          <div className="directory-detail">{c?.account || (a.key === "gmail" && mail.sender?.address)}{label && <small>{label}</small>}</div>
          <span className="state-pill" data-ok={status === "Connected"}>{t(status)}</span>
          <small className="directory-detail">{stamp ? date(stamp) : t("Not checked yet")}</small>
        </>}
        <button id={"select-" + a.key} type="button" aria-expanded={open === a.key} aria-controls="app-setup" onClick={() => choose(a.key)}>
          {open === a.key ? t("Close") : status ? t("Manage") : t("Connect")}<span className="visually-hidden"> {a.name}</span>
        </button>
      </li>
    );
  };
  const group = (name: string, apps: typeof APPS) => (
    <section className="directory-group" data-available={name === "More"} aria-label={t(name)}>
      <h2>{t(name)} <span>· {apps.length}</span></h2>
      {name === "Connected" && !open && <div className="directory-columns" aria-hidden="true"><span>{t("App")}</span><span>{t("Account and destination")}</span><span>{t("Status")}</span><span>{t("Last checked")}</span></div>}
      <ul>{apps.map(card)}</ul>
    </section>
  );
  const siblings = open ? conns.sharedGoogleApps?.[open] : undefined;
  const usage = open ? conns.usage?.[open] : undefined;
  return (
    <Wrap className="page workspace-admin admin-apps" data-panel={!!open}>
      <header className="apps-head">
        <div>
          {embedded ? (
            <div className="apps-embedded-bar">
              <h2>{t("Apps")}</h2>
              <span className="muted">{t("{count} of {total} connected", { count: activeTotal, total: APPS.length })}</span>
            </div>
          ) : (
            <Header title={t("Apps")} action={<span className="muted">{t("{count} of {total} connected", { count: activeTotal, total: APPS.length })}</span>} />
          )}
          {!open && (
            <>
              <p className="muted apps-lede">{t("Everything here is optional. Each app is used only by the automations you turn on, and the demo works without any of them.")}</p>
              <p className="muted apps-lede">
                {t("SMS (UniSMS) is managed by the kymavo operator, so there is no key to connect here.")}
              </p>
            </>
          )}
        </div>
      </header>
      <div className="apps-body" data-panel={!!open}>
        <div className="apps-directory">
          {outcome && !landed && <p role="alert" className="message error">{t("That sign-in took too long or was started by someone else. Start again from the app's Connect button.")}</p>}
          <div className="directory-filters">
            <div className="app-tabs" role="group" aria-label={t("Show")}>
              <button type="button" aria-pressed={!onlyConnected} onClick={() => setOnlyConnected(false)}>{t("All {count}", {count: APPS.length})}</button>
              <button type="button" aria-pressed={onlyConnected} onClick={() => setOnlyConnected(true)}>{t("Connected {count}", {count: total})}</button>
            </div>
            <input id="app-find" type="search" aria-label={t("Find an app")} placeholder={t("Find an app")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {!open && failed.length > 0 && <div className="app-warnings">
            {failed.map(a => <button key={a.key} type="button" onClick={() => choose(a.key)}>{t("{app} needs attention", { app: a.name })}</button>)}
          </div>}
          {connected.length > 0 && group("Connected", connected)}
          {!onlyConnected && more.length > 0 && group("More", more)}
          {(onlyConnected ? connected : found).length === 0 && <div className="app-empty">
            <p role="status">{onlyConnected && total === 0 ? t("Nothing is connected yet.") : t("No app matches.")}</p>
            {query && <button onClick={() => setQuery("")}>{t("Clear search")}</button>}
            {onlyConnected && more.length > 0 && query && group("In All apps", more)}
          </div>}
          {!open && <section className="email-intake" aria-labelledby="email-in-setup">
            <h2 id="email-in-setup"><Text>Receive website form emails</Text></h2>
            <p>{t("Connect a dedicated IMAP mailbox in an automation's Steps tab. Under Starts when, choose An email arrives, then connect the mailbox. Each automation has its own inbox settings.")}</p>
            <a href="#/automations"><Text>Choose an automation</Text></a>
          </section>}
        </div>
        {open && selected && <section key={open} id="app-setup" className="setup-pane motion-page" aria-label={t("{app} setup", { app: selected.name })}>
          <button className="panel-back" onClick={() => { trigger.current = open; setOpen(null); }}>{t("Back to Apps")}</button>
          <header className="panel-head">{renderMarks(open, selected.name, 44)}
            <div><h2 id="panel-title" tabIndex={-1}>{selected.name}</h2><p>{t(selected.line)}</p></div>
          </header>
          <SharedGrants.Provider value={conns.shared}>{setup[open]()}</SharedGrants.Provider>
          {siblings?.length ? <section className="panel-detail"><h3>{t("Apps sharing this Google sign-in")}</h3><ul>{siblings.map(key => <li key={key}>
              <button type="button" className="quiet" onClick={() => choose(key)}>{APPS.find(a => a.key === key)?.name}</button>
              <small>{key === "gmail" ? mail.sender?.address : conn(key as Provider)?.account}</small>
            </li>)}</ul></section> : null}
          {open === "paymongo" && conn("paymongo") && <section className="panel-detail"><h3>{t("Payment status")}</h3>
            {conns.latestPayment ? <p>{t(conns.latestPayment.live ? "Live mode" : "Test mode")} · {t(conns.latestPayment.status)} · {date(conns.latestPayment.updatedAt)}</p> : <p>{t("No payments recorded yet.")}</p>}
          </section>}
          {state(open) && <section className="panel-detail"><h3>{t("Used by")}</h3>
            {usage?.length ? <ul>{usage.map(w => <li key={w.id}><a href={`#/a/${w.id}`}>{w.name}</a></li>)}</ul> : <p>{t("No published automations use this app.")}</p>}
            <small>{t("Last checked")} · {checked(open) ? date(checked(open)!) : t("Not checked yet")}</small>
          </section>}
        </section>}
      </div>
    </Wrap>
  );
}

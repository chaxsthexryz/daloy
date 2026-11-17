import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { PILL, SenderSection, type Settings } from "./BusinessSetup";
import { OutlookConnection, PaymongoConnection, SheetsConnection, SlackConnection, TeamsConnection, TelegramConnection, type Connection, type OutlookSetup, type Provider } from "./Connections";
import { Header } from "./Nav";

type Key = "gmail" | Provider;
// Letter tiles, not logos: Microsoft, Slack and Google allow their names in text but their logos only under licence.
const APPS: { key: Key; name: string; line: string }[] = [
  { key: "gmail", name: "Gmail", line: "Send customer emails from your own address." },
  { key: "outlook", name: "Outlook", line: "Send purchase emails from an Outlook mailbox." },
  { key: "google_sheets", name: "Google Sheets", line: "Add a row to a sheet for every request." },
  { key: "slack", name: "Slack", line: "Post a short note to a channel." },
  { key: "teams", name: "Microsoft Teams", line: "Post a note to a Teams channel." },
  { key: "telegram", name: "Telegram", line: "Send a message to a Telegram chat." },
  { key: "paymongo", name: "PayMongo", line: "Take payments and start automations when they are paid." },
];

/**
 * #/apps: one card per app Daloy can use, connected ones first. Connect or Manage opens that app's own setup below the
 * cards. The Outlook consent callback (#/settings/business/outlook-<code>) lands here with Outlook open.
 */
export function AppsPage({ outlookOutcome }: { outlookOutcome?: string }) {
  const [mail, setMail] = useState<Settings | null>(null);
  const [conns, setConns] = useState<{ connections: Connection[]; outlook: OutlookSetup; paymongoWebhookBase: string } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Key | null>(outlookOutcome ? "outlook" : null);
  const [onlyConnected, setOnlyConnected] = useState(false);
  const [query, setQuery] = useState("");
  const load = async () => {
    try {
      const [m, c] = await Promise.all([api<Settings>("GET", "/settings/email"), api<NonNullable<typeof conns>>("GET", "/settings/connections")]);
      setMail(m);
      setConns(c);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(), []);
  // Braces matter: Chromium's scrollIntoView now returns a promise, which React would take for a cleanup function.
  useEffect(() => {
    document.getElementById("app-setup")?.scrollIntoView({ block: "start" });
  }, [open]);

  if (!mail || !conns) return <main className="page">{error ? <p role="alert" className="message error">{error}</p> : <p>Loading…</p>}</main>;
  const conn = (p: Provider) => conns.connections.find((c) => c.provider === p) ?? null;
  const state = (key: Key): string | null => {
    if (key === "gmail") return mail.sender && mail.sender.status !== "disconnected" ? PILL[mail.sender.status] : null;
    const c = conn(key);
    return c ? (c.status === "active" ? "Connected" : "Needs reconnecting") : null;
  };
  const q = query.trim().toLowerCase();
  const found = APPS.filter((a) => a.name.toLowerCase().includes(q));
  const connected = found.filter((a) => state(a.key));
  const more = found.filter((a) => !state(a.key));
  const total = APPS.filter((a) => state(a.key)).length;
  const setup: Record<Key, () => ReactNode> = {
    gmail: () => <SenderSection data={mail} onChange={load} />,
    google_sheets: () => <SheetsConnection conn={conn("google_sheets")} onChange={load} />,
    slack: () => <SlackConnection conn={conn("slack")} onChange={load} />,
    outlook: () => <OutlookConnection conn={conn("outlook")} setup={conns.outlook} outcome={outlookOutcome} onChange={load} />,
    teams: () => <TeamsConnection conn={conn("teams")} onChange={load} />,
    telegram: () => <TelegramConnection conn={conn("telegram")} onChange={load} />,
    paymongo: () => <PaymongoConnection conn={conn("paymongo")} webhookBase={conns.paymongoWebhookBase} onChange={load} />,
  };
  const card = (a: (typeof APPS)[number]) => {
    const s = state(a.key);
    return (
      <li key={a.key} className="app-card">
        <span className="app-tile" aria-hidden="true">
          {a.name[0]}
        </span>
        <div className="app-text">
          <h3>{a.name}</h3>
          <p className="muted">{a.line}</p>
        </div>
        <div className="actions">
          {s && <span className={`tag${s === "Connected" ? " ok" : ""}`}>{s}</span>}
          <button type="button" aria-expanded={open === a.key} aria-controls="app-setup" onClick={() => setOpen(open === a.key ? null : a.key)}>
            {open === a.key ? "Close" : s ? "Manage" : "Connect"}
            <span className="visually-hidden"> {a.name}</span>
          </button>
        </div>
      </li>
    );
  };

  return (
    <main className="page">
      <Header title="Apps" />
      <p className="muted">Everything here is optional. Each app is used only by the automations you turn on, and the demo works without any of them.</p>
      <section aria-labelledby="email-in-setup">
        <h2 id="email-in-setup">Receive website form emails</h2>
        <p>Connect a dedicated IMAP mailbox in an automation's Steps tab. Under Starts when, choose An email arrives, then connect the mailbox. Each automation has its own inbox settings.</p>
        <a href="#/">Choose an automation</a>
      </section>
      <div className="filters">
        <div className="actions" role="group" aria-label="Show">
          <button type="button" aria-pressed={!onlyConnected} onClick={() => setOnlyConnected(false)}>
            All {APPS.length}
          </button>
          <button type="button" aria-pressed={onlyConnected} onClick={() => setOnlyConnected(true)}>
            Connected {total}
          </button>
        </div>
        <div className="field">
          <label htmlFor="app-find">Find an app</label>
          <input id="app-find" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      {connected.length > 0 && (
        <section aria-labelledby="apps-connected">
          <h2 id="apps-connected">Connected</h2>
          <ul className="apps">{connected.map(card)}</ul>
        </section>
      )}
      {!onlyConnected && more.length > 0 && (
        <section aria-labelledby="apps-more">
          <h2 id="apps-more">More</h2>
          <ul className="apps">{more.map(card)}</ul>
        </section>
      )}
      {(onlyConnected ? connected : found).length === 0 && <p className="muted">{onlyConnected && total === 0 ? "Nothing is connected yet." : "No app matches."}</p>}
      {open && (
        <section id="app-setup" className="app-setup" aria-label={`${APPS.find((a) => a.key === open)!.name} setup`}>
          {setup[open]()}
        </section>
      )}
    </main>
  );
}

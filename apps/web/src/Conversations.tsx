import "./activity.css";
import "./conversations.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { KnowledgeEntry } from "@daloy/engine";
import { api } from "./api";
import { useLanguage } from "./Language";
import { PageHead } from "./Runs";
import type { User } from "./Team";
import { pushToast } from "./Toast";
import { alertChannelSummary, channelLabel, guestDisplayName, nightsBetween, type ConversationSummary, type StaffAlertStatus } from "./lib/conversations";

type Detail = ConversationSummary & {
  messages: { id: string; direction: "in" | "out" | "staff"; text: string; uploadIds: string[]; createdAt: string }[];
  bookings: { id: string; reference: string; status: string; nights: number | null; timezone: string; start: string; end: string }[];
  openDue: { id: string; reference: string; kind: string; amountCentavos: number; status: string; token: string; createdAt: string } | null;
};

type Settings = { conversationRetentionDays: number; staffQuietHours: number; staffAlertPsid: string | null };
type Resource = { id: string; name: string; label?: string; active: boolean };
type ThreadFilter = "all" | "needs" | "bot";

const DIRECTION_LABEL = { in: "Guest", out: "Bot", staff: "Staff" } as const;
const todayIso = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export function ConversationsPage({ user }: { user: User }) {
  const { t } = useLanguage();
  const owner = user.role === "owner";
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [alertStatus, setAlertStatus] = useState<StaffAlertStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [filter, setFilter] = useState<ThreadFilter>("all");
  const [search, setSearch] = useState("");
  const [resources, setResources] = useState<Resource[]>([]);
  const [rooms, setRooms] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showStay, setShowStay] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fieldsForm, setFieldsForm] = useState({ name: "", phone: "", email: "", check_in: "", check_out: "", guests: "" });
  const [stayForm, setStayForm] = useState({ resourceId: "", checkIn: todayIso(), nights: 1 });
  const [depositForm, setDepositForm] = useState({ room: "", checkIn: todayIso(), nights: 1, guests: 2 });
  const [settingsForm, setSettingsForm] = useState({ conversationRetentionDays: 90, staffQuietHours: 12, staffAlertPsid: "" });
  const reqSeq = useRef(0);

  const loadList = async (keepSelection = true) => {
    const seq = ++reqSeq.current;
    const data = await api<{ conversations: ConversationSummary[]; alertStatus: StaffAlertStatus; settings?: Settings }>("GET", "/conversations");
    if (seq !== reqSeq.current) return;
    setList(data.conversations);
    setAlertStatus(data.alertStatus);
    if (data.settings) {
      setSettings(data.settings);
      setSettingsForm({
        conversationRetentionDays: data.settings.conversationRetentionDays,
        staffQuietHours: data.settings.staffQuietHours,
        staffAlertPsid: data.settings.staffAlertPsid ?? "",
      });
    }
    const nextId = keepSelection && selectedId && data.conversations.some((c) => c.id === selectedId) ? selectedId : (data.conversations[0]?.id ?? null);
    setSelectedId(nextId);
    if (!nextId) setDetail(null);
  };

  useEffect(() => {
    loadList(false).catch((e: Error) => setError(e.message));
    api<Resource[]>("GET", "/resources")
      .then((rows) => {
        const active = rows.filter((r) => r.active);
        setResources(active);
        if (active[0]) setStayForm((f) => ({ ...f, resourceId: f.resourceId || active[0]!.id }));
      })
      .catch(() => undefined);
    api<{ entries: KnowledgeEntry[] }>("GET", "/knowledge")
      .then((k) => {
        const titles = k.entries.filter((e) => e.kind === "room").map((e) => e.title);
        setRooms(titles);
        if (titles[0]) setDepositForm((f) => ({ ...f, room: f.room || titles[0]! }));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let live = true;
    api<Detail>("GET", `/conversations/${selectedId}`)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setFieldsForm({
          name: d.fields.name ?? "",
          phone: d.fields.phone ?? "",
          email: d.fields.email ?? "",
          check_in: d.fields.check_in ?? "",
          check_out: d.fields.check_out ?? "",
          guests: d.fields.guests ?? "",
        });
        const checkIn = d.fields.check_in || todayIso();
        const nights = nightsBetween(d.fields.check_in, d.fields.check_out);
        setStayForm((f) => ({ ...f, checkIn, nights }));
        setDepositForm((f) => ({ ...f, checkIn, nights, guests: Number(d.fields.guests) || f.guests }));
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [selectedId]);

  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setError("");
    setNotice("");
    try {
      await fn();
      if (message) {
        setNotice(message);
        pushToast({ id: "cv-status", message, tone: "success" });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const refreshSelected = async (id: string) => {
    await loadList(true);
    const updated = await api<Detail>("GET", `/conversations/${id}`);
    setDetail(updated);
  };

  const saveFields = (e: FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    void act(async () => {
      await api("PUT", `/conversations/${detail.id}/fields`, fieldsForm);
      await refreshSelected(detail.id);
    }, t("Guest details saved."));
  };

  const confirmStay = (e: FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    void act(async () => {
      const res = await api<{ booking: { reference: string } }>("POST", "/bookings/stays", {
        resourceId: stayForm.resourceId,
        checkIn: stayForm.checkIn,
        nights: Number(stayForm.nights),
        conversationId: detail.id,
      });
      setShowStay(false);
      await refreshSelected(detail.id);
      const msg = t("Stay {reference} confirmed.", { reference: res.booking.reference });
      setNotice(msg);
      pushToast({ id: "cv-status", message: msg, tone: "success" });
    });
  };

  const sendDeposit = (e: FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    void act(async () => {
      await api<{ runId: string }>("POST", `/conversations/${detail.id}/deposit-request`, {
        room: depositForm.room || undefined,
        checkIn: depositForm.checkIn,
        nights: Number(depositForm.nights),
        guests: Number(depositForm.guests),
      });
      setShowDeposit(false);
      await refreshSelected(detail.id);
    }, t("Deposit request started."));
  };

  const saveSettings = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const res = await api<{ settings: Settings; alertStatus: StaffAlertStatus }>("PUT", "/conversations/settings", {
        conversationRetentionDays: Number(settingsForm.conversationRetentionDays),
        staffQuietHours: Number(settingsForm.staffQuietHours),
        staffAlertPsid: settingsForm.staffAlertPsid.trim() || null,
      });
      setSettings(res.settings);
      setAlertStatus(res.alertStatus);
      setShowSettings(false);
    }, t("Conversation settings saved."));
  };

  const exportGuest = () => {
    if (!detail) return;
    void act(async () => {
      const payload = await api<unknown>("POST", `/conversations/${detail.id}/export`, {});
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `guest-${detail.id.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }, t("Guest data exported."));
  };

  const deleteGuest = (e: FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    void act(async () => {
      await api("POST", `/conversations/${detail.id}/delete`, { confirm: deleteText.trim() });
      setDeleteText("");
      setDetail(null);
      setMobileView("list");
      await loadList(false);
    }, t("Guest conversation erased."));
  };

  const needle = search.trim().toLowerCase();
  const visible = (list ?? []).filter((c) => {
    if (filter === "needs" && !c.paused) return false;
    if (filter === "bot" && c.paused) return false;
    if (!needle) return true;
    const name = guestDisplayName(c).toLowerCase();
    const channel = channelLabel(c.channel).toLowerCase();
    const preview = c.latestMessage?.text.toLowerCase() ?? "";
    return name.includes(needle) || channel.includes(needle) || preview.includes(needle);
  });

  const subtitle = list !== null
    ? alertStatus
      ? `${t("{count} conversations", { count: list.length })} · ${alertChannelSummary(alertStatus, t)}`
      : t("{count} conversations", { count: list.length })
    : undefined;

  return (
    <main className="page act cv-page">
      <PageHead
        crumbs={[]}
        title={t("Conversations")}
        sub={subtitle}
        actions={owner ? (
          <button type="button" className="act-button" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? t("Hide alert settings") : t("Alert settings")}
          </button>
        ) : undefined}
      />

      <div className="act-body cv-body">
        {error && <p className="message error cv-feedback" role="alert">{error}</p>}
        {notice && <p className="message cv-feedback">{notice}</p>}

        {owner && showSettings && settings && (
          <form className="cv-settings" onSubmit={saveSettings}>
            <div className="cv-settings-grid">
              <div className="field">
                <label htmlFor="cv-psid">{t("Staff Messenger PSID")}</label>
                <input id="cv-psid" value={settingsForm.staffAlertPsid} onChange={(e) => setSettingsForm({ ...settingsForm, staffAlertPsid: e.target.value })} placeholder={t("Optional")} />
              </div>
              <div className="field">
                <label htmlFor="cv-quiet">{t("Staff pause hours")}</label>
                <input id="cv-quiet" type="number" min={1} max={168} value={settingsForm.staffQuietHours} onChange={(e) => setSettingsForm({ ...settingsForm, staffQuietHours: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label htmlFor="cv-retain">{t("Keep messages (days)")}</label>
                <input id="cv-retain" type="number" min={1} max={3650} value={settingsForm.conversationRetentionDays} onChange={(e) => setSettingsForm({ ...settingsForm, conversationRetentionDays: Number(e.target.value) })} />
              </div>
            </div>
            <div className="cv-actions">
              <button type="submit" className="act-button blue">{t("Save settings")}</button>
            </div>
          </form>
        )}

        {list === null ? (
          <p className="act-muted">{t("Loading")}</p>
        ) : list.length === 0 ? (
          <section className="act-card">
            <p className="act-muted">{t("No conversations yet.")}</p>
          </section>
        ) : (
          <div className="cv-shell" data-mobile={mobileView}>
            <section className="cv-list-col" aria-label={t("Conversation list")}>
              <div className="cv-filter-box">
                <label className="cv-search">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
                    <path d="M21 21l-6 -6" />
                  </svg>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label={t("Search guest or channel")}
                    placeholder={t("Search guest or channel")}
                  />
                </label>
                <div className="cv-seg" role="tablist" aria-label={t("Filter")}>
                  {(["all", "needs", "bot"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      role="tab"
                      aria-selected={filter === kind}
                      className={filter === kind ? "is-active" : undefined}
                      onClick={() => setFilter(kind)}
                    >
                      {kind === "all" ? t("All") : kind === "needs" ? t("Needs staff") : t("Bot")}
                    </button>
                  ))}
                </div>
              </div>
              {visible.length === 0 ? (
                <p className="cv-empty-list">{t("No matching conversations.")}</p>
              ) : (
                <ul className="cv-list">
                  {visible.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="cv-item"
                        aria-pressed={c.id === selectedId}
                        onClick={() => {
                          setSelectedId(c.id);
                          setMobileView("detail");
                        }}
                      >
                        <span className="cv-item-top">
                          <span className="cv-item-name">{guestDisplayName(c)}</span>
                          <span className={c.paused ? "cv-badge cv-badge-staff" : "cv-badge"}>
                            {c.paused ? t("Needs staff") : t("Bot")}
                          </span>
                        </span>
                        <span className="cv-meta">
                          <span>{channelLabel(c.channel)}</span>
                          {c.fields.check_in && <span>{c.fields.check_in}</span>}
                        </span>
                        {c.latestMessage && <span className="cv-item-preview">{c.latestMessage.text}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="cv-detail-col" aria-label={t("Conversation details")}>
              <button type="button" className="act-button cv-back" onClick={() => setMobileView("list")}>
                {t("Back to conversations")}
              </button>

              {detail && (
                <div className="cv-detail">
                  <div className="cv-detail-head">
                    <div>
                      <h2>{guestDisplayName(detail)}</h2>
                      <div className="cv-meta">
                        <span>{channelLabel(detail.channel)}</span>
                        <span>{detail.paused ? t("Staff handling") : t("Bot replying")}</span>
                        {(detail.channel === "messenger" || detail.channel === "instagram" || detail.channel === "whatsapp") && (
                          <span>{detail.windowOpen ? t("24-hour reply window open") : t("24-hour reply window closed")}</span>
                        )}
                      </div>
                    </div>
                    <div className="cv-actions">
                      {detail.paused ? (
                        <button
                          type="button"
                          className="act-button blue"
                          onClick={() => void act(async () => { await api("POST", `/conversations/${detail.id}/hand-back`, {}); await refreshSelected(detail.id); }, t("Handed back to bot."))}
                        >
                          {t("Hand back")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="act-button blue"
                          onClick={() => void act(async () => { await api("POST", `/conversations/${detail.id}/take-over`, {}); await refreshSelected(detail.id); }, t("Conversation taken over."))}
                        >
                          {t("Take over")}
                        </button>
                      )}
                      <button type="button" className="act-button" onClick={() => { setShowStay((v) => !v); setShowDeposit(false); }}>
                        {t("Confirm stay")}
                      </button>
                      <button type="button" className="act-button" onClick={() => { setShowDeposit((v) => !v); setShowStay(false); }}>
                        {t("Send deposit request")}
                      </button>
                      <button
                        type="button"
                        className="act-button"
                        onClick={() => void act(async () => {
                          const r = await api<{ channel: string }>("POST", `/conversations/${detail.id}/alert`, {});
                          const msg = t("Alert sent via {channel}.", { channel: r.channel });
                          setNotice(msg);
                          pushToast({ id: "cv-status", message: msg, tone: "info" });
                        })}
                      >
                        {t("Alert staff")}
                      </button>
                    </div>
                  </div>

                  {showStay && (
                    <form className="cv-panel" onSubmit={confirmStay}>
                      <h3>{t("Confirm stay")}</h3>
                      <div className="cv-fields">
                        <div className="field">
                          <label htmlFor="cv-stay-room">{t("Room")}</label>
                          <select id="cv-stay-room" value={stayForm.resourceId} onChange={(e) => setStayForm({ ...stayForm, resourceId: e.target.value })} required>
                            {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor="cv-stay-in">{t("Check-in")}</label>
                          <input id="cv-stay-in" type="date" value={stayForm.checkIn} onChange={(e) => setStayForm({ ...stayForm, checkIn: e.target.value })} required />
                        </div>
                        <div className="field">
                          <label htmlFor="cv-stay-nights">{t("Nights")}</label>
                          <input id="cv-stay-nights" type="number" min={1} max={30} value={stayForm.nights} onChange={(e) => setStayForm({ ...stayForm, nights: Number(e.target.value) })} required />
                        </div>
                      </div>
                      <div className="cv-actions">
                        <button type="submit" className="act-button blue" disabled={resources.length === 0}>{t("Save stay")}</button>
                        <button type="button" className="act-button" onClick={() => setShowStay(false)}>{t("Cancel")}</button>
                      </div>
                    </form>
                  )}

                  {showDeposit && (
                    <form className="cv-panel" onSubmit={sendDeposit}>
                      <h3>{t("Send deposit request")}</h3>
                      <div className="cv-fields">
                        <div className="field">
                          <label htmlFor="cv-dep-room">{t("Room")}</label>
                          {rooms.length > 0 ? (
                            <select id="cv-dep-room" value={depositForm.room} onChange={(e) => setDepositForm({ ...depositForm, room: e.target.value })}>
                              {rooms.map((title) => <option key={title} value={title}>{title}</option>)}
                            </select>
                          ) : (
                            <input id="cv-dep-room" value={depositForm.room} onChange={(e) => setDepositForm({ ...depositForm, room: e.target.value })} />
                          )}
                        </div>
                        <div className="field">
                          <label htmlFor="cv-dep-in">{t("Check-in")}</label>
                          <input id="cv-dep-in" type="date" value={depositForm.checkIn} onChange={(e) => setDepositForm({ ...depositForm, checkIn: e.target.value })} required />
                        </div>
                        <div className="field">
                          <label htmlFor="cv-dep-nights">{t("Nights")}</label>
                          <input id="cv-dep-nights" type="number" min={1} max={30} value={depositForm.nights} onChange={(e) => setDepositForm({ ...depositForm, nights: Number(e.target.value) })} required />
                        </div>
                        <div className="field">
                          <label htmlFor="cv-dep-guests">{t("Guests")}</label>
                          <input id="cv-dep-guests" type="number" min={1} max={100} value={depositForm.guests} onChange={(e) => setDepositForm({ ...depositForm, guests: Number(e.target.value) })} required />
                        </div>
                      </div>
                      <div className="cv-actions">
                        <button type="submit" className="act-button blue">{t("Start deposit flow")}</button>
                        <button type="button" className="act-button" onClick={() => setShowDeposit(false)}>{t("Cancel")}</button>
                      </div>
                    </form>
                  )}

                  <section className="cv-section" aria-label={t("Message history")}>
                    <h3>{t("Messages")}</h3>
                    {detail.messages.length === 0 ? (
                      <p className="act-muted">{t("No messages yet.")}</p>
                    ) : (
                      <ul className="cv-messages">
                        {detail.messages.map((m) => (
                          <li key={m.id} className="cv-msg" data-dir={m.direction}>
                            <span className="cv-msg-who">
                              <span>{t(DIRECTION_LABEL[m.direction])}</span>
                              <span>{new Date(m.createdAt).toLocaleString()}</span>
                            </span>
                            <p>{m.text}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <form className="cv-section" onSubmit={saveFields}>
                    <h3>{t("Guest details")}</h3>
                    <div className="cv-fields">
                      <div className="field">
                        <label htmlFor="cv-f-name">{t("Name")}</label>
                        <input id="cv-f-name" value={fieldsForm.name} onChange={(e) => setFieldsForm({ ...fieldsForm, name: e.target.value })} />
                      </div>
                      <div className="field">
                        <label htmlFor="cv-f-phone">{t("Phone")}</label>
                        <input id="cv-f-phone" value={fieldsForm.phone} onChange={(e) => setFieldsForm({ ...fieldsForm, phone: e.target.value })} />
                      </div>
                      <div className="field">
                        <label htmlFor="cv-f-email">{t("Email")}</label>
                        <input id="cv-f-email" value={fieldsForm.email} onChange={(e) => setFieldsForm({ ...fieldsForm, email: e.target.value })} />
                      </div>
                      <div className="field">
                        <label htmlFor="cv-f-in">{t("Check-in")}</label>
                        <input id="cv-f-in" value={fieldsForm.check_in} onChange={(e) => setFieldsForm({ ...fieldsForm, check_in: e.target.value })} placeholder="YYYY-MM-DD" />
                      </div>
                      <div className="field">
                        <label htmlFor="cv-f-out">{t("Check-out")}</label>
                        <input id="cv-f-out" value={fieldsForm.check_out} onChange={(e) => setFieldsForm({ ...fieldsForm, check_out: e.target.value })} placeholder="YYYY-MM-DD" />
                      </div>
                      <div className="field">
                        <label htmlFor="cv-f-guests">{t("Guests")}</label>
                        <input id="cv-f-guests" value={fieldsForm.guests} onChange={(e) => setFieldsForm({ ...fieldsForm, guests: e.target.value })} />
                      </div>
                    </div>
                    <div className="cv-actions">
                      <button type="submit" className="act-button">{t("Save details")}</button>
                    </div>
                  </form>

                  {(detail.bookings.length > 0 || detail.openDue) && (
                    <section className="cv-section" aria-label={t("Linked stays and payments")}>
                      <h3>{t("Stays and payment")}</h3>
                      {detail.openDue && (
                        <p className="act-muted">
                          {t("Open payment {reference}: PHP {amount} ({status})", {
                            reference: detail.openDue.reference,
                            amount: (detail.openDue.amountCentavos / 100).toFixed(2),
                            status: detail.openDue.status,
                          })}
                        </p>
                      )}
                      {detail.bookings.map((b) => (
                        <p className="act-muted" key={b.id}>
                          {t("Stay {reference} ({status}): {start}", { reference: b.reference, status: b.status, start: b.start.slice(0, 10) })}
                        </p>
                      ))}
                    </section>
                  )}

                  {owner && (
                    <section className="cv-section" aria-label={t("Guest privacy")}>
                      <h3>{t("Guest privacy")}</h3>
                      <div className="cv-actions">
                        <button type="button" className="act-button" onClick={exportGuest}>{t("Export this guest")}</button>
                      </div>
                      <form className="cv-actions" onSubmit={deleteGuest}>
                        <input
                          aria-label={t("Type DELETE to erase this guest")}
                          placeholder={t("Type DELETE to confirm")}
                          value={deleteText}
                          onChange={(e) => setDeleteText(e.target.value)}
                        />
                        <button type="submit" className="cv-danger-btn" disabled={deleteText.trim() !== "DELETE"}>
                          {t("Delete this guest")}
                        </button>
                      </form>
                    </section>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

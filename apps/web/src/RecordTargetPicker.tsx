import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";

export type RecordProvider = "airtable" | "notion" | "trello";
type Choice = { id: string; name: string };

/** Separate from credential entry: only ids returned by the provider can be submitted. */
export function RecordTargetPicker({ app, disabled, hasDestination, onChange, onBusy }: { app: RecordProvider; disabled?: boolean; hasDestination?: boolean; onChange: () => Promise<unknown>; onBusy: (busy: boolean) => void }) {
  const { t } = useLanguage();
  const [parents, setParents] = useState<Choice[] | null>(null);
  const [children, setChildren] = useState<Choice[] | null>(null);
  const [parentId, setParentId] = useState("");
  const [childId, setChildId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; onBusy(false); }; }, [onBusy]);
  const parentLabel = app === "airtable" ? "Base" : app === "trello" ? "Board" : "Database";
  const childLabel = app === "airtable" ? "Table" : "List";
  const root = `/settings/connections/${app}`;
  const run = async (fn: () => Promise<void>) => {
    // A ref also blocks two clicks in the same render. All dependent selects are disabled until the read finishes.
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    setSaved(false);
    try { await fn(); } catch (e) { if (active.current) setError((e as Error).message); }
    finally {
      pending.current = false;
      if (active.current) { setBusy(false); onBusy(false); }
    }
  };
  const load = () => run(async () => {
    setParents(null);
    setChildren(null);
    setParentId("");
    setChildId("");
    const out = await api<Choice[]>("GET", `${root}/${app === "airtable" ? "bases" : app === "notion" ? "databases" : "boards"}`);
    if (active.current) setParents(out);
  });
  const chooseParent = (id: string) => {
    if (pending.current || disabled) return;
    setParentId(id);
    setChildId("");
    setChildren(null);
    setSaved(false);
    if (app === "notion" || !id) return;
    void run(async () => {
      const out = await api<Choice[]>("GET", `${root}/${app === "airtable" ? "bases" : "boards"}/${encodeURIComponent(id)}/${app === "airtable" ? "tables" : "lists"}`);
      if (active.current) setChildren(out);
    });
  };
  const valid = parents?.some((p) => p.id === parentId) && (app === "notion" || children?.some((c) => c.id === childId));
  const saveLabel = app === "airtable" ? "Save table" : app === "notion" ? "Save database" : "Save list";
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    void run(async () => {
      await api("PUT", `${root}/target`, app === "airtable" ? { baseId: parentId, tableId: childId } : app === "notion" ? { databaseId: parentId } : { boardId: parentId, listId: childId });
      if (!active.current) return;
      setParents(null);
      setChildren(null);
      setSaved(true);
      await onChange();
    });
  };
  return <div>
    <button type="button" disabled={busy || disabled} onClick={() => void load()}>{t(app === "airtable" ? hasDestination ? "Change table" : "Pick a table" : app === "notion" ? hasDestination ? "Change database" : "Pick a database" : hasDestination ? "Change list" : "Pick a list")}</button>
    {busy && <p role="status">{t("Loading…")}</p>}
    {parents && <form onSubmit={save}>
      <fieldset disabled={busy || disabled}>
        <div className="field">
          <label htmlFor={`${app}-parent`}>{t(parentLabel)}</label>
          <select id={`${app}-parent`} value={parentId} onChange={(e) => chooseParent(e.target.value)} required>
            <option value="">{t("Choose {target}", { target: t(parentLabel) })}</option>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {parents.length === 0 && <p role="status">{t(app === "notion" ? "No databases were shared with kymavo. Reconnect Notion and select the pages that contain your database." : "No available destinations. Check your account permissions, then try again.")}</p>}
        {app !== "notion" && children && <div className="field">
          <label htmlFor={`${app}-child`}>{t(childLabel)}</label>
          <select id={`${app}-child`} value={childId} onChange={(e) => setChildId(e.target.value)} required>
            <option value="">{t("Choose {target}", { target: t(childLabel) })}</option>
            {children.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {children.length === 0 && <p role="status">{t("No available destinations. Check your account permissions, then try again.")}</p>}
        </div>}
        <button type="submit" className="primary" disabled={!valid || busy || disabled}>{t(saveLabel)}</button>
      </fieldset>
    </form>}
    {saved && <p role="status">{t("Destination saved.")}</p>}
    {error && <p role="alert" className="message error">{error} <button type="button" disabled={busy || disabled} onClick={() => void load()}>{t("Try again")}</button></p>}
  </div>;
}

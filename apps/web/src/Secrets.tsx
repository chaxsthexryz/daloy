import "./workspace.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";
import { shortDateTime } from "./lib/advanced";
import { validSecretName } from "./lib/secrets";
import { ConfirmSheet, Sheet, usePhone } from "./Sheet";

type Secret = { name: string; createdAt: string };

/**
 * #/secrets: named secrets for webhook signing and HTTP steps (Doop row W9). Write-only: the API never returns a value,
 * the field is cleared after every save, and nothing in this file reads one back.
 */
export function SecretsPage() {
  const { t } = useLanguage();
  const phone = usePhone();
  const [list, setList] = useState<Secret[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [dialog, setDialog] = useState<"form" | Secret | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const load = () => api<Secret[]>("GET", "/secrets").then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  // The sheet opens after this render (Sheet calls showModal in its own effect), so focus the value from the parent's.
  useEffect(() => {
    if (dialog === "form" && replacing) valueRef.current?.focus();
  }, [dialog]);
  // Saving under a name that exists replaces its value, so say so before the owner presses Save.
  const replacing = name !== "" && !!list?.some((s) => s.name === name);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSaved("");
    if (!validSecretName(name)) return setError(t("Use a-z, 0-9 and _, starting with a letter (up to 100 characters)."));
    try {
      await api("PUT", `/secrets/${name}`, { value });
      setSaved(name);
      setName("");
      setDialog(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setValue("");
    }
  };
  const replace = (s: Secret) => {
    setName(s.name);
    setValue("");
    setSaved("");
    setError("");
    if (phone) setDialog("form");
    else valueRef.current?.focus();
  };
  const remove = async (s: Secret) => {
    setError("");
    setSaved("");
    try {
      await api("DELETE", `/secrets/${s.name}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setDialog(null);
  };

  const form = (
    <form onSubmit={save} className="wk-secret-form wk-fields" autoComplete="off">
      {replacing && <p className="wk-sub wk-replacing">{t("Replacing ")}<b>{name}</b>{t(". The old value stops working as soon as you save.")}</p>}
      <div className="wk-secret-row">
        <div>
          <label htmlFor="secret-name">{t("Name")}</label>
          <input id="secret-name" type="text" className="wk-mono" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="shop_hook" />
        </div>
        <div>
          <label htmlFor="secret-value">{t("Value")}</label>
          <input id="secret-value" ref={valueRef} type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} required maxLength={10000} />
        </div>
        <button className="wk-button blue">{t("Save secret")}</button>
      </div>
      <p className="wk-muted">{t("Name: a-z, 0-9 and _ only. In an HTTP step, write it as ")}<code>{"{{secrets.name}}"}</code>.</p>
      <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
    </form>
  );

  return (
    <main className="page wk wk-secrets">
      <header className="wk-head">
        <div>
          <a className="wk-back" href="#/advanced">{t("Advanced")}</a>
          <div className="wk-title-row">
            <h1>{t("Secrets")}</h1>
            {list && <span className="wk-sub">{t("{count} saved", { count: list.length })}</span>}
          </div>
        </div>
        {phone && <button type="button" className="wk-button blue wk-head-action" onClick={() => { setName(""); setValue(""); setError(""); setDialog("form"); }}>{t("Add secret")}</button>}
      </header>
      <p className="wk-lead wk-narrow-text">{t("Named values that automations use: a webhook's signing secret, or a key an HTTP step sends. A value is saved once and can never be read back, not even here. To change one, save it again under the same name.")}</p>
      {!phone && (
        <section className="wk-card" aria-label={t("Save a secret")}>
          <div className="wk-body">
            <h2 className="wk-card-title">{t("Save a secret")}</h2>
            {form}
          </div>
        </section>
      )}
      <p role="status" className="wk-note" hidden={!saved}>{saved && t("Saved {name}. The value is not shown again.", { name: saved })}</p>
      {phone && error && dialog !== "form" && <p role="alert" className="wk-note bad">{error}</p>}
      <section className="wk-card" aria-label={t("Your secrets")}>
        <h2 className="wk-card-head"><b>{t("Your secrets")}</b><span>{t("Values are write-only. Nothing here can show one.")}</span></h2>
        {list === null ? (
          <p className="wk-body wk-sub" role="status">{t("Loading…")}</p>
        ) : list.length === 0 ? (
          <p className="wk-body wk-sub">{t("None yet.")}</p>
        ) : (
          <table className="wk-table wk-secret-table">
            <thead>
              <tr>
                <th scope="col">{t("Name")}</th>
                <th scope="col">{t("Created")}</th>
                <th scope="col"><span className="wk-sr">{t("Actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.name} className={replacing && name === s.name && !phone ? "fresh" : undefined}>
                  <td className="wk-name wk-mono">{s.name}</td>
                  <td className="wk-when" data-label={t("Created")}>{shortDateTime(s.createdAt)}</td>
                  <td className="wk-acts">
                    <button type="button" className="wk-button" aria-label={t("Replace {name}", { name: s.name })} onClick={() => replace(s)}>{t("Replace")}</button>
                    <button type="button" className="wk-button" aria-label={t("Delete {name}", { name: s.name })} onClick={() => setDialog(s)}>{t("Delete")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {dialog === "form" && (
        <Sheet title={replacing ? t("Replace a secret") : t("Save a secret")} onClose={() => setDialog(null)}>
          {form}
        </Sheet>
      )}
      {dialog && dialog !== "form" && (
        <ConfirmSheet
          title={t("Delete {name}?", { name: dialog.name })}
          text={t("Anything that uses it stops working, and the value cannot be recovered. To keep the name and change the value, use Replace instead.")}
          confirm={t("Delete secret")}
          cancel={t("Cancel")}
          danger
          onConfirm={() => void remove(dialog)}
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}

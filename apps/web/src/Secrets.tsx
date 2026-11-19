import "./workspace-admin.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { Text, useLanguage } from "./Language";
import { validSecretName } from "./lib/secrets";
import { Header } from "./Nav";

type Secret = { name: string; createdAt: string };

/** #/secrets: named secrets for webhook signing and HTTP steps. Write-only: the API never returns a value, and the field is cleared after every save. */
export function SecretsPage() {
  const { t } = useLanguage();
  const [list, setList] = useState<Secret[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const valueRef = useRef<HTMLInputElement>(null);
  const load = () => api<Secret[]>("GET", "/secrets").then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSaved("");
    if (!validSecretName(name)) return setError(t("Use a-z, 0-9 and _, starting with a letter (up to 100 characters)."));
    try {
      await api("PUT", `/secrets/${name}`, { value });
      setSaved(name);
      setName("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setValue("");
    }
  };
  const remove = async (s: Secret) => {
    if (!confirm(t("Delete the secret {name}? Anything that uses it stops working.", { name: s.name }))) return;
    setError("");
    setSaved("");
    try {
      await api("DELETE", `/secrets/${s.name}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="page workspace-admin admin-secrets">
      <Header title={t("Secrets")} />
      <p><a href="#/advanced">{t("Advanced")}</a></p>
      <p>{t("Named values that automations use: a webhook's signing secret, or a key an HTTP step sends. A value is saved once and can never be read back, not even here. To change one, save it again under the same name.")}</p>
      <form onSubmit={save} className="create" autoComplete="off">
        <h2>{t("Save a secret")}</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="secret-name">{t("Name")}</label>
            <input id="secret-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="shop_hook" />
          </div>
          <div className="field">
            <label htmlFor="secret-value">{t("Value")}</label>
            <input id="secret-value" ref={valueRef} type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} required maxLength={10000} />
          </div>
          <button className="primary">{t("Save secret")}</button>
        </div>
        <p className="muted hint">{t("Name: a-z, 0-9 and _ only. In an HTTP step, write it as ")}<code>{"{{secrets.name}}"}</code>.</p>
        <p role="status" className="message ok" hidden={!saved}>{saved && t("Saved {name}. The value is not shown again.", { name: saved })}</p>
        <p role="alert" className="message error" hidden={!error}>{error}</p>
      </form>
      <h2><Text>Your secrets</Text></h2>
      {list === null ? (
        <p>{t("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="muted">{t("None yet.")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table cards admin-table">
            <thead>
              <tr>
                <th scope="col">{t("Name")}</th>
                <th scope="col">{t("Created")}</th>
                <th scope="col"><span className="sr-only">{t("Actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.name}>
                  <td data-label={t("Name")}>{s.name}</td>
                  <td data-label={t("Created")}>{new Date(s.createdAt).toLocaleString()}</td>
                  <td data-label={t("Actions")}>
                    <button type="button" aria-label={t("Replace {name}", { name: s.name })} onClick={() => { setName(s.name); setSaved(""); valueRef.current?.focus(); }}>{t("Replace")}</button>{" "}
                    <button type="button" aria-label={t("Delete {name}", { name: s.name })} onClick={() => remove(s)}>{t("Delete")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

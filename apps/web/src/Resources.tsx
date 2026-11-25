import "./workspace.css";
import { Breadcrumb } from "./Breadcrumb";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";
import { countResources } from "./lib/advanced";
import { Sheet } from "./Sheet";

export type Resource = { id: string; name: string; label?: string | null; active: boolean; createdAt: string };

/**
 * The owner's resources: the therapists, rooms or tables a resource field offers (decision 0031). Archived ones leave
 * the forms but keep their id, so past runs still point at them. Doop row W7.
 */
export function ResourcesPage() {
  const { t } = useLanguage();
  const [list, setList] = useState<Resource[] | null>(null);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<Resource | null>(null);
  // Only the newest list request may set the list, so a slow first load cannot hide a resource added after it.
  const latest = useRef(0);
  const load = () => {
    const n = ++latest.current;
    return api<Resource[]>("GET", "/resources").then(
      (rows) => n === latest.current && setList(rows),
      (e: Error) => setError(e.message),
    );
  };
  useEffect(() => {
    load();
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api("POST", "/resources", { name, ...(label.trim() ? { label: label.trim() } : {}) });
      setName("");
      setLabel("");
    });
  };
  const counts = list && countResources(list);

  return (
    <main className="page wk wk-resources">
      <header className="wk-head">
        <div>
          <Breadcrumb items={[{ label: t("Settings"), href: "#/settings" }, { label: t("Resources") }]} />
          <div className="wk-title-row">
            <h1>{t("Resources")}</h1>
            {counts && <span className="wk-sub">{t("{active} active, {archived} archived", counts)}</span>}
          </div>
        </div>
      </header>
      <p className="wk-lead">{t("People, rooms or tables a form can be booked for. Add a field of type resource to a form to let people choose one.")}</p>
      <form onSubmit={add} className="wk-card wk-body wk-add" aria-labelledby="add-resource">
        <h2 id="add-resource" className="wk-card-title">{t("Add a resource")}</h2>
        <div className="wk-add-row">
          <div className="wk-fields">
            <label htmlFor="resource-name">{t("Name")}</label>
            <input id="resource-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder={t("Chair 3, Table 12, Marco")} />
          </div>
          <div className="wk-fields">
            <label htmlFor="resource-label">{t("Room type or label")}</label>
            <input id="resource-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder={t("Garden room, Beach villa (optional)")} />
          </div>
          <button className="wk-button blue">{t("Add resource")}</button>
        </div>
      </form>
      <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
      {list === null ? (
        <p className="wk-sub" role="status">{t("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="wk-sub">{t("No resources yet.")}</p>
      ) : (
        <>
          <div className="wk-card">
            <table className="wk-table">
              <thead>
                <tr>
                  <th scope="col">{t("Name")}</th>
                  <th scope="col">{t("Label")}</th>
                  <th scope="col">{t("Status")}</th>
                  <th scope="col"><span className="wk-sr">{t("Actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} className={r.active ? undefined : "off"}>
                    <td className="wk-name">{r.name}</td>
                    <td>{r.label ? <span className="wk-pill">{r.label}</span> : <span className="wk-muted">-</span>}</td>
                    <td><span className={`wk-pill ${r.active ? "ok" : ""}`}>{r.active ? t("Active") : t("Archived")}</span></td>
                    <td className="wk-acts">
                      <button type="button" className="wk-button" onClick={() => setRenaming(r)}>{t("Rename")}</button>
                      <button type="button" className="wk-button" onClick={() => run(() => api("PATCH", `/resources/${r.id}`, { active: !r.active }))}>
                        {r.active ? t("Archive") : t("Restore")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="wk-muted">{t("Archived resources leave the forms but keep their record, so past bookings still point at them.")}</p>
        </>
      )}
      {renaming && (
        <RenameSheet
          resource={renaming}
          onClose={() => setRenaming(null)}
          onSave={async (next) => {
            await api("PATCH", `/resources/${renaming.id}`, next);
            setRenaming(null);
            await load();
          }}
        />
      )}
    </main>
  );
}

function RenameSheet({ resource, onSave, onClose }: { resource: Resource; onSave: (patch: { name?: string; label?: string | null }) => Promise<void>; onClose: () => void }) {
  const { t } = useLanguage();
  const [value, setValue] = useState(resource.name);
  const [label, setLabel] = useState(resource.label ?? "");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const nextName = value.trim();
    const nextLabel = label.trim() || null;
    if (!nextName) return onClose();
    if (nextName === resource.name && nextLabel === (resource.label ?? null)) return onClose();
    try {
      await onSave({ ...(nextName !== resource.name ? { name: nextName } : {}), ...(nextLabel !== (resource.label ?? null) ? { label: nextLabel } : {}) });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Sheet title={t("Rename {name}", { name: resource.name })} onClose={onClose}>
      <form onSubmit={submit} className="wk-fields">
        <p className="wk-sheet-text">{t("New name for {name}. Runs already started keep the old name.", { name: resource.name })}</p>
        <div>
          <label htmlFor="resource-new-name" className="wk-sr">{t("New name")}</label>
          <input id="resource-new-name" type="text" value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} required maxLength={100} />
        </div>
        <div>
          <label htmlFor="resource-new-label">{t("Room type or label")}</label>
          <input id="resource-new-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder={t("Garden room, Beach villa (optional)")} />
        </div>
        <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
        <div className="wk-sheet-actions inline">
          <button className="wk-button blue">{t("Rename")}</button>
          <button type="button" className="wk-button" onClick={onClose}>{t("Cancel")}</button>
        </div>
      </form>
    </Sheet>
  );
}

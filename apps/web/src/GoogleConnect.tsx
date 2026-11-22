import { useEffect, useState } from "react";
import { api } from "./api";
import { ConnectPanel, useAction } from "./ConnectPanel";
import { DriveConnection, Outcome, SheetsConnection, type Connection, type TestResult } from "./Connections";
import { useLanguage } from "./Language";

/**
 * Google Sheets and Drive cards for "Connect with Google" (decision 0060): the main action is a Google sign-in with
 * drive.file, then Daloy creates the sheet or folder, or the owner picks one in the Google Picker. The service account
 * form stays under Advanced, and is the whole card on an installation without a Google client.
 */

type PickerSetup = { accessToken: string; expiresAt: number | null; apiKey: string; appId: string };
/** Opens a chooser and resolves to the picked file id, or null when the owner closed it. */
export type PickFn = (kind: "sheet" | "folder" | "doc", setup: PickerSetup) => Promise<string | null>;

declare global {
  interface Window {
    /** The e2e suite's stand-in for the Google Picker, set before the page loads. The server re-checks any id it returns. */
    daloyPick?: PickFn;
  }
}

type DocsView = { setIncludeFolders(on: boolean): DocsView; setMimeTypes(types: string): DocsView; setSelectFolderEnabled(on: boolean): DocsView };
type Builder = { addView(v: DocsView): Builder; setOAuthToken(t: string): Builder; setDeveloperKey(k: string): Builder; setAppId(id: string): Builder; setCallback(fn: (data: { action: string; docs?: { id: string }[] }) => void): Builder; build(): { setVisible(on: boolean): void } };
type GooglePickerApi = { picker: { DocsView: new (viewId: string) => DocsView; ViewId: { SPREADSHEETS: string; FOLDERS: string; DOCUMENTS: string }; PickerBuilder: new () => Builder; Action: { PICKED: string; CANCEL: string } } };
type Gapi = { load(name: string, done: () => void): void };

let loaded: Promise<void> | null = null;
/** Google's loader, fetched only when the owner presses a Pick button. The console's CSP allows this host only then. */
function loadPicker(): Promise<void> {
  loaded ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.onload = () => (window as unknown as { gapi: Gapi }).gapi.load("picker", resolve);
    s.onerror = () => {
      loaded = null;
      reject(new Error("The Google Picker could not be loaded. Check your connection and try again."));
    };
    document.head.append(s);
  });
  return loaded;
}

/** The real Google Picker: spreadsheets only, Google Docs only, or folders only (view settings unverified against a live Picker). */
export const googlePicker: PickFn = async (kind, setup) => {
  await loadPicker();
  const { picker } = (window as unknown as { google: GooglePickerApi }).google;
  const view = kind === "sheet" ? new picker.DocsView(picker.ViewId.SPREADSHEETS) : kind === "doc" ? new picker.DocsView(picker.ViewId.DOCUMENTS) : new picker.DocsView(picker.ViewId.FOLDERS).setIncludeFolders(true).setMimeTypes("application/vnd.google-apps.folder").setSelectFolderEnabled(true);
  return new Promise((resolve) => {
    new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(setup.accessToken)
      .setDeveloperKey(setup.apiKey)
      .setAppId(setup.appId)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) resolve(data.docs?.[0]?.id ?? null);
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
};

export const defaultPick: PickFn = (kind, setup) => (window.daloyPick ?? googlePicker)(kind, setup);

type CardProps = { conn: Connection | null; configured: boolean; outcome?: string; onChange: () => Promise<unknown>; pick?: PickFn };

/** Opens the Picker with a server-minted drive.file token. Only the picked id goes back to the server. */
export async function pickWith(slug: string, kind: "sheet" | "folder" | "doc", pick: PickFn) {
  const setup = await api<PickerSetup>("POST", `/settings/connections/${slug}/picker-token`);
  return pick(kind, setup);
}

export function GoogleSheetsCard({ conn, configured, outcome, onChange, pick = defaultPick }: CardProps) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(onChange);
  const [tabs, setTabs] = useState<string[] | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const oauth = conn?.authMethod === "oauth";
  const spreadsheetId = oauth ? conn?.destination?.spreadsheetId : undefined;
  useEffect(() => {
    if (!spreadsheetId) return setTabs(null);
    api<{ tabs: string[] }>("GET", "/settings/connections/google-sheets/tabs").then((r) => setTabs(r.tabs), () => setTabs(null));
  }, [spreadsheetId]);
  if (!configured) return <SheetsConnection conn={conn} onChange={onChange} />;
  const chose = (fn: () => Promise<{ tabs: string[] } | null>) =>
    act(async () => {
      const out = await fn();
      if (out) setTabs(out.tabs);
      setTest(null);
    });
  const create = () => chose(() => api("POST", "/settings/connections/google-sheets/create"));
  const pickSheet = () =>
    chose(async () => {
      const id = await pickWith("google-sheets", "sheet", pick);
      return id ? api("POST", "/settings/connections/google-sheets/pick", { spreadsheetId: id }) : null;
    });

  return (
    <ConnectPanel
      slug="google-sheets" sectionLabel="Destination"
      name="Google Sheets"
      connectLabel="Connect with Google"
      configured
      conn={conn}
      label={oauth ? "Account" : "Service account"}
      outcome={outcome}
      onChange={onChange}
      intro={!conn && <p>{t("Google will ask you to let Daloy see your email address and use only the files you pick or that Daloy creates. Daloy cannot see your other files.")}</p>}
      actions={
        conn?.destination && (
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/google-sheets/test")))}>
            {t("Add a test row")}
          </button>
        )
      }
      after={
        <>
          <Outcome test={test} what={t("Google Sheets accepted a test row")} />
          <p role="alert" className="message error" hidden={!error}>
            {error}
          </p>
        </>
      }
      form={<SheetsConnection conn={oauth ? null : conn} onChange={onChange} embedded />}
    >
      {conn?.destination && (
        <p>
          {t("Rows go to ")}
          <strong>{conn.destination.title}</strong>
          {t(", tab ")}
          <strong>{conn.destination.tab}</strong>
          {t(". Column A holds the request reference, column B the time.")}
        </p>
      )}
      {oauth && (
        <>
          {!conn.destination && <p>{t("Choose the sheet that gets a row for every request.")}</p>}
          <div className="actions">
            <button type="button" className={conn.destination ? "" : "primary"} disabled={busy} onClick={() => void create()}>
              {t("Create a sheet for me")}
            </button>
            <button type="button" disabled={busy} onClick={() => void pickSheet()}>
              {t("Pick an existing sheet")}
            </button>
          </div>
          {conn.destination && tabs && (
            <div className="field">
              <label htmlFor="gs-tab">{t("Tab")}</label>
              <select id="gs-tab" value={conn.destination.tab} disabled={busy} onChange={(e) => void chose(() => api("POST", "/settings/connections/google-sheets/pick", { spreadsheetId, tab: e.target.value }))}>
                {tabs.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      )}
    </ConnectPanel>
  );
}

export function GoogleDriveCard({ conn, configured, outcome, onChange, pick = defaultPick }: CardProps) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(onChange);
  if (!configured) return <DriveConnection conn={conn} onChange={onChange} />;
  const oauth = conn?.authMethod === "oauth";
  const create = () => act(() => api("POST", "/settings/connections/google-drive/create"));
  const pickFolder = () =>
    act(async () => {
      const id = await pickWith("google-drive", "folder", pick);
      if (id) await api("POST", "/settings/connections/google-drive/pick", { folderId: id });
    });

  return (
    <ConnectPanel
      slug="google-drive" sectionLabel="Upload folder"
      name="Google Drive"
      connectLabel="Connect with Google"
      configured
      conn={conn}
      label={oauth ? "Account" : "Service account"}
      outcome={outcome}
      onChange={onChange}
      intro={!conn && <p>{t("Google will ask you to let Daloy see your email address and use only the files you pick or that Daloy creates. Daloy cannot see your other files.")}</p>}
      after={
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
      }
      form={<DriveConnection conn={oauth ? null : conn} onChange={onChange} embedded />}
    >
      {conn?.destination && (
        <p>
          {t("Files go to ")}
          <strong>{conn.destination.title}</strong>
          {t(". Files in a request are kept in Daloy for 7 days, so save them to Drive before then.")}
        </p>
      )}
      {oauth && (
        <>
          {!conn.destination && <p>{t("Choose the folder that gets the files people attach. It can be in My Drive.")}</p>}
          <div className="actions">
            <button type="button" className={conn.destination ? "" : "primary"} disabled={busy} onClick={() => void create()}>
              {t("Create a Daloy uploads folder")}
            </button>
            <button type="button" disabled={busy} onClick={() => void pickFolder()}>
              {t("Pick a folder")}
            </button>
          </div>
        </>
      )}
    </ConnectPanel>
  );
}

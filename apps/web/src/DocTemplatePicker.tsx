import { useState } from "react";
import { api } from "./api";
import { defaultPick, pickWith } from "./GoogleConnect";
import { useLanguage } from "./Language";

/**
 * The template of a "Make a document" step (phase I1, decision 0103). Google lets kymavo open only a file the owner picks in
 * the Google Picker, so there is no field to paste a link into. The server reads the picked file with kymavo's own grant
 * and answers with its name; only the id and the name are kept in the step.
 */
export function DocTemplatePicker({ templateId, templateName, onPick }: { templateId: string; templateName?: string; onPick: (templateId: string, templateName: string) => void }) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choose = async () => {
    setBusy(true);
    setError("");
    try {
      const id = await pickWith("google-drive", "doc", defaultPick);
      if (!id) return;
      const picked = await api<{ templateId: string; title: string }>("POST", "/settings/connections/google-drive/template", { templateId: id });
      onPick(picked.templateId, picked.title);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset>
      <legend>{t("Template")}</legend>
      <p data-testid="template-name">{templateId ? t("Template: {name}", { name: templateName || templateId }) : t("No template picked yet.")}</p>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void choose()}>
          {templateId ? t("Pick another template") : t("Pick a template")}
        </button>
      </div>
      <p className="muted hint">{t("Google lets kymavo open only the template you pick here. Write placeholders such as {example} in the document, then list each one below with the value to put in.", { example: "{{name}}" })}</p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </fieldset>
  );
}

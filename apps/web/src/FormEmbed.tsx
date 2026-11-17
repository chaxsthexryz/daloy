import { useLanguage } from "./Language";
import { useState } from "react";

export function FormEmbed({ link }: { link: string }) {
  const { t } = useLanguage();
  const [result, setResult] = useState<"copied" | "manual" | null>(null);
  const code = `<iframe src="${link}/embed" title="${t("Request form")}" style="width:100%;border:0" height="600" loading="lazy"></iframe>\n<a href="${link}">${t("Open the form")}</a>`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setResult("copied");
    } catch {
      setResult("manual");
    }
  }

  return (
    <>
      <button type="button" onClick={() => void copy()}>{t("Copy embed code")}</button>
      {result === "copied" && <span role="status">{t("Embed code copied.")}</span>}
      {result === "manual" && (
        <label>{t("Copy this HTML into your website")}<textarea readOnly value={code} onFocus={(event) => event.target.select()} />
        </label>
      )}
    </>
  );
}

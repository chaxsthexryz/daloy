import "./brand-preview.css";
import { ACCENT, inkFor } from "@daloy/engine";
import { useState } from "react";
import { useLanguage } from "./Language";
import { initials } from "./lib/onboarding";

type PreviewTab = "form" | "pay";

const DEFAULT_ACCENT = "#1a73e8";

export function CustomerBrandPreview({
  businessName,
  logoUrl,
  accent,
  defaultTab = "form",
  compact = false,
}: {
  businessName: string;
  logoUrl?: string | null;
  accent?: string | null;
  defaultTab?: PreviewTab;
  compact?: boolean;
}) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<PreviewTab>(defaultTab);
  const resolvedName = businessName.trim() || t("Your business name");
  const safeAccent = accent && ACCENT.test(accent) ? accent : DEFAULT_ACCENT;
  const buttonInk = inkFor(safeAccent);

  return (
    <section className={compact ? "brand-preview brand-preview-compact" : "brand-preview"} aria-label={t("Customer preview")}>
      <div className="brand-preview-head">
        <h3 className="brand-preview-title">{t("How your customers see you")}</h3>
        <div className="brand-preview-tabs" role="tablist" aria-label={t("Customer preview")}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "form"}
            onClick={() => setTab("form")}
          >
            {t("Public form")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pay"}
            onClick={() => setTab("pay")}
          >
            {t("Payment page")}
          </button>
        </div>
      </div>

      <div className="brand-preview-card" role="tabpanel">
        <div className="brand-preview-identity">
          {logoUrl ? (
            <img src={logoUrl} alt="" />
          ) : (
            <span className="brand-preview-mark" aria-hidden="true">{initials(businessName)}</span>
          )}
          <strong>{resolvedName}</strong>
        </div>

        {tab === "form" ? (
          <div className="brand-preview-fields">
            <div>
              <span className="brand-preview-field-label">{t("Your name")}</span>
              <div className="example-field">Ana Reyes</div>
            </div>
            <div>
              <span className="brand-preview-field-label">{t("Details")}</span>
              <div className="example-field">{t("Weekend room inquiry or order note")}</div>
            </div>
            <div>
              <span className="preview-send" style={{ background: safeAccent, color: buttonInk }}>{t("Send request")}</span>
            </div>
          </div>
        ) : (
          <div>
            <div className="brand-preview-pay-row">
              <div>
                <span className="brand-preview-field-label">{t("Deposit due")}</span>
                <span className="brand-preview-amount">PHP 1,500.00</span>
              </div>
              <span className="brand-preview-badge">{t("GCash / QR Ph")}</span>
            </div>
            <span className="brand-preview-field-label">{t("Your email")}</span>
            <div className="example-field">ana@example.com</div>
            <div>
              <span className="preview-send" style={{ background: safeAccent, color: buttonInk }}>{t("Upload receipt")}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

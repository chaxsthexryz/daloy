import { Text, useLanguage } from "./Language";
import { useEffect, useState } from "react";
import { api } from "./api";

type Mail = { sender: { status: string } | null; installationAllowed: boolean; installationLocal: boolean };

/** Warns the owner, where they turn an automation on, that email may not reach anyone: no Gmail sender is active and the installation's server is a local catcher or not approved for them. */
export function MailNotice() {
  const { t } = useLanguage();
  const [mail, setMail] = useState<Mail | null>(null);
  useEffect(() => {
    // The notice is a hint: when settings cannot be read it stays hidden.
    api<Mail>("GET", "/settings/email").then(setMail, () => undefined);
  }, []);
  if (!mail || mail.sender?.status === "active") return null;
  const text = mail.installationLocal ? "Emails go to the local test inbox. Nobody receives them." : !mail.installationAllowed ? "This installation's mail server does not send for your account." : null;
  if (!text) return null;
  return (
    <p className="notice">
      {t(text)} <a href="#/apps"><Text>Apps</Text></a>
    </p>
  );
}

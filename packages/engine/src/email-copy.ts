import type { Language } from "./language";

const EMAIL_COPY = {
  en: {
    testSubject: "Daloy test email",
    testBody: "This is a test email from Daloy. Mail from your automations will look like this.",
    verify: "To start sending your automations' email from this address, open this link while you are signed in to Daloy:",
    verifyExpiry: "The link works once and expires in 30 minutes.",
    outlookSubject: "Test email from Daloy",
    outlookBody: "Daloy can send from this mailbox. Approved purchase requests will go out from here.",
  },
  tl: {
    testSubject: "Test email ng Daloy",
    testBody: "Test email ito ng Daloy. Ganito ang magiging email mula sa iyong mga automation.",
    verify: "Para makapagpadala ng email ang iyong mga automation mula sa address na ito, buksan ang link habang naka-sign in sa Daloy:",
    verifyExpiry: "Isang beses lang magagamit ang link at mag-e-expire ito sa loob ng 30 minuto.",
    outlookSubject: "Test email mula sa Daloy",
    outlookBody: "Makakapagpadala ang Daloy mula sa mailbox na ito. Dito ipapadala ang mga na-approve na purchase request.",
  },
} as const;

export const builtInEmailCopy = (language: Language = "en") => EMAIL_COPY[language];

/** Only the built-in wrapper changes language. The saved message and subject stay as authored. */
export function approvalEmailBody(message: string, link: string, expiresAt: string, approver?: string, language: Language = "en") {
  if (language === "tl") {
    const who = approver ? `Mag-sign in bilang ${approver} para sumagot. ` : "";
    return `${message}\n\nI-approve o tanggihan dito:\n${link}\n\n${who}Isang beses lang magagamit ang link at mag-e-expire ito sa ${expiresAt}.`;
  }
  const who = approver ? `To answer, sign in as ${approver}. ` : "";
  return `${message}\n\nApprove or reject here:\n${link}\n\n${who}The link works once and expires at ${expiresAt}.`;
}

/** The owner's one email per day when a scheduled automation misses its run (N17). The link is left out when the installation has no public URL. */
export function missedScheduleEmail(name: string, link: string | undefined, language: Language = "en") {
  if (language === "tl") {
    return {
      subject: `Hindi tumakbo sa iskedyul ang "${name}"`,
      text: `Hindi tumakbo sa itinakdang oras ang automation na "${name}". Maaaring huminto ang worker ng Daloy o nawala ang job.\n\nHindi ito mag-e-email ulit sa loob ng isang araw, at mawawala ang babala kapag tumakbo na ito ayon sa iskedyul.${link ? `\n\nBuksan ito dito:\n${link}` : ""}`,
    };
  }
  return {
    subject: `"${name}" missed its schedule`,
    text: `The automation "${name}" did not run when it was due. The Daloy worker may have been down, or the scheduled job was lost.\n\nYou will not get another email about it for a day, and the warning clears after its next scheduled run.${link ? `\n\nOpen it here:\n${link}` : ""}`,
  };
}

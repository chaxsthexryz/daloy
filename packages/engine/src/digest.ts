import type { Language } from "./language";

export type DigestCounts = { receipts: number; unpaid: number; failedReplies: number; conversationsWaiting?: number };

const COPY = {
  en: {
    subject: (n: number) => `${n} ${n === 1 ? "thing needs" : "things need"} you in kymavo this morning`,
    intro: "Good morning. Here is what needs you today:",
    receipts: (n: number) => `${n} ${n === 1 ? "receipt" : "receipts"} to review`,
    unpaid: (n: number) => `${n} unpaid ${n === 1 ? "order" : "orders"}`,
    failed: (n: number) => `${n} failed ${n === 1 ? "reply" : "replies"}`,
    conversations: (n: number) => `${n} ${n === 1 ? "conversation" : "conversations"} waiting for staff`,
    off: "You get this email only on mornings when something needs you. Turn it off in kymavo under Receipts.",
  },
  tl: {
    subject: (n: number) => `${n} ang kailangan mong asikasuhin sa kymavo ngayong umaga`,
    intro: "Magandang umaga. Ito ang kailangan mong asikasuhin ngayon:",
    receipts: (n: number) => `${n} resibong susuriin`,
    unpaid: (n: number) => `${n} hindi pa bayad na order`,
    failed: (n: number) => `${n} sagot na hindi naipadala`,
    conversations: (n: number) => `${n} ${n === 1 ? "usapang naghihintay" : "usapang naghihintay"} ng staff`,
    off: "Natatanggap mo lang ito sa mga umagang may kailangan kang asikasuhin. I-off ito sa kymavo, sa Receipts.",
  },
} as const;

/**
 * The owner's morning digest (R5, decision 0092): a count and a link for each thing that needs a person. It carries
 * counts only, never a customer's name, number or receipt, because it is an email. Null when there is nothing to do,
 * so no message is sent. The links are left out when the installation has no public URL.
 */
export function digestEmail(counts: DigestCounts, base: string | undefined, language: Language = "en") {
  const c = COPY[language];
  const waiting = counts.conversationsWaiting ?? 0;
  const total = counts.receipts + counts.unpaid + counts.failedReplies + waiting;
  if (total === 0) return null;
  const line = (text: string, path: string) => `- ${text}${base ? `: ${base}/#/${path}` : ""}`;
  const lines = [
    counts.receipts > 0 ? line(c.receipts(counts.receipts), "receipts") : "",
    counts.unpaid > 0 ? line(c.unpaid(counts.unpaid), "activity") : "",
    counts.failedReplies > 0 ? line(c.failed(counts.failedReplies), "activity") : "",
    waiting > 0 ? line(c.conversations(waiting), "conversations") : "",
  ].filter(Boolean);
  return { subject: c.subject(total), text: `${c.intro}\n\n${lines.join("\n")}\n\n${c.off}` };
}

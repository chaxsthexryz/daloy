export type ConversationSummary = {
  id: string;
  channel: "messenger" | "instagram" | "email" | "telegram";
  externalId: string;
  status: "bot" | "staff" | "closed";
  paused: boolean;
  windowOpen: boolean;
  version: number;
  fields: Record<string, string>;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  staffUntil: string | null;
  openDueId: string | null;
  createdAt: string;
  latestMessage: { direction: string; text: string; createdAt: string } | null;
};

export type StaffAlertStatus = {
  staffAlertPsid: string | null;
  messengerConnected: boolean;
  staffWindowOpen: boolean;
  staffWindowExpiresAt: string | null;
  telegramReady: boolean;
  emailFallback: string | null;
  activeChannel: "messenger" | "telegram" | "email";
};

export function guestDisplayName(c: Pick<ConversationSummary, "fields" | "channel" | "externalId">): string {
  const named = c.fields.name?.trim();
  if (named) return named;
  if (c.channel === "email") return c.externalId;
  return `${channelLabel(c.channel)} guest`;
}

export function channelLabel(channel: ConversationSummary["channel"]): string {
  if (channel === "messenger") return "Messenger";
  if (channel === "instagram") return "Instagram";
  if (channel === "telegram") return "Telegram";
  return "Email";
}

/** Computes positive integer nights between two YYYY-MM-DD strings when valid, defaulting to 1. */
export function nightsBetween(checkIn?: string, checkOut?: string): number {
  if (!checkIn || !checkOut) return 1;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return 1;
  const diff = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
  return diff >= 1 && diff <= 30 ? diff : 1;
}

export function alertChannelSummary(s: StaffAlertStatus, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (s.activeChannel === "messenger") return t("Staff alerts go to Messenger (24-hour window open).");
  if (s.activeChannel === "telegram") {
    return s.staffAlertPsid && s.messengerConnected
      ? t("Messenger staff window closed. Alerts fall back to Telegram.")
      : t("Staff alerts go to Telegram.");
  }
  return s.staffAlertPsid && s.messengerConnected
    ? t("Messenger staff window closed. Alerts fall back to {email}.", { email: s.emailFallback ?? "email" })
    : t("Staff alerts go to {email}.", { email: s.emailFallback ?? "email" });
}

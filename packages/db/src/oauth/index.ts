import type { Provider } from "../schema";
import type { OAuthProvider } from "./core";
import { airtable } from "./airtable";
import { gmail } from "./gmail";
import { googleCalendar, googleDrive, googleSheets } from "./google";
import { notion } from "./notion";
import { outlook } from "./outlook";
import { slack } from "./slack";
import { trello } from "./trello";

export * from "./core";
export * from "./outlook";
export * from "./google";
export * from "./gmail";
export * from "./slack";
export * from "./airtable";
export * from "./notion";
export * from "./trello";
export * from "./records";

/** Every provider on the shared OAuth core. A provider whose client is not configured stays on its paste form. */
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [outlook, googleSheets, googleDrive, gmail, googleCalendar, slack, airtable, notion, trello];
export const oauthProvider = (provider: Provider) => OAUTH_PROVIDERS.find((d) => d.provider === provider);

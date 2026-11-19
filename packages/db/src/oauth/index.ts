import type { Provider } from "../schema";
import type { OAuthProvider } from "./core";
import { googleCalendar, googleDrive, googleSheets } from "./google";
import { outlook } from "./outlook";

export * from "./core";
export * from "./outlook";
export * from "./google";

/** Every provider on the shared OAuth core. A provider whose client is not configured stays on its paste form. */
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [outlook, googleSheets, googleDrive, googleCalendar];
export const oauthProvider = (provider: Provider) => OAUTH_PROVIDERS.find((d) => d.provider === provider);

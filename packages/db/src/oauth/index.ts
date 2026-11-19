import type { Provider } from "../schema";
import type { OAuthProvider } from "./core";
import { outlook } from "./outlook";
import { slack } from "./slack";

export * from "./core";
export * from "./outlook";
export * from "./slack";

/** Every provider on the shared OAuth core. A provider whose client is not configured stays on its paste form. */
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [outlook, slack];
export const oauthProvider = (provider: Provider) => OAUTH_PROVIDERS.find((d) => d.provider === provider);

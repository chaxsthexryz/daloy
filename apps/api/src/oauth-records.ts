import { BadRequestException, NotFoundException } from "@nestjs/common";
import { connectionCredential, markConnectionFailed, PROVIDER_NAMES, ProviderError, withRecordAuth, type Db, type Provider } from "@daloy/db";
import type { ApiConfig, SessionUser } from "./http";

/**
 * What the Airtable, Notion and Trello pickers share (decision 0062). A picker needs the OAuth sign-in: a pasted
 * token has its own form. Every list is read with the connection's own token, and the saved target must be in the
 * lists read again at save time, so a forged id gains nothing.
 */
export type Config = Required<ApiConfig>;

/** The workspace's connection, which must be an OAuth grant. */
export async function oauthConnection(db: Db, config: Config, user: SessionUser, provider: Provider) {
  const conn = await connectionCredential(db, config.secretsKey, user.workspaceId, provider);
  if (!conn) throw new NotFoundException(`${PROVIDER_NAMES[provider]} is not connected.`);
  if (conn.authMethod !== "oauth") throw new BadRequestException(`Use Connect ${PROVIDER_NAMES[provider]} to pick from a list. A pasted token has no lists.`);
  return conn;
}

/** Runs fn with the connection's access token. A provider's answer becomes a 400 the page can show; a rejected grant also marks the connection failed. */
export async function pickerCall<T>(db: Db, config: Config, user: SessionUser, provider: Provider, conn: Awaited<ReturnType<typeof oauthConnection>>, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await withRecordAuth(db, config.secretsKey, config.providers, user.workspaceId, config.oauthProviders.find((d) => d.provider === provider), conn, fn);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === "auth") await markConnectionFailed(db, user.workspaceId, provider, err.message, conn.revision);
    throw new BadRequestException(err.message);
  }
}

export const notInList = (what: string) => new BadRequestException(`That ${what} is not in the list. Refresh the list and pick again.`);

import { sql } from "drizzle-orm";
import type { Db } from "../index";

/**
 * Plan R14: the workspace's OAuth grants whose provider account is also connected somewhere else in Daloy, in another
 * workspace or (for Google) in another Google app here. A provider may keep one grant per account and client
 * (unverified), so disconnecting one can end the other. Returns app keys: connections providers, and "gmail" for the
 * Gmail sign-in. Every Google app and Gmail share one Google account id, so they are compared as one family.
 * Only the keys of this workspace come back; nothing about the other place is returned.
 */
export async function sharedGrants(db: Db, workspaceId: string): Promise<string[]> {
  const { rows } = await db.execute<{ app: string }>(sql`
    with grants as (
      select user_id, provider as app, external_id, case when provider like 'google\_%' then 'google' else provider end as family
        from connections where auth_method = 'oauth' and external_id is not null
      union all
      select user_id, 'gmail', external_id, 'google' from mail_senders where auth_method = 'oauth' and external_id is not null
    )
    select distinct mine.app from grants mine
      join grants other on other.family = mine.family and other.external_id = mine.external_id and not (other.user_id = mine.user_id and other.app = mine.app)
      where mine.user_id = ${workspaceId}
      order by mine.app`);
  return rows.map((r) => r.app);
}

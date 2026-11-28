import type { Pool } from "pg";

/**
 * Marks a platform admin as enrolled in two-factor sign-in and passes their live sessions, for tests of the admin API
 * that are not about two-factor itself (decision 0158). The stored secret is a placeholder no code can match.
 */
export async function passSecondFactor(pool: Pool, userId: string) {
  await pool.query("insert into admin_totp (user_id, ciphertext, iv, auth_tag, confirmed_at) values ($1, 'test', 'test', 'test', now()) on conflict do nothing", [userId]);
  await pool.query("update sessions set second_factor_at = now() where user_id = $1", [userId]);
}

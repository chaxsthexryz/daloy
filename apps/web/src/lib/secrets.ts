/** Same rule as apps/api/src/secrets.ts. */
export const validSecretName = (name: string) => /^[a-z][a-z0-9_]{0,99}$/.test(name);

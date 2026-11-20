export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200;
export type PasswordIssue = "current-required" | "too-short" | "too-long";

/** The limit the API applies to any new password (12 to 200), for registration, reset and invite pages. */
export function checkNewPassword(next: string): Exclude<PasswordIssue, "current-required"> | null {
  if (next.length < MIN_PASSWORD) return "too-short";
  if (next.length > MAX_PASSWORD) return "too-long";
  return null;
}

/** The same limits the API applies (min 12, max 200), checked first so the person sees the reason beside the field. */
export function checkPasswordChange(current: string, next: string): PasswordIssue | null {
  if (current.length === 0) return "current-required";
  return checkNewPassword(next);
}

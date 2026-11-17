/** Stored once on the workspace owner's account. The first language is the default for existing installations. */
export const LANGUAGES = ["en", "tl"] as const;
export type Language = (typeof LANGUAGES)[number];

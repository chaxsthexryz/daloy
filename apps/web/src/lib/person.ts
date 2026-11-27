/** What to call a person on screen: the name they set, else their email (decision 0154). */
export const personName = (p: { displayName?: string | null; email: string }) => p.displayName || p.email;

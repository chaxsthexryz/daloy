type Guided = { id: string; createdAt: string; live?: boolean; setup?: unknown };

/** A guided workflow not yet turned on: the rule behind "Draft: continue setup". */
export const isDraft = (w: Guided) => !!w.setup && !w.live;

/** The newest unfinished draft of one template, so Set up for my office reopens it instead of creating another. */
export const newestDraft = <W extends Guided>(list: W[], template: string): W | undefined =>
  list.filter((w) => isDraft(w) && (w.setup as { template?: string }).template === template).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

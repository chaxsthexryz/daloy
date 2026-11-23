import * as z from "zod";

// Menu buttons (decision 0118). A tap comes back from Meta as the button's payload, which is one of these fixed ids, so
// a workflow branches on a known word and a forged payload can never name anything else.
export const MENU_CHOICES = ["rooms", "rates", "location", "activities", "book", "staff"] as const;
export type MenuChoice = (typeof MENU_CHOICES)[number];
export const isMenuChoice = (v: unknown): v is MenuChoice => typeof v === "string" && (MENU_CHOICES as readonly string[]).includes(v);

// Meta's quick replies: at most 13, each title at most 20 characters. Two titles may share a choice (English and Tagalog).
export const menuSchema = z
  .array(z.object({ title: z.string().trim().min(1).max(20), choice: z.enum(MENU_CHOICES) }))
  .min(1)
  .max(13, "a menu has at most 13 buttons");
export type Menu = z.infer<typeof menuSchema>;

// Takes a stored definition as it comes from the database; it was validated when it was saved.
type MenuStep = { type: string; config: unknown };
const stepsOf = (def: unknown): MenuStep[] => (def as { steps?: MenuStep[] } | null)?.steps ?? [];
const menuOf = (s: MenuStep): Menu | undefined => {
  const c = s.config as { quickReplies?: Menu; menu?: Menu };
  return s.type === "meta_reply" ? c.quickReplies : s.type === "email" || s.type === "outlook" ? c.menu : undefined;
};

/** Every choice some menu of this workflow offers: a tap or a number for anything else is dropped. */
export function workflowChoices(def: unknown): MenuChoice[] {
  return [...new Set(stepsOf(def).flatMap((s) => menuOf(s)?.map((m) => m.choice) ?? []))];
}

/** The choices of the workflow's email menu, in the order its numbers go. Save checks that all its email menus agree. */
export function emailMenu(def: unknown): MenuChoice[] {
  const s = stepsOf(def).find((x) => (x.type === "email" || x.type === "outlook") && menuOf(x));
  return s ? menuOf(s)!.map((m) => m.choice) : [];
}

export const numberedMenu = (menu: Menu) => menu.map((m, i) => `${i + 1}. ${m.title}`).join("\n");

/** A reply whose first non-empty line is only a number from the menu, such as "2" or "2.", picks that choice. */
export function numberedChoice(text: string, choices: readonly MenuChoice[]): MenuChoice | undefined {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== "");
  const m = first ? /^\s*(\d{1,2})\.?\s*$/.exec(first) : null;
  return m ? choices[Number(m[1]) - 1] : undefined;
}

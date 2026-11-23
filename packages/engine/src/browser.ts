import * as z from "zod";

/**
 * Addresses no outside call may reach: private, loopback, link-local (cloud metadata), shared, reserved and multicast.
 * The worker's HTTP guard (apps/worker/src/steps/ssrf.ts) and the browser service's proxy (apps/browser) both read this
 * one list, so the two can never drift apart.
 */
export const BLOCKED_RANGES: [network: string, prefix: number, family: "ipv4" | "ipv6"][] = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
];

/** The browser step (phase B2, decision 0108): open a page, run up to 20 actions, keep what they read. */
export const BROWSER_MAX_ACTIONS = 20;
export const BROWSER_MAX_SCREENSHOTS = 5;
/** Output keys the step writes itself, so an extract cannot use them as names. */
const RESERVED = new Set(["url", "screenshots", "mocked", "wouldDo"]);

const selector = z.string().trim().min(1).max(500);
// A literal address must be http(s). One with a placeholder is checked again by the service after it is filled in.
const address = z
  .string()
  .min(1)
  .max(2000)
  .refine((v) => v.includes("{{") || /^https?:\/\//i.test(v.trim()), "use an http:// or https:// address");
const name = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a name uses a-z, 0-9 and _, starting with a letter");

export const browserActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("goto"), url: address }),
  z.strictObject({ action: z.literal("click"), selector: selector.optional(), text: z.string().trim().min(1).max(200).optional() }),
  z.strictObject({ action: z.literal("fill"), selector, value: z.string().max(2000) }),
  z.strictObject({ action: z.literal("wait"), selector }),
  z.strictObject({ action: z.literal("extract"), selector, name }),
  z.strictObject({ action: z.literal("screenshot") }),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

/** The action list as the worker sends it, templates filled in. The service parses it again with this same schema. */
export const browserActionsSchema = z
  .array(browserActionSchema)
  .max(BROWSER_MAX_ACTIONS, `at most ${BROWSER_MAX_ACTIONS} actions`)
  .superRefine((actions, ctx) => {
    const names = new Set<string>();
    actions.forEach((a, i) => {
      if (a.action === "click" && (a.selector === undefined) === (a.text === undefined)) ctx.addIssue({ code: "custom", path: [i], message: "a click needs a selector or a visible text, not both" });
      if (a.action === "extract") {
        if (RESERVED.has(a.name)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `"${a.name}" is used by the step itself, pick another name` });
        if (names.has(a.name)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `"${a.name}" is read twice` });
        names.add(a.name);
      }
    });
    if (actions.filter((a) => a.action === "screenshot").length > BROWSER_MAX_SCREENSHOTS) ctx.addIssue({ code: "custom", message: `at most ${BROWSER_MAX_SCREENSHOTS} screenshots` });
  });

export const browserConfigSchema = z.object({
  url: address.describe("The page to open first, such as https://supplier.example.com/price/{{trigger.sku}}."),
  actions: browserActionsSchema.default([]).describe("What to do on the page, in order."),
});

const PASSWORD_AC = /(^|\s)(current-password|new-password)(\s|$)/;
const CARD_NAME = /card.?num|cc.?num|cvv|cvc|csc|security.?code|expiry|exp.?date/i;

/**
 * Why a field may not be filled, or null when it may. The step never types a password, a one-time code or a card
 * detail (decision 0108). The service reads these attributes from the element right before it types.
 */
export function refusedFillField(el: { type: string; autocomplete: string; name?: string; id?: string }): string | null {
  const type = el.type.toLowerCase();
  const ac = el.autocomplete.toLowerCase();
  if (type === "password" || PASSWORD_AC.test(ac)) return "This is a password field. The browser step never types a password.";
  if (/(^|\s)one-time-code(\s|$)/.test(ac)) return "This is a one-time code field. The browser step never types a login code.";
  if (/(^|\s)cc-/.test(ac) || CARD_NAME.test(el.name ?? "") || CARD_NAME.test(el.id ?? "")) return "This is a payment card field. The browser step never types card details.";
  return null;
}

/** Refuses a value that is a payment card number (13 to 19 digits that pass the Luhn check), whatever the field. */
export function refusedFillValue(value: string): string | null {
  const v = value.trim();
  if (!/^[\d -]+$/.test(v)) return null;
  const digits = v.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return null;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0 ? "This value looks like a payment card number. The browser step never types card details." : null;
}

/** A mocked test run's output: what each action would do, in plain words. Typed values are counted, never shown. */
export function wouldDo(url: string, actions: BrowserAction[]): string[] {
  return [
    `Would open ${url}`,
    ...actions.map((a) => {
      switch (a.action) {
        case "goto":
          return `Would open ${a.url}`;
        case "click":
          return a.selector === undefined ? `Would click the element with the text "${a.text}"` : `Would click ${a.selector}`;
        case "fill":
          return `Would type ${a.value.length} characters into ${a.selector}`;
        case "wait":
          return `Would wait for ${a.selector}`;
        case "extract":
          return `Would read ${a.selector} into ${a.name}`;
        case "screenshot":
          return "Would take a screenshot";
      }
    }),
  ];
}

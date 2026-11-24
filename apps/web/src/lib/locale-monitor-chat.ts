/** Tagalog copy for G4 web page / RSS monitor and team chat triggers (decision 0133). */
export const monitorChatTranslations: Record<string, string> = {
  // Monitor trigger settings
  "Monitor kind": "Uri ng binabantayan",
  "Public web page": "Pampublikong web page",
  "RSS or Atom feed": "RSS o Atom feed",
  "Web address to watch": "Web address na babantayan",
  "Leave empty to watch the whole page text, or enter a selector like .price to watch one value.":
    "Iwang bakante para bantayan ang buong text ng page, o maglagay ng selector gaya ng .price para sa isang value.",
  "kymavo will check the page again soon. Last answer: {problem}":
    "Titingnan ulit ng kymavo ang page maya-maya. Huling sagot: {problem}",
  "Watching this address. kymavo checks every few minutes.":
    "Binabantayan ang address na ito. Tumitingin ang kymavo kada ilang minuto.",
  "kymavo checks this public address every few minutes once turned on. The first check only records what is there now.":
    "Titingnan ng kymavo ang pampublikong address na ito kada ilang minuto kapag naka-on na. Ang unang check ay nagtatala lang ng kasalukuyang laman.",
  "Each check counts against your daily web requests ({used} of {limit} used today).":
    "Bawat check ay bawas sa arawang web requests mo ({used} sa {limit} ang nagamit ngayon).",
  // Team chat trigger settings in Editor
  "Channel ID": "Channel ID",
  "Keyword filter": "Filter ng salita",
  "Ignore messages from bots": "Huwag pansinin ang mga mensahe mula sa bot",
  "Slack verifies each request with X-Slack-Signature using this secret.":
    "Bineberipika ng Slack ang bawat request gamit ang X-Slack-Signature at ang secret na ito.",
  "Teams verifies Outgoing Webhooks with Authorization HMAC, or Teams Workflows with X-Daloy-Signature.":
    "Bineberipika ng Teams ang Outgoing Webhooks gamit ang Authorization HMAC, o ng Teams Workflows gamit ang X-Daloy-Signature.",
  "Discord Application Public Key": "Discord Application Public Key",
  "(64 hex characters, for slash commands)": "(64 hex character, para sa slash commands)",
  "Or signing secret name": "O pangalan ng signing secret",
  "(for signed relay calls)": "(para sa naka-sign na relay calls)",
  "Slash command filter": "Filter ng slash command",
  "Enter a Discord Application Public Key for slash command interactions, or a signing secret name for signed webhook calls.":
    "Maglagay ng Discord Application Public Key para sa slash command interactions, o pangalan ng signing secret para sa naka-sign na webhook calls.",
  // Build with AI plain-language summary
  "When a monitored web page or feed changes": "Kapag nagbago ang binabantayang web page o feed",
  "When a Slack message arrives": "Kapag may dumating na mensahe sa Slack",
  "When a Teams message arrives": "Kapag may dumating na mensahe sa Teams",
  "When a Discord command or message arrives": "Kapag may dumating na command o mensahe sa Discord",
};

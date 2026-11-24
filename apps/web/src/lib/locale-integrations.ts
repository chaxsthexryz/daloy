/** Taglish for the Discord and Google Docs steps (phase I1). Literal console copy only. */
export const integrationTranslations: Record<string, string> = {
  // Apps card and connection
  "Post a message to a Discord channel with a webhook link.": "Mag-post ng mensahe sa Discord channel gamit ang webhook link.",
  "Make a webhook in Discord": "Gumawa ng webhook sa Discord",
  "In Discord, open the channel's settings, choose Integrations, then Webhooks, and make a new webhook. You need the Manage Webhooks permission on that channel. Menu names may differ.": "Sa Discord, buksan ang settings ng channel, piliin ang Integrations, saka ang Webhooks, at gumawa ng bagong webhook. Kailangan mo ang Manage Webhooks permission sa channel na iyon. Maaaring magkaiba ang mga pangalan ng menu.",
  "How to make a webhook": "Paano gumawa ng webhook",
  "Copy the webhook link": "Kopyahin ang webhook link",
  "Choose Copy Webhook URL. Anyone who has this link can post to the channel, so do not share it. kymavo keeps it encrypted and never shows it again.": "Piliin ang Copy Webhook URL. Sinumang may hawak ng link na ito ay puwedeng mag-post sa channel, kaya huwag itong ibahagi. Naka-encrypt ito sa kymavo at hindi na ipapakita ulit.",
  "Webhook link": "Webhook link",
  "Discord channel name, to show in kymavo": "Pangalan ng Discord channel na ipapakita sa kymavo",
  "orders": "mga-order",
  "Connect Discord": "Ikonekta ang Discord",
  "Messages go to this one channel, and everyone in it can read them. Keep names, emails and other private details out of the text. kymavo blocks @everyone and role pings.": "Sa iisang channel na ito napupunta ang mga mensahe, at mababasa ito ng lahat ng nasa channel. Huwag isama ang mga pangalan, email at iba pang pribadong detalye sa text. Hinaharang ng kymavo ang @everyone at mga role ping.",
  "Disconnect Discord? Automations stop posting there until you reconnect.": "I-disconnect ang Discord? Titigil sa pag-post doon ang mga automation hanggang mag-reconnect ka.",
  "Discord accepted the test message. Check that it is in ": "Tinanggap ng Discord ang test message. Tingnan kung nasa ",
  "Discord message": "Mensahe sa Discord",
  // Make a document step
  "Template": "Template",
  "Template: {name}": "Template: {name}",
  "No template picked yet.": "Wala pang napiling template.",
  "Pick a template": "Pumili ng template",
  "Pick another template": "Pumili ng ibang template",
  "Google lets kymavo open only the template you pick here. Write placeholders such as {example} in the document, then list each one below with the value to put in.": "Ang template lang na pipiliin mo rito ang mabubuksan ng kymavo, ayon sa Google. Maglagay ng mga placeholder gaya ng {example} sa dokumento, saka ilista ang bawat isa sa ibaba kasama ang value na ilalagay.",
  "The new document's name, such as Invoice {{trigger.reference}}.": "Pangalan ng bagong dokumento, gaya ng Invoice {{trigger.reference}}.",
  "Placeholders to fill. Each name is a {{name}} in the template; its value is the text to put there.": "Mga placeholder na pupunan. Ang bawat pangalan ay isang {{name}} sa template; ang value nito ang text na ilalagay doon.",
  "Document for {{trigger.name}}": "Dokumento para kay {{trigger.name}}",
  "Google Docs document": "Dokumento sa Google Docs",
  // Plain-language summaries
  "Post to your Discord channel": "Mag-post sa Discord channel mo",
  "Make a Google Docs document from your template": "Gumawa ng dokumento sa Google Docs mula sa template mo",
};

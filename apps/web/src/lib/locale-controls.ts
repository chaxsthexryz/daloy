/** Pause, cancel a run, the send cap and the webhook timestamp (N11b). */
export const controlsTranslations: Record<string, string> = {
  "Paused": "Naka-pause",
  "Pause": "I-pause",
  "Resume": "Ituloy",
  "Paused: it starts no new runs from a form, link, email or schedule. Runs already started finish.": "Naka-pause: hindi ito magsisimula ng bagong run mula sa form, link, email o iskedyul. Matatapos ang mga run na nagsimula na.",
  "Cancel run": "Kanselahin ang run",
  "Cancel this run? It stops before its next step and cannot be started again.": "Kanselahin ang run na ito? Titigil ito bago ang susunod na hakbang at hindi na ito masisimulan ulit.",
  "Cancel stops this run before its next step. Anything already sent stays sent.": "Ititigil nito ang run bago ang susunod na hakbang. Ang naipadala na ay nananatiling naipadala.",
  "Nothing was sent. Choose what to do.": "Walang naipadala. Piliin kung ano ang gagawin.",
  "Require the timestamp (recommended)": "Hingin ang timestamp (inirerekomenda)",
  "The caller sends X-Daloy-Timestamp (unix seconds) and signs the timestamp, a dot and the body: X-Daloy-Signature: sha256=HMAC-SHA256 of \"timestamp.body\". Calls more than 5 minutes off are refused, so a captured call cannot be replayed later.": "Nagpapadala ang caller ng X-Daloy-Timestamp (unix seconds) at nagsa-sign ng timestamp, tuldok at body: X-Daloy-Signature: sha256=HMAC-SHA256 ng \"timestamp.body\". Tinatanggihan ang mga tawag na lampas 5 minuto ang layo, kaya hindi na magagamit ulit ang nakuhang tawag.",
  "A call signed without a timestamp was accepted on {date}. Update the caller, then turn this on.": "May tawag na walang timestamp sa signature na tinanggap noong {date}. Baguhin ang caller, saka i-on ito.",
};

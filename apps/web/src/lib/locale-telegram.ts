// Tagalog for the Telegram message trigger and the Receive messages switch in Apps (T9, decision 0117). English is the key.
export const telegramTranslations: Record<string, string> = {
  "Messages from": "Mga mensahe mula sa",
  "My chat only (the chat chosen in Apps)": "Chat ko lang (ang chat na pinili sa Apps)",
  "Anyone who messages the bot": "Kahit sinong mag-message sa bot",
  "Only run when the message has a photo or PDF": "Tumakbo lang kapag may photo o PDF ang mensahe",
  "A photo or PDF up to 5 MB becomes the file field, which an AI step can read. To reply to the sender, set a Telegram step's chat id to the trigger's chatId.":
    "Ang photo o PDF na hanggang 5 MB ay nagiging file field, na mababasa ng AI step. Para sagutin ang nagpadala, ilagay ang chatId ng trigger bilang chat id ng Telegram step.",
  "Connect Telegram in Apps and turn on Receive messages": "I-connect ang Telegram sa Apps at i-on ang Receive messages",
  "Telegram photo or PDF": "Photo o PDF mula sa Telegram",
  "Receive messages: start automations when someone messages this bot": "Receive messages: magsimula ang mga automation kapag may nag-message sa bot na ito",
  "Telegram then sends the bot's messages to kymavo, so the chat list above stays empty until you turn this off. Needs kymavo on a public https address.":
    "Ipapadala na ng Telegram sa kymavo ang mga mensahe ng bot, kaya walang laman ang listahan ng chat sa itaas hangga't hindi mo ito ino-off. Kailangang nasa public https address ang kymavo.",
  "Receiving messages: automations with a Telegram message trigger start when someone messages this bot.":
    "Tumatanggap ng mensahe: nagsisimula ang mga automation na may Telegram message trigger kapag may nag-message sa bot na ito.",
  "Telegram did not accept kymavo's address, so messages to the bot do not arrive. Telegram only sends to a public https address. Save again once kymavo runs on one.":
    "Hindi tinanggap ng Telegram ang address ng kymavo, kaya hindi dumarating ang mga mensahe sa bot. Sa public https address lang nagpapadala ang Telegram. I-save ulit kapag nasa ganoong address na ang kymavo.",
  // Builder
  "telegram_message": "Mensahe sa Telegram bot",
  "When someone messages your Telegram bot": "Kapag may nag-message sa Telegram bot mo",
};

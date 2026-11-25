/**
 * Taglish wording (R5, decision 0092): how many Filipino sellers write to their own customers. It replaces only the
 * messages that go to customers in the payment, reminder and order templates. Steps, branches, waits, amounts and
 * placeholders stay as they are, so a Taglish template runs exactly like the English one.
 */
type Message = { subject?: string; text?: string; message?: string; confirmedMessage?: string };

export const TAGLISH: Record<string, Record<string, Message>> = {
  "booking-deposit-review": {
    ask_deposit: { confirmedMessage: "Hi {{trigger.name}}, received na namin ang 350 pesos na deposit para sa {{steps.book.output.reference}}. See you on {{trigger.appointment_at}}!" },
    send_pay_link: { message: "Hi {{trigger.name}}, naka-hold na ang slot mo {{steps.book.output.reference}}. Bayaran ang 350 pesos na deposit at i-send ang reference dito: {{steps.ask_deposit.output.payUrl}}" },
    remind: { message: "Reminder lang po: hindi pa bayad ang deposit para sa {{steps.book.output.reference}}. I-pay at i-send ang reference dito: {{steps.ask_deposit.output.payUrl}}" },
    tell_released: { message: "Hi {{trigger.name}}, hindi namin natanggap ang deposit para sa {{steps.book.output.reference}}, kaya na-release na ang slot. Pwede kang mag-book ulit anytime." },
    tell_taken: { message: "Hi {{trigger.name}}, may nag-book na ng {{trigger.appointment_at}}. Pili ka na lang ng ibang time." },
    tell_declined: { message: "Hi {{trigger.name}}, sorry, hindi namin matatanggap ang booking sa {{trigger.appointment_at}}. Pili ka na lang ng ibang time." },
  },
  "order-gcash-checkout": {
    ask_payment: { confirmedMessage: "Hi {{trigger.customer_name}}, confirmed na ang payment mo para sa order {{trigger.order_id}}. Salamat po!" },
    send_checkout: { message: "Hi {{trigger.customer_name}}, bayaran ang {{trigger.amount}} pesos para sa order {{trigger.order_id}} dito: {{steps.ask_payment.output.checkoutUrl}}" },
    remind: { message: "Reminder lang po: unpaid pa ang order {{trigger.order_id}}. Pay dito: {{steps.ask_payment.output.checkoutUrl}}" },
    tell_cancelled: { message: "Hi {{trigger.customer_name}}, na-cancel ang order {{trigger.order_id}} kasi hindi nabayaran on time. Reply ka lang kung nakapag-pay ka na." },
  },
  "invoice-follow-up": {
    remind: { subject: "Reminder: invoice {{trigger.invoice_id}}", text: "Hi {{trigger.customer_name}}, open pa ang invoice {{trigger.invoice_id}} na {{trigger.amount}}. Pwede mo itong bayaran dito: {{trigger.pay_url}}." },
  },
  "appointment-reminder": {
    remind: { subject: "Reminder: ang {{trigger.service}} appointment mo", text: "Hi {{trigger.name}}, reminder ito para sa {{trigger.service}} appointment mo on {{trigger.appointment_at}}. Reply ka lang sa email na ito kung kailangan mong i-reschedule." },
  },
  "no-show-follow-up": {
    offer_rebook: { subject: "Sayang, hindi tayo nagkita", text: "Hi {{trigger.customer_name}}, hindi ka namin nakita sa {{trigger.service}} booking mo. Pili ka ng bagong time dito: {{trigger.rebook_url}}" },
  },
  "shopify-orders": {
    send_receipt: { subject: "Natanggap na namin ang order mo {{trigger.order_number}}", text: "Hi {{trigger.customer_name}}, thank you sa order mo {{trigger.order_number}} ({{trigger.total}} {{trigger.currency}}).\n\n{{trigger.items}}\n\nI-email ka namin kapag na-ship na ito." },
  },
  "store-orders": {
    send_receipt: { subject: "Natanggap na namin ang order mo {{trigger.order_id}}", text: "Hi {{trigger.customer_name}}, thank you sa order mo {{trigger.order_id}} ({{trigger.total}} pesos). I-email ka namin kapag na-ship na ito." },
  },
  "resort-concierge-dm": {
    reply_staff_choice: { text: "Sige po, ipapasa namin ito sa staff at may sasagot dito soon." },
    reply_handoff: { text: "{{steps.answer.output.reply}}\n\nNa-notify na namin ang team at magre-reply kami dito." },
    send_followup: { text: "Hi ulit! Message ka lang kung gusto mo ng rates para sa target dates mo o tulong sa pag-book." },
  },
  "resort-concierge-email": {
    reply_staff_choice: { subject: "Re: {{trigger.subject}}", text: "Thank you sa pag-email! Naipasa na namin ito sa resort team at magre-reply kami soon." },
    reply_handoff: { subject: "Re: {{trigger.subject}}", text: "{{steps.answer.output.reply}}\n\nNa-notify na namin ang team at magre-reply kami soon." },
    send_followup: { subject: "Re: {{trigger.subject}}", text: "Hi ulit! Reply ka lang kung gusto mo ng rates para sa target dates mo o tulong sa pag-book." },
  },
  "resort-deposit-and-stay": {
    tell_taken: { subject: "Taken na ang room para sa {{trigger.check_in}}", text: "Hi {{trigger.name}}, sorry pero hindi na available ang {{steps.quote.output.title}} sa {{trigger.check_in}} ({{trigger.nights}} nights). Reply ka ng ibang dates para ma-check namin agad." },
    ask_deposit: { confirmedMessage: "Hi {{trigger.name}}, confirmed na ang deposit mong {{steps.quote.output.deposit}} pesos para sa {{steps.quote.output.title}} ({{steps.book_stay.output.reference}}, check-in {{trigger.check_in}}). See you!" },
    send_pay_dm: { text: "Hi {{trigger.name}}, naka-hold na ang {{steps.quote.output.title}} sa {{trigger.check_in}} ({{trigger.nights}} nights, ref {{steps.book_stay.output.reference}}). Deposit ay {{steps.quote.output.deposit}} pesos (total {{steps.quote.output.total}} pesos). Pay dito: {{steps.ask_deposit.output.payUrl}}" },
    send_pay_email: { subject: "Deposit request para sa {{steps.book_stay.output.reference}}", text: "Hi {{trigger.name}},\n\nNaka-hold na ang {{steps.quote.output.title}} para sa check-in sa {{trigger.check_in}} ({{trigger.nights}} nights, {{trigger.guests}} guests).\nReference: {{steps.book_stay.output.reference}}\nTotal: {{steps.quote.output.total}} pesos\nDeposit due: {{steps.quote.output.deposit}} pesos\n\nPay dito: {{steps.ask_deposit.output.payUrl}}" },
    remind_email: { subject: "Reminder: deposit para sa {{steps.book_stay.output.reference}}", text: "Hi {{trigger.name}}, reminder lang po na pending pa ang {{steps.quote.output.deposit}} pesos deposit para sa {{steps.book_stay.output.reference}} (check-in {{trigger.check_in}}). Pay dito: {{steps.ask_deposit.output.payUrl}}" },
    tell_released: { subject: "Na-release na ang hold para sa {{steps.book_stay.output.reference}}", text: "Hi {{trigger.name}}, hindi namin natanggap on time ang deposit para sa {{steps.book_stay.output.reference}}, kaya na-release na ang hold. Message ka lang ulit anytime kung magbu-book ka uli." },
    send_pre_arrival: { subject: "Ready na para sa stay mo ({{steps.book_stay.output.reference}})", text: "Hi {{trigger.name}},\n\nSee you sa {{steps.quote.output.title}} on {{steps.book_stay.output.checkIn}} (check-out {{steps.book_stay.output.checkOut}}, reference {{steps.book_stay.output.reference}}).\nReply ka lang dito o sa Messenger kung kailangan mo ng directions or arrival help." },
    send_review: { subject: "Thank you sa pag-stay sa amin ({{steps.book_stay.output.reference}})", text: "Hi {{trigger.name}},\n\nThank you sa pag-stay sa amin! Welcome ang honest feedback ng lahat ng guests sa Google profile at Facebook page namin. Reply ka lang dito kung may notes ka para sa team." },
  },
  "telegram-assistant": {
    reply: { text: "kymavo assistant update:\n{{steps.write_answer.output.draft}}" },
  },
  "freelancer-lead-crm": {
    send_receipt: { subject: "Natanggap na namin ang inquiry mo", text: "Thank you sa pag-reach out! Na-receive namin ang project details mo at babalikan ka namin within one working day." },
  },
  "freelancer-client-onboarding": {
    send_welcome: { subject: "Welcome on board", text: "Thank you sa pag-send ng onboarding details! Na-set up na namin ang project space mo at mag-a-update kami sa next steps." },
  },
  "client-brief-to-trello": {
    send_receipt: { subject: "Natanggap na ang task request", text: "Thank you sa pag-send ng request! Naidagdag na namin ito sa task board at mag-a-update kami pag nagsimula na." },
  },
  "whatsapp-inquiry-to-sheets": {
    reply_customer: { text: "Hi! Thank you sa pag-message. Na-receive namin ang inquiry mo at may magre-reply sa team namin soon." },
  },
  "customer-feedback-triage": {
    send_thanks: { subject: "Thank you sa feedback mo", text: "Salamat sa pag-share ng feedback mo! Binabasa namin lahat ng response para mas mapaganda ang service namin." },
  },
  "daily-morning-briefing": {
    send_brief: { text: "Good morning! Eto ang daily briefing mo for today:\n\n{{steps.write_brief.output.draft}}" },
  },
};

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
};

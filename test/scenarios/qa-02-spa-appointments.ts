import { edge, email, REJECTED, type Scenario } from "./types";

// QA-02 Spa Appointment Automation. Today's engine can only express the v2 shape: the time is plain text and every
// booking reaches the same notifications. `desired` is the booking the business asked for; today's schema rejects it.
export const qa02: Scenario = {
  id: "QA-02",
  name: "Spa appointments",
  definition: {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "name", label: "Name", type: "text", required: true },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "service", label: "Service", type: "text", required: true },
          { name: "therapist", label: "Therapist", type: "text", required: true },
          { name: "appointment_at", label: "Appointment time", type: "text", required: true },
        ],
      },
    },
    steps: [email("notify", "frontdesk@example.com", "New booking"), email("confirm", "{{trigger.email}}", "Your booking")],
    edges: [edge("notify", "confirm")],
  },
  cases: [
    { name: "a future booking reaches the front desk and the customer", payload: { email: "ana@example.com", therapist: "Ana", appointment_at: "2027-01-20T14:00" }, want: ["notify", "confirm"] },
    {
      name: "a time of 32:00 is refused",
      payload: { email: "ana@example.com", therapist: "Ana", appointment_at: "2027-01-20T32:00" },
      want: REJECTED,
      gap: { phase: "P6a", today: ["notify", "confirm"], why: "there is no zoned datetime field, so any text is a time" },
    },
    {
      name: "a time in the past is refused",
      payload: { email: "ana@example.com", therapist: "Ana", appointment_at: "2020-01-20T14:00" },
      want: REJECTED,
      gap: { phase: "P6a", today: ["notify", "confirm"], why: "there is no future-only time check" },
    },
  ],
};

const fields = [
  { name: "email", label: "Email", type: "email", required: true },
  { name: "appointment_at", label: "Appointment time", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
  { name: "therapist", label: "Therapist", type: "resource", required: true },
];

/** One definition per missing capability, so each schema rejection names exactly one gap. */
export const desired = {
  datetimeField: {
    trigger: { type: "form", config: { fields: [fields[0], fields[1]] } },
    steps: [email("confirm", "{{trigger.email}}", "Your booking")],
    edges: [],
  },
  resourceField: {
    trigger: { type: "form", config: { fields: [fields[0], fields[2]] } },
    steps: [email("confirm", "{{trigger.email}}", "Your booking")],
    edges: [],
  },
  relativeDelay: {
    trigger: { type: "manual", config: {} },
    steps: [{ id: "wait", type: "delay", config: { until: "{{trigger.appointment_at}}", offsetSeconds: -3600 } }, email("remind", "{{trigger.email}}", "Reminder")],
    edges: [edge("wait", "remind")],
  },
  bookingStep: {
    trigger: { type: "manual", config: {} },
    steps: [
      { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.therapist}}", start: "{{trigger.appointment_at}}", minutes: 60 } },
      email("confirm", "{{trigger.email}}", "Your booking"),
      email("taken", "{{trigger.email}}", "That time is taken"),
    ],
    edges: [edge("book", "confirm", "done"), edge("book", "taken", "taken")],
  },
};

/** A one-hour delay, to show what a mocked test run reports as the wake-up time. */
export const hourDelay = {
  trigger: { type: "manual", config: {} },
  steps: [{ id: "wait", type: "delay", config: { seconds: 3600 } }],
  edges: [],
};

import { edge, email, REJECTED, type Scenario } from "./types";

// QA-02 Spa Appointment Automation. Since P6a the time is a zoned datetime field and the therapist a workspace resource;
// every booking still reaches the same notifications until P6b. `desired` holds the shapes a later phase adds.
const customer = { name: "Mia", email: "mia@example.com", service: "Massage" };

/** The harness adds this resource, named Ana, to the owner's workspace before the cases run. */
export const ANA = "0f0e2d4c-3b2a-4c1d-8e9f-a0b1c2d3e4f5";
/** Next year, so the cases stay in the future whenever they run. */
export const appointment = (time: string) => `${new Date().getUTCFullYear() + 1}-01-20T${time}`;

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
          { name: "therapist", label: "Therapist", type: "resource", required: true },
          { name: "appointment_at", label: "Appointment time", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
        ],
      },
    },
    steps: [email("notify", "frontdesk@example.com", "New booking"), email("confirm", "{{trigger.email}}", "Your booking")],
    edges: [edge("notify", "confirm")],
  },
  cases: [
    { name: "a future booking reaches the front desk and the customer", payload: { ...customer, therapist: ANA, appointment_at: appointment("14:00") }, want: ["notify", "confirm"] },
    { name: "a time of 32:00 is refused", payload: { ...customer, therapist: ANA, appointment_at: appointment("32:00") }, want: REJECTED, rejects: ["appointment_at: is not a real date and time"] },
    { name: "a time in the past is refused", payload: { ...customer, therapist: ANA, appointment_at: "2020-01-20T14:00" }, want: REJECTED, rejects: ["appointment_at: must be in the future"] },
    {
      name: "a time between the hourly slots is refused",
      payload: { ...customer, therapist: ANA, appointment_at: appointment("14:30") },
      want: REJECTED,
      rejects: ["appointment_at: must start on a 60-minute slot, counted from midnight in Asia/Manila"],
    },
    { name: "a therapist given by name instead of a resource is refused", payload: { ...customer, therapist: "Ana", appointment_at: appointment("14:00") }, want: REJECTED, rejects: ["therapist: must be one of this workspace's resources"] },
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

/** A reminder a day before the appointment. For an appointment a few hours away that time has passed. */
export const dayBeforeReminder = {
  trigger: { type: "webhook", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }, fields[1]] } },
  steps: [{ id: "wait", type: "delay", config: { until: "{{trigger.appointment_at}}", offsetSeconds: -86_400 } }, email("remind", "{{trigger.email}}", "Reminder")],
  edges: [edge("wait", "remind")],
};

/** A one-hour delay, to show what a mocked test run reports as the wake-up time. */
export const hourDelay = {
  trigger: { type: "manual", config: {} },
  steps: [{ id: "wait", type: "delay", config: { seconds: 3600 } }],
  edges: [],
};

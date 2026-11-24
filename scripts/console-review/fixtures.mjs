import { URLSearchParams } from "node:url";
import { page, renderForm } from "../../apps/api/src/public.ts";
import { publicCopy } from "../../apps/api/src/public-copy.ts";
import { defaultAnswers, officeRequestDefinition } from "../../packages/engine/src/office-request.ts";
import { defaultPurchaseAnswers } from "../../packages/engine/src/purchase-request.ts";

export const workflowId = "11111111-1111-4111-8111-111111111111";
export const runId = "22222222-2222-4222-8222-222222222222";
export const officeId = "33333333-3333-4333-8333-333333333333";
export const purchaseId = "44444444-4444-4444-8444-444444444444";
const resourceId = "55555555-5555-4555-8555-555555555555";
export const formPath = "/forms/66666666-6666-4666-8666-666666666666";
export const inviteToken = "i".repeat(43);
export const resetToken = "r".repeat(43);
export const reference = "REQ-SAMPLE";
export const samplePassword = "Sample review phrase";

const createdAt = "2026-06-17T01:05:00.000Z";
const finishedAt = "2026-06-17T01:05:03.000Z";
const ownerEmail = "owner@example.test";
const approverEmail = "approver@example.test";
const subject = "The reception printer is jammed.";
const runError = "Sample office inbox refused a message.";
const names = { office: "Office requests", purchase: "Purchase requests" };
const manualDefinition = {
  trigger: { type: "manual", config: {} },
  steps: [{ id: "notice", type: "email", config: { to: "office@example.test", subject: "Sample notice", text: "An office request came in." } }],
  edges: [],
};
const version = { id: "sample-version", version: 1, published: true, createdAt, definition: manualDefinition };
const run = {
  id: runId, workflowId, workflowName: "Office intake", reference, state: "failed", live: true, needsReview: false,
  triggerPayload: { summary: subject }, version: 1, test: false, error: runError, createdAt, finishedAt,
  steps: [
    { id: "sample-step", stepId: "notice", attempt: 1, state: "failed", input: {}, output: null, error: runError, branch: null,
      inputTokens: null, outputTokens: null, outcome: null, resolvedBy: null, resolvedAt: null, createdAt, finishedAt },
  ],
};
const work = {
  id: workflowId, name: run.workflowName, slug: "office-intake", createdAt, live: true,
  last: { runId, state: run.state, createdAt, needsReview: false, deliveryFailed: false, superseded: false, reference },
};
const mail = {
  profile: { businessName: "Sample office", website: null, inquiryEmail: null, replyTo: null },
  sender: null, signInEmail: ownerEmail, installationFrom: "office@example.test", installationAllowed: true, installationLocal: true,
};
const roles = ["owner", "operator", "approver", "requester"];
const members = roles.map((role, index) => ({ userId: `sample-user-${index}`, email: `${role}@example.test`, role, createdAt }));
const meter = { used: 0, limit: null, resetsOn: "2027-01-01" };
const getFixtures = new Map([
  ["/workspace/members", members],
  ["/settings/connections", { connections: [], oauth: [], shared: [], outlook: { configured: false }, paymongoWebhookBase: "https://example.test" }],
  ["/settings/email", mail],
  ["/settings/brand", { logo: null, accent: null }],
  ["/settings/ai", {
    current: { preset: "local", model: "sample-model", hasKey: false, keys: [], saved: false },
    presets: { local: { label: "Sample model", defaultModel: "sample-model", needsKey: false, models: [{ id: "sample-model", free: true, note: "" }] } },
  }],
  ["/settings/ai/local-models", { ok: true, models: ["sample-model"] }],
  ["/usage", { plan: null, label: "Local", limits: null, ai: meter, email: meter, http: meter, automations: { live: 1, limit: null }, minScheduleMinutes: null }],
  ["/step-schemas", { schemas: { email: { type: "object", properties: {} } }, branches: {} }],
  [`/workflows/${workflowId}`, { ...work, latest: version, live: version, trigger: null }],
  [`/workflows/${workflowId}/versions`, [version]],
  [`/workflows/${workflowId}/versions/1`, version],
  [`/runs/${runId}`, run],
  [`/runs/${runId}/explanation`, null],
  ["/runs/ask", {
    runId, reference, workflowName: work.name, answers: {
      happened: { headline: "The request was saved and the office email failed.", lines: [], fix: null },
      why: { headline: runError, lines: ["The sample request is still in kymavo."], fix: null },
      next: { headline: "Check the office email settings.", lines: [], fix: { href: "#/apps", label: "Open Apps" } },
    },
  }],
  ["/deliveries", []],
  ["/secrets", [{ name: "OFFICE_KEY", createdAt }]],
  ["/tokens", [{ id: "sample-client", name: "Office client", scopes: ["read"], createdAt, lastUsedAt: null, revokedAt: null, expiresAt: null }]],
]);

export function makeFixtures({ role = "owner", language = "en", state = "normal" }) {
  const member = members.find((entry) => entry.role === role);
  const user = member && { id: member.userId, workspaceId: "sample-workspace", email: member.email, role, language, ask: true };
  const officeAnswers = { ...defaultAnswers(ownerEmail, language), name: names.office };
  const purchaseAnswers = { ...defaultPurchaseAnswers(ownerEmail, language), name: names.purchase, approver: approverEmail };
  const office = { id: officeId, name: names.office, slug: "office-requests", createdAt, live: false, setup: { template: "office-request", step: "fields", answers: officeAnswers } };
  const purchase = { id: purchaseId, name: names.purchase, slug: "purchase-requests", createdAt, live: false, setup: { template: "purchase-request", step: "approver", answers: purchaseAnswers } };
  const booking = {
    id: "sample-booking", reference: "BK-SAMPLE", status: "active", start: "2026-06-17T08:00:00+08:00", end: "2026-06-17T09:00:00+08:00",
    timezone: "Asia/Manila", version: 1, attention: false, resource: { id: resourceId, name: "Reception" }, runId: null,
  };
  const resource = { id: resourceId, name: "Reception", active: true, createdAt };
  const copy = publicCopy[language];

  return (url, method, body) => {
    const p = url.pathname;
    if (p === formPath) {
      if (method === "GET") {
        const fields = officeRequestDefinition(officeAnswers, language).trigger.config.fields;
        return { html: renderForm(fields, [], officeId, mail.profile.businessName, language) };
      }
      const submission = new URLSearchParams(body);
      if (method === "POST" && submission.get("email") === "requester@example.test" && submission.get("summary") === subject) {
        return { html: page(`<h1>${copy.received}</h1><p>${copy.reference} <strong>${reference}</strong>.</p><p>${copy.receipt}</p>`, copy.received, language) };
      }
    }
    if (method === "GET") {
      if (p === "/auth/me") return user ? { json: user } : { status: 401, json: { message: "Please sign in." } };
      if (p === "/workflows") {
        if (state === "error") return { status: 503, json: { message: "Sample service unavailable." } };
        return { json: state === "empty" ? [] : [work, office, purchase] };
      }
      if (p === `/workflows/${officeId}`) return { json: office };
      if (p === `/workflows/${purchaseId}`) return { json: purchase };
      if (p === "/runs") return { json: url.searchParams.has("review") || state === "empty" ? [] : [run] };
      if (p === "/my/requests") return { json: role === "approver" ? [] : [{ reference, subject, createdAt, automation: names.office, state: "failed" }] };
      if (p === "/resources") return { json: [resource] };
      if (p === "/bookings") return { json: [booking] };
      if (getFixtures.has(p)) return { json: getFixtures.get(p) };
    }
    if (method === "POST" && p === "/ai/chat") return { json: { kind: "draft", name: work.name, definition: manualDefinition, summary: "Send an office notice by email.", warnings: [] } };
    if (method === "POST" && (p === "/auth/password-reset" || p === `/auth/password-reset/${resetToken}`)) return { json: {} };
    if (method === "POST" && p === `/bookings/${booking.id}/no-show`) {
      booking.status = "no_show";
      return { json: {} };
    }
    if (method === "PATCH" && p === `/resources/${resourceId}`) {
      resource.active = JSON.parse(body).active;
      return { json: {} };
    }
    return undefined;
  };
}

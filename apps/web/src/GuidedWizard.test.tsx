import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GeneratedWizard } from "./GuidedWizard";
import { LanguageContext } from "./Language";

describe("GeneratedWizard (G2)", () => {
  it("renders template questions and Edit steps fallback link for any starter template", () => {
    const html = renderToStaticMarkup(
      <LanguageContext.Provider value={{ language: "en", setLanguage: () => undefined }}>
        <GeneratedWizard
          wf={{
            id: "11111111-1111-4111-8111-111111111111",
            name: "Appointment reminder",
            slug: "appointment-reminder",
            createdAt: "2026-11-26T00:00:00Z",
            trigger: null,
            live: null,
            latest: {
              id: "v1",
              version: 1,
              published: false,
              createdAt: "2026-11-26T00:00:00Z",
              definition: {
                trigger: {
                  type: "form",
                  config: {
                    fields: [
                      { name: "name", label: "Name", type: "text", required: true },
                      { name: "email", label: "Email", type: "email", required: true },
                      { name: "service", label: "Service", type: "text", required: true },
                      { name: "appointment_at", label: "Time", type: "datetime", timezone: "Asia/Manila", required: true },
                    ],
                  },
                },
                steps: [
                  { id: "wait_for_day_before", type: "delay", config: { until: "{{trigger.appointment_at}}", offsetSeconds: -86400 } },
                  { id: "remind", type: "email", config: { to: "{{trigger.email}}", subject: "Reminder", text: "See you soon." } },
                ],
                edges: [{ from: "wait_for_day_before", to: "remind" }],
              },
            },
          }}
          setup={{ kind: "generated", template: "appointment-reminder", step: "questions", answers: {} }}
          onDone={async () => undefined}
        />
      </LanguageContext.Provider>,
    );
    expect(html).toContain("Step 1 of 4");
    expect(html).toContain("When to send the reminder");
    expect(html).toContain("Reminder email wording");
    expect(html).toContain('href="#/w/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain("Edit steps");
  });
});

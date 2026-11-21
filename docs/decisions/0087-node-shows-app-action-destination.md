# 0087. A node shows the app, the action and where it acts

## Context

A node showed its type name and the step id (`email_1`), plus a short summary of its config. A seller reading the diagram could not tell which app a step used or who a message goes to.

## Decision

Each node shows, top to bottom: the app mark and name with the step number, the action as the title, and a destination line. The step id moves to the top right, where "Connect <App>" replaces it when the app is not connected. The destination line is words, not templates: `{{trigger.email}}` reads "Customer email from the form", using the form field's label. A step that writes to a destination picked in Apps (a sheet, a channel, a chat, a table, a list) shows that name, or "chosen in Apps" until one is picked.

An email step needs Gmail only when no sender can send: the workspace has no active Gmail sender and the installation has none either. A trigger that needs an app (PayMongo, Messenger and Instagram) shows the same note.

## Consequences

- Nodes are slightly taller. The layout row height (130) still fits them.
- The "apps connected" banner is unchanged. It still counts the apps a draft needs, not Gmail.
- Step ids stay visible, so references such as `{{steps.email_1.output}}` can still be written by reading the canvas.

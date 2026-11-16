# 0034: Run the Astra Daloy demo in the browser

## Context

Portfolio visitors need to try an office request without signing in or sending mail. Daloy already has a pure preview function for this workflow.

## Options

Use a shared demo account on the running installation, or render the existing template in each visitor's browser.

## Decision

Serve Astra Daloy at `/#/demo` before the console checks for a session. Use the template's form fields, validation and email previews. Keep the submission in component state.

## Consequences

Visitors can use the demo offline after the page loads. Refreshing clears their edits. Each run has the same sample reference. The demo illustrates the request and messages. Checking actual delivery still requires the worker and a mail service.

# 0040. Email-in and website forms

## Context

A shop may already receive an email each time someone submits its contact form. Another shop may want to put a Daloy form directly on its website. Both need a way to start an automation without a site-specific integration.

## Options

We considered an inbound email service, IMAP polling, a JavaScript form that posts across origins, and an iframe displaying the hosted form. A service would add an external account. A JavaScript form would need another submission client, cross-origin access and a way to distribute field changes.

## Decision

The owner can assign one IMAP folder to an automation. The worker checks its credentials and opens the folder read-only. Once the published email trigger starts listening, the worker stores the current mailbox numbering and starts after the highest existing message. It uses an identifier for the connected mailbox, the server's UIDVALIDITY and the message UID as the event key. Two different website notifications can have the same Message-ID.

The database stores the credential separately from workflow versions. Replacing a credential invalidates outstanding polls. Saving runs and the new mailbox position in one transaction makes it safe for the next worker to take over after a crash. A pending run whose enqueue failed goes through the existing recovery sweep.

An iframe points at a dedicated public form address. The standalone form and its embed use the same renderer and submission handler. Only the embed permits framing by another website. Embedded requests have no workspace member attached even when the browser sends a session cookie.

## Consequences

The mailbox provider must support IMAP over verified TLS on port 993 and password authentication. Reading a message leaves it in the folder. A mailbox numbering reset pauses intake until the owner confirms a new starting point. Forwarded notifications carry plain text and sender-supplied headers. Attachments stay in the mailbox. Keep an automation's outgoing notifications out of its monitored folder.

The copied form keeps working after published field changes. A website that strips iframes can link to the hosted form or send its existing form notifications to the monitored folder. Live provider and hosted editor checks belong to the owner. The automated checks use a loopback IMAP server and a website on a second origin.

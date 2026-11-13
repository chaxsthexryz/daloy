# 0017: Workflows drafted by the AI as whole definitions

## Context

The owner wants to describe a workflow in plain words and have the AI build it, then keep chatting to change it. The model is the one picked on the AI model page (decision 0016): a small local model, the Gemini free tier or a paid provider.

## Options

1. Tool calling: the model calls add_step, connect and set_config one at a time. Close to how a person edits, but it needs tool-call support, which differs per provider and is weak in small local models, and a run of calls can leave a half-built graph.
2. The model writes the whole definition as JSON, which the existing `definitionSchema` checks. One request per message, any chat model works, and a draft is either valid as a whole or refused with reasons.

## Decision

Option 2. `draftPrompt()` gives the model the step types with their JSON schemas, the branch labels, the expression syntax and one template as an example, and puts the request (plus the current draft for a change) in the user message. `parseDraftReply()` takes the outermost JSON object from the reply and validates it. An invalid reply goes back to the model once with its problems; a second failure is reported to the user. No JSON schema is sent to the provider, because the definition's nested unions exceed what some providers' structured output accepts.

The AI never saves or publishes. Build with AI saves the draft as an unpublished version; Ask the AI only changes the editor's unsaved draft.

## Consequences

A change rewrites the whole definition, so a model may also alter parts it was not asked to; the canvas shows the result before anything is saved, and the version history keeps every saved version. Large workflows make long prompts; the prompt is kept under about 3,000 tokens without the current draft. Small local models often fail the schema; the repair turn helps, but Gemini or a larger model is the practical choice. Quality with a real model has not been measured; the tests use fake models.

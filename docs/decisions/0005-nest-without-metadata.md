# 0005: NestJS without decorator metadata, own rate limit guard, @node-rs/argon2

## Context

PROJECT.md names NestJS for the API. Nest normally reads constructor types from TypeScript's emitted decorator metadata. The project runs TypeScript through esbuild (vitest for tests, tsx at runtime), and esbuild does not emit that metadata. Nest 12 is also ESM only.

## Options

1. Add a build step with `tsc` or SWC to emit metadata, and run compiled JavaScript.
2. Keep esbuild and name every injected dependency with `@Inject(TOKEN)`.

For rate limiting, `@nestjs/throttler` is CommonJS. Under tsx it loaded a second copy of `@nestjs/core`, and Nest could not inject `Reflector` into its guard. The tests passed, because vitest loads modules differently, but `pnpm start` failed.

For password hashing, the two main options are `argon2` and `@node-rs/argon2`. Both are MIT licensed and ship prebuilt binaries.

## Decision

- Option 2. Every constructor parameter uses `@Inject`.
- A rate limit guard of our own (`RateLimit` in `http.ts`): a fixed window per IP and route, in memory.
- `@node-rs/argon2`, which defaults to argon2id and needs no install scripts.

## Consequences

There is no build step, and tests and runtime use the same compiler. Forgetting `@Inject` fails at startup with a clear Nest error. Rate limit counters are per process, which is fine for one API instance. Several instances would need a shared counter in Postgres.

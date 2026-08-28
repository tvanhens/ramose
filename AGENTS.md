# Ramose

Bun workspace. The published package is `packages/ramose` (npm: `ramose`).
Consumer demos live in `examples/*`.

See `README.md` for the product overview and `CONTRIBUTING.md` for local
commands, tests and CI. Documentation lives at [ramose.ai](https://ramose.ai)
(source in `website/`). There is no in-repo `docs/` folder.

## Code Review Rules

Before reviewing, examine any issues linked from the pull request for context
on its intended scope, requirements, and expected behavior.

Bias toward approving pull requests. Only raise blocking findings: concrete
issues introduced by the change that must be fixed before merge because they
cause incorrect behavior, security or data-loss risk, break a public contract,
or create a migration or compatibility problem that will be materially harder
to fix later.

Do not report style preferences, speculative concerns, minor maintainability
improvements, optional hardening, or other feedback that can be addressed later
without significant cost or breakage. Do not block on pre-existing problems or
unrelated code. A finding must identify a specific failure scenario and explain
why fixing it after merge would be unsafe or substantially more difficult. If
that case cannot be made, omit the finding and approve the change.

## Testing policy

Do not introduce mocks, fakes, scripted peers, or in-memory infrastructure
substitutes. Ramose has three test layers:

1. **Pure unit tests** (`bun run test:unit`) — parsers, query lowering, policy
   compilation, state transitions, error classification, retry decisions,
   serialization, and other deterministic logic. No Worker, Durable Object,
   R2, Cache API, WebSocket, or auth service. If a failure reaction is a
   pure transition, test it with ordinary input values.
2. **Alchemy local integration** (`bun run test:local`) — anything that
   crosses an infrastructure boundary. Share one Alchemy stack per suite
   (`test/local`) and isolate tests with unique database names. During the
   authorization redesign, `/db/*` is fail-closed (401); local tests still
   run against the real Worker/DO/R2 topology and prove health, deny, and
   `/__test__/*` instrumentation. Successful data-plane claims resume when
   #344 / #339 / #343 reopen `/db/*`.
3. **Cloudflare e2e** (`bun run test:e2e` / `test:e2e:cf`) — edge
   propagation, deployment convergence, and platform failures workerd
   cannot reproduce honestly.

Allowed instrumentation wraps a real implementation and forwards to it:
`test/support/recorder.ts` (HTTP/WebSocket), checkpoints in
`packages/ramose/src/internal/test-hooks.ts`, and `/__test__/db/:name/*`
(R2/storage, checkpoint arm/release, DO abort, real session/watch WebSockets,
and forwarded transact/query/index controls). These are inert
unless `RAMOSE_TEST_HOOKS=1` and `RAMOSE_STAGE` is not `prod`.

Not allowed: `scriptedPeer`, `FakeSocket` / `fakeDispatch`, `MemoryBucket`
/ `MemCache`, Better Auth `memoryAdapter`, `mock.module("cloudflare:workers")`,
in-process peers, scripted `fetch`/WebSocket implementations, fake DO
namespaces, or virtual services whose only purpose is to fail on the Nth
call. `Alchemy.inMemoryState()` is Alchemy deploy state for the real local
stack, not a Ramose double. Domain fixtures and pure-function inputs are
fine.

`scripts/check-test-doubles.ts` rejects new violations. Existing ones are
allowlisted in `scripts/test-double-allowlist.json` — shrink that file;
do not add entries.

## Cursor Cloud specific instructions

Cursor Cloud Agent environment and runtime caveats live in
[`.cursor/CLOUD.md`](.cursor/CLOUD.md). Read that file when working as a
Cursor Cloud Agent.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation
details when the documentation isn't enough.

Note: this is the canonical [`Effect-TS/effect`](https://github.com/Effect-TS/effect)
repo, whose `main` branch is v4. The `effect-smol` repo the Effect Solutions guide
names is archived. Update with
`git -C ~/.local/share/effect-solutions/effect pull --depth 1`.

## Effect Language Service

This repo is on TypeScript 7 (native), so the Effect diagnostics come from
[`@effect/tsgo`](https://github.com/Effect-TS/tsgo), not the `@effect/language-service`
tsserver plugin that the Effect Solutions guide describes — TS7 does not load
JS TS plugins. `@effect/tsgo` patches the native `tsc` binary; the `prepare`
script re-applies the patch on every install, so `bunx tsc --version` should
report `7.0.2+effect-tsgo.<version>`. If it prints a bare version, Effect
diagnostics are silently off — run `bunx effect-tsgo patch --typescript --no-oxlint`.

Effect diagnostics surface as `TS377xxx` codes in `bun run typecheck` and count
toward its exit code. Suppress with a scoped directive rather than disabling the
rule globally — both forms are verified against this repo's setup:

```ts
// @effect-diagnostics-next-line floatingEffect:off   <- suppresses the next line only
// @effect-diagnostics floatingEffect:off             <- suppresses for the whole file
```

Prefer the `-next-line` form. The file-level form is appropriate for type-level
test fixtures (`packages/ramose/test/db/*-types.ts`), where bare expressions are
deliberate type assertions rather than dropped effects.
<!-- effect-solutions:end -->

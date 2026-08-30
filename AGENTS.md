# Ramose

Ramose is a Bun workspace. The published `ramose` package is in
`packages/ramose`; consumer examples are in `examples`.

Use `README.md` for the product overview and `CONTRIBUTING.md` for development
commands. Public documentation is published at [ramose.ai](https://ramose.ai)
from `website/src/content/docs`.

## Checks

```sh
bun install
bun run typecheck
bun run test:unit
bun run test:browser
bun run test:local
bun run build
```

Use pure unit tests for deterministic logic, browser tests for browser APIs,
local integration tests for infrastructure boundaries, and Cloudflare e2e for
edge behavior. Do not replace Worker, Durable Object, R2, Cache API, WebSocket,
authentication, IndexedDB, DOM, or browser behavior with test doubles. Recorded
browser frames must come from `bun run record:frames` and retain their
`PROVENANCE.md`.

## Repository prose

Keep repository prose limited to public documentation, public API TSDoc,
concise contributor instructions, legal notices, tool-required directives and
markers, and fixture provenance. Do not add implementation comments, internal
design or status Markdown, explanatory fields in config or data files, issue
history, migration phases, temporary status, or language declaring contracts
frozen, locked, or gated. Express behavior through names, types, tests, and
public documentation.

## Effect

Before writing Effect code, run `effect-solutions list`, read the relevant
guides with `effect-solutions show <topic>...`, and consult the Effect v4 source
in `~/.local/share/effect-solutions/effect` when needed.

This repository uses TypeScript 7 with `@effect/tsgo`. Effect diagnostics are
reported by `bun run typecheck` as `TS377xxx`. If a diagnostic must be
suppressed, prefer a scoped `@effect-diagnostics-next-line` directive.

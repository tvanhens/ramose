# Ramose

An immutable, Datomic-inspired graph database for Cloudflare (Workers + Durable
Objects + R2), built on the Effect runtime. It is a Bun workspace with one
published package — `packages/ramose` (npm: `ramose`), which is the engine, the
peer Worker and the client — and two consumer demos in `examples/*`.

See `README.md` for the product overview and `CONTRIBUTING.md` for local
commands, tests and CI. All documentation lives on the docs site
([ramose.ai](https://ramose.ai), source in `website/`) — there is no in-repo
`docs/` folder.

## Cursor Cloud specific instructions

Cursor Cloud Agent environment and runtime caveats live in
[`.cursor/CLOUD.md`](.cursor/CLOUD.md) to keep this file harness-agnostic. Read
that file when working as a Cursor Cloud Agent.

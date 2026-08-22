# Ramose

An immutable, Datomic-inspired graph database for Cloudflare (Workers + Durable
Objects + R2), built on the Effect runtime. It is a Bun workspace with one
published package — `packages/ramose` (npm: `ramose`), which is the engine, the
peer Worker and the client — and two consumer demos in `examples/*`.

See `README.md` for the product overview and `CONTRIBUTING.md` for local
commands, tests and CI. All documentation lives on the docs site
([ramose.ai](https://ramose.ai), source in `website/`) — there is no in-repo
`docs/` folder.

## Pre-launch API overhaul (read before changing public API)

A full public-API review and cleanup plan is in flight: `API-REVIEW.md` at the
repo root, tracked by GitHub issue #205 (issues #170–#209). Four standing
decisions govern all public-surface work — do not contradict them:

1. **Operations only.** `Operation`/`db.run` is the sole write path;
   `db.transact` is being retired from the public surface (#174).
2. **Effect is hidden from app users** (#206). `ramose/db` client surface and
   `ramose/react` must expose zero Effect types — promises, plain tagged
   errors, subscription handles, async operation bodies. Effect stays internal
   and behind an explicit escape hatch. Deploy files remain Effect-flavored.
3. **The API adopts the docs' vocabulary** (#204). `Entity`/`Field`/`Schema`,
   `set`/`remove`/`delete`, `ServerAuth`; see #204 for the full name map.
4. **North star: MCP-native** (#209, deferred). Keep the projection cheap:
   named ops only, the registry on `Server`, serializable query values,
   `doc:` on operations.

When picking up one of the tracked issues, read its body including any
"Amendment" sections — several were re-scoped after the decisions landed.
Check the box in #205 when an issue closes.

## Cursor Cloud specific instructions

Cursor Cloud Agent environment and runtime caveats live in
[`.cursor/CLOUD.md`](.cursor/CLOUD.md) to keep this file harness-agnostic. Read
that file when working as a Cursor Cloud Agent.

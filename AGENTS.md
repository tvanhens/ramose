# Ramose

An immutable, Datomic-inspired graph database for Cloudflare (Workers + Durable
Objects + R2), built on the Effect runtime. It is a Bun workspace with one
published package — `packages/ramose` (npm: `ramose`), which is the engine, the
peer Worker and the client — and two consumer demos in `examples/*`.

See `README.md` for the product overview and `CONTRIBUTING.md` for local
commands, tests and CI. All documentation lives on the docs site
([ramose.ai](https://ramose.ai), source in `website/`) — there is no in-repo
`docs/` folder.

## API overhaul decisions (binding for public-surface work)

Cleanup tracker: issue #205 (issues #170–#215). Seven standing decisions —
do not contradict them: (1) operations only — `db.run` is the sole write
path, `db.transact` retires; (2) zero Effect types on the app surface
(`ramose/db` client, `ramose/react`) — promises, plain tagged errors,
subscriptions; (3) naming per #204's map (`Entity`/`Field`/`Schema`,
`set`/`remove`/`delete`); (4) queries and operations stay serializable
(future MCP projection, #209); (5) authorization moves into the
database itself — an always-on system directory of dbs + grants with
identity-only tokens (#215, design in `design/215-system-directory.md`):
no compat mode — the `ramose.{db,class}` claim format is removed with the
change, not kept; the policy vocabulary renames class → role (amending
#204's map); identity data stays in Better Auth's D1 for now; pre-launch
the API is fully fungible — prefer the quickest path to the end state
over compatibility; (6) no deprecation windows before launch — a breaking change
removes the old surface in the same PR, and a redundant verb does not
ship; (7) required-at-transact — `put` = make this row so (full required
data, insert-or-update via unification); `update` = change what's there
(partial, addressed by eid or unique field, never creates). Read your
issue's "Amendment" sections — several were re-scoped after these
decisions.

## Cursor Cloud specific instructions

Cursor Cloud Agent environment and runtime caveats live in
[`.cursor/CLOUD.md`](.cursor/CLOUD.md) to keep this file harness-agnostic. Read
that file when working as a Cursor Cloud Agent.

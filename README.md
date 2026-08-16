# Ripple

An immutable, Datomic-inspired database for Cloudflare: single-writer
transactor as a Durable Object, indexes as immutable segment trees in R2,
datalog queries executed at the edge. See `SPEC.md` for the design and
milestones; `bench/RESULTS.md` for recorded numbers.

## Layout

- `packages/core` — pure TS engine (datoms, segments, trees, novelty, datalog). No Cloudflare deps.
- `packages/storage` — R2 node store (memory → Cache API → R2), root/log records, GC.
- `packages/transactor` — the write path (`Transactor`, runtime-agnostic) + Durable Object shell + indexer.
- `packages/replica` — QueryReplica DO (novelty subscriber, basis endpoint).
- `packages/worker` — the peer Worker (HTTP API, edge query execution). Exports both DO classes.
- `packages/client` — TS SDK.
- `packages/alchemy` — Alchemy 2 + Effect interface (`Ripple.System` resource, Read/Write/ReadWrite capabilities).
- `bench/`, `test/e2e/` — benches and end-to-end tests.

## Commands

```sh
bun install
bun test                      # core + transactor unit/property tests
bun run typecheck
bun run bench                 # M1 seek/join + M2 transactor benches (in-process)

# local stack (Worker + DOs + R2 emulated by miniflare via Alchemy)
ALCHEMY_STATE=local CLOUDFLARE_ACCOUNT_ID=<any 32 hex> CLOUDFLARE_API_TOKEN=x bun alchemy dev
RIPPLE_URL=http://localhost:1337 bun test test/e2e
RIPPLE_URL=http://localhost:1337 bun run bench/write-do.bench.ts 64 5

# real deploys (Cloudflare credentials via `bun alchemy login` or env)
bun alchemy deploy            # $USER stage
bun alchemy deploy --stage prod
```

`ALCHEMY_STATE=local` keeps Alchemy's state in `.alchemy/` instead of the
Cloudflare state store; the local runtime still wants an account id in the
environment, any placeholder works for emulation.

## Alchemy / Effect interface

`@ripple/alchemy` exposes Ripple to Alchemy 2 the way `alchemy/Cloudflare`
exposes KV: a resource for the thing, capabilities for using it, and one
Effect-native client behind three transports. The typed happy path is
`SchemaFx` (catalog → `create(name, catalog)` → gen transact → builder `q`
→ `eid.pull`). Full example (type-checked): `examples/kv-style/`
(`resources.ts` + `schema.ts` + `app.ts` + `alchemy.run.ts`). The compile-time
walkthrough is `packages/alchemy/src/schema/usage.ts`.

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Ripple from "@ripple/alchemy";
import { SchemaFx } from "@ripple/alchemy";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";

export const User = SchemaFx.Namespace("user", {
  name: SchemaFx.Attr(Schema.String, { unique: "identity" }),
});
export const Movies = SchemaFx.Catalog({ user: User });

export const Peer = Cloudflare.Worker("Peer", { main: "./packages/worker/src/index.ts", env: { /* … */ } });
export const Sys  = Ripple.System("Sys", { peer: Peer });

// inside an Effect-form Worker (deploy time: lowers a `service` binding to the peer)
const system = SchemaFx.fromReadWrite(yield* Ripple.ReadWriteSystem(Sys));
// per request — a database is a name; typed create upserts the name and ensures the catalog
const db  = yield* system.create("movies", Movies);
const ack = yield* db.transact(function* (tx) {
  const ada = yield* tx.entity();
  yield* ada.add(User.name, "Ada");
});
const rows = yield* db.q((q) =>
  q.where("?e", User.name, "?n").options({ minT: ack.t }).find("?e", "?n"),
);
const past = yield* db.asOf(ack.t - 1).q((q) =>
  q.where("?e", User.name, "?n").find("?e"),
);
const ada = yield* rows[0][0].pull({ name: User.name }); // missing required → null

// db-per-tenant: same peer/token, another name
const tenantId = (yield* HttpServerRequest).url.split("/")[2]; // GET /t/:tenant
const tenant   = yield* system.create(tenantId, Movies);       // invalid name → BadRequest; ensure fail → SchemaEnsureError
const tack     = yield* tenant.transact(function* (tx) {
  const e = yield* tx.entity();
  yield* e.add(User.name, "Ada");
});

export default Alchemy.Stack("app", {
  providers: Layer.mergeAll(Cloudflare.providers(), Ripple.providers()),
  state: Cloudflare.state(),
}, /* … */);
```

- **Resource** — `Ripple.System(id, { peer, token?, probe? })`, guard `Ripple.isSystem`.
  Attributes: `url`, `peerName`, `token`. The resource is the *deployment*, not a database:
  a Ripple database is a **name** (the Transactor DO is `idFromName(name)`; the log lives
  under `db/<name>/…`), there is no create-database endpoint and no list, so the provider
  creates nothing — it resolves the peer's URL, carries the shared token, and proves the peer
  serves `/health`. The untyped `create(name)` / `connect(name)` are the same zero-network
  upsert: they validate the name and return a client; the first data transact materializes
  the database. The typed wrap (`SchemaFx.fromReadWrite(system).create(name, catalog)`)
  still upserts the name, then **ensures** the catalog with a schema tx. `destroy` forgets
  the resource; it does **not** erase any log, segments or DOs.
- **Capabilities** — `Ripple.ReadSystem` / `WriteSystem` / `ReadWriteSystem` still yield
  the untyped system (`create(name)`). Wrap with `SchemaFx.fromRead` / `fromWrite` /
  `fromReadWrite` for the catalog-generic client: `create(name, catalog)` / `connect`
  (write / read-write **ensure**; read skips ensure). Typed database client: `transact`
  (gen), `q` (builder), `query` (with `x-ripple-*` meta), `info`, `health`, and the
  `asOf(t)` / `history()` views. Pull is `eid.pull` on a `find` Eid — there is no
  `entity` on the typed surface. `minT` is the read fence, on `q` / `query` and on
  `eid.pull(pattern, { minT })` alike. Privilege follows the
  system — `fromWrite(WriteSystem).create` hands back a write-only database client.
- **Layers** — `*SystemBinding` (Worker service binding to the peer, same-colo, no public hop),
  `*SystemHttp` (plain HTTPS, works anywhere), `*SystemLocal` (`Alchemy.Action`, `alchemy dev`).
- **Errors** — tagged, one per condition the peer/DOs report: `TxRejected`, `TransactorDead`,
  `BadRequest`, `NotFound`, `Unauthorized`, `QueryBudgetExceeded`, `Internal`, `NetworkError`
  (union `Ripple.DatabaseError`, guard `Ripple.isDatabaseError`), plus `SchemaEnsureError`
  when write `create` / `connect` cannot install the catalog. Name check is still
  `BadRequest`. Catch them with `Effect.catchTags` instead of reading status codes.
- **Db-per-tenant** — one `system.create(tenantId, Movies)` per request. No resource per
  tenant, no deploy, no provisioning. The typed create **does** touch the network (ensure
  is a schema tx); the untyped `create(name)` is still the zero-network upsert. The client
  it returns is the same peer/service binding, `fetch`, token and headers pointed at
  `/db/:name/…`. The name is validated (`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`) — an
  invalid one **fails the Effect** with `BadRequest`; ensure failure is `SchemaEnsureError`.
  The **token is shared** across every name — it is the peer's one `RIPPLE_TOKEN`, ignored
  when the peer has it unset (`docs/RUNBOOK.md`).
- **Outside Alchemy** — `Ripple.Client.make({ url, name, token?, fetch? })` gives the
  untyped Effect database client to bun scripts and tests, and
  `Ripple.Client.makeSystem({ url, token?, fetch? })` the untyped system client
  (`create(name)` / `connect` / `health`). `SchemaFx.makeSystem({ url, token?, fetch? })`
  is the typed equivalent (`create(name, catalog)`).

## Operations

See `docs/RUNBOOK.md` (metrics/events to watch, the single-writer write
ceiling and how to split a database, tuning knobs, recovery).

## HTTP API (Worker)

```
GET  /health
POST /db/:name/transact   { tx }                          → { t, txEid, tempids, datoms }
POST /db/:name/query      { query, inputs?, asOf?, history? } → { t, root, result }
POST /db/:name/pull       { eid, pattern, asOf?, history? }
GET  /db/:name/entity/:eid[?asOf=]
GET  /db/:name/info
POST /db/:name/admin/index | /admin/gc
```

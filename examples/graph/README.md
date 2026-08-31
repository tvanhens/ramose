# Graph

The minimal offline-first consumer: one configured root, a no-argument
`client.open()`, and a graph of databases the client walks by name.

```
root (example-graph)
 └── organization "acme"          a child database, reached through Graph
      └── board "roadmap"         a child database of that one
           └── issues             what the application actually renders
```

## Run it

From the repo root:

```sh
bun run dev:graph
```

That brings up the peer on <http://localhost:1341> and the identity Worker on
<http://localhost:1342>. It is shorthand for

```sh
CI=1 ALCHEMY_STATE=local \
  CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
  CLOUDFLARE_API_TOKEN=x \
  bun alchemy dev examples/graph/alchemy.run.ts
```

with each variable defaulted only when you have not set it yourself (see
`.cursor/CLOUD.md` for why miniflare wants them).

`GET /token` on the identity Worker mints a 60-second ES256 bearer for whoever
asks, and `GET /jwks` publishes the key the peer verifies it against. That is a
**development identity**: the key pair in `src/identity.ts` is public and in this
repository, and must never be used where a real principal exists. Reef shows the
same shape with Better Auth; swapping the two changes nothing on the peer or in
the client.

## The shape

| file | what it is |
|---|---|
| `src/catalogs.ts` | the catalog: `Organization` → `Board` → `Issue`, their operations and the read policy |
| `src/app.ts` | `createClient`, the queries, and the two graph walks |
| `src/identity.ts` | the development key pair, issuer and audience |
| `identity-worker.ts` | the identity plane: JWKS and a token endpoint |
| `resources.ts` / `alchemy.run.ts` | the peer, its R2 store, and the identity Worker |
| `peer.ts` | the Worker entry, with the catalog deployed onto it |

## What it demonstrates

```ts
const client = openApp({ url: location.origin, session })
const root = client.open()                       // no argument: the configured root

const board = root
  .query.from(Organization).where({ slug: "acme" }).one().db()
  .query.from(Board).where({ slug: "roadmap" }).one().db()

const receipt = board.mutate.createIssue({ title: "Written offline" })
await receipt.queued                             // durable on this device
await receipt.committed                          // committed by the server

issue.mutate.close()                             // targeted, from a live handle
```

- The root route is client configuration. Every other database is reached by
  walking a deployed `Graph`, and the peer authorizes every segment of that walk
  on every activation.
- A mutation returns a durable receipt. `queued` resolves once the invocation is
  on this device for good; `committed` resolves when the server has committed it.
- `createIssue` declares an **optimistic projection**: the explicit, declared
  changeset an offline device renders until the server answers. It is never
  inferred from the operation body — the body is deployed code the client
  neither has nor may run.
- Entity handles carry `.data`, `.local` and `.mutate`. `.local.pending` is this
  device's own sidecar state, never a persisted fact about the entity.

## What it does not demonstrate

- **One catalog for every level.** The MVP client installs exactly one catalog,
  so a child database bound to a *different* one fails closed — the client would
  have neither its read view nor its operations. Each `Graph` here binds back to
  this catalog, which is what lets one client open the root, an organization and
  a board and mutate all three.
- **No `select` on a query whose rows you intend to mutate.** A projection is
  not an entity: `db.query.from(Issue)` publishes live handles, and
  `db.query.from(Issue).select({ … })` publishes plain rows.
- **Build the query from the database that answers it.** A query hoisted to
  module scope through the portable `Ramose.Query.from` is the same inert value,
  but it carries no entity focus, so its rows are plain data.

# Reef

The flagship Ramose demo: a Linear-style, multi-tenant issue tracker where
**every workspace is its own Ramose database**, reached by walking a deployed
graph from one configured root. Better Auth is the identity plane; membership
data in the root database is the tenancy boundary; the offline-first
`ramose/client` and `ramose/react` render the board.

## Run it

From the repo root, in two terminals:

```sh
bun run dev:reef      # the peer (:1337) and the auth Worker (:1338)
bun run dev:reef:ui   # the SPA dev server (:5173), proxying /api and /db
```

Then open <http://localhost:5173>, create an account, and make a workspace.
The dev server serves the same same-origin shape production uses, so no
CORS or baked URLs are involved.

## The architecture

```
auth Worker (:1338)   Better Auth on D1: sign-in, JWKS,
                      POST /api/auth/ramose/token → 15-minute JWT
        │                  (class "user", attrs { name, email })
        └── JWKS ──► Ramose peer (:1337)
                     one deployed catalog, root database "reef",
                     Transactor/QueryReplica DOs, R2
```

The auth Worker never talks to the peer, so the resource graph is a DAG: the
peer's env needs the auth Worker's JWKS (a service binding deployed, a URL in
dev), and the auth Worker needs nothing back.

Identity is deployment-global: every signed-in account mints the same class
(`user`), and the JWT carries no database or role. What a principal can reach
is data:

- The root database holds `person` rows (the directory, upserted from the
  JWT by operations) and `workspace` rows. A workspace composes the `Graph`
  trait, so it *is* a child database.
- `policy.workspace.read.where((ws) => ws.members.contains(actor))` is the
  tenancy rule. The graph walk resolves a workspace through the filtered
  database, so a non-member cannot see the workspace, its name, or activate
  its child database — that is the read policy, not a UI filter.
- Inside a workspace database the walk itself is the boundary; issues,
  comments and labels are readable by any activated principal, and
  `issue.privateNote` shows a field-level rule (creator only).
- Writes are catalog-bound operations. `createIssue` declares an optimistic
  projection, so an offline device renders its own writes until the server
  commits and converges without a rollback flash.

## The shape

| file | what it is |
|---|---|
| `src/domain/schema.ts` | the catalog: `person`, `workspace`, `label`, `issue`, `comment`, their operations, and the applied policy |
| `src/domain/queries.ts` | the queries the app and tests share |
| `src/domain/rank.ts` | fractional ranking — a drag writes one `:issue/rank` double |
| `src/domain/shared.ts` | auth config, ports, and the workspace slug rules |
| `src/infra/api.ts` | the auth Worker: Better Auth (jwt + `ramose/better-auth` mint plugins) on D1, serving the built SPA as assets |
| `src/infra/resources.ts` / `peer.ts` | the Ramose peer with the catalog deployed onto it |
| `src/infra/domain.ts` | `REEF_DOMAIN` — production naming and routing |
| `src/app/` | the React SPA on `ramose/react` |
| `dev.ts` | the SPA dev server: Bun serve + `/api` and `/db` proxies |
| `test/` | policy and catalog shape, slug rules, ranking — unit tests |

## Deploying to real Cloudflare

The live demo is **https://reef.ramose.ai**, published by
`.github/workflows/reef-publish.yml` on every merge to master. One hostname
serves both Workers:

| path | Worker | how |
|---|---|---|
| `/db/*` | the Ramose peer | a zone route (`src/infra/resources.ts`) |
| everything else | the auth Worker | a custom domain (`src/infra/api.ts`), assets-first |

`REEF_DOMAIN` is what turns all of that on (see `src/infra/domain.ts`). Set,
it attaches the domain and the route and pins the physical names of the
Workers, the D1 database and the R2 bucket; unset, a deploy is an ordinary
personal stage with generated names.

```sh
bun run build:reef
REEF_DOMAIN=reef.ramose.ai bun alchemy deploy examples/reef/alchemy.run.ts --stage prod --adopt
```

Without `REEF_DOMAIN` the SPA needs the peer's origin baked in, because the
auth Worker and the peer sit on different `workers.dev` hosts: deploy once,
then rebuild with `--define 'REEF_PEER_ORIGIN="<peerUrl>"'` and deploy again —
`.github/workflows/reef-preview.yml` does exactly this for every PR.

The API token needs the `todos` e2e permissions (Workers Scripts, R2 — see
CONTRIBUTING.md) **plus `Account / D1 / Edit`** for the Better Auth database,
plus zone access for the hostname.

One thing the local run cannot show you, handled in `src/infra/resources.ts`:
deployed, the peer reaches the auth Worker's JWKS through the `AUTH`
**service binding** (`jwksService`), not its public URL — Cloudflare answers
a Worker→Worker subrequest on `workers.dev` with error 1042 instead of the
key set, and every token would 401.

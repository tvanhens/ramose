# Reef

The flagship Ramose demo: a Linear-style, multi-tenant issue tracker in one
Ramose database. Better Auth supplies identity; workspace membership and
reference-based read policy isolate each tenant's data. The offline-first
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
public Web Worker → auth Worker (:1338): Better Auth on D1, sign-in, JWKS,
                      POST /api/auth/ramose/token → 15-minute JWT
        │                  (class "user", attrs { name, email })
        └── JWKS ──► Ramose peer (:1337)
                     one deployed catalog, root database "reef",
                     Transactor/QueryReplica DOs, R2
```

The public Web Worker routes `/api/*` to the private auth Worker and `/db/*`
to the peer through service bindings. Its own URL is a runtime binding, so
preview bundles need no generated URLs. The
peer needs the auth Worker's JWKS through a service binding, and the auth
Worker needs nothing back.

Identity is deployment-global: every signed-in account mints the same class
(`user`), and the JWT carries no database or role. What a principal can reach
is data:

- The database holds `person`, `workspace`, issue, comment, and label rows.
- `policy.workspace.read.where((ws) => ws.members.contains(actor))` is the
  tenancy rule. A non-member cannot see the workspace or its related rows —
  that is the read policy, not a UI filter.
- Required workspace references scope issues and labels; comments inherit the
  workspace through their issue. Membership policy follows those references, and
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
| `src/infra/api.ts` | the auth Worker: Better Auth (jwt + `ramose/better-auth` mint plugins) on D1, reachable through service bindings |
| `src/infra/resources.ts` / `peer.ts` | the Ramose peer with the catalog deployed onto it |
| `src/infra/web.ts` / `web-worker.ts` | the public SPA and same-origin gateway |
| `src/infra/domain.ts` | `REEF_DOMAIN` — production naming and routing |
| `src/app/` | the React SPA on `ramose/react` |
| `dev.ts` | the SPA dev server: Bun serve + `/api` and `/db` proxies |
| `test/` | policy and catalog shape, slug rules, ranking — unit tests |

## Deploying to real Cloudflare

The public Web Worker serves the SPA and routes authentication and database
requests through native service bindings. The auth Worker has no public
`workers.dev` endpoint. Set `REEF_DOMAIN` to attach the public custom domain
and pin resource names; leave it unset for an isolated preview stage.

```sh
bun run build:reef
bun alchemy deploy examples/reef/alchemy.run.ts --stage preview
```

One build and one deployment work for both previews and production. The stack
returns `appUrl` for the browser and `peerUrl` for direct peer diagnostics.

Run `bun run test:reef` to exercise the production bundle in Chromium against
local Workers and D1, including credentials, workspace writes, and rejection
feedback.

The API token needs the `todos` e2e permissions (Workers Scripts, R2 — see
CONTRIBUTING.md) **plus `Account / D1 / Edit`** for the Better Auth database,
plus zone access for the hostname.

The peer obtains JWKS through the private `AUTH` service binding. The public
Worker supplies its runtime URL to the auth Worker so origin validation and
cookies use the browser’s address even behind local forwarding.

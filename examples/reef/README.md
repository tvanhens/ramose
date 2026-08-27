# Reef

The flagship Ramose demo stack: a Linear-style, multi-tenant issue tracker
where **every workspace is its own Ramose database**. Better Auth
(organizations + JWKS-published JWTs) is the identity plane, and the
compiled policy on the peer enforces admin / member / viewer per datom.

## Run it

From the repo root:

```sh
bun run dev:reef
```

That brings up the peer (`:1337`) and the auth Worker (`:1338`). It is
shorthand for

```sh
CI=1 ALCHEMY_STATE=local \
  CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
  CLOUDFLARE_API_TOKEN=x \
  bun alchemy dev examples/reef/alchemy.run.ts
```

with each variable only defaulted when you have not set it yourself (see
`.cursor/CLOUD.md` for why miniflare wants them).

## The architecture

```
auth Worker (:1338)   BetterAuth on D1: sign-in, orgs, JWKS,
                      POST /api/auth/ramose/token
        │
        └── JWKS ──► Ramose peer (:1337)
                     RAMOSE_POLICY + JWKS verify,
                     Transactor/QueryReplica DOs, R2
```

The auth Worker never talks to the peer, so the resource graph is a DAG:
the peer's env needs the auth Worker's URL (for `RAMOSE_JWKS_URL`), and
the auth Worker needs nothing back.

A workspace is a Better Auth org whose slug is the Ramose database name.
`POST /api/auth/ramose/token` (the `ramose/better-auth` mint plugin) mints
a 15-minute JWT with `ramose: { db: <slug>, class: <role> }`.

## The shape

```
examples/reef/
  alchemy.run.ts        the stack: peer + auth Worker
  src/
    domain/             catalog, policy, queries, ranking, roles, constants, operations
    infra/              the peer resources and the auth Worker entry
  test/                 policy compilation and ranking — unit tests
```

| file | what it is |
|---|---|
| `src/domain/schema.ts` | the schema: `user`, `issue`, `comment`, `label` namespaces |
| `src/domain/policy.ts` | `Ramose.Policy.policy` — classes `owner`/`member`/`viewer`, per-datom read masks, per-operation write arms |
| `src/domain/queries.ts` | every navigational query and pull shape; compiled against the policy in tests |
| `src/domain/rank.ts` | fractional ranking — a drag writes one `:issue/rank` double |
| `src/domain/roles.ts` / `shared.ts` | Better Auth access-control roles and the constants both Workers share |
| `src/infra/api.ts` | the auth Worker: BetterAuth (organization + jwt + `ramose/better-auth` mint plugins) on D1 |
| `src/infra/resources.ts` / `alchemy.run.ts` | the peer (`Ramose.Server` owns it: `auth` is the source of truth) and the stack wiring both Workers |
| `src/domain/operations.ts` | typed operations imported by infra and policy tests |
| `test/` | policy compilation + masked-pull checks, role→class mapping, ranking |

## Deploying to real Cloudflare

The live demo is **https://reef.ramose.ai**. One hostname serves both
Workers:

| path | Worker | how |
|---|---|---|
| `/db/*` | the Ramose peer | a zone route (`src/infra/resources.ts`) |
| everything else | the auth Worker | a custom domain (`src/infra/api.ts`) |

`REEF_DOMAIN` is what turns all of that on (see `src/infra/domain.ts`).
Set, it attaches the domain and the route and pins the physical names of
the Workers, the D1 database and the R2 bucket; unset, a deploy is
exactly what it always was.

```sh
REEF_DOMAIN=reef.ramose.ai
bun run scripts/build-packages.ts
REEF_DOMAIN=$REEF_DOMAIN bun alchemy deploy examples/reef/alchemy.run.ts --stage prod --adopt
```

The API token needs the `todos` e2e permissions (Workers Scripts, R2 —
see CONTRIBUTING.md) **plus `Account / D1 / Edit`** for the Better Auth
database.

Two things the local run cannot show you, both handled in
`src/infra/resources.ts`:

- The peer reaches the auth Worker's JWKS through the `AUTH` **service
  binding** (`RAMOSE_JWKS_SERVICE`), not its public URL. Deployed, both
  Workers sit on `*.workers.dev`, and Cloudflare answers a Worker→Worker
  subrequest there with error 1042 instead of the key set — every token
  would 401.
- `RAMOSE_POLICY` is a plain-text binding, capped at 5.1 kB. The compiled
  policy is namespace-shaped for that reason (`test/policy.test.ts` pins
  the size); miniflare enforces no such limit.

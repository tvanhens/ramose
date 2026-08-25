# Reef

The flagship demo: a Linear-style, multi-tenant, real-time issue tracker where
**every workspace is its own Ramose database**. One app exercises every
headline feature — reactivity (`useLive` over `db.live`), multi-tenancy
(`db.install()` at runtime), auth (Better Auth JWTs verified by the peer
against a compiled `Ramose.Policy`), immutability (`db.asOf` time travel +
`db.history`), and a StyleX design system with dark/light themes. The UI is
written entirely with the `ramose/react` hooks.

## Run it

From the repo root, one command:

```sh
bun run dev:reef
```

That brings up the peer (`:1337`), the auth Worker (`:1338`) and the Vite dev
server (`:5173`) — the SPA is a `Command.Dev` resource in the same stack, so
it starts once both Workers are serving and is torn down with them. It is
shorthand for

```sh
CI=1 ALCHEMY_STATE=local \
  CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
  CLOUDFLARE_API_TOKEN=x \
  bun alchemy dev examples/reef/alchemy.run.ts
```

with each variable only defaulted when you have not set it yourself (see
`.cursor/CLOUD.md` for why miniflare wants them). Then open
http://localhost:5173.

Sign up (accounts are auto-verified — the demo ships no mailer), create a
workspace, and you are on the board. Open a second browser window on the same
account to watch writes propagate live.

> Cross-connection live updates (two windows, two sign-ins) work locally under
> miniflare too. An earlier caveat here about writes only showing up on
> reconnect was issue #28 — sessions sharing a database in one isolate dying on
> the basis fan-out — fixed in `packages/ramose/src/worker/session.ts`.

## The architecture

```
browser SPA (Vite + React 19 + StyleX)
  ├── cookies ──────────► auth Worker   BetterAuth on D1: sign-in, orgs,
  │                       (:1338)       JWKS, POST /api/auth/ramose/token
  └── JWT per request ──► Ramose peer   RAMOSE_POLICY + JWKS verify,
                          (:1337)       Transactor/QueryReplica DOs, R2
```

The browser is the **only** Ramose data-plane client. The auth Worker never
talks to the peer, so the resource graph is a DAG: the peer's env needs the
auth Worker's URL (for `RAMOSE_JWKS_URL`), and the auth Worker needs nothing
back.

A workspace is born entirely from the browser: Better Auth org create →
`POST /api/auth/ramose/token` (the `ramose/better-auth` mint plugin) mints a
15-minute JWT with
`ramose: { db: <slug>, class: <role> }` → `ramose.db(slug, Reef).install()` →
seed labels + the creator's `user` row. No resource, no deploy — a database is
a name.

## The shape

Everything lives under `src/`, split by the runtime it executes in — the
browser, a Cloudflare Worker, or the Alchemy stack on your machine:

```
examples/reef/
  alchemy.run.ts        the one stack: peer + auth Worker + dev-only Vite (`Ui`)
  index.html            Vite root → src/app/main.tsx
  src/
    domain/             shared by every runtime: catalog, policy, queries, ranking, roles, constants
    infra/              deploy-time + Worker code: the peer resources and the auth Worker entry
    app/                the browser SPA (React 19 + StyleX)
  test/                 unit tests over src/domain — part of `bun run test`
```

| file | what it is |
|---|---|
| `src/domain/schema.ts` | the schema: `user`, `issue`, `comment`, `label` namespaces |
| `src/domain/policy.ts` | `Ramose.Policy.policy` — classes `admin`/`member`/`viewer`, `preset` ownership (creator/author pinned to the caller), `issue.privateNote` masked to admin |
| `src/domain/queries.ts` | every navigational query and pull shape; compiled against the policy in tests |
| `src/domain/rank.ts` | fractional ranking — a drag writes one `:issue/rank` double |
| `src/domain/roles.ts` / `shared.ts` | Better Auth access-control roles and the constants both Workers and the SPA share |
| `src/infra/api.ts` | the auth Worker: BetterAuth (organization + jwt + `ramose/better-auth` mint plugins) on D1 and the built SPA as Worker assets |
| `src/infra/resources.ts` / `alchemy.run.ts` | the peer (`Ramose.Server` owns it: `auth` is the source of truth) and the one stack wiring both Workers plus the dev-only `Ui` (`Command.Dev` running Vite) |
| `src/app/ramose.ts` | the workspace wiring: `Ramose.token.jwt` over `authClient.ramose.token` plus create-time `install()` / label seeds; handed to screens as `{ slug, cls, token }` — the peer stamps `sub` / `role` / name / email; screens read `db.principal()` |
| `src/app/route.tsx` | path-based SPA pages (`/`, `/:slug`, `/:slug/issues/:id`) so refresh and a shared URL land on the same screen |
| `src/app/` | the SPA: `ui.tsx` primitives (icons, buttons, dialog, toasts, priority glyph), auth screen, workspace picker, live kanban board, issue detail, time travel |
| `test/` | policy compilation + masked-pull checks, role→class mapping, ranking — part of `bun run test` |

## What each screen demonstrates

- **Workspace picker** — multi-tenancy. Creating "Coral Team" runs
  `ramose.db("coral-team").install()` under the creator's freshly-minted
  admin JWT, then the URL becomes `/coral-team`. Switching workspaces is
  React's own remount: `<RamoseProvider key={slug}>` closes the old client
  and connects a new one whose `Ramose.token.jwt` source re-mints as the
  token nears `exp`, so 15-minute tokens refresh themselves. Refresh stays
  on the board — Vite and the auth Worker both fall back to `index.html`.
- **Board** — local-first reactivity. Columns render one `useLive(db, boardQuery)`
  read against the session overlay; a drag is one `useTransact` `run` writing
  two datoms (status + rank) and the card moves as soon as the pending layer
  applies — the `live` pill pulses on every `ticks` bump `useLive` reports
  (local apply, ack, or an inbound filtered `tx`). There is no refetch code
  anywhere in the app. On a phone, hold a card still, then drag — a flick
  still scrolls the board. An empty board offers **Add sample issues**: nine
  issues, labels and assignees in one `db.run`.
- **Issue detail** — policy in the small. Opening a card is
  `/:slug/issues/:id`, so refresh keeps the panel open. Description and the
  admin-only note ride one standing `usePull`, so edits from another tab
  land in place.
  That note is `Issue.privateNote.optional` in pull shapes (required pulls of
  a masked attribute fail *at compile time* — see `test/policy.test.ts`), and
  comments — a `useLive` on a per-issue query — carry `preset` authorship.
- **Invite → viewer** — enforcement is server-side. A viewer's UI is polite
  (no + buttons, a `viewer` badge, the admin note tagged *masked*), but the
  proof is that a forced write — drag a card — applies locally, then comes
  back from the peer as `Unauthorized`; the pending layer drops, the card
  snaps back, and the toast reads "remove denied on :issue/status".
- **Time travel** — immutability. The slider re-renders the whole board via
  `useQuery(db.asOf(t), boardQuery)` — same query, one extra argument —
  `useBasis` is the slider's ceiling, and deleted issues are recovered from
  `db.history`.
- **Themes** — dark and light are one StyleX `createTheme` over the token
  vars (`src/app/theme/`); the class goes on `<html>` so portaled dialogs and
  toasts inherit it, and the choice persists (first visit follows the OS).

## Deploying to real Cloudflare

The live demo is **https://reef.ramose.ai**, republished from `master` by
[`.github/workflows/reef-publish.yml`](../../.github/workflows/reef-publish.yml).
One hostname serves both Workers:

| path | Worker | how |
|---|---|---|
| `/db/*` | the Ramose peer | a zone route (`src/infra/resources.ts`) |
| everything else | the auth Worker + the built SPA | a custom domain (`src/infra/api.ts`) |

The data plane is therefore **same-origin** with the SPA — a transact is never
preflighted — and the peer keeps its `workers.dev` hostname, which is what the
`Ramose.Server` health check probes.

`REEF_DOMAIN` is what turns all of that on (see `src/infra/domain.ts`). Set, it
attaches the domain and the route and pins the physical names of the Workers,
the D1 database and the R2 bucket; unset, a deploy is exactly what it always
was. The pinning is not cosmetic: CI keeps stack state in the Actions cache,
and Alchemy's generated names carry a random suffix, so without it an evicted
cache would create an empty D1 and R2 and orphan every account and workspace.

A one-off deploy to the real demo, the way CI does it — the peer's URL is known
up front, so the SPA is built first and the whole thing ships in one pass:

```sh
REEF_DOMAIN=reef.ramose.ai
bun run scripts/build-packages.ts                       # see the warning below
VITE_RAMOSE_URL="https://$REEF_DOMAIN" bunx vite build examples/reef
REEF_DOMAIN=$REEF_DOMAIN bun alchemy deploy examples/reef/alchemy.run.ts --stage prod --adopt
```

> **Build the packages first, every time.** `ramose`'s exports resolve `bun` →
> `src` but `default` → `dist`, and Vite is not Bun. The peer Worker is
> resolved by Alchemy under Bun, so it always ships current `src` — but the
> SPA bundles `packages/ramose/dist`, so a skipped build silently ships
> whatever client was left over from the last one. Nothing fails; the bundle
> hash simply does not move while `ramose/db` changes go missing.

To a personal stage on `workers.dev`, where the peer URL only exists *after*
the first deploy, it stays two passes:

```sh
bun alchemy deploy examples/reef/alchemy.run.ts          # first pass: Workers + D1 + R2
bun run scripts/build-packages.ts                        # refresh packages/ramose/dist
VITE_RAMOSE_URL=<peerUrl> bunx vite build examples/reef  # bake the peer URL into the SPA
bun alchemy deploy examples/reef/alchemy.run.ts          # second pass: ship the assets
```

The API token needs the `todos` e2e permissions (Workers Scripts, R2 — see
CONTRIBUTING.md) **plus `Account / D1 / Edit`** for the Better Auth database.
The deployed SPA is served by the auth Worker itself, so cookies stay
same-origin with no proxy.

Two things the local run cannot show you, both handled in
`src/infra/resources.ts`:

- The peer reaches the auth Worker's JWKS through the `AUTH` **service
  binding** (`RAMOSE_JWKS_SERVICE`), not its public URL. Deployed, both Workers
  sit on `*.workers.dev`, and Cloudflare answers a Worker→Worker subrequest
  there with error 1042 instead of the key set — every token would 401.
- `RAMOSE_POLICY` is a plain-text binding, capped at 5.1 kB. The compiled
  policy is namespace-shaped for that reason (`test/policy.test.ts` pins the
  size); miniflare enforces no such limit.

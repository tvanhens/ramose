# Contributing to Ramose

Ramose uses Bun workspaces. The published package is `packages/ramose`, examples
are in `examples`, and public documentation is in `website/src/content/docs`.

## Reviewable changes

Keep each review unit narrow enough for one complete review. Around 1,200
hand-written additions, including tests, is a planning signal rather than a
quota: split before coding when a change is likely to exceed it or spans
unrelated risk boundaries.

Request review after the implementation and relevant checks are stable.
Automated review runs on every push to a ready pull request, so keep the pull
request in draft while implementing and while batching a review round's
root-cause fixes; mark it ready for one verification review rather than one
review per corrective commit. If a second re-review uncovers another
independent blocker class, pause and split or redesign the change. Describe the
primary outcome, intentional public API additions, and relevant test lane in
the pull request.

## Setup and checks

```sh
bun install
bun run typecheck
bun run test:unit
bunx playwright install chromium
bun run test:browser
bun run test:local
bun run test
bun run build
```

Use the test lane that owns the behavior:

| Lane | Command | Scope |
| --- | --- | --- |
| Unit | `bun run test:unit` | Deterministic logic without platform services |
| Browser | `bun run test:browser` | Chromium and browser APIs |
| Local | `bun run test:local` | Worker, Durable Object, R2, cache, WebSocket, and authentication integration |
| Cloudflare | `bun run test:e2e:cf` | Edge and deployment behavior |

Regression tests protect stable invariants, not individual review comments.
Group pure cases in table-driven unit tests; use browser or local tests only for
boundary behavior that those lanes uniquely prove.

Do not introduce mocks, fake platform services, scripted peers, in-memory
infrastructure substitutes, DOM shims, or fake IndexedDB. Re-record browser
frame fixtures with `bun run record:frames`; do not edit the recordings by hand.

`bun run test:local` and `bun run record:frames` start a container image pull
that never returns on a machine whose `docker-credential-desktop` hangs. Each
run leaks about ten hung `docker pull` and credential-helper pairs, so repeated
runs exhaust the per-user process table and every later spawn fails. Recover
with `pkill -x docker-credential-desktop`.

## Local development

Run the Todos example and local peer with:

```sh
bun run dev:todos
```

The peer listens on `http://localhost:1337`. Run e2e tests against it with:

```sh
RAMOSE_URL=http://localhost:1337 bun run test:e2e
```

`bun run dev:graph` runs the offline-first browser client's example instead: a
peer on `http://localhost:1341` and the identity Worker that mints its bearers
on `http://localhost:1342`. `bun run test:browser` starts and stops that same
stack itself, so a browser test can drive the example against a real peer.

## Cloudflare e2e

`bun run test:e2e:cf` deploys a temporary stage, runs the e2e suite, and removes
the stage. It requires:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `RAMOSE_TOKEN` only when the deployed peer requires bearer authentication

Set `KEEP_STAGE=1` to retain the temporary stage for investigation.

## Cloudflare benchmark

```sh
bun run bench:cf [concurrency] [seconds-per-phase]
```

`bun run bench:cf` deploys a throwaway benchmark stage with test hooks and a
small operation catalog, drives the raw transaction path and the `/op` path
from this machine, prints throughput and latency per phase with the
transactor's batch statistics, and destroys the stage. It requires the same
Cloudflare variables as the e2e suite. Transactor tuning variables such as
`RAMOSE_MAX_BATCH` and `RAMOSE_BATCH_BUDGET_MS` are forwarded to the stage, and
`BENCH_LABEL` tags the printed rows so runs can be compared. `KEEP_STAGE=1`
retains the stage. `bun run bench:cf:compare` runs the same benchmark twice,
first against the `master` package source and then against the current
branch, so the two result tables can be compared directly.

## Documentation site

```sh
cd website
bun run dev
bun run check
bun run build
bun run preview
```

Documentation pull requests are previewed automatically. Pushes to `main` or
`master` publish the production site.

## Releases

The package is built into `packages/ramose/dist` and published as `ramose`.
Use npm 11.5.1 or newer.

```sh
bun run release:dry 0.2.0
bun run release 0.2.0
```

The dry run performs release validation without committing, publishing,
tagging, or pushing. The release command updates versions, runs checks, builds,
publishes, tags, and pushes. Prerelease versions use the `next` dist-tag by
default. Useful overrides include `--no-tag`, `--no-push`, `--tag <name>`, and
`--allow-dirty`.

Local publishing uses npm login. The release workflow uses npm trusted
publishing, with `NPM_TOKEN` as a fallback.

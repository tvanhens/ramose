# Contributing to Ramose

Development notes for people changing Ramose itself. Consumer docs live at
[ramose.ai](https://ramose.ai)
(source in `website/`); the short path is [`README.md`](README.md). In-repo
design notes stay in `docs/` (`API.md`, `AUTH_LAYER.md`, `QUERY.md`,
`RUNBOOK.md`).

## Local checks

```sh
bun install
bun run typecheck
bun test                        # unit/integration (~390 tests, no services)
```

Local peer + UI (miniflare): see [`README.md`](README.md). Cursor Cloud Agents
should also read [`.cursor/CLOUD.md`](.cursor/CLOUD.md) for harness-specific
port and credential caveats.

## End-to-end tests

`test/e2e` runs against a live peer and skips when `RAMOSE_URL` is unset:

```sh
RAMOSE_URL=http://localhost:1337 bun run test:e2e   # local alchemy dev
bun run test:e2e:cf                                 # real Cloudflare (below)
```

The full suite, including the cross-connection `db.live` wake case, passes
against local miniflare. Run against real Cloudflare for the production-shaped
check.

### Against real Cloudflare

`bun run test:e2e:cf` runs `scripts/e2e-cloudflare.sh`:

1. Deploys a uniquely named Alchemy stage (`e2e-<epoch>-<rand>`, or
   `ALCHEMY_STAGE` if set) with `ALCHEMY_STATE=local` and `CI=1`
2. Waits for `/health`, then for Durable Objects via `/db/e2e-warmup/info`
3. Runs `RAMOSE_URL=<url> bun run test:e2e`
4. Destroys the stage (set `KEEP_STAGE=1` to leave it up)

Required credentials:

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | yes | Workers / DOs / R2 / Analytics Engine |
| `CLOUDFLARE_ACCOUNT_ID` | variable or secret | yes | Account to deploy into |
| `RAMOSE_TOKEN` | secret | no | Only if the peer is deployed with bearer auth |

Token permission groups (account-scoped), at minimum: **Workers Scripts Write**
(covers Durable Objects), **Workers R2 Storage Write**, **Account Settings
Read**. Grant **Account Analytics Read/Edit** if a deploy reports an Analytics
Engine permission error.

The throwaway deploy is an open peer (no `RAMOSE_TOKEN` / `RAMOSE_POLICY`); the
stage name is unguessable and torn down at the end of the run.

## CI

| Workflow | When | What |
|---|---|---|
| `.github/workflows/ci.yml` | every PR and push to `master` | `typecheck` + unit tests |
| `.github/workflows/e2e-cloudflare.yml` | every PR, push to `master`, and `workflow_dispatch` | `bun run test:e2e:cf` |
| `.github/workflows/docs-preview.yml` | PRs touching `website/` | deploy a `pr-<n>` preview of the docs site, comment the URL, destroy on close |
| `.github/workflows/docs-publish.yml` | every push to `master` / `main`, and `workflow_dispatch` | deploy the docs site `prod` stage to Cloudflare |

The e2e, docs-preview, and docs-publish jobs use the GitHub **Development**
environment (`environment: Development`). Put `CLOUDFLARE_API_TOKEN` there as
a secret and `CLOUDFLARE_ACCOUNT_ID` as a variable (or secret). Optional:
`RAMOSE_DOCS_DOMAIN` (variable) overrides the production docs hostname
(default `ramose.ai`; the zone must already exist in the account, and the
token must be able to read the zone and edit its Workers). The existing GitHub
variable may still be named `RIPPLE_DOCS_DOMAIN` — `docs-publish.yml` maps
whichever name is set onto `RAMOSE_DOCS_DOMAIN` for the deploy, so rename the
variable at your convenience. Cursor Cloud Agents
need the same names in the Cursor secrets panel — see
[`.cursor/CLOUD.md`](.cursor/CLOUD.md).

Each run deploys its own Alchemy stage (`ALCHEMY_STAGE=e2e-<run_id>-<attempt>`),
so Worker / Durable Object / R2 names do not collide across parallel jobs. A
fresh workers.dev hostname is eventually consistent across the edge, so a colo
can serve the HTML placeholder (or 1042/1104/"Worker not found") mid-suite;
both the e2e `Peer` harness and the alchemy HTTPS client classify those as
transient and retry them with jittered backoff — application errors never
retry, and CI does **not** serialize the whole account.

### Docs previews

A PR that touches `website/` gets its own preview deployment: an Alchemy stage
named `pr-<number>` (an assets-only Worker on workers.dev), with the URL
posted/updated as a PR comment on every push. When the PR closes — merged or
not — the stage is destroyed and the comment is edited to say so.

Stack state runs with `ALCHEMY_STATE=local` and the `.alchemy/` directory is
carried between runs via the Actions cache, so re-pushes update the same
Worker (stable URL) and teardown can destroy exactly what deploy created. If
the cache was evicted (a PR idle for over a week), teardown falls back to
deleting the Worker named in the preview comment directly via the Cloudflare
API. The minimal CI token above covers everything; Cloudflare-hosted Alchemy
state (`Cloudflare.state()`) is not used because its state store needs Secrets
Store and edge-preview token scopes beyond that minimal set.

### Docs production

Every push to `master` (or `main`) publishes `website/` as Alchemy stage
`prod`: an assets-only Worker named `ripple-docs` serving
[ramose.ai](https://ramose.ai) — the default domain in `website/alchemy.run.ts`
(the zone is onboarded in the account; Alchemy manages the DNS record and edge
certificate). The physical Worker name is pinned so redeploys adopt the same
script, and its workers.dev hostname
([ripple-docs.tvanhens.workers.dev](https://ripple-docs.tvanhens.workers.dev))
stays up as well. Optional: `RAMOSE_DOCS_DOMAIN` (variable) overrides the
hostname — on any stage, which is how the domain-attach path can be tested
against a scratch stage without touching prod. Re-runs update the same Worker
(`.alchemy/` is cached; the pinned name plus `--adopt` recovers from a
cache miss). Manual republish: **Actions → Docs publish → Run workflow**.

## Releasing to npm

Eight packages publish to npm under the `@ramose` scope, all at the same
version. They are only tested as a matched set, so they move in lockstep and
their internal dependencies are pinned exactly (`"@ramose/core": "0.1.0"`, not
a range).

### Cutting a release

```sh
bun run release:version 0.2.0   # root + all 8 manifests
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin HEAD --tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which typechecks,
tests, builds, verifies, and publishes. The tag is the source of truth: if it
disagrees with the manifests the run fails before publishing anything.

To exercise the pipeline without spending a version number, use **Actions →
Release → Run workflow**, which defaults to a dry run. This matters because npm
never allows a version to be reused, even after unpublishing.

### Releasing by hand

```sh
bun run release:dry   # full sequence, publish is a dry run
bun run release       # the real thing
```

Both run `scripts/release.ts`, which is also what the workflow calls — there is
one definition of the release sequence, so local and CI cannot drift.

It refuses to run against a dirty working tree (`--allow-dirty` overrides), so
what gets published always corresponds to a commit. The publish is wrapped in a
`finally` that restores the `workspace:*` ranges: pinning them mutates eight
manifests, and a publish that fails halfway would otherwise leave them pinned
in your tree, ready to be committed by accident.

Provenance is requested in CI and disabled locally, since attestation needs an
OIDC issuer that only CI has.

### The build

`bun run build` compiles each package to `packages/<name>/dist` with `tsc`.
There is no bundler.

The source imports relative modules with explicit `.ts` extensions
(`./datom.ts`), which Bun resolves natively but Node, esbuild, and a consumer's
`tsc` do not. `rewriteRelativeImportExtensions` in `tsconfig.build.base.json`
rewrites those to `.js` on the way out. Emit is unbundled so the file layout —
and therefore the subpath exports — survives the build.

Each package's `exports` map serves both audiences: the `bun` condition points
at TypeScript source (which also ships), everything else resolves to `dist`.
That is what keeps `bun test` instant in this repo while consumers get compiled
output. Deep subpaths accept all three spellings — `@ramose/core/datom`,
`datom.ts`, and `datom.js` all land on the same module.

### Scripts

Day to day you only need the four `bun run` aliases:

| command | what it does |
| --- | --- |
| `bun run build` | compile all 8 packages to `dist` |
| `bun run release:version <v>` | set the version across root + all 8 manifests |
| `bun run release:dry` | full release sequence, publish is a dry run |
| `bun run release` | full release sequence, for real |

Those wrap the individual steps, each of which stays runnable on its own for
debugging:

| script | what it does |
| --- | --- |
| `scripts/release.ts` | the whole sequence, with guaranteed cleanup |
| `scripts/set-version.ts` | set the version across root + all 8 manifests |
| `scripts/build-packages.ts` | compile to `dist`, stage LICENSE/NOTICE/README |
| `scripts/check-release.ts` | verify versions agree, tag matches, exports resolve |
| `scripts/prepare-publish.ts` | rewrite `workspace:*` → the release version |
| `scripts/publish-packages.ts` | publish in dependency order, skipping what exists |

`prepare-publish.ts` is not optional. `npm publish` does not rewrite the
`workspace:` protocol the way `bun publish` does — it would ship
`"@ramose/core": "workspace:*"` in the tarball, which npm cannot resolve. Run
`--restore` to put the workspace ranges back after a local dry run.

### npm authentication

The release workflow prefers [trusted publishing][trusted-publishing] (OIDC)
and falls back to the `NPM_TOKEN` secret. OIDC cannot bootstrap a package that
does not exist yet — the setting only appears on a package's settings page once
it is on the registry — so the first publish of each package uses the token.

After the first release, enable trusted publishing for each package at
`https://www.npmjs.com/package/@ramose/<name>/access` (publisher: GitHub
Actions, repo `tvanhens/ripple`, workflow `release.yml`). Once all eight are
configured, `NPM_TOKEN` can be deleted.

#### 2FA and the release token

If the npm account has 2FA set to "auth and writes", `npm publish` demands a
one-time password and fails with `EOTP` without one. `bun run release --otp
<code>` passes one through, but a TOTP code lasts ~30 seconds and eight
publishes can outrun it. The publish is idempotent, so a code that expires
partway is recoverable — re-run with a fresh one and the packages that made it
are skipped — but it is a poor loop to be in.

The better answer is a token that bypasses 2FA, which is the same token CI
needs. [Classic tokens were removed in November 2025][access-tokens]; create a
**granular access token** at
[npmjs.com/settings/~/tokens](https://www.npmjs.com/settings/~/tokens):

- **Bypass two-factor authentication**: checked — without this it still prompts
- Packages and scopes: **Read and write**. Select the `@ramose` *scope*, not
  individual packages — a token limited to named packages cannot create ones
  that do not exist yet, which is exactly what a first publish does.
- Expiration: as short as is practical

Use it for one run without writing it to `~/.npmrc`. The `env` prefix is
required: the config key contains `/` and `:`, which are not legal in a shell
variable name, so the usual `VAR=value cmd` form fails before npm ever runs.

```sh
env 'npm_config_//registry.npmjs.org/:_authToken=<token>' bun run release
```

Add the same token as the `NPM_TOKEN` repository secret so the workflow can
bootstrap packages that do not exist yet. Delete it once all eight packages
have trusted publishing configured — at that point nothing needs a
long-lived credential.

[trusted-publishing]: https://docs.npmjs.com/trusted-publishers
[access-tokens]: https://docs.npmjs.com/about-access-tokens

## Contributor License Agreement

Outside contributions require signing [CLA.md](CLA.md), enforced by
`.github/workflows/cla.yml`. It grants the right to license contributions under
terms of the maintainer's choosing, which is what keeps relicensing possible
later without tracking down every past contributor. See the workflow header for
the one-time setup (a signatures repo and the `CLA_SIGNATURES_TOKEN` secret).

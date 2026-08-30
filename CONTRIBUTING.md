# Contributing to Ramose

Development notes for people changing Ramose itself. All docs live at
[ramose.ai](https://ramose.ai) (source in `website/`) — the docs site is the
sole documentation location. The shipped query language (`Query.from`, the kernel
`Query.q` / pipeable stdlib, `Q`) is on the website
([Read data](https://ramose.ai/guides/queries/),
[The query language](https://ramose.ai/reference/query-language/),
[Client API](https://ramose.ai/reference/client-api/)).
Recorded benches in [`bench/RESULTS.md`](bench/RESULTS.md);
brand assets (mark, on-dark mark, horizontal and stacked lockups, app icon) in
[`website/public/brand/`](website/public/brand/).
Normative engine contracts live next to the engine, not on the website —
see [Architectural notes](#architectural-notes).

## Architectural notes

The website is the public documentation location. Engine security and
authorization semantics are specified in-repo so implementation and
conformance tests can cite them:

- Authorization and noninterference:
  [`packages/ramose/src/internal/design/authorization.md`](packages/ramose/src/internal/design/authorization.md)
- Versioned opaque database replication:
  [`packages/ramose/src/internal/design/replication.md`](packages/ramose/src/internal/design/replication.md)

Pure synchronous fallible transformations in
`packages/ramose/src/internal/authorization` compose with `Result.gen`
(`yield*` unwraps a `Result`; the first failure short-circuits). Collect
independent Results with `Result.all`. Translate error vocabularies with
`Result.mapError` before `yield*`. Existing Effect orchestration shells
cross that boundary with `Effect.fromResult` — do not turn the pure
binding, validation, or install kernels into `Effect.gen`.

## Public vocabulary

The app surface uses the words the docs teach. Recorded here so a rename
happens once (part of #204, tracker #205). Wire protocol and `:db/*`
internals stay Datomic-shaped.

| Public name | Was | Notes |
|---|---|---|
| `Entity` | `Namespace` | Record type. `Eid` is an id of one. |
| `Field` | `Attr` / `Attribute` | Value and type. |
| `Schema` | `Catalog` | Composition of entities. `db.schema`, `Database({ schema })`. |
| `set` / `remove` / `delete` | `add` / `retract` / `retractEntity` | Tx verbs and policy arm keys. Cardinality-one `set` replaces. Wire stays `:db/add` etc.; compiled policy JSON stays `add` / `retract` / `retractEntity`. |
| `unique: "upsert" \| "strict"` | `"identity" \| "value"` | Named for what they do. Wire stays `:db.unique/identity` etc. |
| `owned` | `isComponent` | Wire stays `:db/isComponent`. |
| `valueType: "string"` | `":db.type/string"` | Lowered internally. |
| `ServerAuth` / `createServer` / `ServerOptions` | `PeerAuth` / `createPeer` / `PeerOptions` | |
| `db.query` | `db.q` | Hatch is `db.effect.query`. `Query.from` is the app constructor; `Query.q` is the generator/kernel spelling. |
| `Claims` / `claims()` / `P.claim` | `MintedClaims`, `Policy.Claims`, `P.claims` | One token-payload type; no new JWT fields. |

Public writes are `db.run`. There is no public `db.transact`. The internal seed
tool (`seedWrite`, not exported from `ramose/db`) still uses a `TxHandle`
(`tx.entity()`), not `Entity`.
Value-type helpers `Long` / `Instant` / `Uuid` stay as the advanced-form
vocabulary (#207). `Query.q` + `pipe` remain the generator/kernel spelling
under `Query.from`. The remaining casing pass (`./workerEntry`, error
suffixes) is deferred — do not bikeshed it on this pass.

## Local checks

```sh
bun install
bun run typecheck
bun run test:doubles            # reject new test doubles (#390)
bun run test:unit               # fast package tests (`--parallel=3`, no workerd)
bunx playwright install chromium # one-time local browser install
bun run test:browser            # actual Chromium + actual browser APIs
bun run test:local              # Alchemy local stack (serial, workerd)
bun run test                    # unit then local
bun website/scripts/docs-check.mjs   # cited snippets + docs facts; blocks CI
bun run dev:todos               # local peer on :1337
bun run dev:reef                # frozen during the authorization redesign; not a CI/compatibility target
```

`dev:*` runs the whole stack under miniflare and sets `CI=1`,
`ALCHEMY_STATE=local`, and placeholder Cloudflare credentials the emulator
insists on — nothing is uploaded. A raw `bun alchemy dev <stack>` without
those keys fails with `AuthError: No credentials configured`. Cursor Cloud
Agents should also read [`.cursor/CLOUD.md`](.cursor/CLOUD.md) for
harness-specific port and credential caveats.

## Choosing a test layer

Four lanes. Pick the shallowest one that can prove the claim. **Do not
introduce mocks, fakes, scripted peers, or in-memory infrastructure
substitutes** (issue #390). `AGENTS.md` carries the same policy.

| Layer | Command | When |
|---|---|---|
| Pure unit | `bun run test:unit` | Parsers, query lowering, policy compilation, state transitions, error classification, retry decisions, serialization. No Worker, DO, R2, Cache API, WebSocket, or auth service. If a failure reaction is a pure transition, feed it ordinary input values. |
| Real browser | `bun run test:browser` | Browser APIs such as IndexedDB, Web Locks, BroadcastChannel, and lifecycle behavior. Install Chromium once with `bunx playwright install chromium`; never substitute fake IndexedDB or a DOM shim. Fixtures in `test/browser/fixtures.ts` contain ordinary browser setup only. |
| Alchemy local | `bun run test:local` | Anything that crosses an infrastructure boundary. One shared stack (`test/local/alchemy.run.ts`) with `Test.make({ dev: true })`. Unique database names; do not reset DO/R2. During the authorization redesign, `/db/*` is 401; local tests still exercise the real Worker/DO/R2 topology (health, deny, `/__test__/*` recorders and checkpoints). Successful install/transact/query/live claims resume when #344 / #339 / #343 reopen the data plane. |
| Cloudflare e2e | `bun run test:e2e` / `test:e2e:cf` | Edge propagation, deployment convergence, production persistence, and Cloudflare failures workerd cannot reproduce honestly. The same peer contract (`test/contracts/peer.contract.ts`) runs here against `RAMOSE_URL`. |

Allowed instrumentation wraps a real implementation and forwards to it:

- `test/support/recorder.ts` / `test/support/live.ts` — recording `fetch` and `WebSocket` that always call through
- Checkpoints in `packages/ramose/src/internal/test-hooks.ts` (`transactor.commit`, `replica.apply`, `session.notify`, `indexer.run`)
- `POST /__test__/db/:name/r2|storage|basis|checkpoint|abort|transact|query|index|info|log|sessions` — write/corrupt real local R2, exercise storage tiers over real local R2/Cache bindings, invoke the real Worker basis cache/fetch/invalidation path, arm/release/throw at a checkpoint, abort a DO isolate, forward `{ tx }` / `{ query | pull | entity }` to the real Transactor / Replica DO, run or inspect the real transactor/indexer, read its real SQLite log, or inspect real hibernation attachments (status and body pass through; nothing invents success)
- `GET /__test__/db/:name/catalog-proof` — read the exact deployment-bound proof from the real test Worker registry so data-plane conformance requests cannot fabricate or copy a host-side deployment identity
- `GET /__test__/db/:name/session|watch|subscribe` with a WebSocket upgrade — forward to the real Replica DO session/basis-watch endpoint or the real Transactor subscriber; a session `token` is verified by the deployed peer's real JWT verifier
- `IndexedDbReplicaStorage.writeCounts()` — counters incremented immediately after the real IndexedDB transactions that stored a node, manifest, head, or staged chunk actually committed; nothing reads them to make a decision
- `test/browser/frames/*.ndjson` — a **recorded replication frame fixture**, streamed verbatim over the browser lane's own dev server (`vitest.browser.config.ts`) so the real `ReplicationSession`, the real NDJSON decoder, real IndexedDB, and the real observation fence are exercised through the real network path. The other browser suites already feed the identical frame values to that same real storage by direct call; this only makes the delivery real. It is not a peer: no protocol state machine, no request parsing, no per-call scripting, and no conditional behavior — one committed file, chosen by the database name already in the URL, exactly as a static file server would

These routes are 404 unless `RAMOSE_TEST_HOOKS=1` and `RAMOSE_STAGE` is not `prod`. They must not invent a successful transact, query, or frame.

Not allowed: `scriptedPeer`, `FakeSocket` / `fakeDispatch`, `MemoryBucket` / `MemCache`, in-memory browser storage, fake IndexedDB, DOM shims, Better Auth `memoryAdapter`, `mock.module("cloudflare:workers")`, in-process peers, scripted fetch/WebSocket implementations, fake DO namespaces, or a virtual service whose only purpose is to fail on the Nth call. `Alchemy.inMemoryState()` is Alchemy's deploy-state store for the real local stack, not a Ramose double.

### Replica scale probe

`test/browser/replica-scale.browser.test.ts` measures the persisted replica at
10k and 100k logical datoms — cold snapshot and atomic install, the validated
cold restore, and one single-datom change — against the budgets #480 publishes,
and reports node/manifest write amplification from the adapter's own counters.
It runs as part of `bun run test:browser`; to see the measured numbers rather
than just the pass, run it on its own:

```sh
bunx vitest run --config vitest.browser.config.ts --reporter=verbose \
  test/browser/replica-scale.browser.test.ts
```

The dataset is seeded, so a rerun measures the same work. Assert against the
published budget, never against a local best time — CI Chromium is several
times slower than a developer machine.

`bun run test:doubles` (`scripts/check-test-doubles.ts`) fails CI on new violations. The completed #390 migration leaves `scripts/test-double-allowlist.json` empty; keep it empty. Faults that cannot be induced locally belong in pure decision tests or cloud e2e — do not fabricate a substitute implementation that claims to prove them.

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
| `.github/workflows/ci.yml` | every PR and push to `master` | `typecheck` + `test:unit` + `test:browser` + `test:local` (parallel jobs) + `docs-check` |
| `.github/workflows/e2e-cloudflare.yml` | every PR, push to `master`, and `workflow_dispatch` | `bun run test:e2e:cf` |
| `.github/workflows/docs-preview.yml` | PRs touching `website/` | deploy a `pr-<n>` preview of the docs site, comment the URL, destroy on close |
| `.github/workflows/docs-publish.yml` | every push to `master` / `main`, and `workflow_dispatch` | deploy the docs site `prod` stage to Cloudflare |
| `.github/workflows/reef-preview.yml` | **frozen** (authorization redesign) | does not deploy; `workflow_dispatch` refuses. Rebuild is later. |
| `.github/workflows/reef-publish.yml` | **frozen** (authorization redesign) | does not deploy; `workflow_dispatch` refuses. Rebuild is later. |

`examples/reef` is frozen during the authorization redesign: it is excluded
from `typecheck` and `test:unit`, and no workflow deploys it. The tree stays
in the repo as a reference. Do not edit it to keep CI green — later
authorization PRs must land without touching Reef. A dedicated rebuild will
redeploy it after the new model is done.

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

### Reef (frozen)

Reef preview and production publish are **intentionally frozen**, not
accidentally broken. `reef-preview.yml` and `reef-publish.yml` have no
deploy triggers; a manual run exits with an error. `tsconfig.json` excludes
`examples/reef`, and `test:unit` does not run `examples/reef/test`. Local
`bun run dev:reef` still points at the frozen source for inspection, but
Reef is not a public API or backwards-compatibility test.

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

One package publishes to npm: `ramose`, from `packages/ramose`. The
enumerated subpath set is `ramose`, `ramose/db`, `ramose/db/effect`,
`ramose/worker`, `ramose/better-auth`, and `ramose/effect` (the Effect
escape hatch).
The engine (`core`, `storage`, `transactor`, `replica`) lives under
`src/internal/` and is not a public import. The published tarball is `dist`
(with declaration maps); `src` does not ship.

The private workspace root carries the same version, and
`scripts/check-release.ts` fails the release if the two drift.

### Cutting a release

```sh
bun run release:dry 0.2.0   # rehearse it: no side effects whatsoever
bun run release 0.2.0       # bump, commit, publish, tag, push
```

That is the whole thing. In order it bumps the two manifests and commits them
as `release: v0.2.0`, typechecks, tests, builds, verifies, publishes, tags the
release commit, and pushes the branch and tag.

Omit the version to release whatever the manifests already say.

#### Rerunning is safe

Every step checks before it acts, so a run that dies halfway — a network blip,
an expired 2FA ceremony — is fixed by running the same command again:

| step | on a rerun |
| --- | --- |
| version bump | skipped when the manifests already say that version |
| publish | skips versions already on the registry |
| git tag | left alone if it exists |
| push | no-op if the remote already has it |

Two things never happen twice by overwriting: **an existing tag is never
moved**, and **a published version is never republished**. If HEAD has advanced
since the release, the tag stays on the commit that was actually released
rather than being dragged forward.

`release:dry` runs the identical sequence and uploads, commits, tags and
pushes nothing — the manifests are put back afterwards. Use it freely; npm
never allows a version to be reused, even after unpublishing.

CI runs the same script. Pushing the tag triggers
`.github/workflows/release.yml`, and since `bun run release` has already
published, that run skips the publish and just creates the GitHub Release. The
tag is checked against the manifests first, so a mistyped tag fails before
anything is published.

Useful flags: `--no-tag`, `--no-push`, `--tag <dist-tag>`, `--allow-dirty`.

#### Prereleases

The dist-tag is derived from the version, so a prerelease stays off `latest`:

| version | dist-tag | `npm install ramose` gets it? |
| --- | --- | --- |
| `0.2.0` | `latest` | yes |
| `0.2.0-alpha.1` | `next` | no — needs `@next` |

Pass `--tag <name>` to override. The publish prints the version and dist-tag
before uploading anything, so check that line if you are unsure. A dist-tag can
be moved after the fact, but only after people have already installed what it
pointed at.

### Publishing locally vs from CI

`bun run release` publishes from your machine; the workflow publishes from CI.
Both run `scripts/release.ts`, so the sequence cannot drift — the differences
are only these:

| | local | CI |
| --- | --- | --- |
| npm auth | your login (2FA ceremony in the browser) | trusted publishing (OIDC), `NPM_TOKEN` as fallback |
| [provenance][provenance] | no — needs an OIDC issuer | yes |
| GitHub Release | created by the workflow, from the pushed tag | same |

Publishing locally works with no `NPM_TOKEN` and no trusted publishing
configured, which is what to do while OIDC is still being set up. The tag that
`bun run release` pushes still triggers the workflow; the version is already on
the registry by then, so the publish skips and the run only creates the GitHub
Release. That skip path only reads the registry, which needs no credentials, so
it succeeds even when CI cannot authenticate at all.

What a local publish gives up is provenance: attestation needs an OIDC issuer
that only CI has, which is why the local script passes `--no-provenance`.
Packages published this way are not cryptographically linked to the commit and
workflow that built them. Nothing breaks; the npm page just lacks the "Built
and signed on GitHub Actions" badge.

The release refuses to run against a dirty working tree (`--allow-dirty`
overrides), so what gets published always corresponds to a commit. Nothing
mutates a manifest between the build and the publish, so there is nothing to
restore if it fails halfway.

[provenance]: https://docs.npmjs.com/generating-provenance-statements

### The build

`bun run build` compiles `packages/ramose/src` to `packages/ramose/dist` with
`tsc`, in one pass. There is no bundler and no build order.

The source imports relative modules with explicit `.ts` extensions
(`./datom.ts`), which Bun resolves natively but Node, esbuild, and a consumer's
`tsc` do not. `rewriteRelativeImportExtensions` in `tsconfig.build.base.json`
rewrites those to `.js` on the way out. Emit is unbundled so the file layout —
and therefore the subpath exports — survives the build.

Every `exports` entry resolves to `dist`, and the published tarball ships
`dist` only. There is no `bun` condition: one manifest goes to both audiences
(`scripts/release.ts` does not rewrite it on the way out), so a condition
pointing at `src` would resolve here and be absent from the tarball. Bun is
the sharp edge — it always applies the `bun` condition and does not fall back
to `default` when the target is missing, so such an entry makes the package
unimportable under Bun while Node stays happy. `scripts/check-release.ts`
now fails on any `exports` target that `files` does not ship.

What keeps `bun test` instant in the checkout is the `paths` block in the root
`tsconfig.json`: Bun honors it at runtime, ahead of `node_modules`, for both
`import` and `Bun.resolveSync`. It mirrors the public subpath set one-for-one,
so adding an entry to `exports` means adding it there too.

There are no wildcard subpaths; `ramose/internal/*`, `ramose/query`,
`ramose/schema`, and `ramose/workerEntry` do not resolve. Example test suites
that need the engine use workspace-relative imports.

`ramose/effect` is the opt-in Effect escape hatch, not the app path: a
re-export module so a consumer whose resolver refuses undeclared imports
(pnpm without hoisting, Yarn PnP) never has to name `effect` in their own
manifest. Two copies of `effect` in one tree would be two incompatible sets
of types — that failure is confined to the hatch and the deploy surface —
so the ranges in `packages/ramose/package.json` are load-bearing; the
`//dependencies` key there explains each one. `alchemy` is pinned to the
tested 2.x beta and bumped per release.

### Scripts

Day to day you only need these:

| command | what it does |
| --- | --- |
| `bun run release <v>` | the whole release: bump, commit, publish, tag, push |
| `bun run release:dry <v>` | the same sequence with no side effects at all |
| `bun run build` | compile the package to `dist` |
| `bun run release:version <v>` | just the version bump and its commit |

Those wrap the individual steps, each of which stays runnable on its own for
debugging:

| script | what it does |
| --- | --- |
| `scripts/release.ts` | the whole sequence, idempotent |
| `scripts/set-version.ts` | set the version on the root + the package, then commit (`--no-commit` to skip) |
| `scripts/build-packages.ts` | compile to `dist`, stage LICENSE/NOTICE |
| `scripts/check-release.ts` | verify the versions agree, the tag matches, `exports` and `files` resolve |
| `scripts/publish-packages.ts` | publish, skipping a version already on the registry |

`check-release.ts` fails the release if a `workspace:` range appears in the
published manifest: `npm publish` (unlike `bun publish`) ships those verbatim
and npm cannot resolve them.

### npm authentication

The release workflow prefers [trusted publishing][trusted-publishing] (OIDC)
and falls back to the `NPM_TOKEN` secret. OIDC cannot bootstrap a package that
does not exist yet — the setting only appears on a package's settings page once
it is on the registry — so the first publish uses the token.

After the first release, enable trusted publishing at
`https://www.npmjs.com/package/ramose/access` (publisher: GitHub Actions, repo
`tvanhens/ramose`, workflow `release.yml`). Once it is configured, `NPM_TOKEN`
can be deleted.

#### npm version

Publishing needs npm **11.5.1 or newer**; `scripts/release.ts` checks this
before it does any work. Trusted publishing requires it, and so does 2FA on a
modern account: npm has [stopped accepting new TOTP enrollments][2fa], so fresh
2FA setups are passkeys or security keys, and completing one from the CLI means
a browser-based WebAuthn ceremony that older npm cannot run. Old npm falls back
to demanding a TOTP code the account cannot produce and fails with `EOTP`.

```sh
npm install -g npm@latest
```

#### 2FA on publish

With a passkey or security key, `npm publish` hands off to the browser, you
approve with Touch ID or the key, and the publish continues. There is no code
to type — `--otp` only applies to a TOTP account, where it passes a code
through. A TOTP code lasts ~30 seconds, which one publish comfortably fits
inside; the publish is idempotent anyway, so an expired code is recoverable.

#### The release token

CI needs a credential for a package that does not exist yet, since OIDC cannot
bootstrap one. [Classic tokens were removed in November 2025][access-tokens];
create a **granular access token** at
[npmjs.com/settings/~/tokens](https://www.npmjs.com/settings/~/tokens):

- **Bypass two-factor authentication**: checked — without this it still prompts
- Packages and scopes: **Read and write**. Scope it broadly enough to *create*
  `ramose` — a token limited to named packages cannot create one that does not
  exist yet, which is exactly what a first publish does.
- Expiration: as short as is practical

Add it as the `NPM_TOKEN` repository secret. To use one locally for a single
run without writing it to `~/.npmrc`, note that the `env` prefix is required:
the config key contains `/` and `:`, which are not legal in a shell variable
name, so the usual `VAR=value cmd` form fails before npm ever runs.

```sh
env 'npm_config_//registry.npmjs.org/:_authToken=<token>' bun run release
```

**This is a stopgap by design.** Bypass-2FA tokens were blocked from managing
accounts, orgs and packages in [July 2026][gat-restriction], and are
[expected to lose direct publish rights around January 2027][gat-deprecation] —
reduced to staging a publish that a maintainer then approves with 2FA. Move to
trusted publishing as soon as the packages exist and delete the token.

[2fa]: https://docs.npmjs.com/about-two-factor-authentication
[gat-restriction]: https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/
[gat-deprecation]: https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/

[trusted-publishing]: https://docs.npmjs.com/trusted-publishers
[access-tokens]: https://docs.npmjs.com/about-access-tokens

# Cursor Cloud environment notes

Non-obvious setup and runtime caveats for Cursor Cloud Agents working on Ramose.
Standard commands live in `CONTRIBUTING.md` and the `scripts` block of `package.json`;
this file is only the harness-specific detail. The update script has already
installed Bun and run `bun install`, so dependencies are ready when an agent starts.

## Tooling
- The package manager is **Bun** (not npm/pnpm). Node exists on the VM but is not
  used for dependency management. Bun is installed at `~/.bun/bin` and is already
  on `PATH`.

## Lint / test / build
- There is no separate linter. The type checker is the lint gate:
  `bun run typecheck` (`bunx tsc --noEmit`).
- Tests: `bun run test` (unit/integration across `packages/*` + `examples/todos`,
  ~390 tests via `bun:test`, no services required).
- `bun run test:e2e` runs `test/e2e` against a live peer and only executes when
  `RAMOSE_URL` is set (otherwise the tests skip). Point it at a local peer
  (`RAMOSE_URL=http://localhost:1337 bun run test:e2e`) or use
  `bun run test:e2e:cf` for a real Cloudflare deploy (below).
  - The full e2e suite passes against a local `alchemy dev` (miniflare) peer,
    including the cross-connection "a write on another connection wakes db.live"
    case. (An earlier local caveat about that case failing was issue #28 — the
    shared basis watcher's cross-context fan-out killing sessions — fixed in
    `packages/worker/src/session.ts`.)
- There is no production "build" step for local dev; the app runs via `alchemy dev`
  (miniflare) and Vite.

## Running the app (peer Worker + demo UI)
- The peer runs under Alchemy/miniflare, which emulates R2 + both Durable Objects
  in one process — there is **no external database** to start.
- Non-obvious startup requirements for `bun alchemy dev`:
  - Set `CI=1`. Without it, Alchemy tries interactive Cloudflare login and fails
    with `AuthError: No credentials configured` even in local mode.
  - Provide placeholder Cloudflare creds: `CLOUDFLARE_ACCOUNT_ID` (any 32-hex
    string) and `CLOUDFLARE_API_TOKEN=x`. `ALCHEMY_STATE=local` keeps state local.
  - Full command:
    `CI=1 ALCHEMY_STATE=local CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef CLOUDFLARE_API_TOKEN=x bun alchemy dev examples/todos/alchemy.run.ts`
- **Port gotcha:** this Alchemy version serves the peer on **`http://localhost:1337`**,
  not `8787` as some older notes say. Point the UI and e2e tests at 1337:
  `VITE_RAMOSE_URL=http://localhost:1337 bunx vite examples/todos` (UI on `:5173`).
- HTTP API routes are prefixed per database: `POST /db/<name>/transact`,
  `POST /db/<name>/query`, `POST /db/<name>/pull`, `GET /db/<name>/info`. There is a
  top-level `GET /health`. In `tx` maps, every key must be a fully-qualified ident
  (e.g. `:todo/title`); a bare key like `done` is rejected as `tx/invalid`.

## Running the e2e suite against real Cloudflare

The full flow, credentials, and CI wiring live in
[`CONTRIBUTING.md`](../CONTRIBUTING.md). From a Cloud Agent:

```sh
bun run test:e2e:cf
```

Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the Cursor Secrets
panel, then start a new agent so they are injected. Without them the script
exits immediately with a clear error; local `alchemy dev` still works with
placeholders (above). Token permission groups are listed in CONTRIBUTING.md.

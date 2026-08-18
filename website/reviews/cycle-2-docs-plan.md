# Cycle 2 — Docs plan

**Owner:** the Docs agent. Files you own: `website/src/content/docs/getting-started/*`,
`guides/*`, `concepts/*`, `reference/*`, the **sidebar array only** in
`website/astro.config.mjs`, the root `README.md`, and consistency with
`docs/QUERY.md`. Do not touch `index.mdx`, `theme.css`, components, or `public/`.

**Ground truth.** `website/reviews/shipped-api.md` §5.5 / §5.6 / §12 is **stale**:
master PR #30 made `orderBy` / `limit` / `offset` run **server-side**, retired the
callback query builder (deleted), and made `db.live` suppress identical
consecutive emissions. Where this plan and that file disagree, this plan wins.
Never invent an API, flag or file: every symbol below exists in `packages/` or
`examples/`.

**Two verbatim strings the Landing agent is also using — copy them exactly.**

Two-tab wording (use as a `:::note` body wherever the caveat appears):

> On the local emulator writes do not propagate between isolates, so a second
> tab picks them up on reload. Your own tab always updates, because its own write
> moves its own connection forward. Against a deployed peer, every connected
> client updates.

Reef one-liner:

> [`examples/reef`](https://github.com/tvanhens/ripple/tree/master/examples/reef)
> — a Linear-style, multi-tenant issue tracker where every workspace is its own
> database, with Better Auth JWTs and a compiled policy. `bun run dev:reef`.

---

## 1. `getting-started/quickstart.mdx` — the big one

### 1.1 Frontmatter and opening (`:1-11`)

- `description:` → `Two minutes from a clone to a running todo app with a live
  query, then the one command that deploys the same stack.`
- Body opening → `In two minutes you will have a todo app running on your
  machine: a typed schema, a database behind it, and a list that updates itself
  when you write. The local half needs no account and no external database —
  everything runs on your laptop.`

Add one line **above** the `<Steps>` block (nothing on the page states a
prerequisite today; verified on Bun 1.3.10):

> You need [Bun](https://bun.sh) — verified on 1.3.10. Nothing else: no Docker,
> no Postgres, no Cloudflare account.

Keep the `:::note[Pre-release]` aside unchanged.

### 1.2 Step 1 (`:22-32`) — unchanged except the closing sentence

Keep `git clone` / `cd ripple` / `bun install` and the "you should see
`node_modules/` at the repository root" paragraph — the dry run confirmed it
word for word.

### 1.3 Replace steps 2 and 3 with **one** run step plus **one** checkpoint step

Delete `:34-68` entirely (both terminals, the four-env-var block, the inner
"Terminal 3 — checkpoint" block, the placeholder-credentials paragraph and the
whole "Older notes… say 8787" paragraph). Replace with:

````md
2. **Start it.** Leave this terminal running.

   ```sh title="Terminal"
   bun run dev:todos
   ```

   Alchemy brings up the peer on **:1337**, then starts Vite on **:5173** and
   hands it `VITE_RIPPLE_URL` — you never set it yourself. You will see:

   ```
   [Peer] ready at http://localhost:1337
   [Ui] ready at http://localhost:5173/
   Done: 10 succeeded
   ```

   The UI is pinned with `--strictPort`, so a busy :5173 fails loudly instead of
   quietly moving to :5174.

   <details>
   <summary>What that script expands to</summary>

   ```sh
   CI=1 ALCHEMY_STATE=local \
     CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
     CLOUDFLARE_API_TOKEN=x \
     bun alchemy dev examples/todos/alchemy.run.ts
   ```

   The account id is a placeholder and the API token is the literal letter `x`:
   `ALCHEMY_STATE=local` keeps the whole stack in miniflare on your machine, so
   nothing is sent to Cloudflare and nothing is billed. The script defaults each
   variable only when it is unset, so run this form if you want to override one.

   </details>

   :::note[A harmless-looking scare]
   When a tab closes you may see workerd print `The Workers runtime canceled
   this request because it detected that your Worker's code had hung`. That is
   the local emulator reaping a live-query socket, not a crash — the peer keeps
   serving.
   :::

3. **Check it.** From a second terminal:

   ```sh title="Terminal 2 — checkpoint"
   curl http://localhost:1337/health
   # {"ok":true,"service":"ripple","stage":"dev","time":1755500000000}
   ```

   Optional, and four seconds: `bun test examples/todos` — four passing tests
   against a real connection, driving the same `todoQuery` and `addTodo` this
   page documents below.

4. **Open the app.** Vite is already serving `http://localhost:5173/`. You
   should see a heading, a text box, and a list — empty on a first run. Alchemy
   keeps its local state in the repository between runs, so anything you added
   earlier is still there. Type "buy milk", press add, and the row appears.
````

Renumber the remaining steps ("Watch a write travel", "Deploy it (optional)").

### 1.4 Two-tab caution (now inside "Watch a write travel")

Replace the `:::caution[Two tabs, locally]` body with the verbatim two-tab
wording above, and change the label to `:::note[Two tabs, locally]`. Keep the
`CONTRIBUTING.md` attribution if you want it, as one trailing clause.

### 1.5 End of `<Steps>`

Add as the last line inside the `<Steps>` block, after the deploy step:

> Ctrl-C in that terminal stops the peer and the UI together.

### 1.6 "What you just ran" (`:102-195`)

- **`examples/todos/src/db.ts` snippet (`:137-158`)**: print the file **as it
  actually reads** — the fallback is `"http://localhost:8787"`. Then delete the
  apologetic parenthetical at `:160-162` entirely. No commentary is needed:
  `bun run dev:todos` always injects `VITE_RIPPLE_URL`, so the fallback is
  unreachable. (Do **not** edit `examples/todos/src/db.ts` — it is outside your
  ownership.)
- Add an orientation note immediately **above** that snippet, because
  `ManagedRuntime`, `Redacted` and `yield*` currently arrive with no warning and
  the Introduction never mentions Effect:

  > Ripple is built on [Effect](https://effect.website). Its API returns Effect
  > values — descriptions of work — so one `ManagedRuntime` per page holds the
  > connection and is disposed with it, `run(…)` executes one of those values
  > from the browser, and `yield*` inside `db.transact` sequences the steps of a
  > write. That is all the Effect the rest of this path needs.

- `:193-195`: `useLive` is **thirteen** lines in the file and the site says
  twelve elsewhere. Say `about a dozen lines` and drop the number.

### 1.7 "Next" and the examples list (`:197-215`)

- Gloss "peer" on its first use in this page (currently a bare code-block title):
  wherever `peer` first appears in prose, write "the peer — the Worker that
  serves your databases".
- `Both examples in the repository` → `The examples in the repository are small
  enough to read in one sitting:` and add the Reef bullet **first**, using the
  verbatim Reef one-liner above (with "peer on :1337, app on :5173" appended).

---

## 2. `getting-started/introduction.md`

- `:41-43` — "a free audit trail" is a compliance word with no caveat, while the
  landing already states the bound. Replace with: `…per-user rules the database
  enforces, history you can query with db.asOf and db.history (bounded by a
  retention window you set — 20 published roots by default), and one database per
  customer without one deployment per customer.` (Verified:
  `packages/transactor/src/host.ts`, `retainRoots: 20`.)
- `:51-53` — "The Quickstart does that in ten minutes." → `today you clone the
  repository and work inside it — three commands, under two minutes, in the
  Quickstart.`
- Define **peer** once, in the mental-model section: `The **peer** is the Worker
  that serves your databases — one deploy, any number of databases.` The word
  currently does not appear on this page at all, yet the quickstart, permissions
  guide and pre-production checklist all use it bare.
- "Start here" (`:55-60`) — add a fourth bullet: `[Reef](https://github.com/tvanhens/ripple/tree/master/examples/reef)
  — the flagship demo: multi-tenant workspaces, JWT auth and a compiled policy in
  one app.`
- Add one paragraph after "Good fit, bad fit" (the skeptic's "is this Convex?"
  goes unanswered on the page where it is asked). Every claim in it is verified
  elsewhere on this branch:

  > **If you are comparing:** Ripple is closest to Convex and Instant in feel —
  > queries that re-run themselves — and closest to Supabase in that
  > authorization is part of the database rather than middleware. The difference
  > is that it deploys into your own Cloudflare account, and a per-customer
  > database is a function call rather than a provisioning step. The full trade
  > is on the [home page](/).

---

## 3. Stale-after-#30 sweep (do this in one pass)

`orderBy` / `limit` / `offset` run **server-side** — verified
`packages/core/src/query/engine.ts` ("order → offset → limit, then resolve pulls
— so a `:limit` only pulls the rows that survive it") and
`packages/alchemy/src/db/NavQuery.ts` (order/limit/offset serialized into the
wire query). The callback builder is **deleted** — `packages/alchemy/src/db`
exports one query entry point, and `docs/QUERY.md` already records "(the
string-var callback builder is retired)".

### 3.1 `guides/before-production.md:77-79`

Replace the checklist item with:

> - [ ] **`limit` bounds what you receive, not what the query scans.** Sorting
>       and paging run on the peer, before pulls, so `limit(20)` pulls only
>       twenty entities and the client never sees the rest — but the `where`
>       clauses still build the full intermediate relation, so a broad query can
>       still exceed `RIPPLE_QUERY_MAX_CELLS`. Narrow with `where`, not with
>       `limit`.

### 3.2 `concepts/for-datomic-users.md:28`

> | Datalog query | a typed navigational builder — `Ripple.query(Todo).where(…).orderBy(…).limit(n).select(…)`, run by `db.q` / `db.live`; there is no string-variable escape hatch today |

### 3.3 `concepts/for-datomic-users.md:44`

Last sentence of the "Queries are typed, and smaller" bullet →
`Ordering, limit, and offset are lowered into the query and run on the server, so
limit(20) really is twenty rows on the wire.`

### 3.4 Final grep

`rg -n "client.?side|callback builder|legacy builder|queryBuilder|QueryVar" website/src/content/docs docs/QUERY.md` — nothing may claim client-side ordering or a callback form. If `docs/QUERY.md` still contains a stale matrix row, fix it there too.

---

## 4. Accuracy fixes

### 4.1 `concepts/architecture.md:21-23`

"the log in the DO's SQLite, segments and roots in R2 — **before** any
acknowledgement" is wrong. Verified `packages/transactor/src/transactor.ts`: the
commit does one SQLite storage write for the whole batch (group commit) before
the ack; R2 segments and roots are published later by the alarm-driven indexer
(`host.ts`: `indexTxThreshold: 500`, `indexIntervalMs: 5_000`). Rewrite as: `the
log lands in the Durable Object's SQLite before any acknowledgement; segments and
roots are published to R2 afterwards by the indexer, and never rewritten.`

### 4.2 `guides/catalog.md:85-91`

"or the call throws when the module loads" is wrong: `Ripple.Attr` uses
`tryInferDbValueType`, which returns `undefined`; the throw is `inferDbValueType`,
reached from `ensure.ts` at catalog install. Replace the last clause with:

> …or installing the catalog fails with `ripple/schema: cannot infer
> :db.type/* from this Schema`. The check runs when the catalog is installed — at
> deploy (`Ripple.Database`) or at `db.install()` — not when the module loads, so
> pass `valueType` as you write the attribute.

### 4.3 `guides/queries.md:206` and `reference/http-api.md:50-52`

The wire names carry the prefix (`packages/replica/src/replica-do.ts`;
`packages/worker/src/index.ts` `access-control-expose-headers`). Write all three
as `x-ripple-ms`, `x-ripple-r2-gets`, `x-ripple-cache-hits`, and add the clause
"all listed in `access-control-expose-headers`, so a browser can read them."

### 4.4 `guides/live-queries.md:32`

Keep "about a dozen lines". Make sure no page states a line count for `useLive`.

---

## 5. First-hour runnability

### 5.1 `guides/live-queries.md:11-28` — the snippet is in the wrong file

The block is titled `src/todos.ts`, imports `./db.ts` and exports
`db.live(todoQuery)`. The real example keeps `todoQuery` in
`examples/todos/src/todos.ts` (which imports no `db`) and hoists
`const todos = db.live(todoQuery)` in `examples/todos/src/App.tsx:7` — which is
exactly what `quickstart.mdx:193` tells the reader. Split the snippet in two:

- `src/todos.ts` — imports and `todoQuery` only (no `./db.ts` import, no stream).
- `src/App.tsx` — `import { db } from "./db.ts";` + `// built once, outside
  render` + `export const todos = db.live(todoQuery);` and the type comment.

The "build the stream outside render" caution then lands on the exact line the
shipped example hoists.

### 5.2 `guides/queries.md:126-136` — "Running a query" never runs one

Add two lines to the block, using only symbols the quickstart's `src/db.ts`
exports (`run = runtime.runPromise`):

```ts
import { run } from "./db.ts";
const rows = await run(db.q(openTodos)); // from the app you have running
```

Plus one sentence: `Inside a Worker, or inside another Effect, you `yield*` it
instead of calling run.` Cross-link the Effect orientation note in the quickstart
(§1.6).

### 5.3 `guides/catalog.md:38-64` — give the snippet a path and a checkpoint

- Title the grown-catalog block `examples/todos/schema.ts` and say plainly
  whether the reader is meant to edit it or read along. Prefer read-along:
  "This is the version every later page assumes — read it here rather than
  editing the shipped example, whose tests use the smaller catalog."
- Add one verified checkpoint sentence to `catalog.md`, `transactions.md` and
  `queries.md`: `bun test examples/todos` (four passing tests, driving the same
  `todoQuery` and `addTodo`). Do **not** claim the peer logs an install
  transaction — nobody verified that line.
- `live-queries.md` checkpoint: "tick a box in the running app and watch the list
  redraw with no refetch."

### 5.4 `guides/permissions.md:100-178` — make it honest about what is runnable

- Add one line at the top of "Running it locally": `These are files you create —
  scripts/local-jwt.ts, policy.ts and the resources.ts edits below do not exist
  in the clone; examples/todos ships without a policy.`
- Fix the fictional import in the `resources.ts` snippet:
  `import { todoDetail } from "./src/queries.ts";` → import from the module that
  exists (`examples/todos/src/todos.ts`) or from the query you defined earlier on
  this page. `examples/todos` has no `src/queries.ts`.
- Keep the manual two-terminal run command (peer + `VITE_RIPPLE_TOKEN=… bunx vite
  examples/todos`) and label it as the manual form, because the token has to be
  injected into Vite yourself. **Do not** write `VITE_RIPPLE_TOKEN=… bun run
  dev:todos`: that script starts its own Vite on `--port 5173 --strictPort`, so
  it would collide, and env passthrough into `Command.Dev` is unverified.
- `Ripple.authEnv` is real (`packages/alchemy/src/index.ts`) — leave it.

---

## 6. Sidebar (`website/astro.config.mjs`, Examples group only)

Add as the **first** item of the Examples group:

```js
{
  label: "Reef — multi-tenant issue tracker",
  link: "https://github.com/tvanhens/ripple/tree/master/examples/reef",
  attrs: { target: "_blank" },
},
```

Change nothing else in that file — the Landing agent owns the rest.

---

## 7. Root `README.md`

- `README.md:29-33` — replace the two-terminal recipe with:

  ```sh
  bun install
  bun run dev:todos     # peer on :1337, app on :5173
  ```

  Keep `bun alchemy dev examples/todos/alchemy.run.ts` below it as the long form.
  **Do not** claim the four env vars are required: a fresh clone was run with all
  four unset and succeeded (`Done: 8 succeeded`), because `alchemy.run.ts` pins
  `Alchemy.localState()`. They are CI/miniflare defaults.
- Add `bun run dev:reef` beside it as the flagship demo, one line.
- `README.md:136` — "its twelve-line `useLive`" → "its dozen-line `useLive`" (the
  hook body is thirteen lines).

Mirror the structure `examples/todos/README.md` already uses (phase 0 rewrote it
to lead with the one command and keep the long form as its expansion).

---

## 8. Before you finish

- `bun run build` in `website/`, then grep `dist/` for phrases that must be gone:
  `CLOUDFLARE_API_TOKEN` (outside the collapsed aside and the deploy step),
  `Terminal 3`, `Both examples`, `run on the client`, `legacy callback builder`,
  `Older notes in this repository`, `an empty list`, `ten minutes`,
  `throws when the module loads`, `thirteen-line`.
- Confirm `reef` now appears on: the quickstart, the Introduction, and the
  sidebar of every page.
- Confirm the two-tab wording is byte-identical in `quickstart.mdx` and
  `live-queries.md` (and matches what Landing put in `index.mdx`).

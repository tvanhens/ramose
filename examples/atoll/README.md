# Atoll — nested graphs, end to end

> **Design fiction. Nothing here runs.** This example is written against the
> API proposed in [#312 (the graph of graphs)](https://github.com/tvanhens/ramose/issues/312)
> and [#313 (traits)](https://github.com/tvanhens/ramose/issues/313), as if
> both were implemented. It exists to *feel* the API before building it: the
> whole surface is stubbed with real types in [`future.ts`](./future.ts), so
> the app typechecks, autocompletes, and red-squiggles — and every spelling
> can be changed and re-judged in minutes.

Atoll is Reef one level up: an **org** graph whose workspace rows *are*
child graphs, each running the workspace catalog. A ring of reefs.

```
org                     ← root graph, catalog "org" (server config)
├── org/acme            ← a Ws row composing Graph(workspaceCatalog)
└── org/skunkworks      ← another row, same catalog, own database
```

## The loop

1. Edit a spelling — in `future.ts` (the API) or in the app files (the usage).
2. `bun run typecheck` from the repo root. [`assertions.ts`](./assertions.ts)
   pins the guarantees; a broken one means the edit cost something.
3. Re-read `workspace.ts` / `org.ts` / `app.tsx` and judge: better or worse?

Friction found while writing is marked in place — `grep -rn "ergonomics:"
examples/atoll`.

## Files

| File | What it exercises |
| --- | --- |
| [`future.ts`](./future.ts) | The proposed API as typed stubs: `Trait`, `Entity(…, { with })`, `Catalog`, `Graph`, `ApiKey`, defaults, `enter`, `Server`, `open(path, catalog)` |
| [`taggable.ts`](./taggable.ts) | An app trait with trait-scoped operations, composed in **both** catalogs (#313 alone) |
| [`workspace.ts`](./workspace.ts) | The leaf catalog: schema with defaults, operations, policy, one value under a permanent key |
| [`org.ts`](./org.ts) | The root catalog: `Ws` composing `Graph(workspaceCatalog)`, memberships, `enter`, one-transaction graph creation, API keys as rows |
| [`server.ts`](./server.ts) | The whole deploy: root catalog + admins + auth, registry by reachability |
| [`app.tsx`](./app.tsx) | The client: one credential, discovery as a trait query, entering a child, unchanged Ramose inside it |
| [`assertions.ts`](./assertions.ts) | Compile-time assertions — what the types promise |

Measured against Reef, the pitch holds up: workspace provisioning collapses
from an install-effect + org-registration + seed dance into one transaction
(`createWsOp`), per-workspace tokens disappear, `createdAt`/`creator`
boilerplate leaves every create body, and discovery is a live query instead
of a directory. The findings below are where the spellings — not the model —
fought back.

## What writing it surfaced

### 1. The rule shape is the load-bearing problem *(rules)*

Three spellings of "allow" coexist on one policy page:

```ts
createIssueOp: true,                                        // constant
moveIssueOp:   ({ me }) => Q.is(Issue.creator, me),         // implicit row (today's style)
enter:         ({ claim }) => (ws) => Q.some(...)(ws),      // #312's curried style
```

Writing every rule in both catalogs, the explicit `(ws) =>` never earned its
keep: no fragment mentioned its row variable more than once, so the trailing
`(ws)` application is pure ceremony. Worse, supporting both shapes breaks
inference — a fragment is itself applicable, so "returns a fragment or a
row-lambda" gives the inner parameter two candidate contextual types and it
degrades to `any` (see the forced annotation in `org.ts`). Pick one:

- **(a)** Implicit row everywhere (today's `rule:` style), with a `Q.self()`
  escape hatch for the rare fragment that must name the decided row twice.
- **(b)** Uncurried `(auth, row) => Fragment` — one shape, inference works,
  loses point-free reuse (which this example never used anyway).

The curried form's stated benefit — vocabulary reuse across arms — survives
under both, since `memberOf` closes over `auth` either way.

### 2. Rules need a root type *(the silent-misroot bug)*

`memberOf` is written against a **Ws** row. The org policy as first drafted
reused it for `membership: { read: memberOf }` and `removeMemberOp` — whose
decided rows are **Membership** rows. That's a bug the types happily accept,
in the security layer, and it *reads* fine. Rules should carry their root —
`Rule<typeof Ws>` — so arming a Ws-rule on a membership arm is a type error,
and `policy` arms should be typed per-entity to check it. (Left in the code
with an `ergonomics:` flag rather than fixed, as the exhibit.)

### 3. `enter` should only exist where `Graph` is composed

Same mechanism as №2: today `EntityArms.enter` is offered on every kind.
Typing arms per-entity against its compositions makes `enter` on a non-graph
kind a red squiggle instead of an install error.

### 4. Trait operations are declared once, paid for per catalog

`addTagOp` is defined beside `Taggable`, then registered in **both**
catalogs' `defineOperations` *and* armed in **both** policies. #313 rule 7
already allows the trait value to carry its operations; the open question is
whether it may also carry a *default* policy arm that composing catalogs
override. Without that, every trait costs 2×N lines across N catalogs; with
it, a trait author writes policy for graphs they've never seen. The example
keeps the explicit form so the cost stays visible.

### 5. The catalog should flatten the threading

`Workspace` (the schema) is passed to `defineOperations`, again to `policy`
(which also takes the operations), again to `Catalog` (which also takes the
policy). Three values, each containing the previous. Either
`Catalog(key, { schema, operations, policy })` flat, or
`Catalog(key, { policy })` with the rest implied — the current nesting is the
worst of both.

### 6. Defaults win; two small questions

The `createdAt`/`creator` deletion across every create body is the single
biggest readability win in the example. Open: (a) should `default` accept a
plain value (`default: "todo"`) — the function form is noise for constants;
(b) `DefaultCtx` is `{ now, me }` and should probably stay exactly that —
anything richer is an operation body wearing a costume.

### 7. Client entry states everything twice *(client)*

`ramose.open(`org/${ws.name}`, workspaceCatalog)` re-states the path the
discovery row already knows and the catalog the row's `:graph/catalog` stamp
already records — two runtime mismatches waiting. The discovery row should be
openable directly, `ramose.open(ws)`, with the handle typed from the Graph
composition's closed-over catalog. Unresolved: `Query.from(Ramose.Graph)`
spans kinds, so mixed `Graph(catalogA)` / `Graph(catalogB)` results make that
handle a union — is narrowing by kind (#313's `.ofType()` open question) a
prerequisite? Path-based `open` stays for bookmarks and deep links either
way. Also unnamed: the root's address (`"org"` — catalog key? Server config?
`ramose.root(orgCatalog)`?).

### 8. Determinism vs secrets

Operation bodies replay (optimistic prefix), so `createAgentKeyOp` cannot
generate its own randomness — same trap as `new Date()` today, which defaults
now fix for timestamps. The stub invents `op.apiKeys.mint()` as an
engine-side run-once helper; alternatively `ApiKey` ships a system operation.
Whichever wins, the constraint deserves a named, documented door — this is
the one place the example had to invent API beyond the issues.

### 9. The invisible registry needs a window

No `children:` map and no module-scope registry is the point — but "which
catalogs does this deploy serve?" now has no place to be read.
`Server(...).catalogs` or a boot log line is owed.

### 10. Small spellings, all improvements

Option-bag `unique: "upsert"` over the `Field.unique()` wrapper; chained
`.many()` over `Field.many()`; `output` optional on operations (most bodies
return nothing); thunk `Graph(() => catalog)` for self-nesting — and if the
recursive case needs the thunk anyway, consider making it the only form.

## Deliberately out of scope

Everything #312 lists as open stays open here: graph lifecycle/deletion,
re-pointing as migration, retroactive composition and backfill, push
invalidation. The example also skips deeper-than-two nesting (the folder
sketch in `org.ts` shows the spelling), `asOf`/`history`, and any real UI.

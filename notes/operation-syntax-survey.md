# Operation syntax survey

A survey of how ten sync/local-first products define writes, and which of their
patterns map onto Ramose's operation model. Researched 2026-08-26 against each
product's live documentation.

## Where Ramose stands today

The current surface (`packages/ramose/src/db/Operation.ts`, reef/todos examples):

```ts
const Op = Ramose.Operation.for(Reef);

export const setTitleOp = Op.patch("issue/set-title", Issue, ["title"], {
  doc: "Set an issue's title",
});

export const addCommentOp = Op(
  "issue/add-comment",
  {
    on: Issue,
    input: Schema.Struct({ body: Schema.String }),
    output: Schema.Struct({}),
    doc: "Add a comment on an issue",
  },
  (op, input) => {
    op.put(Comment, { body: input.body, at: new Date(), author: op.principal, issue: op.self.eid });
    return {};
  },
);

export const operations = Ramose.defineOperations(Reef, {
  setTitleOp,
  addCommentOp,
  // …12 more in reef
});
```

The model underneath — named operations as the only write path, a shared body
that runs optimistically on the client up to the first `op.effect`, server
authority, permissions checked in the database — is sound and none of the
surveyed products argue against it. The friction is in the syntax:

1. **Every operation carries three names.** The export (`setTitleOp`), the wire
   string (`"issue/set-title"`), and the registry key in `defineOperations`.
   Reef restates all fourteen ops by hand in the registry, and nothing stops
   the three names from drifting.
2. **Empty-output ceremony.** 9 of reef's 14 ops carry
   `output: Schema.Struct({})` and end with `return {}`.
3. **effect/Schema verbosity for trivial inputs.**
   `input: Schema.Struct({ body: Schema.String })` for one field; `Schema` is
   also the first thing a newcomer must learn before writing a write.
4. **The contextual `on:` split.** The target entity travels outside the input
   (`db.run(op, id, input)`), `run(issueId, {})` passes an empty object, and
   `op.self.eid` is `Eid | Tempid`, which forces narrowing like
   `if (typeof issueId === "number")` inside `deleteIssueOp`.
5. **`Op.patch` covers only unconditional sets.** "Set or clear" ops
   (`setDescriptionOp`, `setAssigneeOp`, `setPrivateNoteOp`) fall back to the
   full ~15-line form for what is morally a one-liner.

## The survey

### Zero (Rocicorp) — custom mutators

Zero's current API (`defineMutator` / `defineMutators`; the 0.18-era
`createMutators` + `PushProcessor` shapes are gone, and the old built-in CRUD
mutators and RLS permissions are filed under "Old Stuff") is the closest
architectural twin to Ramose: named TypeScript functions shared by client and
server, run optimistically on the client, re-run authoritatively on the server,
with local effects rebased away when the authoritative result replicates back.

```ts
export const mutators = defineMutators({
  issue: {
    update: defineMutator(
      z.object({ id: z.string(), title: z.string() }),
      async ({ tx, ctx: { userID }, args: { id, title } }) => {
        if (title.length > 100) throw new Error(`Title is too long`);
        await tx.mutate.issue.update({ id, title });
      },
    ),
  },
});

mutators.issue.update.mutatorName; // "issue.update" — computed, not typed twice
zero.mutate(mutators.issue.update({ id, title: "New title" }));
```

Notable choices:

- **Wire names are computed from registry structure.** `defineMutators({ issue: { update } })`
  yields `"issue.update"`. One declaration site; no string literal per op.
- **Validator-first, body-second, nothing else required.** The minimal mutator
  is `defineMutator(async () => {})`. Args validation accepts **any Standard
  Schema library** (Zod, Valibot, …), re-checked authoritatively server-side.
- **Trusted context is separate from args**: `ctx.userID` cannot be forged by
  the client — same role as Ramose's `op.principal`.
- **Server overrides**: `defineMutators(baseMutators, { … })` lets the server
  extend or replace a mutator by name (audit logs, notifications), or a shared
  body branches on `tx.location === "server"`. This is the explicit version of
  Ramose's implicit optimistic-prefix halt at `op.effect`.
- **No output channel yet** ("There is not yet a way to return data from
  mutators") — Ramose is ahead here with typed outputs and
  handle-materialization.
- **Invocation returns `{ client, server }` promises** — the two-phase
  resolution Ramose folds into one `db.run` promise.
- Permissions: "there is no need for a special permissions system … plain
  TypeScript code" — weaker than Ramose's deny-by-default database policy.

### Convex — `mutation({ args, returns, handler })`

Server-authoritative named functions, the same "operations are the write API"
stance as Ramose, and the ergonomic benchmark for the definition site:

```ts
export const createTask = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", { text: args.text });
  },
});
```

Notable choices:

- **One object literal.** Args, optional `returns`, and `handler` are keys of a
  single bag — nothing positional, the body is labeled.
- **Args are a bare record of validators**, not a pre-wrapped struct:
  `args: { text: v.string() }`. Convex wraps it itself.
- **`returns` is optional.** No `output: Struct({})`, no `return {}`.
- **Names come from the module graph**: `convex/myFunctions.ts` exporting
  `sum` is `api.myFunctions.sum` via codegen. No string ids anywhere;
  `internalMutation` hides an op from clients.
- **`ctx.db.patch("tasks", id, { tag: undefined })` removes the field** —
  partial update where `undefined` clears, which is exactly the semantics
  Ramose's "set or clear" ops hand-write today.
- **Side effects are exiled to `action`s** which call mutations; scheduling
  (`ctx.scheduler.runAfter`) is transactional with the mutation. Ramose's
  `op.effect` is the in-body equivalent — more flexible, less principled.
- **`customMutation` wrappers** (convex-helpers) centralize auth/context
  injection — the same role as `Operation.for(catalog)`.
- Optimistic updates are a **separate, manual, per-call-site** cache patch
  (`useMutation(...).withOptimisticUpdate(localStore => …)`) — Ramose's
  run-the-same-body-locally is strictly better and matches Zero.

### InstantDB — `db.transact(db.tx.ns[id].op(...))`

A serializable tx-chunk builder rather than named operations:

```ts
db.transact([
  db.tx.todos[workoutId].update({ title: "Go on a run" }),
  db.tx.goals[healthId].update({ title: "Get fit!" }).link({ todos: workoutId }),
]);
db.tx.profiles.lookup("email", "eva@example.com").update({ name: "Eva" });
```

Writes are ad-hoc from the client; safety comes from CEL-like rules
(`instant.perms.ts`, with `data` / `newData` / `request.modifiedFields`)
evaluated server-side per object. Optimistic queue with automatic rollback.
The same builder runs in the admin SDK server-side.

This is a different worldview from Ramose's named-ops-only write path: intent
is not preserved on the wire (a rank change and a column move are just
`update`s), and policy must reconstruct intent from diffs (`modifiedFields`)
instead of trusting a vetted body. Adopting it would give up what
`Operation` exists to provide. Worth stealing anyway: lookup refs as
first-class subjects (Ramose has this), `merge` for deep JSON patches, and how
little syntax the trivial path needs.

### Triplit — draft-proxy updates

```ts
await client.update("employee", "Fry", async (e) => {
  e.name = "Philip J. Fry";
  e.age += 1;
  e.coworkers.add("Bender");
});
```

The most ergonomic "change one row" call site in the survey — a typed mutable
draft, attribute-level changes captured for sync. Permissions are filter
clauses in the schema, server-enforced; rollback on server rejection is
manual (`onEntitySyncError` + `clearPendingChangesForEntity`), which is worse
than Ramose. Caveat: no npm release since 2025-07;
treat as dormant — a pattern source, not an ecosystem to align with.

### ElectricSQL — no write API by design

Electric is read-path sync only; writes are "your API." The promoted path is
now TanStack DB collections — `collection.insert/update` optimistically, an
`onInsert`/`onUpdate` handler POSTs to your backend, and the optimistic
overlay is held until the Postgres `txid` the handler returns is observed on
the read stream. Everything Ramose's operations standardize (naming, typing,
validation, authorization, optimistic rollback) is left to the app. Nothing
to borrow syntactically; it validates that a product in Ramose's position
should own the write path rather than punt.

### PowerSync — SQL writes + CRUD upload queue

Client writes are plain local SQL (or Drizzle/Kysely sugar); every write is
recorded as a generic `PUT`/`PATCH`/`DELETE` row-diff in an upload queue that
your `uploadData` connector drains against your backend. Lowest possible
call-site ceremony, but **semantic intent is lost on the wire** — the docs
themselves note custom operations ("increment column by 1") as a future hope,
and conflict handling degrades to per-field LWW. This is the anti-pattern
Ramose's named operations exist to avoid; the survey value is confirmation,
not syntax.

### Automerge / Yjs — the merge layer

```ts
handle.change((d) => { d.tasks[0].done = true; });   // Automerge
ydoc.getMap("favorites").set("food", "pizza");        // Yjs
```

Imperative mutation of a draft (Automerge) or typed shared objects (Yjs),
automatic CRDT merge, binary deltas on the wire, no server authority, no
permissions in core. A different problem than Ramose's (server-authoritative,
policy-checked, history-keeping). The one transferable idea is the same as
Triplit's: mutate-a-typed-draft is the ergonomic ceiling for simple edits.

### Ditto / Fireproof / Evolu

- **Ditto**: writes are DQL strings (`ditto.store.execute("INSERT INTO cars DOCUMENTS (:newCar)", …)`)
  with CRDT types declared inline in the query. String-based, no host-language
  typing — a step backward from Ramose's typed handles.
- **Fireproof**: whole-document `database.put`, TS generics, no runtime
  validation, deterministic CRDT merge per `_id`. Too coarse for Ramose's
  datom model.
- **Evolu**: the closest *philosophical* relative — schema types are the
  validators, branded IDs, mutations return typed `Result`s, append-only
  version-less schema. Two lessons: `update("todo", { id, isCompleted })` is a
  clean low-ceremony partial write, and — notably — **Evolu migrated off
  Effect** onto its own `Result`/`Type` primitives to lower its adoption
  barrier. A data point worth weighing for how much `effect/Schema` Ramose
  exposes at the operation definition site.

## Fit ranking

| Product | Execution model vs Ramose | Syntax worth borrowing |
| --- | --- | --- |
| **Zero** | Same (shared body, optimistic client run, server authority) | Registry-computed wire names; validator-first minimal defs; Standard Schema inputs; `{client, server}` result split |
| **Convex** | Same authority model, server-only bodies | Single object literal with `handler:`; optional `returns`; bare-record args; `undefined`-clears patch semantics; internal ops |
| InstantDB | Different (ad-hoc tx chunks + rules) | Chainable serializable builder; `merge`; how small the trivial path is |
| Triplit | Similar client cache, weaker rollback | Draft-proxy `update(id, e => …)` call site |
| Evolu | Client-authoritative | Schema-as-validator; the Effect-exposure caution |
| Automerge/Yjs | Merge layer only | Draft mutation ergonomics |
| PowerSync | Row-diff queue (intent lost) | — (confirms named ops) |
| ElectricSQL | No write path (yours) | — (confirms owning the write path) |
| Ditto | DQL strings | — |
| Fireproof | Whole-doc puts | — |

## Recommendation

**Zero's custom mutators are the best overall map** — it is the only surveyed
product with Ramose's exact execution model, so its syntax decisions transfer
without bending the semantics. **Convex is the best map for the definition
site itself.** The concrete package, in impact order:

1. **Compute wire names from the registry (Zero).** Let `defineOperations`
   accept nested groups and derive `issue/setTitle` from
   `{ issue: { setTitle } }`, with an optional explicit `name:` for wire
   stability across renames. Kills the triple naming and makes the registry
   the single declaration site instead of a restatement.

2. **Make `output` optional and drop the empty-struct ritual (Convex).** No
   `output:` means `{}` on the wire and `void` in the body. Nine reef ops
   lose two lines each.

3. **Accept a bare fields record for `input` (Convex) and Standard Schema
   validators (Zero).** `input: { body: Schema.String }` wrapped into a
   struct internally; any Standard Schema library accepted (effect/Schema
   exposes Standard Schema interop, so zod-first users are not forced through
   `Schema.Struct` on day one).

4. **Give `Op.patch` Convex's patch semantics** — a `null`/`undefined` input
   field clears the field. `setDescriptionOp`, `setAssigneeOp`, and
   `setPrivateNoteOp` collapse from ~15 lines each to one-line patches.

5. **Move to a single labeled options bag** with `handler:` instead of the
   trailing positional body (Convex), which also gives `doc`, `on`, and future
   keys (rate limits, `internal: true`) one obvious home.

6. Smaller alignments: allow `db.run(op, id)` when input is empty; consider
   exposing the optimistic/confirmed split as `{ local, server }` promises on
   the run result (Zero) rather than only the single settled report.

A reef operation after 1–5:

```ts
export const operations = Ramose.defineOperations(Reef, {
  issue: {
    setTitle: Op.patch(Issue, ["title"], { doc: "Set an issue's title" }),
    setAssignee: Op.patch(Issue, ["assignee"], { doc: "Set or clear an issue's assignee" }),
    addComment: Op({
      on: Issue,
      input: { body: Schema.String },
      doc: "Add a comment on an issue",
      handler: (op, { body }) => {
        op.put(Comment, { body, at: new Date(), author: op.principal, issue: op.self });
      },
    }),
  },
});
```

versus today's three names, two empty structs, and a `return {}` per op.

What **not** to adopt: InstantDB/PowerSync-style ad-hoc client writes (they
surrender intent, which Ramose's policy, history, and MCP discovery all lean
on), Ditto's string queries, and Convex's manual per-call-site optimistic
updates (the shared optimistic-prefix body is strictly better).

---

*Sources: zero.rocicorp.dev/docs/mutators; docs.convex.dev (mutation-functions,
writing-data, validation, optimistic-updates, functions-auth); instantdb.com/docs
(instaml, modeling-data, permissions, backend); triplit.dev/docs; electric.ax
(guides/writes, sync/integrations/tanstack) and tanstack.com/db;
docs.powersync.com (handling-writes, client-sdks); automerge.org/docs;
docs.yjs.dev; docs.ditto.live (dql); use-fireproof.com/docs; evolu.dev/docs.*

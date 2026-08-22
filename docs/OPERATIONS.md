# Operations: typed writes, validated where they commit

Proposal. Breaking is allowed — nothing on `master` is frozen. Companion to
`docs/API.md` (the 0.2 client surface) and `docs/AUTH_LAYER.md` (policy).

## 1. The problem, in three parts

**The schema is compile-time only.** `Attr(Schema.NonEmptyString)` narrows
`tx.add` in the editor and then disappears: `Attr` reduces the Schema to a
`:db.type/*` ident (`src/db/Attribute.ts:99-108`, `valueTypes.ts:172-205`) and
the server checks only that tag (`internal/core/tx.ts` → `db.coerce` →
`normalizeValue`). There is no `Schema.decodeUnknown` anywhere in
`packages/ramose/src`. A client that lies — or an old bundle, or `curl` — can
commit `""` into a `NonEmptyString` and `1.5` into an `Int`. The README's
"a wrong write is a red squiggle, not a bad row" is only true of well-behaved
clients today. Validation must run where the write commits.

**Writes are anonymous.** The wire is a raw datom list
(`[":db/add", e, ":issue/status", v]`). Every app immediately re-invents the
missing noun: Reef's `mutations.ts` is sixteen functions of
`(db, args) => db.transact(function* (tx) { … })` — named, argument-shaped
writes with no type for the name, no schema for the arguments, no server
presence, and no atomicity for their read-then-write halves (`ensureSelf`
queries, then transacts, racing every other session). The intent exists; only
the abstraction is missing.

**The UX grew three vocabularies.** Reads hide Effect
(`useLive(db, query)` runs it for you) while writes expose it
(`run(db.transact(function* …))`, every call site prefixed `void`). Errors
surface as `Cause<E>` from `useLive`/`useQuery`/`usePull`, as unwrapped
`unknown` from `useTransact`, and not at all from `useBasis`. Loading is
`rows === undefined` in one hook, `loading` in another, `pending` in a third.
`useTransact` is provider-blind, shares one `error` across a whole panel
(last settler wins), and returns a `Promise<Exit>` no caller in the repository
ever inspects. The server sends `attr` on a policy denial and the client's
`TxRejected` drops it. `R` is pinned to `never` at the React layer even though
`db.transact` propagates a requirements channel.

One design closes all three: the **operation**.

## 2. Goal

A write is a named, schema-typed operation. Its definition — input shape,
output shape, body — is one value shared by browser, Worker and deploy. The
**server** decodes the input, runs the body against the commit-time basis,
enforces policy, and commits — the schemas finally run, where it counts. The
**client** runs the same body optimistically against the overlay and retracts
the pending layer if the server refuses — which is machinery the overlay
already has (`clientTxId` pending layers, `dropLayer` on reject, remap on
ack). Which behavior a definition gets is decided by the Layer that provides
its interpreter, not by the definition.

Non-goals: replacing datalog reads (queries are untouched); removing the four
verbs (`add` / `retract` / `retractEntity` / `entity` remain the substrate
every operation lowers to); a DSL for server logic (bodies are TypeScript run
by Effect, deployed in the peer — not serialized).

## 3. One new noun

```ts
// domain/operations.ts — imported by the browser, the peer, and the stack
import * as Ramose from "ramose/db";
import * as Schema from "effect/Schema";
import { Issue, Reef } from "./schema.ts";

export const MoveIssue = Ramose.Operation("issue/move", {
  input: Schema.Struct({
    issue: Ramose.EidOf(Reef),
    status: Status,
    rank: Schema.Number,
  }),
  output: Schema.Void,
  execute: Effect.fn(function* ({ issue, status, rank }) {
    const tx = yield* Ramose.Tx;
    yield* tx.add(issue, Issue.status, status);
    yield* tx.add(issue, Issue.rank, rank);
  }),
});

export const CreateIssue = Ramose.Operation("issue/create", {
  input: Schema.Struct({ draft: NewIssue }),
  output: Schema.Struct({ issue: Ramose.EidOf(Reef) }),
  execute: Effect.fn(function* ({ draft }) {
    const tx = yield* Ramose.Tx;
    const db = yield* Ramose.Read;                  // datalog at the tx basis
    const last = yield* db.q(lastRankQuery, draft.status);
    const issue = yield* tx.entity();
    yield* issue.add(Issue.title, draft.title);
    yield* issue.add(Issue.rank, rankAfter(last[0]?.rank));
    // …
    return { issue: issue.eid };
  }),
});

export const operations = Ramose.Operations({ MoveIssue, CreateIssue /* … */ });
```

- **`input` / `output` are Effect Schemas.** They are decoded/encoded on both
  sides of the wire — the input schema *is* the server-side validation the
  attr schemas never had. `ParseError` paths become field-level errors.
- **The body is an Effect** whose environment is two services: `Ramose.Tx`
  (the four verbs) and `Ramose.Read` (a `ReadDb` at the basis the body runs
  against). It may also declare its own services; the interpreter's Layer
  must provide them. It may fail with declared domain errors
  (`errors: Schema.Union(…)` of tagged errors) that serialize across the wire
  and arrive typed in `Effect.catchTags`.
- **`Ramose.EidOf(C)`** is the `Eid<C>` schema, so ids in inputs and outputs
  survive the wire and the server's tempid assignment (an output eid minted in
  the body is rewritten through the ack's `tempids`, exactly as pending-layer
  datoms already are).
- Reef's `mutations.ts` is this file with types. The migration is mechanical:
  `(db, a, b, c) =>` becomes `input: Schema.Struct({ a, b, c })`, the
  generator body is unchanged except `tx` arrives by `yield*` instead of by
  argument.

## 4. One definition, two interpreters

| | client (optimistic) | server (authoritative) |
|---|---|---|
| input | `Schema.encode` → wire | `Schema.decodeUnknown` — reject → `InvalidRequest` with issue paths |
| basis | overlay view (confirmed + earlier pending) | commit-loop pre-state — reads are atomic with the commit |
| body | run to produce the pending layer's datoms | run to produce the datoms that commit |
| policy | none (hint only, as today) | `invoke` arm, then `checkTx` on the produced datoms — both must allow |
| outcome | pending layer + `{op:"invoke"}` posted | commit + ack `{ t, txEid, tempids, datoms, output }` |
| on reject | `dropLayer(clientTxId)` — the existing retraction | no `t` spent, typed error in the ack |

The client run is a *prediction*, not a promise: the server may compute
different datoms (a different rank, a different branch of the body). That is
already the overlay's reconciliation model — the ack paints the server's
facts and drops the predicted layer (`paintFacts` + `dropLayer` +
`remapQueued`), so a divergent prediction heals the same way a rejected one
retracts: the standing `live` re-emits and the UI follows. Nothing about
`{op:"tx"}` frames, resync, or covering changes. HTTPS-only clients (Workers)
skip the optimistic half entirely: `submit` is just encode → POST → decode,
same definition, thinner Layer.

`db.transact` remains, unchanged, as the substrate and the escape hatch. An
operation *lowers to* a transaction; the log stores datoms, never op calls —
`asOf` and `history` keep working on facts. The tx entity is annotated
(`:ramose.op/name`, `:ramose.op/input` as JSON) so history answers "what was
*meant*", not only "what changed" — auditing for free.

### Wire

`POST /db/:name/transact` grows a second body form:

```jsonc
{ "invoke": { "name": "issue/move", "input": { … } }, "clientTxId": "…" }
// today's { "tx": [...] } form is unchanged
```

The ack gains `output` (schema-encoded) next to the existing
`{ t, txEid, tempids, datoms }`. Replay dedupe by `clientTxId` in
`recentAcks` covers invokes exactly as it covers raw txs — idempotency is
inherited, and a replayed invoke returns the recorded output.

### Where the server body lives

Bodies are code, so they deploy with the peer — the already-documented
wrapper pattern ("point `main` at your own module that re-exports it")
becomes the front door:

```ts
// peer.ts — the app's Ramose Worker entry
import { makePeer } from "ramose/worker";
import { operations } from "./domain/operations.ts";
export default makePeer({ operations });

// alchemy.run.ts
const worker = Cloudflare.Worker("Peer", { main: import.meta.resolve("./peer.ts") });
```

Policy set the precedent: catalog and policy are deploy-installed *data*
because they are declarative; operations are deploy-bundled *code* because
refinements and invariants are not serializable. An invoke naming an
operation the running peer doesn't carry fails `InvalidRequest`
(`op/unknown`) — the deploy-skew story is an error with a name, not a
fallback. `Ramose.Server` can stamp the registry's names+hashes into the
deploy so drift is visible at `alchemy dev` time.

The peer forwards `{ invoke, principal, clientTxId }` to the transactor DO;
the body runs inside `commitLoop`, between `authorize` and `conn.transact`,
against the same pre-state `checkTx` already reads. That placement is the
whole prize: a body's `db.q` and its writes are one atomic step behind the
one writer — compare-and-swap, unique-title invariants, counters, rank
rebalancing, `ensureSelf` without the race. Budget it like a query
(`QueryBudgetExceeded` applies inside bodies) so a slow body cannot starve
the group commit.

### Policy

One new arm, same language, same deny-by-default:

```ts
const policy = P.policy(Reef, {
  // …
  ops: {
    "issue/move":   P.allow(editor),
    "issue/create": P.allow(editor),
  },
  // optionally, per class: raw datom writes are for admins only
  rawTransact: P.allow(admin),
});
```

Defense in depth is deliberate: the `invoke` arm gates entry, and the datoms
the body produces still pass `checkTx` as the principal — an operation cannot
escalate past field rules, and presets still apply. `rawTransact` (default
`allow` for compatibility, tighten per app) is how an app graduates to
"operations are the only write surface" without Ramose forcing it.

## 5. Errors, one shape

| code | meaning | carries |
|---|---|---|
| `op/unknown` | peer has no such operation | `name` |
| `op/input` | input schema refused | `issues: [{ path, message }]` |
| `op/denied` | `invoke` arm or datom-level policy said no | `name`, `attr?` |
| `op/failed` | body failed with a declared domain error | the tagged error, re-hydrated |
| `tx/*` | body's datoms hit engine validation | as today |

Alongside: the client stops dropping `attr` from `TxRejected`, and ingress vs
transactor denials stop being different tags for the same fact
(`Unauthorized` 403 vs `TxRejected` code `"policy"` — pick one, keep the
status). `issues` paths are what turns a server rejection into a red field
under the right input instead of a toast.

## 6. The React surface, one vocabulary

The consistency pass is worth doing even before operations land; operations
are what it converges on.

- **One error type.** Every hook exposes the flattened tagged union
  (`DbError` or the op's declared errors) — not `Cause` here and `unknown`
  there. `errorMessage` accepts all of it. Defects stay defects.
- **One state vocabulary.** Reads: `{ rows, error, loading }`
  (`useQuery`'s `data` → `rows`, `useLive`'s implicit
  `rows === undefined` becomes explicit `loading`). Writes:
  `{ run, pending, error }`. `useBasis` gets its error channel back.
- **`useOperation`** is the write hook:

  ```tsx
  const move = useOperation(db, MoveIssue);
  //    ^ { run: (input: { issue; status; rank }) => Promise<void>,
  //        pending: boolean, error: MoveIssue.Error | undefined }
  onMove={(id, status, rank) => move.run({ issue: id, status, rank })}
  ```

  Typed by the input schema, scoped per call site (no more one-`error`-per-
  panel, no more `void run(db.transact(function* …))` in JSX), db-aware like
  every read hook, keyed on the same `seamOf` identity. `useTransact` stays
  as the raw-tx twin with the same `{ run, pending, error }` shape.
- **The provider carries a runtime.** `RamoseProvider` builds a
  `ManagedRuntime` over the already-shipped `Ramose.layer`; hooks run through
  it. The `R = never` pin disappears: an operation that requires a service
  gets it from Layers registered at the provider — which is also where a test
  swaps the submit interpreter for an in-memory one. Same definition,
  different Layer, per the design's one rule.
- **Retraction is visible, not just correct.** The overlay already snaps rows
  back; `useOperation`'s per-site `error` (plus an optional provider-level
  `onRejected(op, error)` for the generic toast) is what tells the user *why*
  the card jumped back. The op's name and input are in hand, so the message
  writes itself.

## 7. Attr-level validation still tightens

Operations validate operation inputs; the raw `tx` path (and `rawTransact`
apps) should also stop accepting what the editor rejects. The declarative
subset of an attr's Schema — refinements the AST already exposes
(`minLength`, `pattern`, int-ness, literal unions) — serializes into the
installed attr metadata (`ensure.ts` alongside `:db/valueType`) and the
engine enforces it in `valueFor`, failing `tx/schema-mismatch` with the attr.
Arbitrary refinements stay compile-time on the raw path; that residue is
precisely the argument for closing `rawTransact` once an app's writes are
operations.

## 8. How we get there

1. **Consistency pass (no new concepts).** One error type and one state
   vocabulary across hooks; `attr` kept on `TxRejected`; `useBasis` error
   channel; `ManagedRuntime` in the provider; `Promise<Exit>` dead API
   removed. Breaking, small, immediately felt.
2. **`Operation` + client interpreter (no server changes).** The definition,
   `Ramose.Operations`, `useOperation`, and a submit Layer that lowers to
   today's `{ tx }` POST — optimistic apply and retraction ride the existing
   overlay unchanged. Reef's `mutations.ts` migrates; docs teach operations
   as the write surface, the four verbs as what's inside one.
3. **Server invoke.** `{ invoke }` wire form, `makePeer({ operations })`,
   body execution in the commit loop, output in the ack, `op/*` errors,
   policy `ops` arm. Input schemas now run server-side; read-then-write
   becomes atomic.
4. **Close the gap.** `:ramose.op/*` tx annotation; declared domain-error
   schemas; attr-level declarative validation on the raw path; `rawTransact`
   policy arm; Reef flips it to `admin`.

Each phase ships alone; nothing waits on the whole.

## 9. Invariants preserved

- **One writer, dense `t`, persist-before-ack** — an invoke is one entry in
  the same group commit; rejection spends no `t`.
- **The log stores datoms.** Operations are how writes are *stated*, never
  how history is *stored*; `asOf` / `history` / time travel unchanged.
- **Deny by default** — an unlisted op is uninvokable, and op bodies pass the
  same datom-level policy as everyone else.
- **The overlay contract** — pending layers, `clientTxId` covering, remap,
  resync: untouched. Optimistic operations are new producers of an existing
  thing, not a second reconciliation scheme.
- **Datalog is the read language everywhere** — in components, in bodies on
  the client, in bodies behind the writer. Full power, one syntax.

## 10. Open questions

- **Versioning:** is `name` enough, or `name@n` with the peer serving the
  latest and refusing unknown versions? Start with names; skew is already a
  typed error.
- **Output of an optimistic run:** `run` resolves with the *server's* output.
  Should the provisional output be observable at all, or is "the live query
  already moved" the whole optimistic contract? Lean: the latter — fewer
  states to name.
- **Effects inside bodies beyond Tx/Read** (clock, ids): provide as services
  from day one (`Ramose.OpClock`?) or let bodies close over `Date.now` and
  accept prediction drift, which reconciliation already heals? Lean: heal.
- **Does `ops` policy live in `P.policy` or in `makePeer`?** Policy — it is
  authorization, and it already ships as data.

# Server-Side Operations

- **Status**: Draft for review
- **Date**: 2026-08-22
- **Rendered version**: published as a Claude Code artifact (same content)

Make explicitly defined, schema-checked operations the only way to transact
data to the remote database — while keeping writes optimistic on the client
and revocable on rejection.

## 1. Context: today the client authors the transaction

There is exactly one write path: the app builds a transaction in the browser
with `db.transact(function* (tx) { … })` and submits the raw ops —
`[":db/add", e, a, v]` tuples — to the peer Worker (`db/Db.ts` →
`makeDb.submit`). With a session open, the overlay (`db/overlay.ts`) applies
the same ops locally as a `PendingLayer` keyed by a fresh `clientTxId`, queues
the POST through a FIFO `outbox`, and drops the layer when the ack (or a
rejection) comes back. The server can veto or rewrite a transaction
(`worker/index.ts` → `ingress`, policy `preset`s), but it cannot *originate*
one: all write logic lives in client code, e.g. Reef's
`examples/reef/src/app/mutations.ts`.

Three consequences motivate this design:

- **The server can only say no.** Policy can deny or pin fields, but
  multi-step invariants ("a created issue always gets a status row and an
  activity entry") are only as trustworthy as the client that ran them.
- **No home for side effects.** Provisioning a Reef workspace today is a
  Better Auth call from one Worker plus `install()` and seed transactions run
  *from the browser* under an admin JWT — ordered by client code, with no
  transactional relationship between the steps.
- **No typed request/response contract.** A transaction returns a `TxReport`;
  there is no way for a write to have a declared input and output shape that
  both sides validate.

## 2. Goals and non-goals

### Goals

- Operations are defined explicitly, in app code, with `effect/Schema` input
  and output schemas.
- In operations mode, they are the **only** data write path to the remote
  database; raw `/transact` is closed to app tokens.
- An operation body mixes **transaction steps** (datom writes) with
  **side-effect steps** (anything else: provisioning, auth calls, webhooks).
- Clients execute the same body optimistically *up to the first side-effect
  step* — the optimistic prefix — and queue the operation for server
  persistence; a rejection revokes the optimistic entry.
- Reuse the existing machinery: overlay pending layers, FIFO outbox, tempid
  remap, group commit, replay keys.

### Non-goals

- **Durable offline queueing.** The pending queue stays in-memory, exactly as
  today; the durable-overlay attempt was deliberately reverted (`ad5be3b`)
  and this design does not reopen it.
- **Rebase or CRDT merge.** Rejected operations are dropped, not replayed
  against new state.
- **Distributed transactions across effects.** Side effects are not rolled
  back by a failed commit; the contract is idempotency plus compensation,
  not 2PC.
- **Runtime registration.** The operation set is fixed at deploy time, like
  policy.

## 3. API: defining an operation

An operation is a named value built from `ramose/db` (so definitions stay
portable — they must pass `test/db-portable.test.ts` and import no Worker or
engine internals). The body is an Effect, passed as the third argument to
`Ramose.Operation`: `(op, input) => Effect<Output, E>`, written with
`Effect.gen` (or `Effect.fn`) per house style. `op` exposes the four transaction verbs plus
reads and an effect step, each itself an Effect, so bodies compose like any
other Effect — helpers are plain functions returning Effects, and failures
ride the typed error channel:

```ts
import * as Ramose from "ramose/db";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const createIssue = Ramose.Operation("issue/create", {
  input: Schema.Struct({ title: Schema.String, status: IssueStatus }),
  output: Schema.Struct({ id: Ramose.EntityId }),
}, (op, input) =>
  Effect.gen(function* () {
    const id = yield* op.entity();
    yield* op.add(id, Issue.title, input.title);
    yield* op.add(id, Issue.status, input.status);
    yield* op.add(id, Issue.creator, op.principal.eid); // server-authored identity

    // side-effect step: runs on the server; client execution stops here
    yield* op.effect("notify", ({ env }) => postToSlack(env, input.title));

    return { id };
  }),
);

export const operations = Ramose.Operations({ createIssue, moveIssue, deleteIssue });
```

> **Decision.** The body is `(op, input) => Effect`, not a raw generator
> callback like `db.transact`. An operation returns an output and fails with
> typed errors — exactly the Effect contract — and running the body as a
> fiber is what makes the client-side prefix halt (§5) lawful: `op.effect`
> can end optimistic execution by interruption, with no lexical analysis of
> the body.

The registry is handed to both sides of the wire: `Ramose.Server({ …,
operations })` at deploy time and `ramose.db(name, catalog, { operations })`
in the client. Invocation returns an ordinary Effect, so `useTransact` works
unchanged:

```ts
const { run, pending } = useTransact();
run(db.run(createIssue, { title, status: "todo" })); // Effect<OpReport<typeof createIssue>>
```

> **Decision.** Operation input and output are validated with `effect/Schema`
> at runtime — decoded on client submit and again at server ingress, encoded
> into the ack. This is the codebase's first runtime `Schema.decodeUnknown`;
> decode failures map to `InvalidRequest`, and the decoder rides only on
> `ramose/db`'s existing Effect dependency, so no new client weight.

## 4. Semantics: two kinds of steps, one commit

|                  | Transaction steps | Side-effect steps |
| ---------------- | ----------------- | ----------------- |
| **Verbs**        | `op.entity`, `op.add`, `op.retract`, `op.retractEntity`; reads via `op.q` / `op.pull` against the speculative view | `op.effect(name, run)` |
| **Server**       | Accumulate into *one* transaction, committed atomically at the end via the existing Transactor group commit | Run in step order, immediately, with server context (`env`, bindings, `principal`); results flow to later steps |
| **Client**       | Applied optimistically as a pending layer *if they precede the first effect step*; steps after it are server-only | Never run — client-side `op.effect` interrupts the body fiber, ending execution there |
| **On rejection** | Nothing committed; optimistic layer revoked | Already ran; must be idempotent or compensated |

Interleaving is real, not cosmetic: an effect can produce a value a later
transaction step writes (create an external resource, then record its id as a
datom). But the datoms themselves are all-or-nothing — an operation never
half-commits its writes. And because any step after the first effect may
depend on that effect's response, the client cannot safely guess past it:
the **optimistic prefix** — the transaction steps before the first
side-effect step — is the exact boundary of what can be committed
optimistically. Authors control how much of an operation is optimistic by
ordering effect-independent writes first.

> **Decision.** Effects run *before* the commit, in body order, and are not
> rolled back if the commit is rejected. Authors get one honest contract —
> effects are at-least-once under retry, so they must be idempotent — instead
> of a false promise of distributed atomicity. Idempotency is aided by the
> replay key (§6): a replayed `clientOpId` returns the original ack without
> re-running the body.

## 5. Client: optimistic execution and revocation

Client-side, `db.run(operation, input)` decodes the input, then runs the
*same body Effect* as a fiber against the overlay's speculative view — but
only up to the first `op.effect` step. Transaction verbs in that prefix
collect ops exactly as `txBuilder` does today. The halt needs no inspection
of the body: on the client, `op.effect` resolves to an Effect that
interrupts the fiber with an internal halt signal, which `db.run` catches,
keeping the ops collected so far as the prefix. Those ops become a
`PendingLayer` keyed by a fresh `clientOpId`, visible to live queries in the
same tick, and the invocation — `{ name, input, clientOpId }`, not raw ops —
is queued on the existing FIFO outbox.

> **Decision.** Optimistic execution stops at the first side-effect step.
> Transaction steps after an effect may depend on the effect's response, so
> the client cannot assume they are safe to commit optimistically — no
> `optimistic` simulation hooks, no `undefined`-typed effect results. The
> client never evaluates an effect thunk at all, and an operation that opens
> with an effect is simply not optimistic.

```
app ──run(op, input)──▶ client runtime ──▶ prefix → PendingLayer(clientOpId) ──▶ outbox (FIFO)
                        (runs body until first effect step)
                                                                          │
                                          POST /db/:name/op { name, input, clientOpId }
                                                                          ▼
                        peer worker: decode input · run body (effects run) · collect tx ops
                                                                          │ one tx
                                                                          ▼
                                              Transactor DO: group commit → t
        ◀── ack { t, datoms, output } — drop layer, repaint confirmed ────┘
        ◀╌╌ rejected — drop layer (optimistic entry revoked), typed error ╌┘
```

Everything downstream of the layer is today's overlay code with the key
renamed: acks drop the layer by `clientOpId` and paint the server's
`WireDatom[]`; `remapQueued` rewrites tempids in still-queued invocations'
optimistic layers; failures drop the layer and surface a typed error (the
"drag snaps back, toast explains why" behavior Reef already demonstrates).
Because the server executes the *full* body against *its* state, the
confirmed transaction is normally a superset of the optimistic prefix and
may differ from it — which the ack repaint already handles, since confirmed
truth always replaces the layer wholesale.

## 6. Wire & server: transport, execution, idempotency

One new endpoint and one new session frame, alongside the existing ones:

```
POST /db/:name/op            { name: "issue/create", input, clientOpId }
                       → 200 { t, txEid, tempids, datoms, clientOpId, output }
                       → 4xx { error: "OperationRejected", step, reason }

// worker/session.ts ClientFrame gains:
{ id, op: "operation", name, input, clientOpId }
```

Server execution lives where transaction interception already happens
(`worker/index.ts` → `ingress`): resolve the operation by name (unknown →
`InvalidRequest`), decode the input, run the body with server context —
effect steps get `env` and the authenticated `principal`; transaction verbs
accumulate against a speculative view at the replica basis. The accumulated
ops then flow through the existing pipeline unchanged: policy `checkWrite`,
forward to the Transactor DO, group commit, ack with the operation's encoded
output attached.

> **Decision.** Idempotency extends the existing replay mechanism:
> `clientTxReplayKey(principal, id)` becomes the op replay key over
> `clientOpId`. Because an operation ack now carries an output and effects
> must not re-run, op acks are persisted in Transactor DO storage for a
> bounded window rather than relying only on the in-memory 256-entry ring.

## 7. Shipping: operations are code, bundled into the peer Worker

The repo has one precedent for app-authored server rules — `Policy`, shipped
as compiled JSON in a 5.1 kB binding, because the peer Worker runs no
consumer code. Operations break that constraint deliberately: side-effect
steps are arbitrary functions and cannot ship as data.

> **Decision.** `Ramose.Server` accepts an `operations` module path; the
> Alchemy build bundles it into the peer Worker entry (`ramose/worker`
> becomes a factory over the registry). Policy stays data; operations become
> the one sanctioned way consumer code runs inside the peer. The alternative
> — executing operations in a separate app Worker over a service binding —
> keeps the peer pure but splits the write path across two deployables and
> reintroduces the "no transactional relationship between steps" problem for
> reads; rejected for v1.

Portability falls out of the module boundary: an operations module imports
`ramose/db` and app schema only, so the same file bundles into the browser.
Effect thunks are dead weight there — the client stops before ever reaching
one — and can be split out of the browser bundle later if size demands it.

## 8. Enforcement & migration: closing the raw write path

A server that declares operations can opt into `writes: "operations"`. In
that mode `/transact` (HTTP and session frame) is rejected for app-class
tokens with `Unauthorized`; `admin`-class tokens keep raw transact for
tooling, migrations, and tests. `db.install()` — itself "an ordinary
transaction" — becomes admin-only, which is honest: schema changes were never
an app-level write.

Migration is incremental and Reef is the test set — every function in
`examples/reef/src/app/mutations.ts` ("each is one `db.transact` generator")
maps one-to-one onto an operation. The motivating case composes both step
kinds:

```ts
export const provisionWorkspace = Ramose.Operation("workspace/provision", {
  input: Schema.Struct({ slug: Schema.String, name: Schema.String }),
  output: Schema.Struct({ ready: Schema.Boolean }),
}, (op, input) =>
  Effect.gen(function* () {
    // side effects: schema install + org registration — server only, idempotent
    yield* op.effect("db/install", ({ databases }) => databases.install(input.slug, Reef));
    yield* op.effect("org/register", ({ env, principal }) => registerOrg(env, input, principal));

    // transaction steps: follow the effects, so no optimistic prefix — commit server-side only
    const self = yield* op.entity();
    yield* op.add(self, User.name, op.principal.name);
    yield* seedLabels(op);
    return { ready: true };
  }),
);
```

What is today two browser-run transactions under an admin JWT plus an
unrelated auth-Worker call becomes one named, schema-checked, server-ordered
operation. Here the effects come first, so nothing is applied optimistically
— appropriate, since the creating tab has no session on the new database
yet. In ordinary data operations like `createIssue`, authors put
effect-independent writes ahead of the first effect and keep today's
instant feel.

## 9. Errors: one new tagged error

`OperationRejected` joins `db/Errors.ts`, carrying the operation name, the
failing step, and the wire reason; schema failures stay `InvalidRequest`,
policy denials stay `TxRejected`. It is terminal for standing queries (added
to `Db.ts` → `terminal()`): a rejected operation must never be silently
retried, precisely because its effect steps may not be free to repeat.

## 10. Open questions

- **Reads inside bodies.** v1 exposes `op.q`/`op.pull` against the
  speculative view; do operations need a read-consistency guarantee stronger
  than replica basis (i.e., execute inside the Transactor DO instead of the
  Worker)?
- **Cross-database operations.** `provisionWorkspace` targets the new
  database; is an operation always bound to one `db(name)`, with
  control-plane databases reached only via effects, or do we allow
  multi-database transaction steps later?
- **Prefix ergonomics.** The optimistic prefix ends at the first effect even
  when later transaction steps don't actually consume its result. Is
  author-controlled ordering enough, or do we eventually want an explicit
  escape hatch (e.g. marking an effect as not ending the prefix) for
  effect-independent writes?
- **Registry drift.** Client and server can briefly disagree on the operation
  set across deploys; unknown-name rejection covers the safety, but do we
  want a version handshake in `info`?

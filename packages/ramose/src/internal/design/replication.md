# Versioned Opaque Database Replication Contract

This is the normative version-1 contract for issues #473 and #533. It refines
`LIVE-2`–`LIVE-7`, `NI-1`–`NI-3`, and `REV-1` in
[`authorization.md`](authorization.md). The codecs in
`internal/replication/protocol.ts` are the executable source of truth when a
shape or bound is in doubt.

The protocol synchronizes one complete current application snapshot for one
activated root-relative Graph path. It never transports the raw transaction
log, a physical basis, storage roots, server entity or attribute ids, catalog
proofs, rule inputs, or JWT payloads.

## Transport and activation

An authenticated client opens:

```text
POST /db/:configuredRoot/replicate
Content-Type: application/json
Accept: application/x-ndjson
```

The strict request is:

```ts
{
  type: "Activate"
  protocol: 1
  graphPath: readonly string[]
  scope: { type: "database" }
  readCompatibilityHash: ReadCompatibilityHash
  resumeRevision?: OpaqueId
}
```

The path is relative to the configured root selected by the URL. The client
cannot provide a database id, catalog key, catalog hash, policy identity,
principal cache key, or response identity. Unknown properties are rejected.
The server authenticates first, resolves and authorizes the complete path
against its deployed database registry, and provisions an already-authorized
dynamic child through the normal Graph path machinery.

`readCompatibilityHash` is a full untruncated SHA-256 encoded as 43 canonical
unpadded base64url characters. Its domain-separated canonical descriptor
contains only normalized fields, entities, traits, trait composition, and the
versioned Graph-read interpretation needed to construct/query the local `Db`.
Catalog scoping is stripped from those local names because permanent catalog
identity is authenticated separately.
Operations, executable codecs, projections, deployment identity,
documentation, defaults/callbacks, and client build identity are absent. The
server authenticates and resolves the complete authorized path before
comparing this value with the target catalog. A mismatch is HTTP 409 with
exactly one `TerminalError` whose code is `update-required`, and no
data-bearing frames. It is not a `Reset`; `ResumeReady` is possible only after
agreement.

A compatible successful response is newline-delimited JSON with content type
`application/x-ndjson` and `cache-control: no-store`. One encoded frame plus
one newline is enqueued per stream pull. The response stream has a zero-byte
high-water mark, so the next frame is not constructed until downstream asks
for it. Cancellation aborts authorization work and closes the real Replica
watch.

Protocol incompatibility is HTTP 409 with exactly one version-1
`TerminalError` whose code is `incompatible-version`. Malformed or oversized
activation is the ordinary opaque invalid-request response. Version 1 emits no
heartbeat; transport silence after the one-shot activation result is its
liveness behavior.

## Opaque identity and revision

Every data-bearing frame carries one server-derived identity:

```ts
{
  version: 1
  server: OpaqueId
  principal: OpaqueId
  database: OpaqueId
  catalog: OpaqueId
  readView: OpaqueId
  readCompatibilityHash: ReadCompatibilityHash
  authenticator: OpaqueId
}
```

Each `OpaqueId` is a 32-byte digest encoded as 43 unpadded base64url
characters. The fields are independent domain-separated HMACs under the
server's internal secret. `authenticator` covers the other fields.

- `server` partitions the public server namespace.
- `principal` covers verified claims and sorted classes, excluding token
  expiry and issued-at. Ordinary token refresh is therefore stable; subject,
  claim, or class replacement is not.
- `database` covers the server-resolved stable target database.
- `catalog` covers its permanent deployed catalog key.
- `readCompatibilityHash` is the server-confirmed target descriptor above.
- `readView` covers only authorized-read semantics: each ordered stable route
  database, its read compatibility, the installed read-only policy subset,
  versioned Graph-read semantics, and every ordered stable ancestor
  database/entity dependency. Configured-root spelling, mutable Graph path
  text, deployment/version identity, operation bodies/hashes and
  operation-only codecs/rules, documentation/default metadata, projections,
  and client build identity are excluded.

Consequently an operation-only or deployment-only change preserves
`readView`, entity identities, revisions, and replica eligibility. Stored
schema, entity/trait composition, read-policy, or Graph-read semantic changes
rotate compatibility. Principal, stable database, and permanent catalog
remain separate authenticated identity dimensions.

Client-visible entity and reference identities are HMACs of their internal
entity ids inside this authenticated partition. They are stable for the same
partition and unlinkable across partition transitions. Logical state is
hashed from the complete authorized datom sequence. An authorized revision is
an HMAC of that state digest and the identity authenticator. Hidden-only
physical state therefore neither changes the revision nor changes snapshot
bytes.

The client treats every identity field and revision as opaque. Decoding a JWT
or an opaque id never grants cache authority.

## Sealed entity handles

The wire identity above names an entity *within one partition*: it rotates with
the authenticator, which is what keeps two partitions of one database
unlinkable, and it is one-way, so nothing can read an entity out of it. It
therefore cannot be a durable mutation target, and a client holding only wire
identities can read a row it has no way to address.

Every data-bearing frame therefore also carries a `handles` binding: one entry
per distinct entity the frame's datoms name, as a subject or as a reference
value, pairing that wire identity with the sealed `EntityId` of the same
entity. The sealed handle is the reversible envelope minted by the engine's
entity-id codec, bound to the stable `{ server, principal, database }` scope
and excluding the catalog, the read view, the schema, the deployment, the graph
path text, and the bearer. Sealing is deterministic per `(root, scope, eid)`, so
the handle replication binds, the handle an allocation mapping returns, and the
handle a sealed output position carries are one byte-identical string for one
entity — three carriers, one identity.

The binding is additive to the partition mechanism, not a replacement for it:
the datoms keep using wire identities, and the handle crosses only inside an
authenticated stream the server has already authorized end to end. It is
therefore disclosed only to the partition owner, who can already mint the same
handle by invoking an operation that returns the entity. A second principal
reading the same row receives a different handle and cannot open this one.

Client obligations. A frame's binding is required and strict: a handle must be
the canonical unpadded base64url of the 41-byte envelope, an entity may not be
rebound within one partition, and a snapshot or change that would leave an
entity of the installed value unbound is refused rather than installed. A
committed value keeps bindings for exactly the entities it holds; a handle whose
entity is retracted is pruned with its last fact.

## Logical datoms

A wire datom is:

```ts
{
  entity: OpaqueId
  field: string
  value:
    | { type: "long"; value: number }
    | { type: "double"; value: number | "positive-infinity" | "negative-infinity" }
    | { type: "string"; value: string }
    | { type: "boolean"; value: boolean }
    | { type: "ref"; value: OpaqueId }
    | { type: "uuid"; value: string }
    | { type: "instant"; value: number }
    | { type: "bytes"; value: string }
  op: "add" | "retract"
}
```

The database places no smaller replication-specific limit on a stored string
or byte array. A value that does not fit the bounded scalar codec is carried
in snapshot datoms as ordered `string-part` or `bytes-part` values. Every part
contains an opaque logical-value identity, zero-based index, total part count,
and at most 131,072 bytes of text. Non-final byte parts encode exactly 98,304
raw bytes, so their canonical base64 text concatenates without padding. The
client validates a complete, nonconflicting part set and reassembles the
logical string/base64 value only when `SnapshotCommit` atomically installs the
snapshot. A delta involving a fragmented value uses `Reset` plus a chunked
snapshot; `Change` retains its separate 1 MiB bounded-delta policy.

`field` is the deployed logical field ident. Bytes are canonical base64, UUIDs
are canonical lowercase UUIDs, longs/instants are safe integers, and the two
JSON-inexpressible double infinities use the exact markers above. Snapshot
datoms always have `op: "add"`. A `Change` may contain additions and
retractions. No physical eid, attribute eid, value tag, transaction eid,
transaction time, basis, storage root, policy input, queue position, or count
exists in this representation.

## Frames and server transitions

Every frame has `protocol: 1` and is one of:

| Frame | Required payload | Meaning |
|---|---|---|
| `SnapshotStart` | identity, snapshot, revision | Begin staging one complete authorized value. |
| `SnapshotChunk` | identity, snapshot, zero-based index, add datoms, sealed-handle bindings | One bounded ordered part; never queryable by itself. |
| `SnapshotCommit` | identity, snapshot, revision, chunk count | Atomically install the staged value. |
| `Change` | identity, from revision, revision, datoms, sealed-handle bindings | Atomically move one complete authorized value to another. Multiple physical bases may be conflated. |
| `ResumeReady` | identity, revision | One-shot proof that a supplied, resolved committed revision is still the complete current authorized value. |
| `Reset` | identity | The old resume basis or partition cannot be reused; a snapshot follows. |
| `KeepAlive` | identity | Reserved fixed-shape liveness frame. Version 1 does not emit it. |
| `TerminalError` | fixed code, optional identity | Close opaquely, report wire incompatibility, or require a compatible client. |

First sync is `SnapshotStart`, zero or more `SnapshotChunk`, then
`SnapshotCommit`. The server hashes a complete authorized prepass, streams
bounded chunks packed against the actual complete frame envelope, renews
authorization for delayed chunks, checks every
remaining old-snapshot chunk against the newest authorized value after a
renewal, and rescans before commit. If the authorized revision changed, it
restarts without committing the abandoned snapshot.

Resume resolves the opaque revision through a private mapping in a
binding-addressed Replica Durable Object. Each authenticated partition owns an
independent fixed quota of eight revisions; there is no shared admission or
eviction pool. A new revision can evict only the oldest revision in that same
object. Distinct authenticated partitions allocate distinct bounded objects,
so pressure in one partition cannot change another partition's first snapshot
or later resume result. A hidden-only advance updates the private basis of its
unchanged revision without changing that record's age or eviction order. The
raw basis never leaves the internal route. Missing, evicted, mismatched, or
unreconstructable records all produce the same `Reset` followed by a snapshot.

A supplied resume revision that resolves in that authenticated binding always
takes the complete logical reconstruction, authorization, projection, digest,
and final current-revision validation path. If the resulting authorized
revision is unchanged, the server emits exactly one `ResumeReady`, after the
real watch is ready and immediately before entering the steady-state cycle.
A visible difference emits only `Change`; an unavailable or incompatible base
emits only `Reset` followed by a snapshot. Neither path also emits
`ResumeReady`. It is an activation result, never a periodic heartbeat.

At each fixed cycle, a changed target basis makes the server reconstruct the
prior authorized value at the private basis, diff it against the newest
complete authorized value, and recheck the final revision before emission. A
visible diff is one atomic `Change`. No diff means silence and the private
mapping advances without a public revision transition. More than 256 changed
datoms or 1 MiB of changed datoms produces opaque `Reset` plus a chunked
snapshot instead of an unbounded delta.

The real Replica wake queue has capacity one with sliding/latest semantics.
A conflated change is also a valid initial-ready handshake because ordered
WebSocket delivery proves readiness preceded it. Notifications only update
that latest slot. After the ready handshake, replication does not drain
notification values; a separate failure-only signal detects watch closure.
That failure signal is an active abort source from the moment the watch is
attached, including initial authorization, snapshot projection and chunk
checks, resume reconstruction, checkpoints, and fixed-cycle waits. A watch
failure can therefore emit only the opaque `closed` terminal after any
uncommitted staging frames; it cannot emit another state-bearing frame or a
snapshot commit. The same fence applies before `ResumeReady`. Client
cancellation remains distinct and closes silently.
Notifications never schedule authorization, hashing, diffing, a heartbeat, a
timer, or a replication-loop iteration. One activity-independent cycle is
fixed to the settled complete-path lease cadence (no later than five seconds).
Every cycle reauthorizes the complete path. An unchanged target basis then
skips the logical scan; a changed basis advances once at that same fixed slot.
The next deadline retains the prior phase, skips missed slots without catch-up
work, and is shortened for an earlier token expiry. Thus zero hidden activity
and an arbitrary hidden burst have the same cycle/checkpoint ordering, hidden
work cannot queue extra cycles, and later visible work never waits behind a
hidden-scheduled cycle. Exactly one cycle timer is live and cancellation closes
it and the watch promptly.

## Client transition table

The pure reference transition machine never mutates its input. `committed` is
the only queryable value; `staging` is not.

| Current state and frame | Transition | Queryable result |
|---|---|---|
| Any, `Reset` with same identity | Discard staging; retain prior complete value until replacement commits. | Prior complete value. |
| Any, `Reset` with new identity | Discard staging and retained data; select new partition. | Empty. |
| Any, `SnapshotStart` | Create fresh staging; retain prior value only for the same identity. | Prior complete value or empty. |
| Matching staging, new `SnapshotChunk` | Store the immutable indexed chunk. | Unchanged. |
| Matching staging, identical duplicate chunk | Ignore. | Unchanged. |
| Matching staging, conflicting duplicate chunk | Fail the transition. | Unchanged. |
| Missing/wrong staging, chunk | Ignore, except identity mismatch fails. | Unchanged. |
| Commit with every index `0..chunks-1` exactly once | Validate no duplicate facts; atomically replace `committed`. | New complete value. |
| Incomplete, stale, or reordered commit | Ignore. | Unchanged. |
| `Change.from` equals committed revision | Apply all additions/retractions to a copy, then atomically replace. | New complete value. |
| Duplicate `Change.revision` | Ignore. | Unchanged. |
| Stale/unrelated `Change.from` | Ignore and reconnect/resume conservatively. | Unchanged. |
| `ResumeReady` with matching identity and committed revision | Accept idempotently; install no data and change no revision. | Existing complete value. |
| `ResumeReady` with missing/wrong committed revision | Fail the transition; never mark the retained value current. | Unchanged. |
| Mismatched frame identity | Fail the transition. | Unchanged. |
| `TerminalError` | Discard staging, close, and retain data only when the identity still matches. | Prior complete value or empty. |

Ordered transport is expected, but duplicate, interruption, reordering, and
stale input can therefore expose only the preceding complete value or one
newly committed complete value.

## Durable compatibility agreement

The confirmed compatibility hash is part of the authenticated identity, the
physical replica partition key, and every committed manifest. It is therefore
covered by the identity authenticator; restore also requires the manifest's
copy and identity copy to agree before following its content-addressed roots.
Restore and credential-bound restore require the
currently installed client hash and compare it before `dbFromRecord` or any
other `Db` construction. A mismatch removes only that committed replica,
its committed head and local candidate bindings, staging/chunks, its
partitioned content-addressed nodes, and its exact local credential binding.
It never deletes the IndexedDB database or the mutation store families —
#475's outbox, queue cursors, receipts, ClientRefs and their mappings, or
#476's optimistic layers.

IndexedDB schema version 4 upgrades the landed replica stores conditionally.
Compatible version-2/3 manifests carrying the confirmed hash survive. Legacy
manifests and bindings without it are incompatible and are quarantined; they
are never interpreted as local schema metadata. Incomplete pre-agreement
staging is discarded. Online activation must establish a fresh compatible
snapshot after quarantine.

## Local token-refresh candidate

The internal browser session accepts an optional local `cacheKey` foundation
for the public refreshable auth provider owned by #477. It has no protocol
field and grants no authority. The client persists only a domain-separated
full SHA-256 selector over the canonical server origin, configured root, and
raw key. A separate domain-separated route-slot digest addresses the current
root-relative Graph path for lookup only. Neither digest participates in
`ReplicationIdentity`, `readView`, the committed partition key, or server
authorization.

An exact previously authenticated bearer fingerprint retains its existing
behavior: a compatible committed value may be constructed and published stale
before the network opens. A changed bearer can use the stable selector only to
read an authenticated identity, revision, and manifest existence from a small
committed-head sidecar. The sidecar is installed or deleted atomically with its
committed manifest and is backfilled during the version-4 upgrade. That
metadata path never reads the heavy committed record, follows content nodes, or
constructs a `Db`; its revision may be sent as `resumeRevision` while the
candidate remains unobservable.

The first complete, strictly decoded identity-bearing response frame must
confirm the installed `readCompatibilityHash`. A candidate becomes usable only
through one of these valid initial transitions:

- matching `ResumeReady` constructs and publishes the confirmed revision as
  current;
- matching `Change` applies the authoritative change first and publishes only
  the new value;
- authenticated `Reset` or `SnapshotStart` may locate the confirmed identity's
  already committed partition and publish it stale while replacement staging
  proceeds;
- a matching reserved `KeepAlive` may expose only a stale value; an
  identity-bearing terminal may update bindings but exposes no rotated-token
  candidate.

An initial snapshot chunk/commit, change gap, mismatched resume, identity-free
terminal, schema mismatch, malformed/truncated first frame, or fetch failure
cannot confirm or publish a candidate. Exact credential and optional stable
selector records are rebound together only after a valid current authenticated
frame. A colliding selector is therefore just a nomination: wrong-principal
confirmation replaces its metadata without ever loading the nominated value.
Because committed partitions use stable authenticated identity rather than the
route slot, a renamed Graph path can recover the same partition after current
authorization and then bind its new opaque slot even when it supplied no resume
revision.

The `replica-cache-candidates-v1` and `replica-committed-heads-v1` object stores
are separate from heavy committed manifests, exact credential bindings,
staging, and content nodes. Candidate selection reads only those two bounded
stores. The mutation store families — outbox, queue cursors, receipts,
ClientRefs and their mappings, and #476's future optimistic layers — are keyed
by the stable server/principal/database triple rather than by the replica
partition, so a read-view change or a database eviction leaves them intact.
They are never part of candidate lookup or rebinding, and only an explicit
scoped clear removes them, in the same transaction as the replicas.

### Submission and acknowledgement (#475 slice 2)

One pass drives at most one head per receiver database, and only the head.
Databases are decided independently and driven concurrently, so a blocked,
quarantined, or unreadable head holds its own queue and no other; within a
database, moving only the head is what preserves FIFO across a restart.

A record naming an unmapped `ClientRef` waits exactly where it is. Once its
mapping is durable, the *submitted* body carries the sealed handle in the
target and at each declared input position — computed fresh at submission time
from the mappings that exist then. The durable row is never rewritten: it
records what the client actually intended, and the canonical invocation digest
is over that intent.

The plan and the handles its ready records will submit are read in **one**
readonly transaction. Read separately, an acknowledgement committing in between
would let the plan report a head blocked on a ref that is already resolved, or
report a record ready whose own row the same acknowledgement has removed.

Every terminal answer is persisted in exactly one client transaction: the
receipt with its output and mappings, the removal of the submitted outbox row,
and — for a commit — the internal `committed-unobserved` marker. The
independent replication stream is deliberately *not* in that transaction, which
is precisely why the marker exists: the commit is durable here and the causally
fresh activation that observes it is a separate, later event (#476, slice 3).
A crash cut anywhere leaves the invocation queued, and the next pass consumes
#487's exact replay — the same receipt, the same mappings, no second commit.

Non-terminal answers change nothing durable and surface as typed queue states.
`operation_changed` and `invocation_update_required` are never silent drops:
the record stays queued at its head and the reason is reported. A transport
failure and an answer this build cannot interpret are both `Retry`, never a
silent commit.

**Every terminal answer needs proof.** Acting on one is irreversible: it
removes the durable outbox row, and for an allocating invocation it is also the
only chance to recover the authoritative mappings — miss it and every dependent
record blocks on a ref nothing can resolve. A commit is accepted only with the
durable `completed` receipt for that exact invocation, so an object-shaped 200
from an incompatible server mid-rollout, a proxy, or a captive portal stays
queued rather than being read as a commit. A refusal is terminal only when the
server bound it to a durable receipt, or when it is `invocation_conflict`, which
says a *different* receipt already owns this id.

A status code alone is never enough in either direction. The Worker
deliberately answers a bare, receipt-free 403 when the caller's lease expires
between the authoritative commit and the response, and that invocation *did*
commit. A 409 code this build does not recognize is non-terminal for the same
reason: a newer server may name an outcome an older client has never heard of,
and the client must not answer that by destroying durable work. An absent
`result` on an otherwise valid 200 is malformed rather than `null`: recording
it would corrupt the output and remove the only copy that could be replayed.

A 409 carrying no receipt at all is a refusal decided *before* the claim — the
request never reached the one authoritative state machine — so it commits
nothing and answers the identical request identically. It stays non-terminal,
because an older client must never destroy durable work over an outcome a newer
server named and it has not heard of, but it is reported as `Refused` rather
than as `Retry`: an ordinary retry state makes that loop silent, with nothing
naming what has to change (the invocation, the caller's authorization, or the
deployed operation). A 409 that *does* carry a receipt this build will not act
on is a different problem — an answer this client cannot interpret — and stays
`Retry`.

One pass settles its databases rather than joining them. A durable write that
throws for one database must not discard what every sibling database did in the
same pass: that progress is the caller's only report, and the work behind it is
already durable. The failing database reports `Interrupted`, which claims
nothing in either direction — the next pass decides the same head again.

Two durable outputs are compared canonically, and structurally when the
canonical form is undefined for them. Durable output is deliberately not held
to RFC 8785's rules, so a value the queue is required to store can be one the
canonicalizer refuses; both throwing and calling such an output unequal would
wedge the very head the comparison exists to release.

### Queue liveness

The invariant every durable transition preserves: **after any transaction
commits, every non-terminal row is progressable** — its database's FIFO head
can eventually submit, become terminal, or be unblocked by a mapping some live
path can still produce, or it is reported with a typed non-terminal state that
names what must change — and no removed or terminal row strands ownership
(client refs, slots, FIFO sequences) that new work could need.

| transition | effect | why the invariant holds |
|---|---|---|
| enqueue | adds a row | refuses a dependency with no local allocator, one owned by another database, one it allocates itself, and one whose allocator was already rejected. An allocator always precedes its dependents in FIFO order by construction: the ownership row must already exist, so it was enqueued earlier — a dependent can never wait on a record behind it. It also refuses an invocation id any receipt already owns, in any database. |
| acknowledge `Committed` | mappings + receipt + row removal | every allocated slot must come back mapped, so no registered ref is stranded; an unreadable mapping row is repaired rather than skipped; dependents unblock on the mapping. |
| acknowledge `Rejected` | receipt + row removal + cascade | the refused slots can never map, so every transitively dependent row becomes terminal in the same transaction; the ownership rows survive as history and new work behind them is refused at enqueue. |
| cascade `dependency_rejected` | receipt + row removal | same cut, and confined to one database — a cross-database dependency cannot exist, because enqueue refuses one. |
| re-acknowledge (converged) | row removal only | the terminal answer must match exactly — state, failure code, mappings, and the output, compared canonically — so two passes that disagree conflict instead of one silently keeping the other's result; the receipt and its `observation` are left untouched, so a fence that already advanced is not reset. |
| `blocked` | nothing durable | the allocator is queued ahead of it, so a mapping is still producible. |
| `update-required`, `unreadable`, `refused` | nothing durable | deliberately holds its own database and is *reported*; never silently cleared, never re-executed. Client action is what clears it. |
| `beginActivation` | bumps the receiver's activation counter | changes no row's terminality and no FIFO position; a strictly larger number can only ever fence more receipts, never fewer, and an unused number costs nothing. |
| activation fence | flips `unobserved` to `observed` | touches no queue row at all: the receipt was already terminal and the marker is internal. Idempotent, so a repeat selects nothing. |
| `clearScope` | removes all five families by prefix | everything in the scope goes together, so nothing survives to be stranded. |

Global invocation ownership lives on the receipt store, not the outbox. The
outbox's own index only holds while its row does, and an acknowledgement
removes the row — so without a receipt-side index the same globally unique
invocation id could be queued again for a sibling database, miss the old
receipt under its own `[partition, invocation]` key, and execute one intent
twice. Receipts outlive their rows and are removed only by a scoped clear, so
they are what can say "this id is spoken for" for as long as it matters.

A property test drives random dependency graphs across two databases through
random accept/refuse interleavings against real IndexedDB, asserting the end
state directly: nothing queued, nothing blocked, every invocation terminal. It
also asserts that the sweep actually produced a cascade, so it cannot pass
vacuously.

**A rejection is a cut through the dependency graph, not one record.** A
refused invocation's allocation slots can never be mapped — the one queued
record that could have produced them is the one being removed — so everything
depending on those refs, and on *their* allocations transitively, becomes
terminal in the same transaction with a typed `dependency_rejected` failure.
Leaving them queued would make the next one the head, blocked on a ref nothing
can resolve, holding its database forever. Independent work in the same
database is untouched, and new work may not be enqueued behind a ref whose
allocating invocation was already rejected.

Every reader of the mapping store goes through its decoder, including the
acknowledgement. A row that *looks* right but does not decode would otherwise
be treated as already installed and skipped, while planning drops it — dependents
blocked forever, with the record that could have replayed already removed. The
acknowledgement is the authoritative answer for exactly that ref, so it repairs
such a row rather than refusing.

### The post-commit activation fence (#475 slice 3)

**The invariant.** A committed receipt is marked `observed` only when the
authoritative replication stream has, on an activation that *began after that
receipt was already durable*, delivered a matching outcome carrying the current
committed state. Causal freshness is the whole point: output from a generation
that was already open when the acknowledgement landed proves nothing about
whether the server's stream has caught up to the commit, so it may not clear
the marker.

The client half is therefore three steps, in this order and no other:

1. the acknowledgement transaction persists receipt, output, mappings, outbox
   removal, and the `unobserved` marker — stamped with the activation counter
   in force at that moment;
2. the prior replication generation for that database is invalidated and
   closed, and the counter is incremented durably: that increment *is* the
   fresh activation's identity;
3. a new activation opens from the client's current committed revision, and its
   first matching outcome fences — in one client transaction — every receipt
   stamped **strictly below** the new counter.

Between steps 1 and 3 the marker is durable and the operation is visible as
public `committed`. Nothing about the fence is public: no transaction position,
no observation token, no server-visible acknowledgement.

**One counter, not one fence record per receipt.** The counter is per receiver
database — the same `{server, principal, database}` triple every mutation
family is keyed by, and exactly the granularity one replication activation
covers — and it lives on the durable queue cursor that already exists for that
receiver. It is monotonic and never reused. A receipt stamped `c` is fenced by
the first matching outcome of any activation `n > c`; a receipt acknowledged
*after* activation `n` began is stamped `n`, is not `< n`, and therefore
requires a later activation. That is the whole bookkeeping: coalescing (one
`Change` clearing many receipts) and the "later commits need a later
generation" rule both fall out of the single comparison, and no per-receipt
fence row can drift from the receipts it claims to describe.

A stored row written before the counter existed decodes as `0` — "durable
before any activation this build began" — which is exactly what such a row
means, so no migration is needed and no queue is orphaned.

**What satisfies the fence.** Only an authoritative outcome on the fresh
activation, and only the first one:

| frame | fences? | why |
|---|---|---|
| `Change` that continues the committed revision and installs | yes | the server advanced this activation's stream past the commit |
| `Change` the client already holds (`duplicate`) | yes | the same acknowledgement, for a revision already durable here |
| `Change` whose local install lost its CAS | no | this session installed nothing; the next outcome fences |
| `ResumeReady` matching the resumed identity and revision | yes | the authorized no-op / hidden-result answer |
| `SnapshotCommit` that actually installs | yes | the completed reset staging |
| `Reset`, `SnapshotStart`, `SnapshotChunk` | no | incomplete staging is not an outcome |
| `KeepAlive` | no | liveness, not state |
| `TerminalError` | no | the activation ended without an outcome |
| identity or `readCompatibilityHash` mismatch | no | the session quarantines and fails before any outcome |
| anything on a superseded generation | no | `current(generation)` refuses it |

The frozen contract names the reset case as "`SnapshotCommit` following a
matching `Reset`". A fresh activation that supplies no resume revision — its
local replica was quarantined between the acknowledgement and the reconnect —
receives `SnapshotStart` with no preceding `Reset`, because there was no
revision to reset *from*. That commit fences on the same terms. Reading it any
other way would leave such an activation permanently unable to fence, and it
cannot fence early: the snapshot is taken after this activation's own
authoritative basis fence. Nothing else about the reset case changes —
incomplete staging never installs, so it never fences.

**The crash-cut matrix.** Every cut converges because the durable state after
it is the input the next start reads, and the next start always begins a *new*
activation:

| cut | durable state after the cut | recovery |
|---|---|---|
| during the acknowledgement transaction | invocation still queued, receipt still `queued` | the next pass resubmits and consumes #487's exact replay; identical answer, no second commit |
| after the acknowledgement, before the counter increment | receipt `committed`/`unobserved` stamped `c`; counter `c` | restart reconstructs the unobserved set, increments to `c+1`, and `c < c+1` fences |
| after the increment, before the activation opens | counter `n`; receipt stamped `c < n` | restart increments to `n+1`; the receipt is still `< n+1`. Skipping `n` costs nothing: the counter is an ordering, not a resource |
| after the activation opens, before the first frame | counter `n`; nothing observed | same as above — a new activation, a strictly larger number |
| after the first matching frame, before the fence transaction | receipt still `unobserved` | the fence transaction is all-or-nothing; the restart's activation fences it |
| during the fence transaction | either every selected receipt is `observed` or none is | IndexedDB aborts the whole transaction; the next activation reselects |
| after the fence transaction | receipt `observed` | a later activation selects nothing; re-fencing is idempotent |

Two rules make the matrix collapse to "always converges". First, the counter is
incremented *before* the activation opens, so a cut can only ever make the
client fence with a **larger** number than it needed — never a smaller one.
Second, the fence transaction is a single client transaction over the receipt
family, so it has no partial state to reconcile.

**Failure taxonomy.** A fence attempt that throws leaves the durable marker
untouched and is retried by the next matching outcome on the same activation,
and failing that by the next activation; it never fails the replication
session, because observation is downstream of persistence. A fence that would
land behind a completed `clearLocalData()` is refused by the same scope
generation check every other durable mutation write makes. A rejection is not
fenced at all — nothing committed, so the marker is `null` and stays `null`.

**What #476 consumes.** `ActivationFence` exposes the durable transition as a
queryable and subscribable snapshot: the activation in force, the receipts
still awaiting a fence, and the invocations the last fence cleared. #475 owns
persisting and exposing that transition; #476 owns atomically removing or
replaying optimistic layers when it occurs.

## Optimistic projections and the speculative overlay (#476 slice 1)

An operation may declare one optional pure optimistic projection. It is trusted
code from the installed client bundle, not a serialized, inferred, restricted,
or interpreted form of the authoritative body — that body stays deployed server
code and never crosses the client boundary. **Nothing in this design reads
callback source.** There is no parser, no AST, no bytecode, no interpreter, and
no `Function.prototype.toString`; a projection is executed by calling it.

This section specifies slice 1: the contract, the identity, native execution,
and the deterministic in-memory overlay. Durability and the observation fence
are slice 2.

### The determinism contract

The local view is a *function*, not an accumulator:

```
view = project(committed, [layer₀ … layerₙ₋₁], resolver)
```

`committed` is the immutable replica `Db`. Each layer is one invocation's plain
data changeset. `project` is deterministic: the same committed value, the same
ordered layers, and the same resolver produce byte-identical datoms, so the
same query answers. Three rules make that hold.

1. **Ordering is positional, never causal.** The fold runs in
   `(layer, operation)` order above `committed.basisT`, one transaction per
   emitting operation — so a projection that sets one cardinality-one field
   twice replaces its own first write, exactly as a later layer replaces an
   earlier one. There is no dependency graph: removing a layer removes exactly
   one, and every later layer is re-applied at its new position. Nothing is
   derived from wall-clock time, iteration order of an unordered map, or a
   random source.
2. **Speculative ids are assigned by first appearance.** A ref the committed
   replica cannot resolve gets a local id from `committed.nextEid` upward, in
   the same `(layer, operation)` order. These ids are *derived*, never durable,
   and never leave the client: the overlay is rebuilt whenever the committed
   value or the layer list changes.
3. **A projection cannot observe anything but its own input.** The API supplies
   validated invocation input, the invocation's own target, the client refs its
   declared allocation slots minted, and a transaction builder. It supplies no
   local-database query, no Effect, no clock, and no server capability. This is
   an API and authoring constraint, enforced by what is *passed*, never by
   inspecting what the author wrote.

### The changeset

A layer's changeset is plain datom-level data over the replica's own value
model — the same eight logical value types the replica materializes, with
`ref` carrying an `EntityId` or a `ClientRef` instead of a replication
identity. Four operations: `set`, `remove`, `create`, `delete`. There is no
changeset algebra beyond that, and no executable form: the whole record is
structured-cloneable, which is what makes slice 2's durable row a store rather
than a serializer.

Values are lowered from the *declared* field, so a projection passes a stamped
field ref (`Issue.status`) rather than a bare ident. A bare ident cannot say
whether a 55-character string is a handle or a title, and guessing would bind a
durable intent to a coincidence.

The overlay lowers each operation through `replicaFactDatom` — the same
projection the replica installer and the integrity validator share — so a value
type the committed schema does not admit is refused identically in all three.
A refusal is recorded and skipped; it never throws, because one bad operation
must not wedge the queue it belongs to.

`set` on a cardinality-one field retracts the current value first, exactly as
the public verb means. `delete` retracts the entity's own datoms and the
inbound reference datoms that would otherwise dangle. Both read the view built
from the committed value and the layers *below* — never the layers above — so
application is a fold, not a fixpoint.

### Layer lifecycle

One layer per invocation, in invocation (FIFO) order. The state machine is
pure; slice 2 gives it a durable store.

| state | means | leaves by |
|---|---|---|
| `queued` | the projection ran and the invocation has not received a terminal answer | `commit` → `committed-unobserved`; `reject` → removed |
| `committed-unobserved` | the authoritative receipt, output, and mappings are durably known; the independent replication stream has not caught up | `fence(n)` when the layer's stamped activation is `< n` → removed |

| event | effect | replay |
|---|---|---|
| `enqueue` | appends a layer with a strictly greater FIFO sequence | none — the new layer is last |
| `commit(invocation, activation)` | the layer stays in place, stamped with the activation counter in force | none — the visible datoms do not change, so the UI cannot flash |
| `reject(invocation)` | removes exactly that layer | from its index |
| `fence(n)` | removes every `committed-unobserved` layer stamped `< n` | from the lowest removed index |

`commit` deliberately changes no datom. That is what makes "receipt completion
followed by a delayed or coalesced `Change` never produces a rollback flash" a
property of the state machine rather than of timing: the layer is retained,
under a new name, until a causally fresh activation fences it.

A `reject` on a `committed-unobserved` layer is refused, not silently applied —
the invocation is already terminal, and removing its layer would roll the view
back under an authoritative commit. Out-of-order sequences and duplicate
invocations are refused the same way.

### ClientRef aliasing

A projection cannot manufacture an `EntityId`, a mapping, a receipt, an
authorization, or a commit result. It may *create* a `ClientRef` only through a
declared allocation slot, and it may *use* one only when that ref is
committed-mapped, supplied by the invocation's own target or validated input, or
minted by one of its declared slots — the three sources a durable layer row
accounts for. Slice 1 enforced the create half; slice 2's durable row carries
the other two, which is what closes the rule on `set`, `remove`, and `delete`
(see "The closed aliasing rule" below). The input-supplied case is why those
verbs cannot simply be narrowed to allocations.

Reference resolution is one function with three cases, and the middle case is
the whole aliasing rule:

- a `ClientRef` with no durable mapping resolves to a speculative id keyed by
  the ref;
- a `ClientRef` whose mapping is known resolves through the mapped `EntityId`
  — to the committed local id when the replica already holds that entity, and
  otherwise to a speculative id keyed by the *`EntityId`*. Either way it is the
  same id any direct reference to that handle resolves to, so a mapped entity
  is presented once, never twice;
- an `EntityId` resolves to its committed local id, or to a speculative id an
  alias already assigned to it. An `EntityId` the client has never seen is
  refused rather than invented: only a ref this device minted may bring a new
  entity into the local view.

Both lookups are *injected*, as pure functions over a fixed snapshot, and that
is deliberate rather than incidental. The replication stream names an entity by
`makeEntityIdentity` — a one-way HMAC over `{database, eid}` — while a sealed
`EntityId` is a reversible ciphertext under different scope material that only
the server can open. They are two different derivations of the same private
eid, so a client holding one cannot relate it to the other. Today the only
handles a client has at all come from operation outputs and allocation
mappings; a replicated row carries none. **Optimistic updates addressed by
`EntityId` therefore need a handle-to-local-id binding that does not exist
yet** — creates addressed by `ClientRef` are complete without it, because a
speculative id needs no bridge. Closing that gap belongs with the public
surface work that first hands an application a handle for a replicated row
(#477 / #480); until then the resolver's `entity` half is supplied by whoever
holds such a binding, and the overlay refuses what it cannot resolve rather
than inventing a row.

### What the overlay is not

It is not a second index. The overlay is the committed `Db`'s roots with the
layer datoms in novelty and a raised basis, so query membership, sorting,
reference joins, and graph-local pulls reflect it because the engine reads only
through `Db.datoms` / `Db.seekMany` / `Db.first` / `Db.datomsArray`. Nothing in
the query path knows a layer exists. The committed replica is untouched, and a
projection-only client change never invalidates it.

### Projection identity

The projection's identity is explicit, declared, and independent of `readView`,
`readCompatibilityHash`, Worker deployment identity, and `OperationVersion`. It
is never derived from the callback's source.

- `revision` — the author-declared projection revision, defaulting to `1`. It
  is deliberately *not* part of the operation's canonical descriptor: bumping
  it must not rotate `OperationVersion`, or a projection edit would invalidate
  every already-queued invocation's right to submit.
- `build` — the installed client build identity, the same for every projection
  in one bundle. It records which bundle produced a durable layer.

On restart the callback is resolved from the installed client bundle before
replay, keyed by the operation's catalog / owner / local name. The decision
table is total:

| durable record | installed bundle | outcome |
|---|---|---|
| no projection identity | anything | `none` — the invocation never had a layer, so reconstructing none is exact |
| identity present | operation absent | `update-required: operation-missing` |
| identity present | operation declares no projection | `update-required: projection-missing` |
| `revision` differs | — | `update-required: projection-revision` |
| `revision` matches, `build` differs | — | `bound`, marked `rebound` |
| `revision` and `build` match | — | `bound` |

Build drift alone is not `update-required`. An unchanged revision from a new
bundle is the author's explicit statement that the projection's behavior did
not change, and treating every client redeploy as drift would quarantine every
queued layer on every deploy — the opposite of what #475's stable handles buy.
Revision drift *is* `update-required`: the alternative is executing a
projection whose author has said it no longer means the same thing.

## Durability and observation-fenced reconciliation (#476 slice 2)

Slice 1 fixed the shapes; this slice persists them and drives the transitions.

### The durable layer row

One row per invocation that produced a layer, in `mutation-layers-v1`, keyed
`[partition, sequence]` — the *same* partition and the *same* FIFO position its
outbox row holds, so a scoped clear removes it by the same prefix range and the
FIFO order needs no second source of truth. A unique `by-invocation` index
enforces that one invocation owns at most one layer, globally, exactly as the
receipt store enforces invocation ownership.

The row holds: operation identity, the pinned `OperationVersion`, the *declared*
projection identity `{revision, build}`, the validated input, the invocation's
target, its declared allocation slots and the client refs they minted, the refs
its target and input supply, the sealing epoch its own handles agree on
(codec version and the identity root's `keyId`), and its own bookkeeping —
sequence, state, and activation stamp.

It holds **no callback source, AST, bytecode, closure, or interpreter
artifact**, and — deliberately — **no changeset**. The changeset is recomputed
on restart by resolving the callback from the installed bundle and running it
over the stored input. A stored changeset would outlive the very identity check
that exists to refuse it: a bundle whose projection has drifted would replay a
snapshot of code its author has disowned. Recomputation is what makes "restart
reconstructs exactly the same speculative view by natively replaying the
matching projection" a statement about the code installed *now*.

Every write is inside a transaction that already exists:

| durable event | layer transition | transaction |
|---|---|---|
| enqueue | the row is created `queued` | the enqueue write, so a projection is durable before `receipt.queued` resolves and a cut can never leave one half |
| commit | `committed-unobserved`, stamped with the activation the same transaction read | the acknowledgement write, beside the receipt, the mappings, and the row removal |
| reject | the row is removed | the same acknowledgement write; the rejection cascade removes the cut's rows too |
| fence(n) | every `committed-unobserved` row its receipts covered is removed | the reconciliation transaction below |
| `clearLocalData()` | every row of the scope is removed | the one atomic clearing transaction, with the replicas |

### The reconciliation transaction

`fenceActivation(receiver, n)` is one client storage transaction over the
receipts, the layers, the committed heads, and the scope generation. In it:

1. **confirm** the authoritative replica state this fence observes — the
   committed head of this receiver database, over every read view of it. A
   settled outcome always implies one; its absence means the replica was
   cleared or evicted in between, so nothing is removed and the next outcome
   reselects;
2. advance every receipt the fence covers from `unobserved` to `observed`
   (`stamp < n`, the whole bookkeeping);
3. remove exactly the layers those receipts own — selected by the *receipt*, so
   one predicate decides both halves;
4. read back the surviving rows in sequence order. That order **is** the record
   of the resulting layer order: it comes from inside the transaction that
   produced it, so the replay is over what was committed rather than over a
   later read a concurrent enqueue could already have changed.

All four or none. A terminal, an incomplete reset, a prior generation, and an
identity or schema mismatch never reach it — the session settles none of them —
and a scope whose generation moved is refused before anything is written. An
undecodable layer row is counted, never removed.

### The driver

`OptimisticReconciler` is the production caller, one per receiver database:

```
acknowledgement persisted  →  restart(prior)   close → increment → open
fresh activation opens     →  outcome(n)       the session's own hook
first settled frame        →  settle(n)        the reconciliation transaction
```

The order is the contract, not a convenience — see the fence section above. A
`Committed` queue progress is what requires a fresh activation; a `Rejected` one
requires nothing but an immediate replay, because the acknowledgement already
removed exactly that layer. There is no dependency graph and no replication
wait.

Crash cuts converge because every state is a function of durable rows:

| cut | after restart |
|---|---|
| inside the enqueue | no layer and no invocation |
| after the acknowledgement, before the fence | the mapped optimistic view, intact — the layer is `committed-unobserved` and its ref aliases onto the returned handle |
| after `beginActivation`, before the activation opens | the counter is larger than it needed to be, which fences a superset and is always safe |
| inside the fence transaction | nothing observed, nothing removed; the next settled frame fences |
| after a rejection, before the replay | exactly that layer gone, the later ones replayed at their new positions |

### Restart and quarantine

Restoring is total, and scoped to the whole receiver database. A rotated
projection revision, a missing operation or projection, an unreadable row, or a
sealing epoch this build cannot use withholds *every* layer of that database as
the typed, data-free `update-required` state. Partial replay would present a
speculative view the installed bundle cannot account for. The durable rows are
kept, so a compatible build replays them unchanged, and **the committed replica
is never reset by any of it** — a projection-only client change does not
invalidate replicated data.

Build drift alone still rebinds; that is slice 1's decision table, unchanged.

### The closed aliasing rule

The durable row carries the refs the invocation was given, so the overlay's
rule is closed on every verb rather than on `create` alone: a `ClientRef` is
admitted when it is committed-mapped, supplied by this invocation's own target
or validated input, or minted by one of its declared allocation slots.
Anything else is the `undeclared-ref` refusal — recorded and skipped, never a
speculative entity no durable record accounts for.

Nameability is a property of the **layer**, not of the assembled view. The
declaration is therefore checked *before* the shared resolution map is
consulted: reading that map first would let a ref one layer legitimately owns
become nameable by every later layer, simply because the owner had already
resolved it. A sealed `EntityId` is different — it names an authority the
device was given rather than one an invocation declared — so an alias any layer
bound resolves for all, which is exactly what makes resolution order-symmetric.

Aliases are bound in one pass over `(layer, operation)` order *before* the fold,
so resolution is order-symmetric: naming a mapped handle before the client ref
that aliases it resolves exactly as naming it after does, and the entity is
presented once either way.

### The `.local` sidecar

Entity-local pending metadata is derived from the layers and nothing else —
recomputed, never accumulated, so removing a layer removes its contribution by
construction. Per entity: the invocations still holding optimistic state for it,
whether any of them is still `queued`, and whether one of them brought it into
the view. It is client-internal state, never a persisted trait, never an
application datom, and not yet public API; #477 decides what an application
sees.

## Integrity validation and corruption recovery

Every restore path — cold restore, confirmed-candidate restore, and exact
credential-bound restore — validates the whole partition before any `Db` can
exist.

First the committed manifest. It must be this storage version, be filed under
the partition its own identity derives, state a complete identity (nothing may
be compared against a half-identity, which would throw before anything could
classify the record), agree with itself and the installed client about the
confirmed compatibility hash, carry four well-formed index roots whose counts
are consistent, and describe a value it can actually materialize: every stored
attribute well formed and numbered, every partition-local id in the user range
and below the allocator, no id claimed twice across the entity and attribute
maps, and every kept fact an assertion with a complete value whose entity,
field, and referent all have local ids. The journal is held to the same standard
as the value, because the next `Change` rebuilds the whole committed set from
it.

Then every node reachable from those four roots: it must exist in this
partition's node store, hash to the content address it is filed under, decode,
and sit in a position its own body agrees with — the index it was encoded for,
the referenced node kind, the referenced subtree count, the directory's
key/child arity, index order within a leaf and across a directory's keys, and
the separator its parent filed it under, which is always the smallest datom of
its own subtree. A bulk build gives every reachable node of one value a distinct
address, so a repeated address is itself a structural failure and also bounds
the walk.

Finally the conclusions only a completed walk can reach. A manifest keeps two
descriptions of one value — a logical journal of authorized facts, and four
physical index roots built from it — and the local id maps and stored schema sit
between them. The roots are the one part no content address covers, so a damaged
manifest can pair one index's current root with a superseded root of the same
size, and a drifted journal is invisible to the first restore but rebuilds a
different value at the next `Change`. Restore therefore replays the shared
logical-to-physical projection the install used, folding a commutative digest
over the bootstrap datoms, the stored schema datoms, and every journal fact,
partitioned by each index's own membership rule. Each walked tree must equal the
tree the manifest describes. Comparing whole datom sets would need both sides
resident; the fold costs one hash per fact and holds four fixed-size digests.
It also carries the largest transaction number, which must equal the manifest's
claimed basis: that value becomes the restored `basisT`, and lowering it filters
intact facts out of every read.

The walk is depth-first, so it costs one read, one digest, and one decode per
reachable node, plus one comparison and one fold step per datom, and holds a
bounded batch of node bodies at a time. A walk that stops part-way yields no
value at all; a partial `Db` is never constructed.

Missing node, hash mismatch, structural invariant violation, and undecodable
record are classified separately for diagnosis and collapse to one caller
outcome: this partition must be replaced by a fresh snapshot. An intact replica
whose compatibility hash or replica schema disagrees with the installed client
is the other outcome: the client must update first. Both are returned as typed
outcomes rather than thrown, and wrong-generation interactions keep surfacing
the ordinary typed fence errors.

Quarantine withdraws exactly one
server/principal/database/read-view/compatibility partition from selection: its
committed manifest, its head, and the exact credential binding and cache
candidate that would nominate it again. Nothing can restore or resume it
afterwards. Its content nodes are deliberately left to reachability GC, and its
staging with them: a `Db` another session has already published holds its own
roots and node store and no longer depends on the manifest, so deleting the
nodes underneath it would turn a stale value into one that throws mid-query,
while leaving them costs only space until the sweep. They are inert in the
meantime — unreachable from any manifest — and re-installing the same value
rewrites each node under its own address, repairing a damaged body in passing.

Sibling read views, sibling databases, other principals, other servers, the
scope's durable confirmation and generation, its route observations, and the
future outbox, receipt, ClientRef, and optimistic families are all preserved — a
corrupt committed read value is never a reason to discard a durable operation
identity. Because withdrawal is still destructive it is generation-fenced like
clearing and eviction, and the whole quarantine is one IndexedDB transaction, so
a crash cut leaves the corrupt partition exactly as it was and a retry completes
it.

### The publish fence

Reading a partition and acting on it are never one atomic step. A walk takes as
long as reading the replica, and a staged snapshot outlives the connection that
began it. Destructive maintenance in another handle sees neither — a restore
holds no pin until its caller has a value, and staging is not a participant — so
rather than widen what maintenance can see, every path states one invariant:

> Nothing derived from an earlier read of a partition may become observable or
> durable until, in one IndexedDB transaction at the moment it becomes
> load-bearing, the derivation re-confirms both the durable generations guarding
> that partition and the committed state it assumed.

The generations are what a clear or an eviction moves, and only those two delete
content nodes, so re-observing them is exactly what separates "the value I
validated is still mine to publish" from "its nodes were deleted while I was
reading them". An ordinary install moves the committed state instead, and leaves
a validated manifest and its nodes entirely intact — publishing it is the older
of the old-or-new complete values a caller is promised, not a mixture — so each
path re-confirms only the part of the committed state its own derivation
depended on. Every path derives from the one invariant:

- a **restored replica** re-confirms the generations in `validated`, the single
  place cold restore, bound restore, and confirmed-candidate restore all funnel
  through, after the walk and before the manifest can be handed back;
- a **quarantine** re-confirms the exact manifest it refused, by revision, root
  addresses, basis, allocator, and stored-map sizes;
- a **snapshot start** re-confirms that the base revision its staging recorded
  is still the committed one, and rebases the staging when it is not — a
  snapshot identity is a deterministic function of identity and revision, so a
  reconnect resumes the very same staging, and a base its commit can never
  satisfy again would strand the partition on every following attempt;
- a **snapshot commit** and a **change apply** re-confirm their base revision
  inside the very transaction that installs;
- a **restored replica** additionally re-confirms the partition's sweep
  generation, because reachability GC is a second writer that deletes nodes
  without touching a manifest (see below).

A failed generation re-check surfaces the ordinary typed fence error; a failed
committed-state re-check reports that nothing is selected, so the caller chooses
again from what is actually stored.

Validating a partition takes as long as reading it, so another session may
install a complete replacement while a walk is still running. Withdrawal is
therefore conditional on the refused manifest still being the stored one,
compared by revision, the four root addresses, the basis, the allocator, and the
size of every stored map, and the install identifier. A refusal that loses that
comparison withdraws nothing and reports that nothing is selected, rather than
acting on a value it never examined. For the same reason a restore that ran
after a snapshot had begun streaming would quarantine underneath the replacement
being received, so the session validates the committed value before it stages
that snapshot's first frame.

The install identifier is what makes that comparison complete. A re-install of
the *same* revision rebuilds identical roots and identical maps, so nothing the
record says about its own value can separate the manifest that was refused from
a repaired one written in its place — and a repair is exactly what a
re-install of the same revision is: it rewrites the damaged node under its own
address. Every install therefore stamps the manifest with an identifier unique
to the act of installing rather than to the value, which nothing authorizes
anything with and which never leaves the device. Manifests written before that
field existed carry none and compare as absent on both sides, so their behavior
is unchanged.

One `Db` construction is deliberately not preceded by a walk: the duplicate or
out-of-order `Change`, which installs nothing and hands back the value already
committed. A session reaches that path only after it restored the partition
through the walk or installed a snapshot into it, so the manifest it reads is
that one or a strictly later install some live client materialized — never a
cold unverified record. The only check worth making there is a full walk, a
partial one would pass over exactly the damage it skipped, and at 100k datoms
that walk costs a whole cold restore per duplicate frame. Damage appearing
afterwards is caught by the next restore's walk, with every other stored-node
failure.

## Reachability GC and bounded quota recovery

A committed replica is content-addressed and immutable, so every install writes
a new set of nodes and abandons the ones it superseded. At 100k datoms a whole
replica is 81 nodes and 430 KiB, and one changed datom orphans 62 of those 81
immediately. Quarantine leaves a partition's nodes and staging behind by design,
and a failed install leaves the nodes it had already written. Reclaiming that is
one sweep, and the only interesting part of it is what it may never delete.

### Retention

A node record is *retained* when it is reachable from a live root set of its own
partition. Reachability is partition-local by construction: node records are
keyed by `[partition, hash]`, so no partition can keep another's node alive. The
live root sets are exactly:

1. the four index roots of the partition's committed manifest, when one is
   stored;
2. every root set an in-process holder has retained — a replication session
   retains the roots of the value it currently publishes, including a stale
   value published over a partition that has since been quarantined;
3. nothing at all for a partition with an in-flight materialization: its fresh
   nodes have no roots yet, so that partition is excluded from the sweep
   entirely rather than described by a root set.

Everything else in the partition is unreachable from every value a live
participant can read, and is swept. One thing is deliberately *not* retained: a
`Db` older than the one its session currently publishes. Reclaiming superseded
roots is the entire point of the sweep — they are where the garbage comes from —
so a holder that needs an older value to stay readable must retain it. GC never
writes a manifest, a head, a binding, or a candidate, so no install identifier
can be dropped or invented by a sweep, and `writeCounts()` shows zero manifests
and zero heads for any GC pass.

### Sweep invariants

- **Fail closed on damage.** A body believed wrongly under-reports its children,
  and the intact descendants would then be classified as garbage, so the sweep
  refuses to believe anything it cannot authenticate. Content addresses do that
  for the *structure*: a body that hashes to the address its parent filed it
  under is the node that address names, so the children it lists are the real
  ones, while a valid leaf stored under a directory's address, a half-written
  record, or a missing node is refused.

  A manifest authenticates nothing. It is an ordinary stored record and its four
  roots are just hashes, so damage that swapped one for another correctly stored
  node — a superseded root of the same index and count — passes every address
  check and would hand the sweep a live set describing some other value, which
  it would then delete the current one to honour. Roots therefore get the full
  restore-strength validation, ending in the digest fold that proves the walked
  trees are the ones this manifest's own journal describes. Retained roots skip
  it: they are values this process restored through that same walk or
  materialized itself, and retaining too much is safe anyway.

  Any of those refusals leaves the partition's live set unknown, and GC sweeps
  nothing in it. Damage is never converted into deletion; the restore walk is
  what classifies and quarantines it, on nodes the sweep left in place.
- **Materialization exclusion.** An install marks its partition in flight
  synchronously before materialization creates its first node transaction, and
  clears the mark only after the install transaction settles — closing the
  storage handle does not clear it, because a closed IndexedDB connection still
  runs the transactions it already created to completion. GC reads that mark and
  creates its sweep transaction in one synchronous block, with no `await`
  between them. Either GC saw the mark and skipped the partition, or the
  materialization had not yet created a node transaction — and every transaction
  it creates afterwards is created after the sweep transaction. IndexedDB
  serializes overlapping `readwrite` transactions in creation order, so a
  content-addressed re-put of a node the sweep is deleting always lands after
  the delete, never before it.

  The mark is realm-local, like every other in-process lifecycle registration
  here, so a sweep in another tab cannot see it: it would find nodes reachable
  from nothing — because the manifest naming them is not committed yet — and
  could delete them while the installer's base-revision CAS still passed. An
  install therefore records the partition's sweep generation before it
  materializes and re-confirms it inside the transaction that installs. In one
  realm that value cannot move inside that window, so no live session is ever
  fenced by it; across realms it is the durable trace such a sweep leaves, and
  re-reading it turns the hazard into a refused install rather than a manifest
  committed over deleted nodes. #478's all-tab barrier replaces the mark; this
  record is what makes the interval safe until it does.
- **Sweep CAS.** The live set is computed from a committed manifest read outside
  the sweep transaction. The sweep transaction re-reads that manifest and
  requires its fingerprint — including the install identifier — to be unchanged.
  A sweep is therefore always consistent with the committed value as of the
  instant it commits, and a partition whose manifest moved is skipped rather
  than swept against a value nobody examined.
- **Retention re-check.** The manifest CAS does not cover retention, because a
  restore that validated an *older* manifest publishes without moving the
  manifest at all, and the pass may have computed its live set before that
  happened. The same synchronous block that reads the materialization mark
  therefore re-reads the retained roots, and skips the partition when one has
  appeared that the live set does not already cover. A root that has gone since
  is harmless — the live set was simply more generous than it needed to be.

  This composes with the publish fence only because a restore retains *before*
  its fence transaction exists, with no await in between, so exactly one of two
  orders can hold. If the sweep's synchronous block ran first, its transaction
  was created before the fence's, IndexedDB orders the generation bump ahead of
  the fence's read, and the fence sees it and refuses. If it runs second, it
  finds the retention covering the roots it was about to reclaim and skips. A
  holder that retained *after* receiving its value would sit in neither order:
  the sweep could plan while nothing was retained and still transact after a
  fence that had already read a generation of zero. Every value the storage
  hands out therefore arrives already retained, and its receiver owns exactly
  one release.
- **Only impossible staging.** Staging is swept only when its recorded base
  revision is no longer the committed one, which is exactly the condition under
  which its `SnapshotCommit` can never install again. A snapshot still streaming
  against a current base is never touched, and a reconnect rebases the stale
  case anyway.
- **Content only.** A sweep reclaims content nodes and impossible staging. The
  #475 mutation families — outbox, queues, receipts, ClientRefs, mappings — are
  not merely skipped but structurally out of reach: the sweep transaction never
  names those stores, so IndexedDB itself would refuse a write to one. Storage
  pressure is no reason to discard work the user has not yet had acknowledged,
  which is why the quota recovery pass is this same pass and nothing wider.
- **One transaction.** The generation bump, the node deletes, and the staging
  deletes are one IndexedDB transaction with a boundary immediately before its
  commit, so a crash cut leaves either the complete pre-sweep state or the
  complete post-sweep state. Both are states a later walk accepts, because the
  swept set was provably unreachable from the committed manifest either way.

### The sweep generation

The publish fence rests on one premise: only a clear and an eviction delete
content nodes, and both bump a generation the fence re-observes. GC deletes
nodes without touching a manifest, so it must either take that same fence or
break it. Two mechanisms were available.

Bumping the guarded **database** generation was rejected. Every live session of
that database leases that record, so a sweep would refuse those sessions' next
install with the ordinary fence error — and sweeping superseded roots while a
session is running is the normal case, not the exception. GC would then be
unable to reclaim anything without disturbing exactly the sessions it must leave
alone.

Instead GC bumps a per-partition **sweep generation**: one more record in the
same `replica-generations-v1` store, under the same discipline of being readable
inside any transaction, with exactly one writer (a sweep that deleted at least
one node) and exactly one reader (the restore publish fence). `validated` reads
it in the same transaction that takes the walk's lifecycle lease, before the
walk, and re-reads it in the same transaction that re-confirms the scope and
database generations, after it. A changed value means nodes were deleted in this
partition while the walk was running, so the manifest it read is no longer safe
to publish.

That outcome says nothing about the partition — only about this attempt — and
commonly the partition is untouched, because a sweep reclaims superseded roots
while the current manifest stands. The same is true of a refusal whose
withdrawal loses its manifest CAS: an install moved the record on, and a sweep
of the roots it superseded is exactly how a healthy partition reaches that
branch. Reporting an absence for either would strand an offline restore that has
no other way to obtain the value, so both make the restore read the stored
record again and walk it again, up to a small bounded number of attempts. A
partition that keeps moving under every attempt is reported as *contended* — a
typed outcome distinct from an absence, because something is certainly stored
and a caller must never read persistent contention as an empty partition worth
re-snapshotting from scratch. A clear or an eviction keeps surfacing the
ordinary typed fence error, unchanged.

A scoped clear and a database eviction remove the sweep-generation records of
the partitions they delete, in the same transaction and by the same prefix
range: a record is named after its partition, so nothing else would ever remove
it once that partition is gone. The scope and database generations they bump
survive by design, exactly as before.

The install paths observe it too, but only for the window between writing their
nodes and committing the manifest that names them, and never through the
session's long-lived lease. In one realm the materialization mark keeps that
value still, so a sweep of the roots a running session superseded still fences
nothing; across realms it is the only signal an install has that its fresh nodes
may already be gone.

### Bounded quota recovery

Native quota exhaustion is a typed outcome, not a corruption. `QuotaExceededError`
and the historical browser spellings — Firefox's `NS_ERROR_DOM_QUOTA_REACHED`
and legacy code 1014, Safari's `QUOTA_EXCEEDED_ERR` and legacy code 22 — are
classified together; everything else propagates unchanged.

An install that fails that way performs at most one GC pass and at most one
retry. The failed attempt's own nodes are unreachable, so the pass reclaims them
along with every superseded root, and the pass runs between the two attempts —
after the first attempt released its materialization mark, before the retry
takes it — so the partition that needs the space is not the one partition GC
skips. The pass is unscoped, because storage pressure is a property of the
origin rather than of one principal, and it can still only delete what is
provably unreachable.

If the retry also exhausts quota, the install throws a typed quota error
carrying what the pass reclaimed. Nothing was installed: materialization writes
only content nodes, and the install itself is one atomic transaction, so the
previously committed manifest is byte-identical to what it was and the
old-or-new guarantee holds. Active data is never evicted to make room.

## Authorization and noninterference

Initial admission and every fixed lease renewal rerun the complete ordered Graph
path through the one deployed authorization evaluator. A stream is fixed to
the admitted path identity and may not migrate when a mutable Graph name,
ancestor entity, child database, read compatibility, or principal
changes. The next authorization fence occurs no later than five seconds after
the preceding admitted lease, including while idle.
Failure emits only the fixed `closed` terminal envelope; reconnect under a new
partition follows the opaque reset path.

Only the target's `filteredDb` reaches logical projection, hashing, snapshot,
or diff code. A hidden-only commit emits no data frame, revision, reset,
sequence gap, count, queue metadata, heartbeat, or diagnostic close reason.
Repeated hidden commits conflate without running an advance and cannot
accumulate memory or proportional visible-frame latency.

For activation resume specifically, equality of the private physical basis is
not a shortcut. A zero-physical-change world and a hidden-only-physical-change
world with the same complete authorized logical value execute the same
implementation-scheduled reconstruction, logical validation, and pre-emission
checkpoint path, then emit byte-identical `ResumeReady` frames in the same
position. No basis, hidden count, alternate scheduling signal, or timing
metadata crosses the boundary.

The legacy `/session` `ClientFrame`/`TxPushFrame`/`ResyncFrame` wire remains
testing-only and publicly fail-closed. `/replicate` neither accepts nor emits
its raw `t` values and is not an alias for it.

## Bounds and version ownership

| Item | Version-1 bound |
|---|---:|
| Activation JSON | 65,536 UTF-8 bytes |
| One encoded frame | 1,100,000 UTF-8 bytes |
| Path segments | 1,024 |
| Path segment / field ident | 4,096 UTF-8 bytes |
| Scalar string / base64 value or snapshot value part | 131,072 UTF-8 bytes |
| Non-final raw byte value part | 98,304 bytes |
| Snapshot datoms per chunk | 16 |
| Change datoms | 256 and 1,048,576 encoded bytes |
| Private resume records per authenticated binding object | 8 revisions |

Protocol, client build, local storage, and read-view versions have separate
owners. Protocol mismatch resets at the wire layer. Client build mismatch
resets the derived client representation. Storage version mismatch invokes
the storage migration layer, which must reset if it cannot migrate atomically.
Read-view mismatch resets the authenticated data partition. These decisions
are made before a resume token can be reused.
